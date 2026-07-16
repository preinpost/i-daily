// model.ts — 순수 로직: 타입 · 설정 · 마크다운 ↔ 구조 파서/렌더러. (부작용 없음)
// 부작용/서버 없음 → server.ts·test에서 import.

// ───────────────────────── 타입 ─────────────────────────
export type Task = {
	key: string;
	desc: string;
	progress: number | "";
	due: string;
	subs?: string[];
};
export type Space = { label: string; tasks: Task[] };
export type Block = { spaces: Space[]; issues: string; collab: string };
export type Scrum = { prev: Block; today: Block };
export type ListItem = {
	done: boolean;
	key: string;
	desc: string;
	progress?: number | "";
	due?: string;
	subs?: string[];
};
export type Section =
	| { title: string; kind: "scrum" }
	| { title: string; kind: "list"; items: ListItem[] }
	| { title: string; kind: "raw"; body: string };
export type Doc = {
	date: string;
	owner: string;
	preamble: string;
	sections: Section[];
	scrum: Scrum;
};
export type Shortcut = { name: string; url: string };
export type TaskRow = {
	date?: string;
	side: string;
	space: string;
	key: string;
	desc: string;
	progress: number | null;
	due: string;
	subs?: string[];
};
export type TaskFilter = {
	from?: string;
	to?: string;
	side?: string;
	key?: string;
};

export interface Store {
	list(): Promise<string[]>;
	get(date: string): Promise<Doc | null>;
	put(date: string, doc: Doc): Promise<void>;
	getShortcuts(): Promise<Shortcut[]>;
	putShortcuts(items: Shortcut[]): Promise<void>;
}

// ───────────────────────── 설정 (config) — 회사/개인 값은 DB config에서 주입 ─────────────────────────
// 하드코딩된 회사 정보 제거 → 최초 실행 시 설정 페이지에서 등록, DB(settings 테이블)에 저장.
// route()가 요청마다 DB config를 읽어 setConfig()로 주입하고, 순수 렌더러들은 getConfig()를 읽는다.
// renderer(브라우저)에도 공유되므로 process 가 없을 수 있다.
const env = (k: string, d: string): string =>
	(globalThis as { process?: { env?: Record<string, string | undefined> } })
		.process?.env?.[k] ?? d;

export type Config = {
	owner: string; // 작성자 이름
	jiraBase: string; // Jira 브라우즈 베이스 (예: https://your-org.atlassian.net/browse/)
	spaces: string[]; // 스페이스 자동완성 목록
	jiraClientId: string; // Jira OAuth 2.0 (3LO) client id (developer.atlassian.com 등록)
	jiraClientSecret: string; // Jira OAuth 2.0 (3LO) client secret
	reportAgent: string; // 주간보고 다듬기에 쓸 에이전트 id (claude|codex|pi|"")
	reportPrompt: string; // 주간보고 커스텀 프롬프트 override (비면 내장 기본값)
};

// 기본값엔 회사/개인 정보 없음. env는 선택적 초기값(공개 배포 시 비움).
export const DEFAULT_CONFIG: Config = {
	owner: env("OWNER", ""),
	jiraBase: env("JIRA_BASE", ""),
	spaces: [],
	jiraClientId: env("JIRA_CLIENT_ID", ""),
	jiraClientSecret: env("JIRA_CLIENT_SECRET", ""),
	reportAgent: "",
	reportPrompt: "",
};

export function mergeConfig(stored?: Partial<Config> | null): Config {
	const s = (stored ?? {}) as Record<string, unknown>;
	const str = (v: unknown, d: string): string =>
		typeof v === "string" ? v : d;
	const spaces = Array.isArray(s.spaces)
		? s.spaces.filter((x): x is string => typeof x === "string")
		: DEFAULT_CONFIG.spaces;
	return {
		owner: str(s.owner, DEFAULT_CONFIG.owner),
		jiraBase: str(s.jiraBase, DEFAULT_CONFIG.jiraBase),
		spaces,
		jiraClientId: str(s.jiraClientId, DEFAULT_CONFIG.jiraClientId),
		jiraClientSecret: str(s.jiraClientSecret, DEFAULT_CONFIG.jiraClientSecret),
		reportAgent: str(s.reportAgent, DEFAULT_CONFIG.reportAgent),
		reportPrompt: str(s.reportPrompt, DEFAULT_CONFIG.reportPrompt),
	};
}

