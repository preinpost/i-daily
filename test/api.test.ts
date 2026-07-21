// /api/* 라우팅 — 실제 Hono 앱(buildApp)을 app.request()로 두드려 HTTP 경로까지 검증.
import { test, expect } from "./tiny.ts";
import { freshDb } from "./d1.ts";
import { buildApp } from "../src/server/app.ts";
import { d1Backend } from "../src/shared/store-drizzle.ts";
import { parseDoc } from "../src/shared/model.ts";
import type { Hono } from "hono";

const U = "u1";

// 스키마 적용된 D1 → d1Backend → Hono 앱.
async function makeApp(user = U): Promise<Hono> {
	const db = await freshDb();
	return buildApp(d1Backend(db, user), db);
}

// app.request() 로 호출하고 {status, body} 로 정규화(JSON/텍스트 자동 판별).
async function call(
	app: Hono,
	method: string,
	path: string,
	body?: unknown,
): Promise<{ status: number; body: any }> {
	const init: RequestInit = { method, headers: {} };
	if (body !== undefined && method !== "GET" && method !== "HEAD") {
		(init.headers as Record<string, string>)["content-type"] =
			"application/json";
		init.body = JSON.stringify(body);
	}
	const res = await app.request(path, init);
	const ct = res.headers.get("content-type") || "";
	const b = ct.includes("application/json") ? await res.json() : await res.text();
	return { status: res.status, body: b };
}

test("/api/days 초기 빈 목록 + 메타", async () => {
	const app = await makeApp();
	const r = await call(app, "GET", "/api/days");
	expect(r.status).toBe(200);
	expect(r.body.days).toEqual([]);
	expect(typeof r.body.today).toBe("string");
	expect(r.body.user).toBe(U);
});

test("config 최초 firstRun → PUT 저장 → configured", async () => {
	const app = await makeApp();
	const g0 = await call(app, "GET", "/api/config");
	expect(g0.status).toBe(200);
	expect(g0.body.firstRun).toBe(true);
	expect(g0.body.configured).toBe(false);

	const put = await call(app, "PUT", "/api/config", {
		owner: "홍길동",
		jiraBase: "https://jira.test", // host만 — /browse/ 자동
	});
	expect(put.status).toBe(200);
	expect(put.body.configured).toBe(true);

	const g1 = await call(app, "GET", "/api/config");
	expect(g1.body.firstRun).toBe(false);
	expect(g1.body.config.owner).toBe("홍길동");
	expect(g1.body.config.jiraBase).toBe("https://jira.test");

	// config가 렌더링(jiraBase)에 반영되는지 — PUT day 후 teams 출력 확인
	const doc = parseDoc(
		"## 데일리 스크럼\n\n**[금일 진행 업무]**\n  + **[backend]**\n    + [ABC-1](https://x/ABC-1) 작업 (10%, ~7/12)\n- 이슈 사항: 없음\n- 협업 및 기타: 없음",
		"2026-07-10",
	);
	const putDay = await call(app, "PUT", "/api/day/2026-07-10", doc);
	expect(putDay.body.teams).toContain("https://jira.test/browse/ABC-1");
});

test("carry로 생성 → get → 목록 왕복", async () => {
	const app = await makeApp();
	const date = "2026-07-10";
	const c = await call(app, "POST", `/api/day/${date}/carry`);
	expect(c.status).toBe(200);
	expect(c.body.data.date).toBe(date);
	const g = await call(app, "GET", `/api/day/${date}`);
	expect(g.status).toBe(200);
	expect(g.body.data.date).toBe(date);
	const days = await call(app, "GET", "/api/days");
	expect(days.body.days).toEqual([date]);
});

test("없는 날짜 404", async () => {
	const app = await makeApp();
	const r = await call(app, "GET", "/api/day/2000-01-01");
	expect(r.status).toBe(404);
});

