// server/agent.ts — 주간업무보고 에이전트 (서버 측, BYOK + custom endpoint).
//
// Cloudflare Workers 는 로컬 프로세스 spawn 불가 → 에이전트 CLI(claude/codex/pi) 실행 불가.
// 대신 사용자가 등록한 자기 LLM API 키(BYOK)로 provider 를 직접 fetch 해 서술을 다듬는다.
//   - provider ∈ anthropic | openai | custom(OpenAI 호환 baseUrl).
//   - 키 없음/provider 미설정 → 결정적 집계(deterministic)만 반환(+warn).
//   - 키 있음 → provider 호출. 실패 시 결정적 집계로 안전 폴백(+warn).
// 키는 ai_auth 테이블에 AES-GCM 암호문으로만 저장 → 여기서 복호화(env.AI_ENC_KEY)해 메모리에서만 사용.
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { Backend } from "../shared/backend.ts";
import {
	buildWeeklyDigest,
	renderDigestText,
	splitDigestText,
	weekWindow,
	DEFAULT_REPORT_PROMPT,
} from "../shared/report.ts";
import { readAiAuthEnc } from "../shared/store-drizzle.ts";
import { decryptSecret } from "./crypto.ts";

type DB = DrizzleD1Database;

// UI 가 보여줄 지원 provider 목록(정적). 모델은 Test(/models)로 가져오거나 직접 입력.
export const AI_PROVIDERS = [
	{
		id: "anthropic",
		label: "Anthropic (Claude)",
		defaultModel: "claude-haiku-4-5",
		keyHint: "sk-ant-… (console.anthropic.com)",
		custom: false,
	},
	{
		id: "openai",
		label: "OpenAI (GPT)",
		defaultModel: "gpt-4o-mini",
		keyHint: "sk-… (platform.openai.com)",
		custom: false,
	},
	{
		id: "custom",
		label: "Custom (OpenAI 호환 endpoint)",
		defaultModel: "",
		keyHint: "API 키 (없으면 아무 값)",
		custom: true,
	},
] as const;

export type ProviderId = (typeof AI_PROVIDERS)[number]["id"];

export function isProvider(id: string): id is ProviderId {
	return AI_PROVIDERS.some((p) => p.id === id);
}

export function providerNeedsBaseUrl(id: string): boolean {
	return !!AI_PROVIDERS.find((p) => p.id === id)?.custom;
}

type GenerateOpts = {
	from?: string;
	to?: string;
	useAgent?: boolean;
};
type GenerateResult = {
	ok: true;
	from: string;
	to: string;
	count: number;
	text: string;
	thisWeek: string;
	nextWeek: string;
	deterministic: string;
	usedAgent: string | null;
	warn?: string;
};

type AiCreds = {
	provider: string;
	model: string;
	apiKey: string;
	baseUrl?: string; // custom 필수. anthropic/openai 는 무시(고정 base).
};

// custom baseUrl 검증 + 정규화. https 만 허용(SSRF 완화), 끝 슬래시 제거.
export function normalizeBaseUrl(raw: string): string {
	const s = (raw || "").trim().replace(/\/+$/, "");
	if (!s) throw new Error("baseUrl 이 필요합니다.");
	let u: URL;
	try {
		u = new URL(s);
	} catch {
		throw new Error("baseUrl 형식이 올바르지 않습니다.");
	}
	if (u.protocol !== "https:") throw new Error("baseUrl 은 https 여야 합니다.");
	return s;
}

// provider → API base(끝 슬래시 없음). custom 은 사용자 baseUrl.
function resolveBase(provider: string, baseUrl?: string): string {
	if (provider === "anthropic") return "https://api.anthropic.com/v1";
	if (provider === "openai") return "https://api.openai.com/v1";
	if (provider === "custom") return normalizeBaseUrl(baseUrl || "");
	throw new Error(`지원하지 않는 provider: ${provider}`);
}

function isAnthropic(provider: string): boolean {
	return provider === "anthropic";
}

// 모델 목록 조회(GET /models). Test 성공 판정 + 모델 후보 제공.
export async function listModels(ai: AiCreds): Promise<string[]> {
	const base = resolveBase(ai.provider, ai.baseUrl);
	const headers: Record<string, string> = isAnthropic(ai.provider)
		? { "x-api-key": ai.apiKey, "anthropic-version": "2023-06-01" }
		: { authorization: `Bearer ${ai.apiKey}` };
	const res = await fetch(`${base}/models`, { headers });
	if (!res.ok) {
		throw new Error(
			`${ai.provider} /models ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`,
		);
	}
	const j = (await res.json().catch(() => ({}))) as {
		data?: { id?: string }[];
	};
	let ids = (j.data || [])
		.map((m) => String(m?.id || ""))
		.filter(Boolean);
	// OpenAI 는 임베딩/음성 등 잡음이 많다 → 대화형만 추림(빈 결과면 원본 유지).
	if (ai.provider === "openai") {
		const chat = ids.filter((id) => /^(gpt-|o\d|chatgpt)/i.test(id));
		if (chat.length) ids = chat;
	}
	return Array.from(new Set(ids)).sort();
}