let _cfg: Config = mergeConfig(null);
export function setConfig(stored?: Partial<Config> | null): Config {
	_cfg = mergeConfig(stored);
	return _cfg;
}
export function getConfig(): Config {
	return _cfg;
}
// 최소 설정 완료 여부 — 최초 실행 시 설정 페이지로 유도할 판단 기준.
export function isConfigured(c: Config = _cfg): boolean {
	return Boolean(c.owner.trim() && c.jiraBase.trim());
}
// 티켓 키 → Jira URL. jiraBase는 host까지만 받고 `/browse/`는 자동(이미 포함되면 그대로). 미설정이면 빈 문자열.
export function ticketUrl(key: string): string {
	const base = (getConfig().jiraBase || "").trim().replace(/\/+$/, "");
	if (!base) return "";
	const path = /\/browse$/i.test(base) ? base : base + "/browse";
	return `${path}/${(key || "").trim()}`;
}

export const PORT = Number(env("PORT", "8787"));

// ───────────────────────── 모델 헬퍼 ─────────────────────────
export const emptyBlock = (): Block => ({
	spaces: [],
	issues: "없음",
	collab: "없음",
});
export const emptyScrum = (): Scrum => ({
	prev: emptyBlock(),
	today: emptyBlock(),
});
export const emptyDoc = (date: string): Doc => ({
	date,
	owner: getConfig().owner,
	preamble: "",
	sections: [
		{ title: "일일 진행 업무", kind: "list", items: [] },
		{ title: "데일리 스크럼", kind: "scrum" },
		{ title: "메모", kind: "raw", body: "" },
	],
	scrum: emptyScrum(),
});
export const clone = <T>(o: T): T => structuredClone(o);
// 로컬 타임존 기준 오늘 날짜. toISOString()은 UTC라 KST 오전 9시 전에 전날로 어긋남.
export const todayStr = (): string => {
	const d = new Date();
	return (
		d.getFullYear() +
		"-" +
		String(d.getMonth() + 1).padStart(2, "0") +
		"-" +
		String(d.getDate()).padStart(2, "0")
	);
};

// ───────────────────────── 데일리 스크럼 렌더러 (구조 → 마크다운) ─────────────────────────
export function fmtDue(due: string): string {
	if (!due) return "";
	const p = due.split("-");
	return `${+p[1]}/${+p[2]}`;
}
// 진척·마감 메타 `(N%, ~M/D)` — 스크럼 태스크·일일 항목 공용.
export function fmtMeta(
	progress: number | "" | null | undefined,
	due: string | null | undefined,
): string {
	const parts: string[] = [];
	if (progress !== "" && progress !== null && progress !== undefined)
		parts.push(`${progress}%`);
	if (due) parts.push("~" + fmtDue(due));
	return parts.length ? ` (${parts.join(", ")})` : "";
}
export function taskMeta(t: Task): string {
	return fmtMeta(t.progress, t.due);
}
// 티켓 링크 머리(마크다운). 키 없으면 설명만.
function mdHead(key: string, desc: string): string {
	if (!key) return desc;
	const url = ticketUrl(key);
	const link = url ? `[${key}](${url})` : `[${key}]`;
	return link + (desc ? ` ${desc}` : "");
}
export function taskLine(t: Task): string {
	const meta = taskMeta(t);
	const desc = (t.desc || "").trim();
	const key = (t.key || "").trim();
	if (key) {
		const url = ticketUrl(key);
		const link = url ? `[${key}](${url})` : `[${key}]`;
		return `    + ${link}` + (desc ? ` ${desc}` : "") + meta;
	}
	return "    + " + (desc || "(내용)") + meta;
}
// 스페이스가 렌더링할 내용(라벨 또는 태스크)을 가졌는지.
function spaceHasContent(sp: Space): boolean {
	return (
		Boolean((sp.label || "").trim()) ||
		(sp.tasks ?? []).some((t) => t.key || t.desc)
	);
}
// 스페이스 한 개 → 마크다운 라인들.
function fmtSpaceLines(sp: Space): string[] {
	const lines = [`  + **[${sp.label || "?"}]**`];
	for (const t of sp.tasks ?? []) {
		if (!(t.key || t.desc)) continue;
		lines.push(taskLine(t));
		for (const s of t.subs ?? [])
			if (s.trim()) lines.push("        + " + s.trim());
	}
	return lines;
}
export function fmtBlock(title: string, b: Block): string {
	const L = [`**[${title}]**`, "- 업무 계획"];
	for (const sp of b.spaces ?? [])
		if (spaceHasContent(sp)) L.push(...fmtSpaceLines(sp));
	L.push("- 이슈 사항: " + ((b.issues || "").trim() || "없음"));
	L.push("- 협업 및 기타: " + ((b.collab || "").trim() || "없음"));
	return L.join("\n");
}
export function renderScrum(s: Scrum): string {
	return (
		fmtBlock("전일 진행 업무", s.prev) +
		"\n\n" +
		fmtBlock("금일 진행 업무", s.today)
	);
}

