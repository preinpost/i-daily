// server/app.ts — Hono 앱 (Cloudflare Workers).
// 일지 CRUD 는 journalRoutes 를 app.route("/api", ...) 로 마운트; 도메인
// 라우트(jira/lunch/agent/me)는 부모 app 에 직접 등록. 모두 Hono 네이티브 매칭.
// 인증: 세션(sid 쿠키 → sessions D1) 기반. 미로그인 시 user=SETUP("setup").
import { Hono } from "hono";
import type { Backend } from "../shared/backend.ts";
import { SETUP_USER } from "../shared/backend.ts";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { journalRoutes } from "./journal.ts";
import { searchLunch } from "./lunch.ts";
import {
	generateReport,
	defaultPrompt,
	AI_PROVIDERS,
	isProvider,
	providerNeedsBaseUrl,
	normalizeBaseUrl,
	testConnection,
} from "./agent.ts";
import {
	writeAiAuthEnc,
	clearAiAuth,
	hasAiAuth,
} from "../shared/store-drizzle.ts";
import { encryptSecret } from "./crypto.ts";
import {
	jiraStatus,
	jiraTickets,
	jiraSetDue,
	jiraTransitions,
	jiraTransition,
	jiraLogout,
} from "./jira.ts";

type DB = DrizzleD1Database;

