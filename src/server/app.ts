// server/app.ts — Hono 앱 (Cloudflare Workers).
// 일지 CRUD 는 journalRoutes 를 app.route("/api", ...) 로 마운트; 도메인
// 라우트(jira/agent/me)는 부모 app 에 직접 등록. 모두 Hono 네이티브 매칭.
// 인증: 세션(sid 쿠키 → sessions D1) 기반. 미로그인 시 user=SETUP("setup").
import { Hono } from "hono";
import type { Backend } from "../shared/backend.ts";
import { SETUP_USER } from "../shared/backend.ts";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { journalRoutes } from "./journal.ts";
import { generateReport } from "./agent.ts";
import {
	listWeeklyReports,
	getWeeklyReport,
	putWeeklyReport,
	deleteWeeklyReport,
} from "../shared/store-drizzle.ts";
import { composeWeeklyReportText, splitDigestText } from "../shared/report.ts";
import {
	jiraStatus,
	jiraTickets,
	jiraSetDue,
	jiraTransitions,
	jiraTransition,
	jiraLogout,
} from "./jira.ts";
import {
	microsoftStatus,
	microsoftDisconnect,
	microsoftGraphProxy,
} from "./microsoft.ts";
import type { AppAuth } from "../auth/index.ts";
import {
	serializeDoc,
	datesInRange,
	composeExportMarkdown,
	composeExportJson,
	type ExportDay,
} from "../shared/model.ts";

type DB = DrizzleD1Database;

/** Microsoft Graph 등 auth/env 가 필요한 라우트용(테스트에서는 생략 가능). */
export type AppAuthDeps = {
	env: Env;
	auth: AppAuth;
};

