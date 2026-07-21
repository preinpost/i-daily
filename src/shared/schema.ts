// schema.ts — Drizzle 스키마 (진실의 원천). D1(Cloudflare) 저장소의 테이블 정의.
// drizzle-kit generate 가 이 파일에서 migrations/*.sql 을 생성한다.
import {
	sqliteTable,
	sqliteView,
	text,
	integer,
	primaryKey,
	index,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// days — 하루 메타
export const days = sqliteTable(
	"days",
	{
		user: text("user").notNull(),
		date: text("date").notNull(),
		owner: text("owner").notNull().default(""),
		preamble: text("preamble").notNull().default(""),
		updatedAt: text("updated_at").notNull(),
	},
	(t) => [primaryKey({ columns: [t.user, t.date] })],
);

// sections — 순서 있는 섹션(raw 는 body)
export const sections = sqliteTable(
	"sections",
	{
		user: text("user").notNull(),
		date: text("date").notNull(),
		pos: integer("pos").notNull(),
		kind: text("kind").notNull(),
		title: text("title").notNull(),
		body: text("body").notNull().default(""),
	},
	(t) => [primaryKey({ columns: [t.user, t.date, t.pos] })],
);

// blocks — 스크럼 블록별 이슈/협업
export const blocks = sqliteTable(
	"blocks",
	{
		user: text("user").notNull(),
		date: text("date").notNull(),
		side: text("side").notNull(),
		issues: text("issues").notNull().default("없음"),
		collab: text("collab").notNull().default("없음"),
	},
	(t) => [primaryKey({ columns: [t.user, t.date, t.side] })],
);

// spaces — 스크럼 스페이스(라벨)
export const spaces = sqliteTable(
	"spaces",
	{
		user: text("user").notNull(),
		date: text("date").notNull(),
		side: text("side").notNull(),
		pos: integer("pos").notNull(),
		label: text("label").notNull().default(""),
	},
	(t) => [primaryKey({ columns: [t.user, t.date, t.side, t.pos] })],
);

// tasks — 스크럼 태스크(하위=subs_json)
export const tasks = sqliteTable(
	"tasks",
	{
		user: text("user").notNull(),
		date: text("date").notNull(),
		side: text("side").notNull(),
		spacePos: integer("space_pos").notNull(),
		pos: integer("pos").notNull(),
		jkey: text("jkey").notNull().default(""),
		descr: text("descr").notNull().default(""),
		progress: integer("progress"),
		due: text("due").notNull().default(""),
		subsJson: text("subs_json").notNull().default("[]"),
	},
	(t) => [
		primaryKey({ columns: [t.user, t.date, t.side, t.spacePos, t.pos] }),
		index("idx_tasks_ud").on(t.user, t.date),
		index("idx_tasks_key").on(t.jkey),
	],
);

// list_items — 일일 진행
export const listItems = sqliteTable(
	"list_items",
	{
		user: text("user").notNull(),
		date: text("date").notNull(),
		pos: integer("pos").notNull(),
		done: integer("done").notNull().default(0),
		jkey: text("jkey").notNull().default(""),
		descr: text("descr").notNull().default(""),
		progress: integer("progress"),
		due: text("due").notNull().default(""),
		subsJson: text("subs_json").notNull().default("[]"),
	},
	(t) => [
		primaryKey({ columns: [t.user, t.date, t.pos] }),
		index("idx_items_ud").on(t.user, t.date),
	],
);

// shortcuts — 바로가기
export const shortcuts = sqliteTable(
	"shortcuts",
	{
		user: text("user").notNull(),
		pos: integer("pos").notNull(),
		name: text("name").notNull().default(""),
		url: text("url").notNull().default(""),
	},
	(t) => [primaryKey({ columns: [t.user, t.pos] })],
);

// settings — user별 config JSON 한 행
export const settings = sqliteTable("settings", {
	user: text("user").primaryKey(),
	json: text("json").notNull().default("{}"),
});

// jira_auth — user별 OAuth 토큰 JSON 한 행 (config 와 분리해 렌더러 유출 방지)
export const jiraAuth = sqliteTable("jira_auth", {
	user: text("user").primaryKey(),
	json: text("json").notNull().default("{}"),
});

// oauth_states — OAuth `state`(CSRF) 단기 저장. Workers 멀티인스턴스 대응(in-memory 대체).
// payload=JSON{redirectUri,fromUser,createdAt}. TTL ~5분(조회 시 만료 판정后 삭제).
export const oauthStates = sqliteTable("oauth_states", {
	state: text("state").primaryKey(),
	payload: text("payload").notNull().default("{}"),
	createdAt: text("created_at").notNull(),
});

// sessions — 로그인 세션. httpOnly 쿠키(sid) → user(account_id). D1 저장(Workers 무상태 대응).
export const sessions = sqliteTable("sessions", {
	sid: text("sid").primaryKey(),
	user: text("user").notNull(),
	createdAt: text("created_at").notNull(),
	expiresAt: text("expires_at").notNull(),
});

// task_rows 뷰 — 스크럼 태스크 + 일일 항목 평탄화(빈 행 제외). 파생 쿼리용.
export const taskRows = sqliteView("task_rows", {
	user: text("user").notNull(),
	date: text("date").notNull(),
	side: text("side").notNull(),
	space: text("space").notNull(),
	jkey: text("jkey").notNull(),
	descr: text("descr").notNull(),
	progress: integer("progress"),
	due: text("due").notNull(),
	subsJson: text("subs_json").notNull(),
}).as(sql`
  SELECT t.user AS user, t.date AS date, t.side AS side, sp.label AS space,
         t.jkey AS jkey, t.descr AS descr, t.progress AS progress, t.due AS due, t.subs_json AS subs_json
    FROM tasks t
    JOIN spaces sp ON sp.user = t.user AND sp.date = t.date AND sp.side = t.side AND sp.pos = t.space_pos
   WHERE t.jkey <> '' OR t.descr <> ''
  UNION ALL
  SELECT user, date, 'daily' AS side, '' AS space, jkey, descr, progress, due, subs_json
    FROM list_items
   WHERE jkey <> '' OR descr <> ''
`);
