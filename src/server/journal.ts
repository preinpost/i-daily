// journal.ts — 일지 CRUD + config/tasks/shortcuts 를 Hono 네이티브 라우트로.
// buildApp 이 app.route("/api", journalRoutes(backend)) 로 마운트한다.
// config(jiraBase/owner)는 요청별 미들웨어가 c.set("config") 로 담고(전역 아님 →
// Worker 동시성 안전), 핸들러가 c.get("config") 로 읽어 렌더 함수에 인자로 넘긴다.
import { Hono } from "hono";
import type { Backend } from "../shared/backend.ts";
import { SETUP_USER } from "../shared/backend.ts";
import {
	todayStr,
	dayResponse,
	serializeDoc,
	carryNew,
	dailyToBlock,
	isConfigured,
	type Config,
	type Doc,
	type ListItem,
} from "../shared/model.ts";

// YYYY-MM-DD 만 매칭하는 date 파라미터(형식 불일치 URL 은 라우팅 자체가 안 됨 → notFound).
const DATE = "/day/:date{\\d{4}-\\d{2}-\\d{2}}";

type Vars = { config: Config };

export function journalRoutes(backend: Backend): Hono<{ Variables: Vars }> {
	const store = backend.store;
	const app = new Hono<{ Variables: Vars }>();

	// 요청마다 DB config 를 Context 에 주입(요청별 격리). 렌더러는 c.get("config") 로 읽는다.
	app.use("*", async (c, next) => {
		c.set("config", await backend.readConfig());
		await next();
	});

	app
		.get("/config", async (c) => {
			const cfg = c.get("config");
			return c.json({
				config: cfg,
				configured: isConfigured(cfg),
				firstRun: !(await backend.hasConfig()),
			});
		})
		.put("/config", async (c) => {
			const body = await c.req.json().catch(() => ({}));
			const saved = await backend.writeConfig(body || {});
			return c.json({ config: saved, configured: isConfigured(saved) });
		});

	app.get("/days", async (c) => {
		const cfg = c.get("config");
		return c.json({
			days: await store.list(),
			today: todayStr(),
			user: backend.user,
			isSetup: backend.user === SETUP_USER, // 미로그인 → 전체화면 로그인 게이트
			owner: cfg.owner,
			jiraBase: cfg.jiraBase,
			config: cfg,
			configured: isConfigured(cfg),
			firstRun: !(await backend.hasConfig()),
			spaces: await backend.listSpaceLabels(),
		});
	});

	// 과거 일지에서 학습한 스페이스 라벨(자동완성 후보).
	app.get("/spaces", async (c) =>
		c.json({ spaces: await backend.listSpaceLabels() }),
	);

	app.get("/tasks", async (c) => {
		const rows = await backend.queryTasks({
			from: c.req.query("from") || undefined,
			to: c.req.query("to") || undefined,
			side: c.req.query("side") || undefined,
			key: c.req.query("key") || undefined,
		});
		return c.json({ tasks: rows, count: rows.length });
	});

	app
		.get("/shortcuts", async (c) => c.json(await store.getShortcuts()))
		.put("/shortcuts", async (c) => {
			const body = await c.req.json().catch(() => undefined);
			const items = Array.isArray(body) ? body : [];
			await store.putShortcuts(items);
			return c.json(items);
		});

	app
		.get(DATE, async (c) => {
			const date = c.req.param("date");
			const d = await store.get(date);
			return d
				? c.json(dayResponse(c.get("config").jiraBase, d))
				: c.json({ error: "not found", date }, 404);
		})
		.put(DATE, async (c) => {
			const cfg = c.get("config");
			const date = c.req.param("date");
			const doc = (await c.req.json().catch(() => ({}))) as Doc;
			doc.date = date;
			doc.owner ??= cfg.owner;
			await store.put(date, doc);
			return c.json(dayResponse(cfg.jiraBase, doc));
		});

	app.get(`${DATE}/markdown`, async (c) => {
		const d = await store.get(c.req.param("date"));
		return c.text(d ? serializeDoc(c.get("config").jiraBase, d) : "");
	});

	// prev-daily: 직전 근무일의 일일 진행 → 전일 스크럼 블록(block) + 가져오기용 items.
	app.get(`${DATE}/prev-daily`, async (c) => {
		const date = c.req.param("date");
		const earlier = (await store.list()).filter((d) => d < date);
		const prev = earlier.length ? earlier[earlier.length - 1] : null;
		if (!prev) return c.json({ block: null, items: [], from: null, count: 0 });
		const pdoc = await store.get(prev);
		const listSec: any = pdoc?.sections.find((s) => s.kind === "list");
		const items: ListItem[] = (listSec?.items ?? []).map((it: ListItem) => ({
			done: !!it.done,
			key: it.key || "",
			desc: it.desc || "",
			progress: it.progress ?? "",
			due: it.due || "",
			subs: (it.subs || []).slice(),
		}));
		const count = items.filter(
			(it) => (it.key || "").trim() || (it.desc || "").trim(),
		).length;
		return c.json({ block: dailyToBlock(items), items, from: prev, count });
	});

	app.post(`${DATE}/carry`, async (c) => {
		const cfg = c.get("config");
		const date = c.req.param("date");
		const doc = await carryNew(store, date, cfg.owner);
		await store.put(date, doc);
		return c.json(dayResponse(cfg.jiraBase, doc));
	});

	return app;
}
