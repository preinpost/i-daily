// api.ts — 전송(transport) 무관 라우팅. Electron main의 IPC 핸들러가 호출한다.
// 기존 server.ts의 handle(Request)→Response 를 route(method,path,body,user,db)→{status,body} 로 추출.
// 프런트 client.js의 api(method,path,body) 시그니처를 그대로 받으므로 UI 로직은 무손상.
//
// [방향 B] DB 드라이버를 추상화하기 위해 실제 로직은 routeWith(backend) 에 있다.
// route(user, db) 는 better-sqlite3 를 sqliteBackend 로 감싸 routeWith 를 부르는 얇은 래퍼 —
// 기존 호출처(test·main/index.ts) 시그니처를 무손상 유지. Workers는 routeWith + d1Backend 사용.
import {
	todayStr,
	dayResponse,
	serializeDoc,
	carryNew,
	dailyToBlock,
	setConfig,
	getConfig,
	isConfigured,
	type Doc,
	type ListItem,
} from "./model.ts";
import type { Backend } from "./backend.ts";
import { sqliteBackend } from "./store.ts";

export type ApiResult = { status: number; body: any };
const res = (body: any, status = 200): ApiResult => ({ status, body });

// 하위 호환 래퍼: better-sqlite3 db + user → sqliteBackend → routeWith.
// 기존 route(method,path,body,user,db) 호출처(test·Electron main)를 무손상 유지한다.
export function route(
	method: string,
	rawPath: string,
	body: any,
	user: string,
	db: Parameters<typeof sqliteBackend>[0],
): Promise<ApiResult> {
	return routeWith(method, rawPath, body, sqliteBackend(db, user));
}

// method+path(+쿼리)+body → {status, body}. backend 로 DB 드라이버를 주입받는다.
export async function routeWith(
	method: string,
	rawPath: string,
	body: any,
	backend: Backend,
): Promise<ApiResult> {
	const { user } = backend;
	const store = backend.store;
	const cfg = setConfig(await backend.readConfig()); // 요청마다 DB config 주입 (렌더러들이 getConfig() 사용)
	const u = new URL(rawPath, "http://ipc"); // 쿼리스트링 파싱용 더미 베이스
	const p = u.pathname;

	if (p === "/api/config") {
		if (method === "GET")
			return res({
				config: cfg,
				configured: isConfigured(cfg),
				firstRun: !(await backend.hasConfig()),
			});
		if (method === "PUT") {
			const saved = await backend.writeConfig(body || {});
			setConfig(saved);
			return res({ config: saved, configured: isConfigured(saved) });
		}
	}

	if (method === "GET" && p === "/api/days") {
		return res({
			days: await store.list(),
			today: todayStr(),
			user,
			owner: cfg.owner,
			jiraBase: cfg.jiraBase,
			config: cfg,
			configured: isConfigured(cfg),
			firstRun: !(await backend.hasConfig()),
			spaces: await backend.listSpaceLabels(),
		});
	}
	// 과거 일지에서 학습한 스페이스 라벨 (자동완성 후보)
	if (method === "GET" && p === "/api/spaces") {
		return res({ spaces: await backend.listSpaceLabels() });
	}
	if (method === "GET" && p === "/api/tasks") {
		const q = u.searchParams;
		const rows = await backend.queryTasks({
			from: q.get("from") || undefined,
			to: q.get("to") || undefined,
			side: q.get("side") || undefined,
			key: q.get("key") || undefined,
		});
		return res({ tasks: rows, count: rows.length });
	}
	if (p === "/api/shortcuts") {
		if (method === "GET") return res(await store.getShortcuts());
		if (method === "PUT") {
			const items = Array.isArray(body) ? body : [];
			await store.putShortcuts(items);
			return res(items);
		}
	}

	const md = p.match(/^\/api\/day\/(\d{4}-\d{2}-\d{2})$/);
	if (md) {
		const date = md[1];
		if (method === "GET") {
			const d = await store.get(date);
			return d ? res(dayResponse(d)) : res({ error: "not found", date }, 404);
		}
		if (method === "PUT") {
			const doc = body as Doc;
			doc.date = date;
			doc.owner ??= getConfig().owner;
			await store.put(date, doc);
			return res(dayResponse(doc));
		}
	}

	const mdown = p.match(/^\/api\/day\/(\d{4}-\d{2}-\d{2})\/markdown$/);
	if (mdown && method === "GET") {
		const d = await store.get(mdown[1]);
		return res(d ? serializeDoc(d) : "");
	}

	const mp = p.match(/^\/api\/day\/(\d{4}-\d{2}-\d{2})\/prev-daily$/);
	if (mp && method === "GET") {
		const earlier = (await store.list()).filter((d) => d < mp[1]);
		const prev = earlier.length ? earlier[earlier.length - 1] : null;
		if (!prev) return res({ block: null, items: [], from: null, count: 0 });
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
		// block = 전일 스크럼용, items = 일일 진행 가져오기용
		return res({ block: dailyToBlock(items), items, from: prev, count });
	}

	const mc = p.match(/^\/api\/day\/(\d{4}-\d{2}-\d{2})\/carry$/);
	if (mc && method === "POST") {
		const doc = await carryNew(store, mc[1]);
		await store.put(mc[1], doc);
		return res(dayResponse(doc));
	}

	return res({ error: "not found", path: p }, 404);
}
