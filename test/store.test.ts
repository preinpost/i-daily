import { test, expect } from "./tiny.ts";
import {
	sqliteStore,
	queryTasks,
	listSpaceLabels,
	createDb,
	readJiraAuth,
	writeJiraAuth,
	clearJiraAuth,
} from "../src/shared/store.ts";
import { parseDoc } from "../src/shared/model.ts";

const freshDb = () => createDb(); // 스키마는 store.ts SCHEMA와 동일(진실 테이블 + task_rows 뷰)

test("sqliteStore 왕복 + 파생 tasks 쿼리 + 유저 격리", async () => {
	const db = freshDb();
	const store = sqliteStore(db, "u1");
	const doc = parseDoc(
		"## 데일리 스크럼\n\n**[금일 진행 업무]**\n  + **[backend]**\n    + [OPIT-1](https://x/OPIT-1) 배포 (40%, ~7/12)\n- 이슈 사항: 없음\n- 협업 및 기타: 없음",
		"2026-07-10",
	);
	await store.put("2026-07-10", doc);
	expect(await store.list()).toEqual(["2026-07-10"]);
	expect(
		(await store.get("2026-07-10"))!.scrum.today.spaces[0].tasks[0].key,
	).toBe("OPIT-1");

	const rows = queryTasks(db, "u1", { key: "opit" }); // 대소문자 무관
	expect(rows.length).toBe(1);
	expect(rows[0].progress).toBe(40);
	expect(rows[0].side).toBe("today");

	await store.put("2026-07-10", doc); // 재저장 → tasks 중복 없이 재생성
	expect(queryTasks(db, "u1", {}).length).toBe(1);
	expect(queryTasks(db, "u2", {}).length).toBe(0); // 다른 유저는 안 보임
});

test("정규화 왕복: 전체 Doc(subs·이슈/협업·리스트 done·섹션순서) byte-identical", async () => {
	const store = sqliteStore(freshDb(), "u1");
	const md = [
		"머리말 텍스트",
		"",
		"## 일일 진행 업무",
		"- [x] [OPIT-9](u) 완료건",
		"    - 하위메모",
		"- 티켓없는 건",
		"",
		"## 데일리 스크럼",
		"",
		"**[금일 진행 업무]**",
		"  + **[backend]**",
		"    + [OPIT-1](https://x/OPIT-1) 배포 (40%, ~7/12)",
		"        + 서브태스크",
		"- 이슈 사항: 스테이징 접속불가",
		"- 협업 및 기타: QA팀 공유",
		"",
		"## 메모",
		"자유 텍스트 줄글",
	].join("\n");
	const doc = parseDoc(md, "2026-07-10");
	await store.put("2026-07-10", doc);
	const got = (await store.get("2026-07-10"))!;
	expect(JSON.stringify(got)).toBe(JSON.stringify(doc)); // 재조립 완전 동일
	// 정규화 필드가 실제 살아있는지
	expect(got.scrum.today.spaces[0].tasks[0].subs).toEqual(["서브태스크"]);
	expect(got.scrum.today.issues).toBe("스테이징 접속불가");
	const list: any = got.sections.find((s) => s.kind === "list");
	expect(list.items[0].done).toBe(true);
	expect(list.items[0].subs).toEqual(["하위메모"]);
	expect(got.sections.map((s) => s.kind)).toEqual(["list", "scrum", "raw"]);
});

test("shortcuts 유저별 격리 + 순서 보존", async () => {
	const db = freshDb();
	await sqliteStore(db, "u1").putShortcuts([
		{ name: "Jira", url: "https://x" },
		{ name: "Wiki", url: "https://y" },
	]);
	expect(await sqliteStore(db, "u1").getShortcuts()).toEqual([
		{ name: "Jira", url: "https://x" },
		{ name: "Wiki", url: "https://y" },
	]);
	expect(await sqliteStore(db, "u2").getShortcuts()).toEqual([]);
	await sqliteStore(db, "u1").putShortcuts([
		{ name: "Only", url: "https://z" },
	]); // 교체 시 잔여 없음
	expect(await sqliteStore(db, "u1").getShortcuts()).toEqual([
		{ name: "Only", url: "https://z" },
	]);
});

test("listSpaceLabels: 최근 사용순 · 대소문자 중복 제거 · 유저 격리", async () => {
	const db = freshDb();
	const u1 = sqliteStore(db, "u1");
	await u1.put(
		"2026-07-10",
		parseDoc(
			"## 데일리 스크럼\n\n**[금일 진행 업무]**\n  + **[backend]**\n    + [A-1](https://x/A-1) x\n  + **[infra]**\n    + [B-1](https://x/B-1) y\n- 이슈 사항: 없음\n- 협업 및 기타: 없음",
			"2026-07-10",
		),
	);
	await u1.put(
		"2026-07-12",
		parseDoc(
			"## 데일리 스크럼\n\n**[금일 진행 업무]**\n  + **[Backend]**\n    + [A-2](https://x/A-2) z\n- 이슈 사항: 없음\n- 협업 및 기타: 없음",
			"2026-07-12",
		),
	);
	expect(listSpaceLabels(db, "u1")).toEqual(["Backend", "infra"]);
	expect(listSpaceLabels(db, "u2")).toEqual([]);
});

test("jira_auth 왕복 + 유저 격리 + clear", () => {
	const db = freshDb();
	const auth = {
		accessToken: "at",
		refreshToken: "rt",
		expiresAt: 1_700_000_000_000,
		cloudId: "cloud-1",
		siteUrl: "https://x.atlassian.net",
		siteName: "X",
	};
	expect(readJiraAuth(db, "u1")).toBe(null);
	writeJiraAuth(db, "u1", auth);
	expect(readJiraAuth(db, "u1")).toEqual(auth);
	expect(readJiraAuth(db, "u2")).toBe(null); // 유저 격리
	writeJiraAuth(db, "u1", { ...auth, accessToken: "at2" }); // upsert
	expect(readJiraAuth(db, "u1")!.accessToken).toBe("at2");
	clearJiraAuth(db, "u1");
	expect(readJiraAuth(db, "u1")).toBe(null);
});