// Teams 붙여넣기용 HTML — Teams는 붙여넣은 마크다운은 렌더 안 하고 HTML은 렌더함
export function esc(x: string): string {
	return (x || "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
// 태스크 머리(HTML). escDesc/escMeta는 이미 escape된 값.
function htmlHead(key: string, escDesc: string, escMeta: string): string {
	if (!key) return (escDesc || "(내용)") + escMeta;
	const url = ticketUrl(key);
	const anchor = url ? `<a href="${url}">[${esc(key)}]</a>` : `[${esc(key)}]`;
	return anchor + (escDesc ? ` ${escDesc}` : "") + escMeta;
}
export function taskHtml(t: Task): string {
	const meta = esc(taskMeta(t));
	const desc = esc((t.desc || "").trim());
	const key = (t.key || "").trim();
	const subs = (t.subs || []).filter((s) => s.trim());
	const subHtml = subs.length
		? `<ul>${subs.map((s) => `<li>${esc(s.trim())}</li>`).join("")}</ul>`
		: "";
	return `<li>${htmlHead(key, desc, meta)}${subHtml}</li>`;
}
export function blockHtml(title: string, b: Block): string {
	let inner = "";
	for (const sp of b.spaces ?? []) {
		if (!spaceHasContent(sp)) continue;
		const rows = (sp.tasks ?? [])
			.flatMap((t) => (t.key || t.desc ? [taskHtml(t)] : []))
			.join("");
		inner += `<li><b>[${esc(sp.label || "?")}]</b><ul>${rows}</ul></li>`;
	}
	return (
		`<p><b>[${esc(title)}]</b></p><ul>` +
		`<li>업무 계획<ul>${inner}</ul></li>` +
		`<li>이슈 사항: ${esc((b.issues || "").trim() || "없음")}</li>` +
		`<li>협업 및 기타: ${esc((b.collab || "").trim() || "없음")}</li>` +
		`</ul>`
	);
}
export function renderScrumHtml(s: Scrum): string {
	return (
		blockHtml("전일 진행 업무", s.prev) + blockHtml("금일 진행 업무", s.today)
	);
}

// ───────────────────────── 체크리스트 렌더러/파서 (일일 진행 업무) ─────────────────────────
export function renderList(items: ListItem[]): string {
	const L: string[] = [];
	for (const it of items ?? []) {
		const key = (it.key || "").trim();
		const desc = (it.desc || "").trim();
		if (!key && !desc) continue;
		L.push(`- ${mdHead(key, desc)}${fmtMeta(it.progress, it.due)}`);
		for (const s of it.subs ?? []) if (s.trim()) L.push("    - " + s.trim());
	}
	return L.join("\n");
}
export function parseList(
	body: string,
	year = new Date().getFullYear(),
): ListItem[] {
	const items: ListItem[] = [];
	let cur: ListItem | null = null;
	const mk = (content: string, done: boolean): ListItem => {
		// 항목을 리턴 → 바깥에서 cur 대입(TS 흐름분석)
		let key = "";
		const km = content.match(/^\[([^\]]+)\]\([^)]*\)\s*(.*)$/);
		if (km) {
			key = km[1].trim();
			content = km[2];
		}
		let desc = content.trim(),
			progress: number | "" = "",
			due = "";
		const mm = content.match(/^(.*?)\s*\(([^)]*)\)\s*$/); // 끝의 (N%, ~M/D) 메타 (스크럼 태스크와 동일 규칙)
		if (mm && (/\d+\s*%/.test(mm[2]) || /~\s*\d+\/\d+/.test(mm[2]))) {
			desc = mm[1].trim();
			const pm = mm[2].match(/(\d+)\s*%/);
			if (pm) progress = Number(pm[1]);
			const dm = mm[2].match(/~\s*(\d+)\/(\d+)/);
			if (dm)
				due = `${year}-${String(+dm[1]).padStart(2, "0")}-${String(+dm[2]).padStart(2, "0")}`;
		}
		const item: ListItem = { done, key, desc, progress, due, subs: [] };
		items.push(item);
		return item;
	};
	for (const raw of body.split("\n")) {
		const line = raw.replace(/\s+$/, "");
		if (!line.trim()) continue;
		let m: RegExpMatchArray | null;
		if ((m = line.match(/^[-*]\s*\[([ xX])\]\s*(.*)$/))) {
			cur = mk(m[2], m[1].toLowerCase() === "x");
			continue;
		}
		if ((m = line.match(/^\s*[-+*]\s+(.*)$/))) {
			const indent = raw.match(/^ */)?.[0].length ?? 0;
			if (indent >= 2 && cur) {
				(cur.subs ??= []).push(m[1].trim());
				continue;
			} // 하위 불릿
			cur = mk(m[1], false); // 체크박스 없는 불릿 → 항목
		}
		// 비-리스트 줄글은 스킵 (일일 진행 업무는 목록 가정)
	}
	return items;
}

