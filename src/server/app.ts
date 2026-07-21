// server/app.ts — Hono 앱 (Cloudflare Workers).
// 일지 CRUD 는 journalRoutes 를 app.route("/api", ...) 로 마운트; 도메인
// 라우트(jira/lunch/agent/me)는 부모 app 에 직접 등록. 모두 Hono 네이티브 매칭.
// 인증: 세션(sid 쿠키 → sessions D1) 기반. 미로그인 시 user=SETUP("setup").
import { Hono, type Context } from "hono";
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
	jiraConnect,
	jiraCallback,
	jiraTickets,
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

	// ── Jira OAuth + 티켓 ──
	// origin 은 redirect URI 구성용(콜백 URL). 신뢰 가능한 오리진만 사용(동적 호스트 주의).
	// request.url 은 유효하지만 파싱은 안전하게 감싼다.
	const originOf = (c: Context): string => {
		try {
			return new URL(c.req.url).origin;
		} catch {
			return "";
		}
	};
	// httpOnly sid 쿠키 판독(없으면 undefined).
	const readSid = (c: Context): string | undefined => {
		const ck = c.req.header("cookie") || "";
		const m = ck.match(/(?:^|;\s*)sid=([^;]+)/);
		return m ? decodeURIComponent(m[1]) : undefined;
	};
	// sid 쿠키 직렬화. Secure 는 https 요청에서만 붙인다 —
	// 로컬 dev(http://localhost)에서 Secure 쿠키는 브라우저가 저장하지 않기 때문.
	const sidCookie = (c: Context, sid: string, maxAge: number): string => {
		let https = false;
		try {
			https = new URL(c.req.url).protocol === "https:";
		} catch {
			https = false;
		}
		return `sid=${sid}; HttpOnly; ${https ? "Secure; " : ""}SameSite=Lax; Path=/; Max-Age=${maxAge}`;
	};

	app.get("/api/jira/status", async (c) => {
		return c.json(await jiraStatus(backend, db));
	});
	app.get("/api/jira/connect", async (c) => {
		// 클라이언트가 새 창으로 열 수 있도록 인가 URL 을 반환. 진행 상태 등록.
		const r = await jiraConnect(backend, db, originOf(c));
		return c.json(r);
	});
	// Atlassian 이 리다이렉트시키는 콜백. code/state 로 토큰 교환 → 성공/실패 HTML.
	app.get("/api/jira/callback", async (c) => {
		let code: string | null = null;
		let state: string | null = null;
		let err: string | null = null;
		try {
			const u = new URL(c.req.url);
			code = u.searchParams.get("code");
			state = u.searchParams.get("state");
			err = u.searchParams.get("error");
		} catch {
			/* 잘못된 요청 → 빈 값으로 진행 */
		}
		const r = await jiraCallback(db, code, state, err);
		// 성공시 sid 세션 쿠키(+메인창 알림용 postMessage 스크립트).
		const headers: Record<string, string> = {};
		if (r.sid) {
			headers["Set-Cookie"] = sidCookie(c, r.sid, r.maxAge ?? 0);
		}
		// 성공(sid 있음) 시: 메인창에 알림 후 팝업 자동 닫기. 메인창은 리로드로 대시보드 갱신.
		// 실패 시: 에러 메시지를 볼 수 있도록 팝업 유지.
		const notify = r.sid
			? `<script>try{if(window.opener&&!window.opener.closed){window.opener.postMessage({type:'i-daily-login'},location.origin);}}catch(e){}setTimeout(function(){try{window.close();}catch(e){}},400);</script>`
			: "";
		const hint = r.sid
			? "로그인 완료 — 이 창은 자동으로 닫힙니다."
			: "이 창을 닫고 다시 시도하세요.";
		return c.html(
			`<!doctype html><meta charset=utf-8><body style="font-family:system-ui,sans-serif;padding:48px;text-align:center;color:#222"><h2>${r.html}</h2><p>${hint}</p>${notify}</body>`,
			200,
			headers,
		);
	});
	app.get("/api/jira/tickets", async (c) => {
		return c.json(await jiraTickets(backend, db));
	});
	app.post("/api/jira/logout", async (c) => {
		// 세션 sid 는 쿠키에서 판독 — 로그아웃은 jira_auth + 세션 동시 삭제.
		const sid = readSid(c);
		const r = await jiraLogout(backend, db, sid);
		// sid 쿠키 만료시켜 미로그인(=setup) 상태로 복귀.
		return c.json(r, 200, {
			"Set-Cookie": sidCookie(c, "", 0),
		});
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