// 워커 엔트리가 요청마다 새 앱을 만들어 (이미 인증된) backend 와 db 를 직접 건네준다.
// 도메인 라우트(jira)는 토큰 저장을 위해 Drizzle db 도 함께 받는다.
export function buildApp(
	backend: Backend,
	db: DB,
	authDeps?: AppAuthDeps,
): Hono {
	const app = new Hono();

	// ── 주간보고 ── 결정적 집계.
	app.post("/api/agent/generate", async (c) => {
		const opts = await c.req.json().catch(() => ({}));
		const r = await generateReport(backend, opts);
		return c.json(r);
	});

	// ── 주간보고 스냅샷 ── 기간별 저장본(오른쪽 목록 · MCP save).
	const YMD = /^\d{4}-\d{2}-\d{2}$/;
	app.get("/api/weekly-reports", async (c) => {
		const items = await listWeeklyReports(db, backend.user);
		return c.json({ reports: items });
	});
	app.get("/api/weekly-reports/:from/:to", async (c) => {
		const from = c.req.param("from");
		const to = c.req.param("to");
		if (!YMD.test(from) || !YMD.test(to)) {
			return c.json({ error: "invalid date" }, 400);
		}
		const row = await getWeeklyReport(db, backend.user, from, to);
		if (!row) return c.json({ error: "not found", from, to }, 404);
		return c.json({
			...row,
			text: composeWeeklyReportText(row.thisWeek, row.nextWeek),
		});
	});
	app.put("/api/weekly-reports", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as {
			from?: string;
			to?: string;
			thisWeek?: string;
			nextWeek?: string;
			text?: string;
		};
		const from = String(body.from || "").trim();
		const to = String(body.to || "").trim();
		if (!YMD.test(from) || !YMD.test(to) || from > to) {
			return c.json({ ok: false, error: "from/to YYYY-MM-DD 필요" }, 400);
		}
		let thisWeek = String(body.thisWeek ?? "");
		let nextWeek = String(body.nextWeek ?? "");
		// text 만 오면 금주/차주로 분할
		if (body.text != null && body.thisWeek == null && body.nextWeek == null) {
			const parts = splitDigestText(String(body.text));
			thisWeek = parts.thisWeek;
			nextWeek = parts.nextWeek;
		}
		const saved = await putWeeklyReport(db, backend.user, {
			from,
			to,
			thisWeek,
			nextWeek,
		});
		return c.json({
			ok: true,
			...saved,
			text: composeWeeklyReportText(saved.thisWeek, saved.nextWeek),
		});
	});
	app.delete("/api/weekly-reports/:from/:to", async (c) => {
		const from = c.req.param("from");
		const to = c.req.param("to");
		if (!YMD.test(from) || !YMD.test(to)) {
			return c.json({ ok: false, error: "invalid date" }, 400);
		}
		const ok = await deleteWeeklyReport(db, backend.user, from, to);
		return c.json({ ok }, ok ? 200 : 404);
	});

	// ── 업무일지 내보내기 ── 기간(from~to, 포함) 내 일지를 md|json 으로 조립.
	app.get("/api/export", async (c) => {
		const from = (c.req.query("from") || "").trim();
		const to = (c.req.query("to") || "").trim();
		const fmt = (c.req.query("format") || "md").toLowerCase();
		if (!YMD.test(from) || !YMD.test(to) || from > to) {
			return c.json(
				{ ok: false, error: "from/to YYYY-MM-DD 필요(from<=to)" },
				400,
			);
		}
		if (fmt !== "md" && fmt !== "json") {
			return c.json({ ok: false, error: "format=md|json" }, 400);
		}
		const allDates = await backend.store.list();
		const dates = datesInRange(allDates, from, to);
		const cfg = await backend.readConfig();
		const days: ExportDay[] = [];
		for (const date of dates) {
			const doc = await backend.store.get(date);
			days.push({
				date,
				doc,
				markdown: doc ? serializeDoc(cfg.jiraBase, doc) : "",
			});
		}
		if (!days.length) {
			return c.json({ ok: true, count: 0, from, to, days: [] });
		}
		const filename = `i-daily_${from}_${to}.${fmt}`;
		const safeName =
			/^[A-Za-z0-9._-]+$/.test(filename) ? filename : "export.txt";
		if (fmt === "md") {
			const body = composeExportMarkdown(cfg.jiraBase, from, to, days);
			c.header("Content-Type", "text/markdown; charset=utf-8");
			c.header(
				"Content-Disposition",
				`attachment; filename="${safeName}"`,
			);
			return c.body(body);
		}
		const body = JSON.stringify(composeExportJson(from, to, days), null, 2);
		c.header("Content-Type", "application/json; charset=utf-8");
		c.header(
			"Content-Disposition",
			`attachment; filename="${safeName}"`,
		);
		return c.body(body);
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

	// ── Microsoft Graph (보조 연결 — 로그인 대체 아님) ──
	// 연결 시작은 클라이언트가 /api/auth/link-social { provider:"microsoft" }.
	app.get("/api/microsoft/status", async (c) => {
		if (!authDeps) {
			return c.json({ configured: false, connected: false });
		}
		return c.json(
			await microsoftStatus(authDeps.env, authDeps.auth, c.req.raw),
		);
	});
	app.post("/api/microsoft/disconnect", async (c) => {
		if (!authDeps) {
			return c.json({ ok: false, error: "auth unavailable" }, 503);
		}
		return c.json(
			await microsoftDisconnect(authDeps.env, authDeps.auth, c.req.raw),
		);
	});
	// Graph 테스트/실험 프록시 — graph.microsoft.com 만.
	app.post("/api/microsoft/graph", async (c) => {
		if (!authDeps) {
			return c.json({ ok: false, status: 503, body: null, error: "auth unavailable" }, 503);
		}
		const b = (await c.req.json().catch(() => ({}))) as {
			method?: string;
			path?: string;
			body?: unknown;
			headers?: Record<string, string>;
		};
		const r = await microsoftGraphProxy(authDeps.auth, c.req.raw, b);
		return c.json(r, (r.status >= 400 && r.status < 600 ? r.status : 200) as 200);
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