// ───────────────────────── 데일리 스크럼 파서 (마크다운 → 구조) ─────────────────────────
export function parseTask(content: string, year: number): Task {
	let key = "",
		rest = content;
	const km = content.match(/^\[([^\]]+)\]\([^)]*\)\s*(.*)$/);
	if (km) {
		key = km[1].trim();
		rest = km[2];
	}
	let desc = rest.trim();
	let progress: number | "" = "";
	let due = "";
	const mm = rest.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
	if (mm && (/\d+\s*%/.test(mm[2]) || /~\s*\d+\/\d+/.test(mm[2]))) {
		desc = mm[1].trim();
		const pm = mm[2].match(/(\d+)\s*%/);
		if (pm) progress = Number(pm[1]);
		const dm = mm[2].match(/~\s*(\d+)\/(\d+)/);
		if (dm)
			due = `${year}-${String(+dm[1]).padStart(2, "0")}-${String(+dm[2]).padStart(2, "0")}`;
	}
	return { key, desc, progress, due, subs: [] };
}
// 블록 헤더 **[전일/금일 …]** → 대상 블록.
function pickBlock(s: Scrum, header: string): Block | null {
	if (header.includes("전일")) return s.prev;
	if (header.includes("금일")) return s.today;
	return null;
}
// 블록 메타(이슈/협업/업무계획 소제목) 한 줄 반영. 처리했으면 true.
function applyBlockMeta(cur: Block, line: string): boolean {
	let m: RegExpMatchArray | null;
	if ((m = line.match(/^-\s*이슈\s*사항\s*:\s*(.*)$/))) {
		cur.issues = m[1].trim() || "없음";
		return true;
	}
	if ((m = line.match(/^-\s*협업[^:]*:\s*(.*)$/))) {
		cur.collab = m[1].trim() || "없음";
		return true;
	}
	if (/^-\s*업무\s*계획/.test(line)) return true; // 고정 소제목, 스킵
	return false;
}
// '+' 불릿 한 줄 → 스페이스/태스크/하위불릿 반영. 갱신된 space/task 리턴.
function applyScrumBullet(
	cur: Block,
	space: Space | null,
	task: Task | null,
	content: string,
	indent: number,
	year: number,
): { space: Space | null; task: Task | null } {
	const sm = content.match(/^\*\*\[(.+?)\]\*\*\s*$/); // 스페이스 + **[label]**
	if (sm) {
		const ns: Space = { label: sm[1].trim(), tasks: [] };
		cur.spaces.push(ns);
		return { space: ns, task: null };
	}
	if (indent >= 6) {
		if (task) (task.subs ??= []).push(content.trim());
		return { space, task };
	} // 하위 불릿
	let sp = space;
	if (!sp) {
		sp = { label: "", tasks: [] };
		cur.spaces.push(sp);
	} // 라벨 없는 스페이스 보정
	const nt = parseTask(content, year);
	sp.tasks.push(nt);
	return { space: sp, task: nt };
}
export function parseScrum(body: string, year: number): Scrum {
	const s = emptyScrum();
	let cur: Block | null = null;
	let space: Space | null = null;
	let task: Task | null = null;
	for (const raw of body.split("\n")) {
		const line = raw.replace(/\s+$/, "");
		if (!line.trim()) continue;
		const header = line.match(/^\*\*\[(.+?)\]\*\*\s*$/);
		if (header) {
			cur = pickBlock(s, header[1]);
			space = null;
			task = null;
			continue;
		}
		if (!cur) continue;
		if (applyBlockMeta(cur, line)) continue;
		const bm = line.match(/^\s*\+\s+(.*)$/);
		if (!bm) continue;
		const indent = raw.match(/^ */)?.[0].length ?? 0;
		({ space, task } = applyScrumBullet(cur, space, task, bm[1], indent, year));
	}
	return s;
}

