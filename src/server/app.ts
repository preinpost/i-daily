// server/app.ts — Hono 앱 (Cloudflare Workers).
// shared/api.ts 의 routeWith(method,path,body,backend) 에 Backend provider 를 주입받는다.
// 도메인 라우트(jira/login/lunch/agent) 는 기존 IPC 채널을 대체.
// 인증: 세션(sid 쿠키 → sessions D1) 기반. 미로그인 시 user=SETUP("setup").
import { Hono, type Context } from "hono";
import type { Backend } from "../shared/backend.ts";
import { SETUP_USER } from "../shared/backend.ts";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { routeWith } from "../shared/api.ts";
import { searchLunch } from "./lunch.ts";
import { generateReport, scanAgents, defaultPrompt } from "./agent.ts";
import {
	jiraStatus,
	jiraConnect,
	jiraCallback,
	jiraTickets,
	jiraLogout,
} from "./jira.ts";

type DB = DrizzleD1Database;

// 도메인 라우트가 jira 토큰 저장을 위해 Drizzle db 가 필요 → provider 가 (backend, db) 쌍을 준다.
export function buildApp(getPair: () => { backend: Backend; db: DB }): Hono {
	const app = new Hono();

	// ── 점심 ── 카카오 로컬 키워드 검색.
	app.post("/api/lunch/search", async (c) => {
		const opts = await c.req.json().catch(() => ({}));
		const r = await searchLunch(getPair().backend, opts);
		return c.json(r);
	});

	// ── 주간보고 ── 결정적 집계 + (웹에선 비활성) 에이전트 안내.
	app.get("/api/agent/scan", (c) => c.json(scanAgents()));
	app.post("/api/agent/generate", async (c) => {
		const opts = await c.req.json().catch(() => ({}));
		const r = await generateReport(getPair().backend, opts);
		return c.json(r);
	});
	app.get("/api/agent/default-prompt", (c) => c.json(defaultPrompt()));

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
		const { backend, db } = getPair();
		return c.json(await jiraStatus(backend, db));
	});
	app.get("/api/jira/connect", async (c) => {
		const { backend, db } = getPair();
		// 클라이언트가 새 창으로 열 수 있도록 인가 URL 을 반환. 진행 상태 등록.
		const r = await jiraConnect(backend, db, originOf(c));
		return c.json(r);
	});
	// Atlassian 이 리다이렉트시키는 콜백. code/state 로 토큰 교환 → 성공/실패 HTML.
	app.get("/api/jira/callback", async (c) => {
		const { db } = getPair();
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
		const { backend, db } = getPair();
		return c.json(await jiraTickets(backend, db));
	});
	app.post("/api/jira/logout", async (c) => {
		const { backend, db } = getPair();
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
		const { backend } = getPair();
		return c.json({ user: backend.user, isSetup: backend.user === SETUP_USER });
	});

	// ── 일지 CRUD catch-all ── 도메인 라우트 이후에 매칭되도록 마지막에 등록.
	// /api/day, /api/days, /api/config, /api/tasks, /api/shortcuts, /api/spaces 등 → routeWith.
	app.all("/api/*", async (c) => {
		const method = c.req.method;
		const qi = c.req.url.indexOf("?");
		const path = c.req.path + (qi >= 0 ? c.req.url.slice(qi) : "");
		const body =
			method === "GET" || method === "HEAD"
				? undefined
				: await c.req.json().catch(() => undefined);
		const { backend } = getPair();
		const r = await routeWith(method, path, body, backend);
		return c.json(r.body, r.status as any);
	});

	return app;
}