// 워커 엔트리가 요청마다 새 앱을 만들어 (이미 인증된) backend 와 db 를 직접 건네준다.
// 도메인 라우트(jira)는 토큰 저장을 위해 Drizzle db 도 함께 받는다.
export function buildApp(backend: Backend, db: DB, env: Env): Hono {
	const app = new Hono();

	// ── 점심 ── 카카오 로컬 키워드 검색.
	app.post("/api/lunch/search", async (c) => {
		const opts = await c.req.json().catch(() => ({}));
		const r = await searchLunch(backend, opts);
		return c.json(r);
	});

	// ── 주간보고 ── 결정적 집계 + (BYOK 키 있으면) provider 서술 다듬기.
	app.post("/api/agent/generate", async (c) => {
		const opts = await c.req.json().catch(() => ({}));
		const r = await generateReport(backend, opts, env, db);
		return c.json(r);
	});
	app.get("/api/agent/default-prompt", (c) => c.json(defaultPrompt()));

	// ── AI(BYOK) 키 ── 키는 ai_auth 에 AES-GCM 암호문으로만 저장. 평문은 렌더러로 절대 반환 안 함.
	app.get("/api/ai/status", async (c) => {
		const cfg = await backend.readConfig();
		return c.json({
			hasKey: await hasAiAuth(db, backend.user),
			provider: cfg.reportProvider || "",
			model: cfg.reportModel || "",
			baseUrl: cfg.reportBaseUrl || "",
			providers: AI_PROVIDERS,
			encReady: !!env.AI_ENC_KEY,
		});
	});
	// 키/endpoint 검증 + 모델 목록 조회. 저장 전 일회성 — 키를 저장하지 않고 provider 에만 전달.
	app.post("/api/ai/test", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as {
			provider?: string;
			apiKey?: string;
			baseUrl?: string;
		};
		const provider = String(body.provider || "").trim();
		const apiKey = String(body.apiKey || "").trim();
		let baseUrl = String(body.baseUrl || "").trim();
		if (!provider || !apiKey) {
			return c.json({ ok: false, error: "provider · apiKey 필요", models: [] }, 400);
		}
		if (!isProvider(provider)) {
			return c.json({ ok: false, error: "지원하지 않는 provider", models: [] }, 400);
		}
		if (providerNeedsBaseUrl(provider)) {
			try {
				baseUrl = normalizeBaseUrl(baseUrl);
			} catch (e) {
				return c.json(
					{ ok: false, error: String((e as Error).message), models: [] },
					400,
				);
			}
		}
		const r = await testConnection({ provider, model: "", apiKey, baseUrl });
		return c.json(r, r.ok ? 200 : 502);
	});
	app.put("/api/ai/key", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as {
			provider?: string;
			model?: string;
			apiKey?: string;
			baseUrl?: string;
		};
		const provider = String(body.provider || "").trim();
		const model = String(body.model || "").trim();
		const apiKey = String(body.apiKey || "").trim();
		let baseUrl = String(body.baseUrl || "").trim();
		if (!provider || !apiKey) {
			return c.json({ ok: false, error: "provider · apiKey 필요" }, 400);
		}
		if (!isProvider(provider)) {
			return c.json({ ok: false, error: "지원하지 않는 provider" }, 400);
		}
		if (providerNeedsBaseUrl(provider)) {
			try {
				baseUrl = normalizeBaseUrl(baseUrl);
			} catch (e) {
				return c.json({ ok: false, error: String((e as Error).message) }, 400);
			}
		} else {
			baseUrl = ""; // 비-custom 은 baseUrl 저장 안 함(고정 endpoint).
		}
		if (!env.AI_ENC_KEY) {
			return c.json(
				{ ok: false, error: "서버에 AI_ENC_KEY secret 이 없습니다(관리자)." },
				500,
			);
		}
		const enc = await encryptSecret(env.AI_ENC_KEY, apiKey);
		await writeAiAuthEnc(db, backend.user, enc);
		await backend.writeConfig({
			reportProvider: provider,
			reportModel: model,
			reportBaseUrl: baseUrl,
		});
		return c.json({ ok: true, hasKey: true, provider, model, baseUrl });
	});
	app.delete("/api/ai/key", async (c) => {
		await clearAiAuth(db, backend.user);
		await backend.writeConfig({
			reportProvider: "",
			reportModel: "",
			reportBaseUrl: "",
		});
		return c.json({ ok: true, hasKey: false });
	});

	// ── Jira REST (로그인/세션은 Better Auth · /api/auth) ──
	app.get("/api/jira/status", async (c) => {
		return c.json(await jiraStatus(backend, db));
	});
	// 레거시: 클라이언트가 아직 /api/jira/connect 를 부르면 Better Auth 로 안내.
	app.get("/api/jira/connect", (c) => {
		return c.json({
			ok: false,
			error:
				"로그인은 Better Auth(/api/auth/sign-in/social · Atlassian)를 사용하세요.",
			useBetterAuth: true,
		});
	});
	app.get("/api/jira/tickets", async (c) => {
		return c.json(await jiraTickets(backend, db));
	});
	app.put("/api/jira/due", async (c) => {
		const b = (await c.req.json().catch(() => ({}))) as {
			key?: string;
			due?: string;
		};
		return c.json(await jiraSetDue(backend, db, b.key || "", b.due || ""));
	});
	app.get("/api/jira/transitions", async (c) => {
		const key = c.req.query("key") || "";
		return c.json(await jiraTransitions(backend, db, key));
	});
	app.post("/api/jira/transition", async (c) => {
		const b = (await c.req.json().catch(() => ({}))) as {
			key?: string;
			transitionId?: string;
		};
		return c.json(
			await jiraTransition(backend, db, b.key || "", b.transitionId),
		);
	});
	app.post("/api/jira/logout", async (c) => {
		// jira_auth 만 정리. 세션 쿠키는 클라이언트가 /api/auth/sign-out 으로 끊는다.
		const r = await jiraLogout(backend, db);
		return c.json(r);
	});

	// ── 로그인 상태 ── 현재 user(세션)와 setup 여부.
	app.get("/api/me", (c) => {
		return c.json({ user: backend.user, isSetup: backend.user === SETUP_USER });
	});

	// ── 일지 CRUD ── 도메인 라우트 이후에 마운트(겹치는 경로 없음: /config /days /day/* 등).
	app.route("/api", journalRoutes(backend));

	// 마운트된 sub-app 의 notFound 는 안 발동 → 최상위에서 JSON 404 보장.
	app.notFound((c) => c.json({ error: "not found", path: c.req.path }, 404));

	return app;
}
