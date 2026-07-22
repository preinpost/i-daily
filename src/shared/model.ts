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
	space?: string; // 소속 스페이스 라벨(데일리 스크럼과 동일 개념). 없으면 무그룹.
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
// config(jiraBase/owner)는 전역이 아니라 렌더 함수에 인자로 전달한다(요청별 격리, Worker 동시성 안전).
// renderer(브라우저)에도 공유되므로 process 가 없을 수 있다.
const env = (k: string, d: string): string =>
	(globalThis as { process?: { env?: Record<string, string | undefined> } })
		.process?.env?.[k] ?? d;

export type Config = {
	owner: string; // 작성자 이름
	jiraBase: string; // Jira 브라우즈 베이스 (예: https://your-org.atlassian.net/browse/)
	reportProvider: string; // 주간보고 다듬기 LLM provider ("" | anthropic | openai | custom). BYOK.
	reportModel: string; // provider 모델 id (예: claude-haiku-4-5). 비면 provider 기본값.
	reportBaseUrl: string; // custom provider 의 OpenAI 호환 base URL(https). 다른 provider 는 비움.
	reportPrompt: string; // 주간보고 커스텀 프롬프트 override (비면 내장 기본값)
	lunchLat: string; // 사무실 위도(WGS84, 문자열) — 점심 검색 기준점
	lunchLng: string; // 사무실 경도(WGS84, 문자열)
	lunchRadius: string; // 점심 검색 반경(m), 기본 1000
};

// 기본값엔 회사/개인 정보 없음. env는 선택적 초기값(공개 배포 시 비움).
// 참고: Jira OAuth 클라이언트(client id/secret)는 user 설정이 아닌 서버 전역 secret.
// → 본 타입엔 없고, server/jira.ts 가 env(JIRA_CLIENT_ID/SECRET)에서 직접 읽는다.
// (과거에는 settings JSON 에 저장→ GET /api/days 로 브라우저에 secret 유출되었음.)
export const DEFAULT_CONFIG: Config = {
	owner: env("OWNER", ""),
	jiraBase: env("JIRA_BASE", ""),
	reportProvider: "",
	reportModel: "",
	reportBaseUrl: "",
	reportPrompt: "",
	lunchLat: "",
	lunchLng: "",
	lunchRadius: "1000",
};

export function mergeConfig(stored?: Partial<Config> | null): Config {
	const s = (stored ?? {}) as Record<string, unknown>;
	const str = (v: unknown, d: string): string =>
		typeof v === "string" ? v : d;
	return {
		owner: str(s.owner, DEFAULT_CONFIG.owner),
		jiraBase: str(s.jiraBase, DEFAULT_CONFIG.jiraBase),
		reportProvider: str(s.reportProvider, DEFAULT_CONFIG.reportProvider),
		reportModel: str(s.reportModel, DEFAULT_CONFIG.reportModel),
		reportBaseUrl: str(s.reportBaseUrl, DEFAULT_CONFIG.reportBaseUrl),
		reportPrompt: str(s.reportPrompt, DEFAULT_CONFIG.reportPrompt),
		lunchLat: str(s.lunchLat, DEFAULT_CONFIG.lunchLat),
		lunchLng: str(s.lunchLng, DEFAULT_CONFIG.lunchLng),
		lunchRadius: str(s.lunchRadius, DEFAULT_CONFIG.lunchRadius),
	};
}