test("잘못된 날짜 형식은 라우팅 안 됨 → 404", async () => {
	const app = await makeApp();
	const r = await call(app, "GET", "/api/day/not-a-date");
	expect(r.status).toBe(404);
});

test("shortcuts PUT→GET 왕복", async () => {
	const app = await makeApp();
	const items = [{ name: "Jira", url: "https://x" }];
	const put = await call(app, "PUT", "/api/shortcuts", items);
	expect(put.status).toBe(200);
	const get = await call(app, "GET", "/api/shortcuts");
	expect(get.body).toEqual(items);
});

test("PUT day 저장 후 /api/tasks 쿼리(대소문자 무관)", async () => {
	const app = await makeApp();
	const date = "2026-07-10";
	const doc = parseDoc(
		"## 데일리 스크럼\n\n**[금일 진행 업무]**\n  + **[backend]**\n    + [OPIT-1](https://x/OPIT-1) 배포 (40%, ~7/12)\n- 이슈 사항: 없음\n- 협업 및 기타: 없음",
		date,
	);
	const put = await call(app, "PUT", `/api/day/${date}`, doc);
	expect(put.status).toBe(200);
	const q = await call(app, "GET", "/api/tasks?key=opit&side=today");
	expect(q.body.count).toBe(1);
	expect(q.body.tasks[0].progress).toBe(40);
});

test("prev-daily가 직전 일일 items + block 반환", async () => {
	const app = await makeApp();
	const prev = parseDoc(
		"## 일일 진행 업무\n- [OPIT-9](https://x/OPIT-9) 배포 (70%, ~7/11)\n  - 하위A\n\n## 데일리 스크럼\n\n**[금일 진행 업무]**\n- 이슈 사항: 없음\n- 협업 및 기타: 없음",
		"2026-07-10",
	);
	await call(app, "PUT", "/api/day/2026-07-10", prev);
	const r = await call(app, "GET", "/api/day/2026-07-11/prev-daily");
	expect(r.status).toBe(200);
	expect(r.body.from).toBe("2026-07-10");
	expect(r.body.count).toBe(1);
	expect(r.body.items.length).toBe(1);
	expect(r.body.items[0].key).toBe("OPIT-9");
	expect(r.body.items[0].progress).toBe(70);
	expect(r.body.items[0].subs).toEqual(["하위A"]);
	expect(r.body.block.spaces.length >= 1).toBe(true);
});

test("과거 일지 스페이스 라벨 학습 (/api/spaces · /api/days)", async () => {
	const app = await makeApp();
	const empty = await call(app, "GET", "/api/spaces");
	expect(empty.status).toBe(200);
	expect(empty.body.spaces).toEqual([]);

	const day1 = parseDoc(
		"## 데일리 스크럼\n\n**[금일 진행 업무]**\n  + **[backend]**\n    + [A-1](https://x/A-1) 작업\n  + **[infra]**\n    + [B-1](https://x/B-1) 작업\n- 이슈 사항: 없음\n- 협업 및 기타: 없음",
		"2026-07-10",
	);
	const day2 = parseDoc(
		"## 데일리 스크럼\n\n**[금일 진행 업무]**\n  + **[Backend]**\n    + [A-2](https://x/A-2) 작업\n  + **[qa]**\n    + [C-1](https://x/C-1) 작업\n- 이슈 사항: 없음\n- 협업 및 기타: 없음",
		"2026-07-11",
	);
	await call(app, "PUT", "/api/day/2026-07-10", day1);
	await call(app, "PUT", "/api/day/2026-07-11", day2);

	const sp = await call(app, "GET", "/api/spaces");
	expect(sp.status).toBe(200);
	// 최근 사용순, 대소문자 중복 제거(최근 casing 유지)
	expect(sp.body.spaces).toEqual(["Backend", "qa", "infra"]);

	const days = await call(app, "GET", "/api/days");
	expect(days.body.spaces).toEqual(["Backend", "qa", "infra"]);
});
