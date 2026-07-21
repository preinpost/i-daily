// /api/* 라우팅 — 실제 Hono 앱(buildApp)을 app.request()로 두드려 HTTP 경로까지 검증.
import { test, expect } from "./tiny.ts";
import { freshDb } from "./d1.ts";
import { buildApp } from "../src/server/app.ts";
import { d1Backend } from "../src/shared/store-drizzle.ts";
import { parseDoc } from "../src/shared/model.ts";
import type { Hono } from "hono";

const U = "u1";

// 스키마 적용된 D1 → d1Backend → Hono 앱.
// 테스트용 최소 Env(AI_ENC_KEY 는 32바이트 base64). 나머지 바인딩은 미사용.
const TEST_ENV = {
	AI_ENC_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
} as unknown as Env;

async function makeApp(user = U): Promise<Hono> {
	const db = await freshDb();
	return buildApp(d1Backend(db, user), db, TEST_ENV);
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

test("AI BYOK: status 초기 → 키 저장(암호문만) → status hasKey → 삭제", async () => {
	const app = await makeApp();

	// 초기: 키 없음, provider 목록·encReady 노출.
	const s0 = await call(app, "GET", "/api/ai/status");
	expect(s0.status).toBe(200);
	expect(s0.body.hasKey).toBe(false);
	expect(s0.body.encReady).toBe(true);
	expect(Array.isArray(s0.body.providers)).toBe(true);
	expect(s0.body.providers.some((p: any) => p.id === "anthropic")).toBe(true);

	// provider·apiKey 누락 → 400.
	const bad = await call(app, "PUT", "/api/ai/key", { provider: "anthropic" });
	expect(bad.status).toBe(400);

	// 미지원 provider → 400.
	const bad2 = await call(app, "PUT", "/api/ai/key", {
		provider: "nope",
		apiKey: "x",
	});
	expect(bad2.status).toBe(400);

	// 정상 저장 → config 에 provider/model 반영, 응답에 평문 키 없음.
	const put = await call(app, "PUT", "/api/ai/key", {
		provider: "anthropic",
		model: "claude-haiku-4-5",
		apiKey: "sk-ant-secret-XYZ",
	});
	expect(put.status).toBe(200);
	expect(put.body.ok).toBe(true);
	expect(JSON.stringify(put.body).includes("sk-ant-secret-XYZ")).toBe(false);

	// status: hasKey=true, provider/model 노출(키 평문은 없음).
	const s1 = await call(app, "GET", "/api/ai/status");
	expect(s1.body.hasKey).toBe(true);
	expect(s1.body.provider).toBe("anthropic");
	expect(s1.body.model).toBe("claude-haiku-4-5");
	expect(JSON.stringify(s1.body).includes("sk-ant-secret-XYZ")).toBe(false);

	// config 로도 평문 키가 새지 않음.
	const cfg = await call(app, "GET", "/api/config");
	expect(JSON.stringify(cfg.body).includes("sk-ant-secret-XYZ")).toBe(false);
	expect(cfg.body.config.reportProvider).toBe("anthropic");

	// 삭제 → hasKey=false, config provider 비움.
	const del = await call(app, "DELETE", "/api/ai/key");
	expect(del.status).toBe(200);
	const s2 = await call(app, "GET", "/api/ai/status");
	expect(s2.body.hasKey).toBe(false);
	expect(s2.body.provider).toBe("");
});

test("config 부분 갱신: 다른 필드 보존(AI 설정 ↔ 일반 설정 서로 안 지움)", async () => {
	const app = await makeApp();

	// 1) owner/jiraBase 저장.
	await call(app, "PUT", "/api/config", {
		owner: "홍길동",
		jiraBase: "https://jira.test",
	});

	// 2) AI 키 저장(provider/model) → owner/jiraBase 가 날아가면 안 됨.
	await call(app, "PUT", "/api/ai/key", {
		provider: "anthropic",
		model: "claude-haiku-4-5",
		apiKey: "sk-ant-xyz",
	});
	const c1 = await call(app, "GET", "/api/config");
	expect(c1.body.config.owner).toBe("홍길동");
	expect(c1.body.config.reportProvider).toBe("anthropic");
	expect(c1.body.config.reportModel).toBe("claude-haiku-4-5");

	// 3) 일반 설정 저장(lunch 만 전송) → AI provider/model 이 초기화되면 안 됨.
	await call(app, "PUT", "/api/config", {
		owner: "홍길동",
		jiraBase: "https://jira.test",
		lunchRadius: "1500",
	});
	const c2 = await call(app, "GET", "/api/config");
	expect(c2.body.config.lunchRadius).toBe("1500");
	expect(c2.body.config.reportProvider).toBe("anthropic");
	expect(c2.body.config.reportModel).toBe("claude-haiku-4-5");
});

test("AI BYOK: custom endpoint 검증(baseUrl 필수·https) — 네트워크 없이", async () => {
	const app = await makeApp();

	// providers 에 custom 존재 + custom 플래그.
	const s = await call(app, "GET", "/api/ai/status");
	const custom = s.body.providers.find((p: any) => p.id === "custom");
	expect(custom?.custom).toBe(true);

	// custom 인데 baseUrl 없음 → 400.
	const noBase = await call(app, "PUT", "/api/ai/key", {
		provider: "custom",
		apiKey: "k",
	});
	expect(noBase.status).toBe(400);

	// custom + http(비https) → 400.
	const httpBase = await call(app, "PUT", "/api/ai/key", {
		provider: "custom",
		apiKey: "k",
		baseUrl: "http://insecure.example/v1",
	});
	expect(httpBase.status).toBe(400);

	// /api/ai/test: 키 누락 → 400 (네트워크 미접촉).
	const testNoKey = await call(app, "POST", "/api/ai/test", {
		provider: "openai",
	});
	expect(testNoKey.status).toBe(400);

	// /api/ai/test: custom + baseUrl 없음 → 400.
	const testNoBase = await call(app, "POST", "/api/ai/test", {
		provider: "custom",
		apiKey: "k",
	});
	expect(testNoBase.status).toBe(400);
});
