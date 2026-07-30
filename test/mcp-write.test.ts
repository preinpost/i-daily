// MCP write 흐름 — create_day / add_daily_task / put_day_markdown 과 동일 로직을 D1 로 검증.
import { test, expect } from "./tiny.ts";
import { freshDb } from "./d1.ts";
import { d1Backend } from "../src/shared/store-drizzle.ts";
import {
	carryNew,
	parseDoc,
	appendDailyTasks,
	dailyItemsOf,
	serializeDoc,
} from "../src/shared/model.ts";

const U = "mcp-user";

test("create_day: carry 생성 · exists 시 force 없으면 유지 · force 시 덮어쓰기", async () => {
	const backend = d1Backend(await freshDb(), U);
	await backend.writeConfig({ owner: "홍길동", jiraBase: "https://jira.test" });
	const d = "2026-07-10";

	const doc1 = await carryNew(backend.store, d, "홍길동");
	await backend.store.put(d, doc1);
	expect(await backend.store.list()).toEqual([d]);

	const existing = await backend.store.get(d);
	expect(existing == null).toBe(false);

	// force 없음 → 기존 유지(도구의 status:exists 분기)
	const again = await backend.store.get(d);
	expect(again!.date).toBe(d);

	// force → carry 재생성
	const overwritten = await carryNew(backend.store, d, "홍길동");
	await backend.store.put(d, overwritten);
	expect((await backend.store.get(d))!.owner).toBe("홍길동");
});

test("add_daily_task: 없는 날 carry 생성 후 구조화 항목 추가", async () => {
	const backend = d1Backend(await freshDb(), U);
	await backend.writeConfig({ owner: "홍길동", jiraBase: "https://jira.test" });
	const d = "2026-07-11";

	let doc = await backend.store.get(d);
	expect(doc).toBe(null);
	doc = await carryNew(backend.store, d, "홍길동");
	const added = appendDailyTasks(doc, [
		{
			done: false,
			key: "QAOP-1",
			desc: "필드 추가",
			progress: 10,
			due: "2026-07-20",
			subs: ["세부"],
			space: "qa",
		},
		{
			done: false,
			key: "",
			desc: "코드 리뷰",
			progress: "",
			due: "",
			subs: [],
			space: "qa",
		},
	]);
	await backend.store.put(d, doc);

	const got = await backend.store.get(d);
	expect(added.length).toBe(2);
	expect(dailyItemsOf(got!).map((x) => x.key)).toEqual(["QAOP-1", ""]);
	expect(dailyItemsOf(got!)[0].space).toBe("qa");
	expect(dailyItemsOf(got!)[0].progress).toBe(10);
	expect(dailyItemsOf(got!)[0].subs).toEqual(["세부"]);
});

test("put_day_markdown: 마크다운 저장 후 get 왕복", async () => {
	const backend = d1Backend(await freshDb(), U);
	await backend.writeConfig({ owner: "홍길동", jiraBase: "https://jira.test" });
	const d = "2026-07-12";
	const md = [
		"## 일일 진행 업무",
		"",
		"- [OPIT-9](https://x/OPIT-9) 배포 (50%, ~7/15)",
		"",
		"## 데일리 스크럼",
		"",
		"**[금일 진행 업무]**",
		"- 업무 계획",
		"- 이슈 사항: 없음",
		"- 협업 및 기타: 없음",
		"",
		"## 메모",
		"",
		"hello",
	].join("\n");
	const doc = parseDoc(md, d, "홍길동");
	await backend.store.put(d, doc);
	const got = await backend.store.get(d);
	expect(got!.sections.find((s) => s.kind === "raw")!.body).toContain("hello");
	expect(dailyItemsOf(got!)[0].key).toBe("OPIT-9");
	const round = serializeDoc("https://jira.test", got!);
	expect(round).toContain("OPIT-9");
	expect(round).toContain("hello");
});

test("generate_weekly_report: from/to 집계 · thisWeek/nextWeek", async () => {
	const backend = d1Backend(await freshDb(), U);
	await backend.writeConfig({ owner: "홍길동", jiraBase: "https://jira.test" });
	const d = "2026-07-28"; // 화
	const doc = await carryNew(backend.store, d, "홍길동");
	appendDailyTasks(doc, [
		{
			done: false,
			key: "OPIT-1",
			desc: "배포",
			progress: 50,
			due: "2026-07-31",
			subs: [],
			space: "backend",
		},
	]);
	await backend.store.put(d, doc);

	const { generateReport } = await import("../src/server/agent.ts");
	const r = await generateReport(backend, {
		from: "2026-07-24",
		to: "2026-07-30",
	});
	expect(r.ok).toBe(true);
	expect(r.from).toBe("2026-07-24");
	expect(r.to).toBe("2026-07-30");
	expect(r.count).toBe(1);
	expect(r.text).toContain("OPIT-1");
	expect(r.thisWeek).toContain("OPIT-1");
	expect(r.usedAgent).toBe(null);
});

test("weekly_reports: put → list → get → delete 왕복", async () => {
	const db = await freshDb();
	const {
		putWeeklyReport,
		listWeeklyReports,
		getWeeklyReport,
		deleteWeeklyReport,
	} = await import("../src/shared/store-drizzle.ts");
	const { composeWeeklyReportText } = await import("../src/shared/report.ts");

	const saved = await putWeeklyReport(db, U, {
		from: "2026-07-24",
		to: "2026-07-30",
		thisWeek: "[기타]\nㅇ[QAOP-1] a (~7/28)",
		nextWeek: "[기타]\nㅇ[QAOP-1] a (~7/28)",
	});
	expect(saved.from).toBe("2026-07-24");

	const list = await listWeeklyReports(db, U);
	expect(list.length).toBe(1);
	expect(list[0].from).toBe("2026-07-24");

	const got = await getWeeklyReport(db, U, "2026-07-24", "2026-07-30");
	expect(got!.thisWeek).toContain("QAOP-1");
	expect(composeWeeklyReportText(got!.thisWeek, got!.nextWeek)).toContain(
		"금주 업무 내용",
	);

	// upsert
	await putWeeklyReport(db, U, {
		from: "2026-07-24",
		to: "2026-07-30",
		thisWeek: "updated",
		nextWeek: "",
	});
	expect(
		(await getWeeklyReport(db, U, "2026-07-24", "2026-07-30"))!.thisWeek,
	).toBe("updated");

	expect(await deleteWeeklyReport(db, U, "2026-07-24", "2026-07-30")).toBe(
		true,
	);
	expect(await getWeeklyReport(db, U, "2026-07-24", "2026-07-30")).toBe(null);
});