// 최소 설정 완료 여부 — 최초 실행 시 설정 페이지로 유도할 판단 기준.
export function isConfigured(c: Config): boolean {
	return Boolean(c.owner.trim() && c.jiraBase.trim());
}
// 티켓 키 → Jira URL. jiraBase는 host까지만 받고 `/browse/`는 자동(이미 포함되면 그대로). 미설정이면 빈 문자열.
export function ticketUrl(jiraBase: string, key: string): string {
	const base = (jiraBase || "").trim().replace(/\/+$/, "");
	if (!base) return "";
	const path = /\/browse$/i.test(base) ? base : base + "/browse";
	return `${path}/${(key || "").trim()}`;
}

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
export const emptyDoc = (date: string, owner = ""): Doc => ({
	date,
	owner,
	preamble: "",
	sections: [
		{ title: "일일 진행 업무", kind: "list", items: [] },
		{ title: "데일리 스크럼", kind: "scrum" },
		{ title: "메모", kind: "raw", body: "" },
	],
	scrum: emptyScrum(),
});
export const clone = <T>(o: T): T => structuredClone(o);
// 업무 기준 시간대는 KST(UTC+9). Workers 런타임은 호스트 TZ와 무관하게 Date가 항상
// UTC라 로컬 getter(getDate/getDay 등)도 UTC 값을 돌려준다 → KST 00~09시에 하루 전으로
// 어긋남. 명시적 오프셋 + UTC getter로 worker/browser/node 어디서나 KST 달력 값을 만든다.
export function kstParts(now: Date = new Date()): {
	y: number;
	m: number; // 1~12
	day: number;
	dow: number; // 0=일 … 6=토
} {
	const k = new Date(now.getTime() + 9 * 3600 * 1000);
	return {
		y: k.getUTCFullYear(),
		m: k.getUTCMonth() + 1,
		day: k.getUTCDate(),
		dow: k.getUTCDay(),
	};
}
export const todayStr = (now: Date = new Date()): string => {
	const { y, m, day } = kstParts(now);
	return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
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
function mdHead(jiraBase: string, key: string, desc: string): string {
	if (!key) return desc;
	const url = ticketUrl(jiraBase, key);
	const link = url ? `[${key}](${url})` : `[${key}]`;
	return link + (desc ? ` ${desc}` : "");
}
export function taskLine(jiraBase: string, t: Task): string {
	const meta = taskMeta(t);
	const desc = (t.desc || "").trim();
	const key = (t.key || "").trim();
	if (key) {
		const url = ticketUrl(jiraBase, key);
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
function fmtSpaceLines(jiraBase: string, sp: Space): string[] {
	const lines = [`  + **[${sp.label || "스페이스 없음"}]**`];
	for (const t of sp.tasks ?? []) {
		if (!(t.key || t.desc)) continue;
		lines.push(taskLine(jiraBase, t));
		for (const s of t.subs ?? [])
			if (s.trim()) lines.push("        + " + s.trim());
	}
	return lines;
}
export function fmtBlock(jiraBase: string, title: string, b: Block): string {
	const L = [`**[${title}]**`, "- 업무 계획"];
	for (const sp of b.spaces ?? [])
		if (spaceHasContent(sp)) L.push(...fmtSpaceLines(jiraBase, sp));
	for (const [label, val] of [
		["이슈 사항", b.issues],
		["협업 및 기타", b.collab],
	] as const) {
		const items = parseMetaLines(val);
		if (!items.length) {
			L.push(`- ${label}: 없음`);
		} else {
			L.push(`- ${label}`);
			for (const it of items) {
				L.push("  - " + it.text);
				for (const s of it.subs) L.push("    - " + s);
			}
		}
	}
	return L.join("\n");
}
export function renderScrum(jiraBase: string, s: Scrum): string {
	return (
		fmtBlock(jiraBase, "전일 진행 업무", s.prev) +
		"\n\n" +
		fmtBlock(jiraBase, "금일 진행 업무", s.today)
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
function htmlHead(
	jiraBase: string,
	key: string,
	escDesc: string,
	escMeta: string,
): string {
	if (!key) return (escDesc || "(내용)") + escMeta;
	const url = ticketUrl(jiraBase, key);
	const anchor = url ? `<a href="${url}">[${esc(key)}]</a>` : `[${esc(key)}]`;
	return anchor + (escDesc ? ` ${escDesc}` : "") + escMeta;
}
export function taskHtml(jiraBase: string, t: Task): string {
	const meta = esc(taskMeta(t));
	const desc = esc((t.desc || "").trim());
	const key = (t.key || "").trim();
	const subs = (t.subs || []).filter((s) => s.trim());
	const subHtml = subs.length
		? `<ul>${subs.map((s) => `<li>${esc(s.trim())}</li>`).join("")}</ul>`
		: "";
	return `<li>${htmlHead(jiraBase, key, desc, meta)}${subHtml}</li>`;
}
// 이슈·협업 개행 문자열 → 2레벨(메인+하위) 구조. 탭(\t) 시작 = 하위.
export type MetaItem = { text: string; subs: string[] };
export function parseMetaLines(value?: string): MetaItem[] {
	const v = (value || "").trim();
	if (!v || v === "없음") return [];
	const items: MetaItem[] = [];
	for (const raw of v.split("\n")) {
		const isSub = raw.startsWith("\t");
		const t = raw.replace(/^\t+/, "").trim();
		if (!t) continue;
		if (isSub) {
			if (items.length) items[items.length - 1].subs.push(t);
		} else {
			items.push({ text: t, subs: [] });
		}
	}
	return items;
}
// 이슈·협업 → HTML (없음이면 인라인, 값 있으면 라벨만 + 2레벨 중첩 <ul>)
function metaHtml(label: string, val: string | undefined): string {
	const items = parseMetaLines(val);
	if (!items.length) return `<li>${label}: 없음</li>`;
	const lis = items
		.map((it) => {
			const sub = it.subs.length
				? `<ul>${it.subs.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`
				: "";
			return `<li>${esc(it.text)}${sub}</li>`;
		})
		.join("");
	return `<li>${label}<ul>${lis}</ul></li>`;
}
export function blockHtml(jiraBase: string, title: string, b: Block): string {
	let inner = "";
	for (const sp of b.spaces ?? []) {
		if (!spaceHasContent(sp)) continue;
		const rows = (sp.tasks ?? [])
			.flatMap((t) => (t.key || t.desc ? [taskHtml(jiraBase, t)] : []))
			.join("");
		inner += `<li><b>[${esc(sp.label || "스페이스 없음")}]</b><ul>${rows}</ul></li>`;
	}
	return (
		`<p><b>[${esc(title)}]</b></p><ul>` +
		`<li>업무 계획<ul>${inner}</ul></li>` +
		metaHtml("이슈 사항", b.issues) +
		metaHtml("협업 및 기타", b.collab) +
		`</ul>`
	);
}
export function renderScrumHtml(jiraBase: string, s: Scrum): string {
	return (
		blockHtml(jiraBase, "전일 진행 업무", s.prev) +
		blockHtml(jiraBase, "금일 진행 업무", s.today)
	);
}

// ───────────────────────── 체크리스트 렌더러/파서 (일일 진행 업무) ─────────────────────────
// 무그룹 항목은 기존과 동일하게 평불릿(- ...)으로, 스페이스가 붙은 항목은 데일리 스크럼과
// 같은 규칙(그룹 헤더 `  + **[label]**` → 항목 `    + ...` → 하위 `        + ...`)으로 그룹핑해 렌더.
function pushListItem(
	L: string[],
	jiraBase: string,
	it: ListItem,
	bullet: string,
	subBullet: string,
): void {
	const key = (it.key || "").trim();
	const desc = (it.desc || "").trim();
	if (!key && !desc) return;
	L.push(
		`${bullet}${mdHead(jiraBase, key, desc)}${fmtMeta(it.progress, it.due)}`,
	);
	for (const s of it.subs ?? []) if (s.trim()) L.push(subBullet + s.trim());
}
export function renderList(jiraBase: string, items: ListItem[]): string {
	const L: string[] = [];
	const spaceOrder: string[] = [];
	const bySpace = new Map<string, ListItem[]>();
	for (const it of items ?? []) {
		const sp = (it.space || "").trim();
		if (!sp) {
			pushListItem(L, jiraBase, it, "- ", "    - ");
			continue;
		}
		let bucket = bySpace.get(sp);
		if (!bucket) {
			bucket = [];
			bySpace.set(sp, bucket);
			spaceOrder.push(sp);
		}
		bucket.push(it);
	}
	for (const sp of spaceOrder) {
		L.push(`  + **[${sp}]**`);
		for (const it of bySpace.get(sp) ?? [])
			pushListItem(L, jiraBase, it, "    + ", "        + ");
	}
	return L.join("\n");
}
export function parseList(
	body: string,
	year = new Date().getFullYear(),
): ListItem[] {
	const items: ListItem[] = [];
	let cur: ListItem | null = null;
	let curSpace = "";
	const mk = (content: string, done: boolean, space: string): ListItem => {
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
		const item: ListItem = { done, key, desc, progress, due, subs: [], space };
		items.push(item);
		return item;
	};
	for (const raw of body.split("\n")) {
		const line = raw.replace(/\s+$/, "");
		if (!line.trim()) continue;
		const indent = raw.match(/^ */)?.[0].length ?? 0;
		let m: RegExpMatchArray | null;
		// 스페이스 그룹 헤더: "  + **[label]**" (데일리 스크럼과 동일 규칙)
		if ((m = line.match(/^\s*\+\s*\*\*\[(.+?)\]\*\*\s*$/))) {
			curSpace = m[1].trim();
			cur = null;
			continue;
		}
		// 체크박스 항목 — 항상 무그룹(최상위)
		if ((m = line.match(/^[-*]\s*\[([ xX])\]\s*(.*)$/))) {
			cur = mk(m[2], m[1].toLowerCase() === "x", "");
			continue;
		}
		// dash 불릿: 무그룹 항목(들여쓰기 0) 또는 무그룹 항목의 하위(들여쓰기 ≥2)
		if ((m = line.match(/^\s*-\s+(.*)$/))) {
			if (indent >= 2 && cur && !cur.space) {
				(cur.subs ??= []).push(m[1].trim());
				continue;
			}
			cur = mk(m[1], false, "");
			continue;
		}
		// plus 불릿: 스페이스 그룹 항목(들여쓰기 ≥4) 또는 그 하위(들여쓰기 ≥6)
		if ((m = line.match(/^\s*\+\s+(.*)$/))) {
			if (indent >= 6 && cur && cur.space) {
				(cur.subs ??= []).push(m[1].trim());
				continue;
			}
			cur = mk(m[1], false, curSpace);
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
// 블록 메타(이슈/협업/업무계획 소제목) 한 줄 반영. 처리했으면 필드명 또는 "skip".
function applyBlockMeta(
	cur: Block,
	line: string,
): "issues" | "collab" | "skip" | null {
	let m: RegExpMatchArray | null;
	// 콜론 유무 모두 매치 — 콜론 없으면 값 비워두고 하위 불릿에서 채움
	if ((m = line.match(/^-\s*이슈\s*사항\s*:?\s*(.*)$/))) {
		cur.issues = m[1].trim() || "";
		return "issues";
	}
	if ((m = line.match(/^-\s*협업[^:]*:?\s*(.*)$/))) {
		cur.collab = m[1].trim() || "";
		return "collab";
	}
	if (/^-\s*업무\s*계획/.test(line)) return "skip"; // 고정 소제목, 스킵
	return null;
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
	let lastMeta: "issues" | "collab" | null = null;
	for (const raw of body.split("\n")) {
		const line = raw.replace(/\s+$/, "");
		if (!line.trim()) continue;
		const header = line.match(/^\*\*\[(.+?)\]\*\*\s*$/);
		if (header) {
			cur = pickBlock(s, header[1]);
			space = null;
			task = null;
			lastMeta = null;
			continue;
		}
		if (!cur) continue;
		const meta = applyBlockMeta(cur, line);
		if (meta === "skip") {
			lastMeta = null;
			continue;
		}
		if (meta === "issues" || meta === "collab") {
			lastMeta = meta;
			continue;
		}
		// 들여쓴 하위 불릿 → 이슈/협업 다중 행 수집
		if (lastMeta && cur) {
			const sub = line.match(/^(\s*)-\s+(.*)$/);
			if (sub) {
				const field = lastMeta === "issues" ? "issues" : "collab";
				const t = sub[2].trim();
				// 4+공백 들여쓰기 = 하위(탭 인코딩), 2공백 = 메인
				const enc = sub[1].length >= 4 ? "\t" + t : t;
				cur[field] = cur[field] ? cur[field] + "\n" + enc : enc;
				continue;
			}
		}
		lastMeta = null;
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
export function parseDoc(text: string, date: string, owner = ""): Doc {
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
		owner,
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
function sectionBody(jiraBase: string, doc: Doc, s: Section): string {
	if (s.kind === "scrum") return renderScrum(jiraBase, doc.scrum);
	if (s.kind === "list") return renderList(jiraBase, s.items);
	return (s.body || "").replace(/\s+$/, "");
}
export function serializeDoc(jiraBase: string, doc: Doc): string {
	const parts: string[] = [];
	if (doc.preamble) parts.push(doc.preamble.trim());
	for (const s of doc.sections) {
		parts.push(
			`## ${s.title}\n\n${sectionBody(jiraBase, doc, s)}`.replace(/\s+$/, ""),
		);
	}
	return parts.join("\n\n") + "\n";
}

export const dayResponse = (jiraBase: string, doc: Doc) => ({
	data: doc,
	teams: renderScrum(jiraBase, doc.scrum),
	teamsHtml: renderScrumHtml(jiraBase, doc.scrum),
});

// 문서의 일일 진행 업무(list 섹션) 항목들 — 필드를 정규화해 반환.
// prev-daily 가져오기 · 전일 이월 등 "어제 일일 → 전일" 흐름의 단일 원천.
export function dailyItemsOf(doc: Doc): ListItem[] {
	const sec = doc.sections.find((s) => s.kind === "list") as
		| (Section & { kind: "list" })
		| undefined;
	return (sec?.items ?? []).map((it) => ({
		done: !!it.done,
		key: it.key || "",
		desc: it.desc || "",
		progress: it.progress ?? "",
		due: it.due || "",
		subs: (it.subs || []).slice(),
		space: it.space || "",
	}));
}

export async function carryNew(
	store: Store,
	date: string,
	owner = "",
): Promise<Doc> {
	const doc = emptyDoc(date, owner);
	const dates = await store.list();
	const earlier = dates.filter((d) => d < date);
	const prev = earlier.at(-1) ?? null;
	if (prev) {
		const p = await store.get(prev);
		// 전일 = 직전 근무일의 일일 진행 업무(실제로 한 일). 금일은 비워두고
		// 당일에 일일 진행 업무를 채운 뒤 스크럼 생성 버튼으로 만든다.
		if (p)
			doc.scrum.prev = dailyToBlock(
				dailyItemsOf(p),
				p.scrum.today.issues,
				p.scrum.today.collab,
			);
	}
	return doc;
}

// 일일 항목의 진척값 — 명시 진척이 있으면 그대로, 없으면 완료=100·미완=빈값.
function itemProgress(it: ListItem): number | "" {
	if (typeof it.progress === "number") return it.progress;
	return it.done ? 100 : "";
}
// 일일 진행 업무(체크리스트) → 전일 진행 업무 블록. 항목의 space 를 그대로 스페이스로 그룹핑(최초 등장 순서 유지).
export function dailyToBlock(
	items: ListItem[],
	issues?: string,
	collab?: string,
): Block {
	const order: string[] = [];
	const bySpace = new Map<string, Task[]>();
	for (const it of items ?? []) {
		if (!((it.key || "").trim() || (it.desc || "").trim())) continue;
		const label = (it.space || "").trim();
		if (!bySpace.has(label)) {
			bySpace.set(label, []);
			order.push(label);
		}
		bySpace.get(label)!.push({
			key: it.key || "",
			desc: it.desc || "",
			progress: itemProgress(it),
			due: it.due || "",
			subs: [...(it.subs || [])],
		});
	}
	return {
		spaces: order.map((label) => ({ label, tasks: bySpace.get(label)! })),
		issues: (issues || "").trim() || "없음",
		collab: (collab || "").trim() || "없음",
	};
}

// ───────────────────────── Doc ↔ 정규화 행 (테이블이 진실) ─────────────────────────
// 하루치 Doc을 실제 테이블 행들로 평탄화 / 다시 조립. store-drizzle.ts가 D1로 왕복시킴.
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
	space: string;
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
					space: it.space || "",
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
			space: it.space || "",
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