// 키/endpoint 검증 + 모델 목록. UI 의 "테스트 & 모델 불러오기" 백엔드.
export async function testConnection(
	ai: AiCreds,
): Promise<{ ok: boolean; models: string[]; error?: string }> {
	try {
		const models = await listModels(ai);
		return { ok: true, models };
	} catch (e) {
		return {
			ok: false,
			models: [],
			error: String((e as Error)?.message || e).slice(0, 200),
		};
	}
}

// provider 직접 호출(fetch). 서술만 다듬어 텍스트 반환. 실패 시 throw.
async function callProvider(
	ai: AiCreds,
	system: string,
	userText: string,
): Promise<string> {
	const base = resolveBase(ai.provider, ai.baseUrl);

	if (isAnthropic(ai.provider)) {
		const res = await fetch(`${base}/messages`, {
			method: "POST",
			headers: {
				"x-api-key": ai.apiKey,
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: ai.model || "claude-haiku-4-5",
				max_tokens: 2000,
				system,
				messages: [{ role: "user", content: userText }],
			}),
		});
		if (!res.ok) {
			throw new Error(
				`anthropic ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`,
			);
		}
		const j = (await res.json()) as {
			content?: { type: string; text?: string }[];
		};
		const text = (j.content || [])
			.filter((b) => b.type === "text" && b.text)
			.map((b) => b.text)
			.join("")
			.trim();
		if (!text) throw new Error("anthropic: 빈 응답");
		return text;
	}

	// openai + custom → OpenAI 호환 chat/completions.
	const res = await fetch(`${base}/chat/completions`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${ai.apiKey}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model: ai.model || "gpt-4o-mini",
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: userText },
			],
		}),
	});
	if (!res.ok) {
		throw new Error(
			`${ai.provider} ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`,
		);
	}
	const j = (await res.json()) as {
		choices?: { message?: { content?: string } }[];
	};
	const text = (j.choices?.[0]?.message?.content || "").trim();
	if (!text) throw new Error(`${ai.provider}: 빈 응답`);
	return text;
}

// 결정적 주간 집계 + (키 있으면) provider 서술 다듬기.
export async function generateReport(
	backend: Backend,
	opts: GenerateOpts,
	env?: Env,
	db?: DB,
): Promise<GenerateResult> {
	const win = weekWindow();
	const from = opts.from || win.from;
	const to = opts.to || win.to;
	const cfg = await backend.readConfig();

	const rows = await backend.queryTasks({ from, to });
	const digest = buildWeeklyDigest(rows, cfg.owner || "", from, to);
	const deterministic = renderDigestText(digest);

	let text = deterministic;
	let usedAgent: string | null = null;
	let warn: string | undefined;

	if (opts.useAgent && digest.count > 0) {
		const provider = (cfg.reportProvider || "").trim();
		if (!provider) {
			warn = "AI provider 미설정 — 설정에서 등록하면 서술을 다듬어요.";
		} else if (!env?.AI_ENC_KEY || !db) {
			warn = "서버에 AI_ENC_KEY secret 이 없어 AI 를 사용할 수 없습니다.";
		} else {
			try {
				const enc = await readAiAuthEnc(db, backend.user);
				if (!enc) {
					warn = "등록된 API 키가 없어 집계 결과만 반환합니다.";
				} else {
					const apiKey = await decryptSecret(env.AI_ENC_KEY, enc);
					const system =
						(cfg.reportPrompt || "").trim() || DEFAULT_REPORT_PROMPT;
					text = await callProvider(
						{
							provider,
							model: cfg.reportModel,
							apiKey,
							baseUrl: cfg.reportBaseUrl,
						},
						system,
						deterministic,
					);
					usedAgent = cfg.reportModel
						? `${provider}/${cfg.reportModel}`
						: provider;
				}
			} catch (e) {
				text = deterministic;
				warn =
					"AI 호출 실패 — 집계 결과로 대체: " +
					String((e as Error)?.message || e).slice(0, 160);
			}
		}
	}

	const { thisWeek, nextWeek } = splitDigestText(text);
	return {
		ok: true,
		from,
		to,
		count: digest.count,
		text,
		thisWeek,
		nextWeek,
		deterministic,
		usedAgent,
		warn,
	};
}

export function defaultPrompt(): string {
	return DEFAULT_REPORT_PROMPT;
}
