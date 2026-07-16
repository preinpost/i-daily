// route() — IPC가 호출하는 전송 무관 라우팅. 기존 server.ts handle()에서 추출한 신규 코드라 커버.
import { test, expect } from "./tiny.ts";
import { createDb } from "../src/shared/store.ts";
import { route } from "../src/shared/api.ts";
import { parseDoc } from "../src/shared/model.ts";

const U = "u1";
const db = () => createDb();

test("route: /api/days 초기 빈 목록 + 메타", async () => {
	const r = await route("GET", "/api/days", undefined, U, db());
	expect(r.status).toBe(200);
	expect(r.body.days).toEqual([]);
	expect(typeof r.body.today).toBe("string");
	expect(r.body.user).toBe(U);
});

test("route: config 최초 firstRun → PUT 저장 → configured", async () => {
	const d = db();
	const g0 = await route("GET", "/api/config", undefined, U, d);
	expect(g0.status).toBe(200);
	expect(g0.body.firstRun).toBe(true);
	expect(g0.body.configured).toBe(false);

	const put = await route(
		"PUT",
		"/api/config",
		{
			owner: "홍길동",
			jiraBase: "https://jira.test", // host만 — /browse/ 자동
		},
		U,
		d,
	);
	expect(put.status).toBe(200);
	expect(put.body.configured).toBe(true);

	const g1 = await route("GET", "/api/config", undefined, U, d);
	expect(g1.body.firstRun).toBe(false);
	expect(g1.body.config.owner).toBe("홍길동");
	expect(g1.body.config.jiraBase).toBe("https://jira.test");

	// config가 렌더링(jiraBase)에 반영되는지 — PUT day 후 teams 출력 확인
	const doc = parseDoc(
		"## 데일리 스크럼\n\n**[금일 진행 업무]**\n  + **[backend]**\n    + [ABC-1](https://x/ABC-1) 작업 (10%, ~7/12)\n- 이슈 사항: 없음\n- 협업 및 기타: 없음",
		"2026-07-10",
	);
	const putDay = await route("PUT", "/api/day/2026-07-10", doc, U, d);
	expect(putDay.body.teams).toContain("https://jira.test/browse/ABC-1");
});

test("route: carry로 생성 → get → 목록 왕복", async () => {
	const d = db();
	const date = "2026-07-10";
	const c = await route("POST", `/api/day/${date}/carry`, undefined, U, d);
	expect(c.status).toBe(200);
	expect(c.body.data.date).toBe(date);
	const g = await route("GET", `/api/day/${date}`, undefined, U, d);
	expect(g.status).toBe(200);
	expect(g.body.data.date).toBe(date);
	const days = await route("GET", "/api/days", undefined, U, d);
	expect(days.body.days).toEqual([date]);
});

test("route: 없는 날짜 404", async () => {
	const r = await route("GET", "/api/day/2000-01-01", undefined, U, db());
	expect(r.status).toBe(404);
});

test("route: shortcuts PUT→GET 왕복", async () => {
	const d = db();
	const items = [{ name: "Jira", url: "https://x" }];
	const put = await route("PUT", "/api/shortcuts", items, U, d);
	expect(put.status).toBe(200);
	const get = await route("GET", "/api/shortcuts", undefined, U, d);
	expect(get.body).toEqual(items);
});

test("route: PUT day 저장 후 /api/tasks 쿼리(대소문자 무관)", async () => {
	const d = db();
	const date = "2026-07-10";
	const doc = parseDoc(
		"## 데일리 스크럼\n\n**[금일 진행 업무]**\n  + **[backend]**\n    + [OPIT-1](https://x/OPIT-1) 배포 (40%, ~7/12)\n- 이슈 사항: 없음\n- 협업 및 기타: 없음",
		date,
	);
	const put = await route("PUT", `/api/day/${date}`, doc, U, d);
	expect(put.status).toBe(200);
	const q = await route(
		"GET",
		"/api/tasks?key=opit&side=today",
		undefined,
		U,
		d,
	);
	expect(q.body.count).toBe(1);
	expect(q.body.tasks[0].progress).toBe(40);
});

test("route: prev-daily가 직전 일일 items + block 반환", async () => {
	const d = db();
	const prev = parseDoc(
		"## 일일 진행 업무\n- [OPIT-9](https://x/OPIT-9) 배포 (70%, ~7/11)\n  - 하위A\n\n## 데일리 스크럼\n\n**[금일 진행 업무]**\n- 이슈 사항: 없음\n- 협업 및 기타: 없음",
		"2026-07-10",
	);
	await route("PUT", "/api/day/2026-07-10", prev, U, d);
	const r = await route(
		"GET",
		"/api/day/2026-07-11/prev-daily",
		undefined,
		U,
		d,
	);
	expect(r.status).toBe(200);
	expect(r.body.from).toBe("2026-07-10");
	expect(r.body.count).toBe(1);
	expect(r.body.items.length).toBe(1);
	expect(r.body.items[0].key).toBe("OPIT-9");
	expect(r.body.items[0].progress).toBe(70);
	expect(r.body.items[0].subs).toEqual(["하위A"]);
	expect(r.body.block.spaces.length >= 1).toBe(true);
});

test("route: 과거 일지 스페이스 라벨 학습 (/api/spaces · /api/days)", async () => {
	const d = db();
	const empty = await route("GET", "/api/spaces", undefined, U, d);
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
	await route("PUT", "/api/day/2026-07-10", day1, U, d);
	await route("PUT", "/api/day/2026-07-11", day2, U, d);

	const sp = await route("GET", "/api/spaces", undefined, U, d);
	expect(sp.status).toBe(200);
	// 최근 사용순, 대소문자 중복 제거(최근 casing 유지)
	expect(sp.body.spaces).toEqual(["Backend", "qa", "infra"]);

	const days = await route("GET", "/api/days", undefined, U, d);
	expect(days.body.spaces).toEqual(["Backend", "qa", "infra"]);
});
