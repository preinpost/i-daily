import { test, expect } from "./tiny.ts";
import {
	sqliteStore,
	queryTasks,
	listSpaceLabels,
	createDb,
	readJiraAuth,
	writeJiraAuth,
	clearJiraAuth,
	writeOauthState,
	consumeOauthState,
	writeSession,
	readSession,
	deleteSession,
	hasConfig,
	readConfig,
	writeConfig,
	migrateConfig,
} from "../src/shared/store.ts";
import { SETUP_USER } from "../src/shared/backend.ts";
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

test("oauth_states 왕복 + TTL 만료 + 회수后 삭제", () => {
	const db = freshDb();
	expect(consumeOauthState(db, "none")).toBe(null); // 미등록
	const now = Date.now();
	writeOauthState(db, "s1", {
		redirectUri: "https://x/callback",
		fromUser: SETUP_USER,
		createdAt: now,
	});
	expect(consumeOauthState(db, "other")).toBe(null); // 다른 state
	const got = consumeOauthState(db, "s1");
	expect(got).toEqual({
		redirectUri: "https://x/callback",
		fromUser: SETUP_USER,
		createdAt: now,
	});
	expect(consumeOauthState(db, "s1")).toBe(null); // 회수后 재조회 불가(삭제)

	// 만료(TTL 초과) → null. createdAt 을 과거로 덮어쓰기 위해 직접 삽입.
	db.prepare(
		"INSERT INTO oauth_states(state,payload,created_at) VALUES(?, ?, ?)",
	).run("s2", "{}", new Date(now - 6 * 60_000).toISOString());
	expect(consumeOauthState(db, "s2", 5 * 60_000)).toBe(null);
});

test("sessions 왕복 + 만료 + delete", () => {
	const db = freshDb();
	const future = Date.now() + 86_400_000;
	writeSession(db, "sid1", "acct-1", future);
	expect(readSession(db, "sid1")?.user).toBe("acct-1");
	expect(readSession(db, "other")).toBe(null);
	deleteSession(db, "sid1");
	expect(readSession(db, "sid1")).toBe(null);

	// 만료 세션은 null
	writeSession(db, "sid2", "acct-2", Date.now() - 1000);
	expect(readSession(db, "sid2")).toBe(null);
});

test("migrateConfig: setup → account_id 복사(1회) + 재호출 no-op", () => {
	const db = freshDb();
	expect(hasConfig(db, SETUP_USER)).toBe(false);
	writeConfig(db, SETUP_USER, {
		owner: "홍길동",
		jiraBase: "https://x.atlassian.net",
	});
	expect(hasConfig(db, SETUP_USER)).toBe(true);

	const acct = "5e8b...account-id";
	expect(hasConfig(db, acct)).toBe(false);
	migrateConfig(db, SETUP_USER, acct); // 첫 로그인 복사
	expect(hasConfig(db, acct)).toBe(true);
	expect(readConfig(db, acct).owner).toBe("홍길동");
	expect(readConfig(db, acct).jiraBase).toBe("https://x.atlassian.net");
	expect(readConfig(db, SETUP_USER).owner).toBe("홍길동"); // 원본 유지

	// account_id 에 이미 설정 있으면(재연결) no-op — 덮어쓰지 않음.
	writeConfig(db, SETUP_USER, { owner: "바뀐이름" });
	migrateConfig(db, SETUP_USER, acct);
	expect(readConfig(db, acct).owner).toBe("홍길동");
});
