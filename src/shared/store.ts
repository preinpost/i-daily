// store.ts — 저장소. 진실=정규화 테이블(better-sqlite3).
// days.doc JSON blob은 폐기 → 하루치 Doc은 days/sections/blocks/spaces/tasks/list_items 행으로 왕복.
import Database from "better-sqlite3";
import {
  docToRows, rowsToDoc, mergeConfig,
  type Store, type Doc, type DocRows, type TaskRow, type TaskFilter, type Shortcut, type Config,
} from "./model.ts";

type DB = Database.Database;

// 진실 = 정규화 테이블. days=하루 메타, sections=순서 있는 섹션(raw는 body),
// blocks=스크럼 블록별 이슈/협업, spaces→tasks=스크럼 태스크(하위=subs_json), list_items=일일 진행.
// task_rows 뷰 = 스크럼 태스크 + 일일 항목을 평탄화한 쿼리용(빈 행 제외). shortcuts=바로가기.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS days (
  user TEXT NOT NULL, date TEXT NOT NULL,
  owner TEXT NOT NULL DEFAULT '',
  preamble TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
  PRIMARY KEY (user, date)
);
CREATE TABLE IF NOT EXISTS sections (
  user TEXT NOT NULL, date TEXT NOT NULL, pos INTEGER NOT NULL,
  kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user, date, pos)
);
CREATE TABLE IF NOT EXISTS blocks (
  user TEXT NOT NULL, date TEXT NOT NULL, side TEXT NOT NULL,
  issues TEXT NOT NULL DEFAULT '없음', collab TEXT NOT NULL DEFAULT '없음',
  PRIMARY KEY (user, date, side)
);
CREATE TABLE IF NOT EXISTS spaces (
  user TEXT NOT NULL, date TEXT NOT NULL, side TEXT NOT NULL, pos INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user, date, side, pos)
);
CREATE TABLE IF NOT EXISTS tasks (
  user TEXT NOT NULL, date TEXT NOT NULL, side TEXT NOT NULL,
  space_pos INTEGER NOT NULL, pos INTEGER NOT NULL,
  jkey TEXT NOT NULL DEFAULT '', descr TEXT NOT NULL DEFAULT '',
  progress INTEGER, due TEXT NOT NULL DEFAULT '', subs_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (user, date, side, space_pos, pos)
);
CREATE TABLE IF NOT EXISTS list_items (
  user TEXT NOT NULL, date TEXT NOT NULL, pos INTEGER NOT NULL,
  done INTEGER NOT NULL DEFAULT 0, jkey TEXT NOT NULL DEFAULT '', descr TEXT NOT NULL DEFAULT '',
  progress INTEGER, due TEXT NOT NULL DEFAULT '', subs_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (user, date, pos)
);
CREATE TABLE IF NOT EXISTS shortcuts (
  user TEXT NOT NULL, pos INTEGER NOT NULL, name TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user, pos)
);
CREATE TABLE IF NOT EXISTS settings (
  user TEXT NOT NULL, json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (user)
);
CREATE INDEX IF NOT EXISTS idx_tasks_ud ON tasks(user, date);
CREATE INDEX IF NOT EXISTS idx_tasks_key ON tasks(jkey);
CREATE INDEX IF NOT EXISTS idx_items_ud ON list_items(user, date);
`;

// task_rows 뷰 = 스크럼 태스크 + 일일 항목 평탄화(빈 행 제외). 일일도 progress/due 노출.
// migrateV2가 옛 뷰(daily progress=NULL)를 DROP 후 이 정의로 재생성하므로 상수로 분리.
const TASK_ROWS_VIEW = `CREATE VIEW IF NOT EXISTS task_rows AS
  SELECT t.user AS user, t.date AS date, t.side AS side, sp.label AS space,
         t.jkey AS jkey, t.descr AS descr, t.progress AS progress, t.due AS due, t.subs_json AS subs_json
    FROM tasks t
    JOIN spaces sp ON sp.user = t.user AND sp.date = t.date AND sp.side = t.side AND sp.pos = t.space_pos
   WHERE t.jkey <> '' OR t.descr <> ''
  UNION ALL
  SELECT user, date, 'daily' AS side, '' AS space, jkey, descr, progress, due, subs_json
    FROM list_items
   WHERE jkey <> '' OR descr <> '';`;

// 스키마 적용 + v1/v2 마이그레이션까지 끝난 DB 하나. main이 userData 경로로 호출.
export function openDb(path: string): DB {
  const db = createDb(path);
  migrateV1(db);
  migrateV2(db);
  return db;
}

// 테스트/도구용: 스키마 적용된 DB 하나 (기본 in-memory).
export function createDb(path = ":memory:"): DB {
  const db = new Database(path);
  db.exec(SCHEMA);
  db.exec(TASK_ROWS_VIEW);
  return db;
}

// ───────────────────────── 정규화 왕복 (sync 코어) ─────────────────────────
function listDates(db: DB, user: string): string[] {
  return (db.prepare("SELECT date FROM days WHERE user=? ORDER BY date").all(user) as { date: string }[]).map((r) => r.date);
}
function readDoc(db: DB, user: string, date: string): Doc | null {
  const day = db.prepare("SELECT owner,preamble FROM days WHERE user=? AND date=?").get(user, date) as { owner: string; preamble: string } | undefined;
  if (!day) return null;
  const rows: DocRows = {
    day: { owner: day.owner, preamble: day.preamble },
    sections: db.prepare("SELECT pos,kind,title,body FROM sections WHERE user=? AND date=? ORDER BY pos").all(user, date) as DocRows["sections"],
    blocks: db.prepare("SELECT side,issues,collab FROM blocks WHERE user=? AND date=?").all(user, date) as DocRows["blocks"],
    spaces: db.prepare("SELECT side,pos,label FROM spaces WHERE user=? AND date=? ORDER BY pos").all(user, date) as DocRows["spaces"],
    tasks: db.prepare("SELECT side,space_pos,pos,jkey,descr,progress,due,subs_json FROM tasks WHERE user=? AND date=? ORDER BY pos").all(user, date) as DocRows["tasks"],
    listItems: db.prepare("SELECT pos,done,jkey,descr,progress,due,subs_json FROM list_items WHERE user=? AND date=? ORDER BY pos").all(user, date) as DocRows["listItems"],
  };
  return rowsToDoc(date, rows);
}
function writeDoc(db: DB, user: string, date: string, doc: Doc): void {
  const now = new Date().toISOString();
  const r = docToRows(doc);
  db.transaction(() => {
    db.prepare("INSERT INTO days(user,date,owner,preamble,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user,date) DO UPDATE SET owner=excluded.owner, preamble=excluded.preamble, updated_at=excluded.updated_at")
      .run(user, date, r.day.owner, r.day.preamble, now);
    for (const t of ["sections", "blocks", "spaces", "tasks", "list_items"]) db.prepare(`DELETE FROM ${t} WHERE user=? AND date=?`).run(user, date);
    const insSec = db.prepare("INSERT INTO sections(user,date,pos,kind,title,body) VALUES(?,?,?,?,?,?)");
    for (const s of r.sections) insSec.run(user, date, s.pos, s.kind, s.title, s.body);
    const insBlk = db.prepare("INSERT INTO blocks(user,date,side,issues,collab) VALUES(?,?,?,?,?)");
    for (const b of r.blocks) insBlk.run(user, date, b.side, b.issues, b.collab);
    const insSp = db.prepare("INSERT INTO spaces(user,date,side,pos,label) VALUES(?,?,?,?,?)");
    for (const sp of r.spaces) insSp.run(user, date, sp.side, sp.pos, sp.label);
    const insTk = db.prepare("INSERT INTO tasks(user,date,side,space_pos,pos,jkey,descr,progress,due,subs_json) VALUES(?,?,?,?,?,?,?,?,?,?)");
    for (const t of r.tasks) insTk.run(user, date, t.side, t.space_pos, t.pos, t.jkey, t.descr, t.progress, t.due, t.subs_json);
    const insLi = db.prepare("INSERT INTO list_items(user,date,pos,done,jkey,descr,progress,due,subs_json) VALUES(?,?,?,?,?,?,?,?,?)");
    for (const it of r.listItems) insLi.run(user, date, it.pos, it.done, it.jkey, it.descr, it.progress, it.due, it.subs_json);
  })();
}
// ───────────────────────── config (settings 테이블, user별 JSON 한 행) ─────────────────────────
export function readConfig(db: DB, user: string): Config {
  const row = db.prepare("SELECT json FROM settings WHERE user=?").get(user) as { json: string } | undefined;
  let stored: Partial<Config> | null = null;
  if (row) { try { stored = JSON.parse(row.json) as Partial<Config>; } catch { stored = null; } }
  return mergeConfig(stored);
}
export function writeConfig(db: DB, user: string, cfg: Partial<Config>): Config {
  const merged = mergeConfig(cfg);
  db.prepare("INSERT INTO settings(user,json) VALUES(?,?) ON CONFLICT(user) DO UPDATE SET json=excluded.json")
    .run(user, JSON.stringify(merged));
  return merged;
}
// settings 행이 아직 없으면(최초 실행) true → 프런트를 설정 페이지로 유도.
export function hasConfig(db: DB, user: string): boolean {
  return db.prepare("SELECT 1 FROM settings WHERE user=?").get(user) !== undefined;
}

function readShortcuts(db: DB, user: string): Shortcut[] {
  return db.prepare("SELECT name,url FROM shortcuts WHERE user=? ORDER BY pos").all(user) as Shortcut[];
}
function writeShortcuts(db: DB, user: string, items: Shortcut[]): void {
  db.transaction(() => {
    db.prepare("DELETE FROM shortcuts WHERE user=?").run(user);
    const ins = db.prepare("INSERT INTO shortcuts(user,pos,name,url) VALUES(?,?,?,?)");
    (items ?? []).forEach((it, i) => ins.run(user, i, it.name || "", it.url || ""));
  })();
}

// 진실. user별. 인터페이스는 async(과거 D1 대비 흔적) — 코어는 better-sqlite3 sync.
export function sqliteStore(db: DB, user: string): Store {
  return {
    async list() { return listDates(db, user); },
    async get(date) { return readDoc(db, user, date); },
    async put(date, doc) { writeDoc(db, user, date, doc); },
    async getShortcuts() { return readShortcuts(db, user); },
    async putShortcuts(items) { writeShortcuts(db, user, items); },
  };
}

// subs_json(하위 항목 문자열 배열) 안전 파싱.
function parseSubs(json: unknown): string[] {
  if (typeof json !== "string" || !json) return [];
  try {
    const a = JSON.parse(json);
    if (!Array.isArray(a)) return [];
    return a.flatMap((s) => (typeof s === "string" && s.trim() ? [s.trim()] : []));
  } catch {
    return [];
  }
}

// 파생 뷰 쿼리 (에이전트·대시보드용). side ∈ prev|today|daily.
export function queryTasks(db: DB, user: string, f: TaskFilter): TaskRow[] {
  const where = ["user=?"]; const args: string[] = [user];
  if (f.from) { where.push("date>=?"); args.push(f.from); }
  if (f.to) { where.push("date<=?"); args.push(f.to); }
  if (f.side) { where.push("side=?"); args.push(f.side); }
  if (f.key) { where.push("jkey LIKE ?"); args.push(`%${f.key.toUpperCase()}%`); }
  const sql = `SELECT date, side, space, jkey AS key, descr AS "desc", progress, due, subs_json FROM task_rows WHERE ${where.join(" AND ")} ORDER BY date, side`;
  type Raw = { date: string; side: string; space: string; key: string; desc: string; progress: number | null; due: string; subs_json: string };
  const rows = db.prepare(sql).all(...args) as Raw[];
  return rows.map((r) => ({
    date: r.date, side: r.side, space: r.space, key: r.key, desc: r.desc, progress: r.progress, due: r.due,
    subs: parseSubs(r.subs_json),
  }));
}

// ───────────────────────── v1(days.doc JSON blob) → 정규화 자동 마이그레이션 ─────────────────────────
// 옛 days 테이블에 doc 컬럼이 있으면 1회 변환. 원본은 *_v1로 남겨 안전(수동 삭제 가능).
// best-effort 실행 — 실패해도 마이그레이션 전체를 막지 않음(구 스키마 편차 흡수).
// 실패 사유는 skipped에 모아 호출측이 필요시 참조하도록 반환.
function tryStep(label: string, fn: () => void, skipped: string[]): void {
  try { fn(); } catch (e) { skipped.push(`${label}: ${e instanceof Error ? e.message : String(e)}`); }
}
// 손상된 레거시 JSON은 null 반환(해당 행만 스킵).
function parseJson<T>(s: string): T | null {
  try { return JSON.parse(s) as T; } catch { return null; }
}
function migrateV1(db: DB): void {
  const hasDays = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='days'").get();
  if (!hasDays) return;
  const cols = db.pragma("table_info('days')") as { name: string }[];
  if (!cols.some((c) => c.name === "doc")) return;   // 이미 v2
  const oldDays = db.prepare("SELECT user,date,doc FROM days").all() as { user: string; date: string; doc: string }[];
  const skipped: string[] = [];
  let oldSc: { user: string; json: string }[] = [];
  tryStep("shortcuts 읽기", () => { oldSc = db.prepare("SELECT user,json FROM shortcuts").all() as { user: string; json: string }[]; }, skipped);
  db.exec("ALTER TABLE days RENAME TO days_v1");
  tryStep("tasks 이름변경", () => db.exec("ALTER TABLE tasks RENAME TO tasks_v1"), skipped);
  tryStep("shortcuts 이름변경", () => db.exec("ALTER TABLE shortcuts RENAME TO shortcuts_v1"), skipped);
  db.exec(SCHEMA);
  for (const r of oldDays) { const d = parseJson<Doc>(r.doc); if (d) tryStep(`day ${r.date}`, () => writeDoc(db, r.user, r.date, d), skipped); }
  for (const r of oldSc) { const sc = parseJson<Shortcut[]>(r.json); if (sc) tryStep(`shortcuts ${r.user}`, () => writeShortcuts(db, r.user, sc), skipped); }
}

// list_items에 progress·due 컬럼 추가(일일 진행 업무도 진척/마감 보유). 기존 DB는 ALTER, 뷰는 재생성.
function migrateV2(db: DB): void {
  const cols = db.pragma("table_info('list_items')") as { name: string }[];
  const has = (n: string) => cols.some((c) => c.name === n);
  if (!has("progress")) db.exec("ALTER TABLE list_items ADD COLUMN progress INTEGER");
  if (!has("due")) db.exec("ALTER TABLE list_items ADD COLUMN due TEXT NOT NULL DEFAULT ''");
  db.exec("DROP VIEW IF EXISTS task_rows");   // 옛 뷰(daily progress=NULL)일 수 있어 항상 최신으로 재생성
  db.exec(TASK_ROWS_VIEW);
}
