// server/app.ts — Hono 앱 (Cloudflare Workers).
// shared/api.ts 의 routeWith(method,path,body,backend) 에 Backend provider 를 주입받는다.
// 도메인 라우트(jira/lunch/agent) 는 기존 IPC 채널을 대체.
// 인증은 아직 없음 → getBackend() 가 임시 유저를 준다.
import { Hono, type Context } from "hono";
import type { Backend } from "../shared/backend.ts";
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
		const { backend, db } = getPair();
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
		const html = await jiraCallback(backend, db, originOf(c), code, state, err);
		return c.html(
			`<!doctype html><meta charset=utf-8><body style="font-family:system-ui,sans-serif;padding:48px;text-align:center;color:#222"><h2>${html}</h2><p>이 창을 닫고 i-daily 로 돌아가세요.</p></body>`,
		);
	});
	app.get("/api/jira/tickets", async (c) => {
		const { backend, db } = getPair();
		return c.json(await jiraTickets(backend, db));
	});
	app.post("/api/jira/logout", async (c) => {
		const { backend, db } = getPair();
		return c.json(await jiraLogout(backend, db));
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