// ───────────────────────── 문서 파서/직렬화 (마크다운 노트 ↔ Doc) ─────────────────────────
export function kindOf(title: string): "scrum" | "list" | "raw" {
	if (title.includes("스크럼")) return "scrum";
	if (title.replace(/\s/g, "") === "일일진행업무") return "list";
	return "raw";
}
export function parseDoc(text: string, date: string): Doc {
	const year = Number(date.slice(0, 4)) || new Date().getFullYear();
	const raw: { title: string; body: string }[] = [];
	let preamble = "";
	let curTitle = "";
	let curBody: string[] | null = null;
	const flush = () => {
		if (curBody !== null)
			raw.push({ title: curTitle, body: curBody.join("\n").trim() });
	};
	for (const line of text.split("\n")) {
		const hm = line.match(/^##\s+(.+?)\s*$/);
		if (hm) {
			flush();
			curTitle = hm[1].trim();
			curBody = [];
		} else if (curBody === null) preamble += line + "\n";
		else curBody.push(line);
	}
	flush();
	const doc: Doc = {
		date,
		owner: getConfig().owner,
		preamble: preamble.trim(),
		sections: [],
		scrum: emptyScrum(),
	};
	for (const r of raw) {
		const kind = kindOf(r.title);
		if (kind === "scrum") {
			doc.scrum = parseScrum(r.body, year);
			doc.sections.push({ title: r.title, kind: "scrum" });
		} else if (kind === "list")
			doc.sections.push({
				title: r.title,
				kind: "list",
				items: parseList(r.body, year),
			});
		else doc.sections.push({ title: r.title, kind: "raw", body: r.body });
	}
	if (!doc.sections.some((x) => x.kind === "scrum"))
		doc.sections.push({ title: "데일리 스크럼", kind: "scrum" });
	return doc;
}
// 섹션 한 개 → 본문 마크다운.
function sectionBody(doc: Doc, s: Section): string {
	if (s.kind === "scrum") return renderScrum(doc.scrum);
	if (s.kind === "list") return renderList(s.items);
	return (s.body || "").replace(/\s+$/, "");
}
export function serializeDoc(doc: Doc): string {
	const parts: string[] = [];
	if (doc.preamble) parts.push(doc.preamble.trim());
	for (const s of doc.sections) {
		parts.push(`## ${s.title}\n\n${sectionBody(doc, s)}`.replace(/\s+$/, ""));
	}
	return parts.join("\n\n") + "\n";
}

export const teamsOf = (doc: Doc): string => renderScrum(doc.scrum);
export const dayResponse = (doc: Doc) => ({
	data: doc,
	teams: renderScrum(doc.scrum),
	teamsHtml: renderScrumHtml(doc.scrum),
});

export async function carryNew(store: Store, date: string): Promise<Doc> {
	const doc = emptyDoc(date);
	const dates = await store.list();
	const earlier = dates.filter((d) => d < date);
	const prev = earlier.at(-1) ?? null;
	if (prev) {
		const p = await store.get(prev);
		if (p?.scrum?.today) {
			doc.scrum.prev = clone(p.scrum.today);
			doc.scrum.today = clone(p.scrum.today);
		}
	}
	return doc;
}

// 일일 항목의 진척값 — 명시 진척이 있으면 그대로, 없으면 완료=100·미완=빈값.
function itemProgress(it: ListItem): number | "" {
	if (typeof it.progress === "number") return it.progress;
	return it.done ? 100 : "";
}
// 일일 진행 업무(체크리스트) → 전일 진행 업무 블록(라벨 없는 스페이스 1개)로 변환
export function dailyToBlock(items: ListItem[]): Block {
	const tasks: Task[] = [];
	for (const it of items ?? []) {
		if (!((it.key || "").trim() || (it.desc || "").trim())) continue;
		tasks.push({
			key: it.key || "",
			desc: it.desc || "",
			progress: itemProgress(it),
			due: it.due || "",
			subs: [...(it.subs || [])],
		});
	}
	return {
		spaces: tasks.length ? [{ label: "", tasks }] : [],
		issues: "없음",
		collab: "없음",
	};
}

// ───────────────────────── Doc ↔ 정규화 행 (테이블이 진실) ─────────────────────────
// 하루치 Doc을 실제 테이블 행들로 평탄화 / 다시 조립. store.ts가 SQL로 왕복시킴.
// 냄새였던 days.doc JSON blob 대신 이 행들이 진실. side ∈ prev|today.
export type DayRow = { owner: string; preamble: string };
export type SectionRow = {
	pos: number;
	kind: string;
	title: string;
	body: string;
};
export type BlockRow = { side: string; issues: string; collab: string };
export type SpaceRow = { side: string; pos: number; label: string };
export type ScrumTaskRow = {
	side: string;
	space_pos: number;
	pos: number;
	jkey: string;
	descr: string;
	progress: number | null;
	due: string;
	subs_json: string;
};
export type ListItemRow = {
	pos: number;
	done: number;
	jkey: string;
	descr: string;
	progress: number | null;
	due: string;
	subs_json: string;
};
export type DocRows = {
	day: DayRow;
	sections: SectionRow[];
	blocks: BlockRow[];
	spaces: SpaceRow[];
	tasks: ScrumTaskRow[];
	listItems: ListItemRow[];
};

const subsJson = (subs?: string[]): string =>
	JSON.stringify((subs ?? []).filter((s) => s && s.trim()));
const parseSubs = (json?: string): string[] => {
	try {
		const a = JSON.parse(json || "[]");
		return Array.isArray(a) ? a : [];
	} catch {
		return [];
	}
};
const numOrNull = (p: number | "" | null): number | null =>
	p === "" || p === null ? null : Number(p);

// 스크럼(prev/today) → blocks/spaces/tasks 행. (빈 스페이스/태스크도 보존 → 왕복 동일)
function scrumToRows(scrum: Scrum): {
	blocks: BlockRow[];
	spaces: SpaceRow[];
	tasks: ScrumTaskRow[];
} {
	const blocks: BlockRow[] = [];
	const spaces: SpaceRow[] = [];
	const tasks: ScrumTaskRow[] = [];
	for (const [side, block] of [
		["prev", scrum.prev],
		["today", scrum.today],
	] as const) {
		blocks.push({
			side,
			issues: (block.issues || "").trim() || "없음",
			collab: (block.collab || "").trim() || "없음",
		});
		(block.spaces ?? []).forEach((sp, si) => {
			spaces.push({ side, pos: si, label: sp.label || "" });
			(sp.tasks ?? []).forEach((t, ti) =>
				tasks.push({
					side,
					space_pos: si,
					pos: ti,
					jkey: t.key || "",
					descr: t.desc || "",
					progress: numOrNull(t.progress),
					due: t.due || "",
					subs_json: subsJson(t.subs),
				}),
			);
		});
	}
	return { blocks, spaces, tasks };
}
// list 섹션들 → list_items 행.
function listSectionsToRows(sections: Section[]): ListItemRow[] {
	const listItems: ListItemRow[] = [];
	for (const sec of sections)
		if (sec.kind === "list")
			(sec.items ?? []).forEach((it, i) =>
				listItems.push({
					pos: i,
					done: it.done ? 1 : 0,
					jkey: it.key || "",
					descr: it.desc || "",
					progress: numOrNull(it.progress ?? ""),
					due: it.due || "",
					subs_json: subsJson(it.subs),
				}),
			);
	return listItems;
}
// Doc → 행들 (빈 스페이스/태스크도 보존 → get→put→get 왕복 동일. 쿼리 뷰가 빈 행은 걸러냄)
export function docToRows(doc: Doc): DocRows {
	const sections: SectionRow[] = doc.sections.map((s, i) => ({
		pos: i,
		kind: s.kind,
		title: s.title,
		body: s.kind === "raw" ? s.body || "" : "",
	}));
	const { blocks, spaces, tasks } = scrumToRows(doc.scrum);
	const listItems = listSectionsToRows(doc.sections);
	return {
		day: { owner: doc.owner, preamble: doc.preamble || "" },
		sections,
		blocks,
		spaces,
		tasks,
		listItems,
	};
}

// 섹션 행 → Section (list는 조립된 items를 붙임).
function rowToSection(s: SectionRow, items: ListItem[]): Section {
	if (s.kind === "scrum") return { title: s.title, kind: "scrum" };
	if (s.kind === "list") return { title: s.title, kind: "list", items };
	return { title: s.title, kind: "raw", body: s.body };
}
// 행들 → Doc (get). 리스트 항목은 단일 list 섹션에 붙임(kindOf상 list는 최대 1개).
export function rowsToDoc(date: string, r: DocRows): Doc {
	const scrum = emptyScrum();
	for (const side of ["prev", "today"] as const) {
		const block = scrum[side];
		const b = r.blocks.find((x) => x.side === side);
		if (b) {
			block.issues = b.issues;
			block.collab = b.collab;
		}
		block.spaces = r.spaces
			.filter((s) => s.side === side)
			.sort((a, b) => a.pos - b.pos)
			.map((sp) => ({
				label: sp.label,
				tasks: r.tasks
					.filter((t) => t.side === side && t.space_pos === sp.pos)
					.sort((a, b) => a.pos - b.pos)
					.map((t) => ({
						key: t.jkey,
						desc: t.descr,
						progress: (t.progress === null ? "" : t.progress) as number | "",
						due: t.due || "",
						subs: parseSubs(t.subs_json),
					})),
			}));
	}
	const items: ListItem[] = [...r.listItems]
		.sort((a, b) => a.pos - b.pos)
		.map((it) => ({
			done: Boolean(it.done),
			key: it.jkey,
			desc: it.descr,
			progress: (it.progress === null ? "" : it.progress) as number | "",
			due: it.due || "",
			subs: parseSubs(it.subs_json),
		}));
	const sections: Section[] = [...r.sections]
		.sort((a, b) => a.pos - b.pos)
		.map((s) => rowToSection(s, items));
	return {
		date,
		owner: r.day.owner,
		preamble: r.day.preamble || "",
		sections,
		scrum,
	};
}
