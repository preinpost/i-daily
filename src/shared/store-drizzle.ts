// store-drizzle.ts — Drizzle 기반 저장소 (D1 / Cloudflare Workers). 저장소의 단일 구현.
// schema.ts 가 테이블 정의의 단일 원천. 정규화 테이블에 하루치 Doc 을 행으로 왕복.
//
// 설계 메모:
//  - D1 은 트랜잭션 미지원 → 다중문장 원자쓰기는 db.batch([...]) 사용(writeDoc·writeShortcuts).
//  - 순수 model.ts(docToRows/rowsToDoc/mergeConfig) 만 의존 → 도메인 로직 공유, 중복 없음.
//  - Backend 인터페이스로 journalRoutes 에 주입 → 라우팅 로직은 저장소 구현 무관(테스트 대체 용이).
import { eq, and, gte, lte, like, asc, desc, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { BatchItem } from "drizzle-orm/batch";
import {
	docToRows,
	rowsToDoc,
	mergeConfig,
	type Store,
	type Doc,
	type DocRows,
	type TaskRow,
	type TaskFilter,
	type Shortcut,
	type Config,
} from "./model.ts";
import { SETUP_USER } from "./backend.ts";
import type { Backend } from "./backend.ts";
import {
	days,
	sections,
	blocks,
	spaces,
	tasks,
	listItems,
	shortcuts,
	settings,
	jiraAuth,
	oauthStates,
	sessions,
	taskRows,
} from "./schema.ts";

type DB = DrizzleD1Database;

// ───────────────────────── 정규화 왕복 (async / D1) ─────────────────────────
async function listDates(db: DB, user: string): Promise<string[]> {
	const rows = await db
		.select({ date: days.date })
		.from(days)
		.where(eq(days.user, user))
		.orderBy(asc(days.date))
		.all();
	return rows.map((r) => r.date);
}

async function readDoc(
	db: DB,
	user: string,
	date: string,
): Promise<Doc | null> {
	const day = await db
		.select({ owner: days.owner, preamble: days.preamble })
		.from(days)
		.where(and(eq(days.user, user), eq(days.date, date)))
		.get();
	if (!day) return null;

	const [sec, blk, sp, tk, li] = await Promise.all([
		db
			.select({
				pos: sections.pos,
				kind: sections.kind,
				title: sections.title,
				body: sections.body,
			})
			.from(sections)
			.where(and(eq(sections.user, user), eq(sections.date, date)))
			.orderBy(asc(sections.pos))
			.all(),
		db
			.select({
				side: blocks.side,
				issues: blocks.issues,
				collab: blocks.collab,
			})
			.from(blocks)
			.where(and(eq(blocks.user, user), eq(blocks.date, date)))
			.all(),
		db
			.select({
				side: spaces.side,
				pos: spaces.pos,
				label: spaces.label,
			})
			.from(spaces)
			.where(and(eq(spaces.user, user), eq(spaces.date, date)))
			.orderBy(asc(spaces.pos))
			.all(),
		db
			.select({
				side: tasks.side,
				spacePos: tasks.spacePos,
				pos: tasks.pos,
				jkey: tasks.jkey,
				descr: tasks.descr,
				progress: tasks.progress,
				due: tasks.due,
				subsJson: tasks.subsJson,
			})
			.from(tasks)
			.where(and(eq(tasks.user, user), eq(tasks.date, date)))
			.orderBy(asc(tasks.pos))
			.all(),
		db
			.select({
				pos: listItems.pos,
				done: listItems.done,
				jkey: listItems.jkey,
				descr: listItems.descr,
				progress: listItems.progress,
				due: listItems.due,
				subsJson: listItems.subsJson,
			})
			.from(listItems)
			.where(and(eq(listItems.user, user), eq(listItems.date, date)))
			.orderBy(asc(listItems.pos))
			.all(),
	]);

	const rows: DocRows = {
		day: { owner: day.owner, preamble: day.preamble },
		sections: sec.map((s) => ({
			pos: s.pos,
			kind: s.kind,
			title: s.title,
			body: s.body,
		})),
		blocks: blk.map((b) => ({
			side: b.side,
			issues: b.issues,
			collab: b.collab,
		})),
		spaces: sp.map((s) => ({
			side: s.side,
			pos: s.pos,
			label: s.label,
		})),
		tasks: tk.map((t) => ({
			side: t.side,
			space_pos: t.spacePos,
			pos: t.pos,
			jkey: t.jkey,
			descr: t.descr,
			progress: t.progress,
			due: t.due,
			subs_json: t.subsJson,
		})),
		listItems: li.map((it) => ({
			pos: it.pos,
			done: it.done,
			jkey: it.jkey,
			descr: it.descr,
			progress: it.progress,
			due: it.due,
			subs_json: it.subsJson,
		})),
	};
	return rowsToDoc(date, rows);
}

async function writeDoc(
	db: DB,
	user: string,
	date: string,
	doc: Doc,
): Promise<void> {
	const now = new Date().toISOString();
	const r = docToRows(doc);
	const ud = and(eq(sections.user, user), eq(sections.date, date));

	// D1 은 트랜잭션 미지원 → batch 로 원자 실행. 빈 values 삽입은 스킵(Drizzle 이 거부).
	// 이종(서로 다른 테이블의 insert/delete) 배열 → BatchItem<'sqlite'>[] 로 명시 타이핑.
	const ops: BatchItem<"sqlite">[] = [
		db
			.insert(days)
			.values({
				user,
				date,
				owner: r.day.owner,
				preamble: r.day.preamble,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: [days.user, days.date],
				set: {
					owner: r.day.owner,
					preamble: r.day.preamble,
					updatedAt: now,
				},
			}),
		db.delete(sections).where(ud),
		db.delete(blocks).where(and(eq(blocks.user, user), eq(blocks.date, date))),
		db.delete(spaces).where(and(eq(spaces.user, user), eq(spaces.date, date))),
		db.delete(tasks).where(and(eq(tasks.user, user), eq(tasks.date, date))),
		db
			.delete(listItems)
			.where(and(eq(listItems.user, user), eq(listItems.date, date))),
	];
	if (r.sections.length)
		ops.push(
			db.insert(sections).values(
				r.sections.map((s) => ({
					user,
					date,
					pos: s.pos,
					kind: s.kind,
					title: s.title,
					body: s.body,
				})),
			),
		);
	if (r.blocks.length)
		ops.push(
			db.insert(blocks).values(
				r.blocks.map((b) => ({
					user,
					date,
					side: b.side,
					issues: b.issues,
					collab: b.collab,
				})),
			),
		);
	if (r.spaces.length)
		ops.push(
			db.insert(spaces).values(
				r.spaces.map((s) => ({
					user,
					date,
					side: s.side,
					pos: s.pos,
					label: s.label,
				})),
			),
		);
	if (r.tasks.length)
		ops.push(
			db.insert(tasks).values(
				r.tasks.map((t) => ({
					user,
					date,
					side: t.side,
					spacePos: t.space_pos,
					pos: t.pos,
					jkey: t.jkey,
					descr: t.descr,
					progress: t.progress,
					due: t.due,
					subsJson: t.subs_json,
				})),
			),
		);
	if (r.listItems.length)
		ops.push(
			db.insert(listItems).values(
				r.listItems.map((it) => ({
					user,
					date,
					pos: it.pos,
					done: it.done,
					jkey: it.jkey,
					descr: it.descr,
					progress: it.progress,
					due: it.due,
					subsJson: it.subs_json,
				})),
			),
		);
	await db.batch(ops as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}

// ───────────────────────── config (settings, user별 JSON 한 행) ─────────────────────────
export async function readConfig(db: DB, user: string): Promise<Config> {
	const row = await db
		.select({ json: settings.json })
		.from(settings)
		.where(eq(settings.user, user))
		.get();
	let stored: Partial<Config> | null = null;
	if (row) {
		try {
			stored = JSON.parse(row.json) as Partial<Config>;
		} catch {
			stored = null;
		}
	}
	return mergeConfig(stored);
}

export async function writeConfig(
	db: DB,
	user: string,
	cfg: Partial<Config>,
): Promise<Config> {
	const merged = mergeConfig(cfg);
	await db
		.insert(settings)
		.values({ user, json: JSON.stringify(merged) })
		.onConflictDoUpdate({
			target: settings.user,
			set: { json: JSON.stringify(merged) },
		});
	return merged;
}

/**
 * 첫 로그인 마이그레이션: fromUser(=setup) 의 config 를 toUser(=account_id) 로 복사.
 * toUser 에 이미 설정이 있으면(재연결 등) no-op. OAuth 클라이언트 config 공유를 위해
 * fromUser 행은 남겨둔다(삭제하지 않음) — 다음 신규 유저의 OAuth 시작에 사용.
 */
export async function migrateConfig(
	db: DB,
	fromUser: string,
	toUser: string,
): Promise<void> {
	if (fromUser === toUser) return;
	const exists = await hasConfig(db, toUser);
	if (exists) return;
	const cfg = await readConfig(db, fromUser);
	await writeConfig(db, toUser, cfg);
}

export async function hasConfig(db: DB, user: string): Promise<boolean> {
	const row = await db
		.select({ user: settings.user })
		.from(settings)
		.where(eq(settings.user, user))
		.get();
	return !!row;
}

// ───────────────────────── jira_auth (OAuth 토큰, user별 JSON 한 행) ─────────────────────────
export type JiraAuth = {
	accessToken: string;
	refreshToken: string;
	expiresAt: number; // epoch ms
	cloudId: string;
	siteUrl: string;
	siteName: string;
};

export async function readJiraAuth(
	db: DB,
	user: string,
): Promise<JiraAuth | null> {
	const row = await db
		.select({ json: jiraAuth.json })
		.from(jiraAuth)
		.where(eq(jiraAuth.user, user))
		.get();
	if (!row) return null;
	try {
		const t = JSON.parse(row.json) as Partial<JiraAuth>;
		if (!t.accessToken || !t.refreshToken || !t.cloudId) return null;
		return {
			accessToken: String(t.accessToken),
			refreshToken: String(t.refreshToken),
			expiresAt: Number(t.expiresAt) || 0,
			cloudId: String(t.cloudId),
			siteUrl: String(t.siteUrl || ""),
			siteName: String(t.siteName || ""),
		};
	} catch {
		return null;
	}
}

export async function writeJiraAuth(
	db: DB,
	user: string,
	auth: JiraAuth,
): Promise<void> {
	await db
		.insert(jiraAuth)
		.values({ user, json: JSON.stringify(auth) })
		.onConflictDoUpdate({
			target: jiraAuth.user,
			set: { json: JSON.stringify(auth) },
		});
}

export async function clearJiraAuth(db: DB, user: string): Promise<void> {
	await db.delete(jiraAuth).where(eq(jiraAuth.user, user));
}

// ───────────────────────── oauth_states (OAuth state CSRF, 단기) ─────────────────────────
// Workers 멀티인스턴스환경에서도 동작하도록 state 를 D1 persist. TTL ~5분.
export type OauthStatePayload = {
	redirectUri: string;
	fromUser: string;
	createdAt: number;
};

export async function writeOauthState(
	db: DB,
	state: string,
	p: OauthStatePayload,
): Promise<void> {
	await db.insert(oauthStates).values({
		state,
		payload: JSON.stringify(p),
		createdAt: new Date(p.createdAt).toISOString(),
	});
}

/** state 로 조회后 삭제(편). 만료퇴는 null. */
export async function consumeOauthState(
	db: DB,
	state: string,
	ttlMs = 5 * 60 * 1000,
): Promise<OauthStatePayload | null> {
	const row = await db
		.select({ payload: oauthStates.payload, createdAt: oauthStates.createdAt })
		.from(oauthStates)
		.where(eq(oauthStates.state, state))
		.get();
	await db.delete(oauthStates).where(eq(oauthStates.state, state));
	if (!row) return null;
	try {
		const p = JSON.parse(row.payload) as Partial<OauthStatePayload>;
		const createdAt = Date.parse(row.createdAt);
		if (!p.redirectUri || !p.fromUser || !createdAt) return null;
		if (Date.now() - createdAt > ttlMs) return null;
		return {
			redirectUri: String(p.redirectUri),
			fromUser: String(p.fromUser),
			createdAt,
		};
	} catch {
		return null;
	}
}

// ───────────────────────── sessions (로그인 세션, sid 쿠키 → user) ─────────────────────────
export type Session = {
	sid: string;
	user: string;
	expiresAt: number;
};

export async function writeSession(
	db: DB,
	sid: string,
	user: string,
	expiresAt: number,
): Promise<void> {
	await db.insert(sessions).values({
		sid,
		user,
		createdAt: new Date().toISOString(),
		expiresAt: new Date(expiresAt).toISOString(),
	});
}

/** sid 로 세션 조회. 만료teu는 null. */
export async function readSession(
	db: DB,
	sid: string,
	now = Date.now(),
): Promise<Session | null> {
	const row = await db
		.select({
			sid: sessions.sid,
			user: sessions.user,
			expiresAt: sessions.expiresAt,
		})
		.from(sessions)
		.where(eq(sessions.sid, sid))
		.get();
	if (!row) return null;
	const expiresAt = Date.parse(row.expiresAt);
	if (!expiresAt || expiresAt <= now) return null;
	return { sid: row.sid, user: row.user, expiresAt };
}

export async function deleteSession(db: DB, sid: string): Promise<void> {
	await db.delete(sessions).where(eq(sessions.sid, sid));
}

/** 요청 쿠키에서 sid 를 읽어 유효한 user 를 리턴(없거나 만료면 SETUP_USER). */
export async function resolveUser(db: DB, request: Request): Promise<string> {
	const ck = request.headers.get("cookie") || "";
	const m = ck.match(/(?:^|;\s*)sid=([^;]+)/);
	if (!m) return SETUP_USER;
	const s = await readSession(db, decodeURIComponent(m[1]));
	return s?.user || SETUP_USER;
}

// ───────────────────────── shortcuts ─────────────────────────
async function readShortcuts(db: DB, user: string): Promise<Shortcut[]> {
	const rows = await db
		.select({ name: shortcuts.name, url: shortcuts.url })
		.from(shortcuts)
		.where(eq(shortcuts.user, user))
		.orderBy(asc(shortcuts.pos))
		.all();
	return rows.map((r) => ({ name: r.name, url: r.url }));
}

async function writeShortcuts(
	db: DB,
	user: string,
	items: Shortcut[],
): Promise<void> {
	const ops: BatchItem<"sqlite">[] = [
		db.delete(shortcuts).where(eq(shortcuts.user, user)),
	];
	if ((items ?? []).length)
		ops.push(
			db.insert(shortcuts).values(
				(items ?? []).map((it, i) => ({
					user,
					pos: i,
					name: it.name || "",
					url: it.url || "",
				})),
			),
		);
	await db.batch(ops as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}

// subs_json(하위 항목 문자열 배열) 안전 파싱.
function parseSubs(json: unknown): string[] {
	if (typeof json !== "string" || !json) return [];
	try {
		const a = JSON.parse(json);
		if (!Array.isArray(a)) return [];
		return a.flatMap((s) =>
			typeof s === "string" && s.trim() ? [s.trim()] : [],
		);
	} catch {
		return [];
	}
}

// ───────────────────────── 파생 쿼리 ─────────────────────────
// task_rows 뷰에서 평탄화(빈 행 제외). side ∈ prev|today|daily. 동적 WHERE.
export async function queryTasks(
	db: DB,
	user: string,
	f: TaskFilter,
): Promise<TaskRow[]> {
	const conds = [eq(taskRows.user, user)];
	if (f.from) conds.push(gte(taskRows.date, f.from));
	if (f.to) conds.push(lte(taskRows.date, f.to));
	if (f.side) conds.push(eq(taskRows.side, f.side));
	if (f.key) conds.push(like(taskRows.jkey, `%${f.key.toUpperCase()}%`));

	const rows = await db
		.select({
			date: taskRows.date,
			side: taskRows.side,
			space: taskRows.space,
			jkey: taskRows.jkey,
			descr: taskRows.descr,
			progress: taskRows.progress,
			due: taskRows.due,
			subsJson: taskRows.subsJson,
		})
		.from(taskRows)
		.where(and(...conds))
		.orderBy(asc(taskRows.date), asc(taskRows.side))
		.all();
	return rows.map((r) => ({
		date: r.date,
		side: r.side,
		space: r.space,
		key: r.jkey,
		desc: r.descr,
		progress: r.progress,
		due: r.due,
		subs: parseSubs(r.subsJson),
	}));
}

// 과거 일지에 쓴 스페이스 라벨 — 최근 사용순, 대소문자 무시 중복 제거.
export async function listSpaceLabels(db: DB, user: string): Promise<string[]> {
	const rows = await db
		.select({
			label: spaces.label,
			lastUsed: sql<string>`MAX(${spaces.date})`,
		})
		.from(spaces)
		.where(and(eq(spaces.user, user), sql`TRIM(${spaces.label}) <> ''`))
		.groupBy(spaces.label)
		.orderBy(
			desc(sql`MAX(${spaces.date})`),
			sql`${spaces.label} COLLATE NOCASE ASC`,
		)
		.all();
	const seen = new Set<string>();
	const out: string[] = [];
	for (const r of rows) {
		const t = (r.label || "").trim();
		const k = t.toLowerCase();
		if (!t || seen.has(k)) continue;
		seen.add(k);
		out.push(t);
	}
	return out;
}

// ───────────────────────── Store / Backend 팩토리 ─────────────────────────
export function d1Store(db: DB, user: string): Store {
	return {
		async list() {
			return listDates(db, user);
		},
		async get(date) {
			return readDoc(db, user, date);
		},
		async put(date, doc) {
			await writeDoc(db, user, date, doc);
		},
		async getShortcuts() {
			return readShortcuts(db, user);
		},
		async putShortcuts(items) {
			await writeShortcuts(db, user, items);
		},
	};
}

// D1 + Drizzle → Backend. Workers 엔트리가 env.DB 로 이것을 만들어 buildApp 에 주입.
export function d1Backend(db: DB, user: string): Backend {
	return {
		user,
		store: d1Store(db, user),
		async queryTasks(f) {
			return queryTasks(db, user, f);
		},
		async listSpaceLabels() {
			return listSpaceLabels(db, user);
		},
		async readConfig() {
			return readConfig(db, user);
		},
		async writeConfig(cfg) {
			return writeConfig(db, user, cfg);
		},
		async hasConfig() {
			return hasConfig(db, user);
		},
	};
}
