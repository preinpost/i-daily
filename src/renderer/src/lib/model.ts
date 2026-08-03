// 순수 로직 · 문서 헬퍼 — 기존 client.js 의 전역 함수들을 인자 기반 순수 함수로 옮김.
// 부작용(toast·렌더) 없음. 컴포넌트가 doc/scrum 을 변형한 뒤 bump() 로 리렌더.
import type {
	Block,
	Config,
	Doc,
	ListItem,
	Meta,
	Section,
	Ticket,
	Which,
} from "../types";

export const WD = ["일", "월", "화", "수", "목", "금", "토"];

/* ── 날짜 ── */
export function parseYmd(s: string): Date {
	const p = (s || "").split("-").map(Number);
	return new Date(p[0], (p[1] || 1) - 1, p[2] || 1);
}
export function ymd(d: Date): string {
	return (
		d.getFullYear() +
		"-" +
		String(d.getMonth() + 1).padStart(2, "0") +
		"-" +
		String(d.getDate()).padStart(2, "0")
	);
}
export function weekOfMonth(d: Date): number {
	return Math.ceil(
		(d.getDate() + new Date(d.getFullYear(), d.getMonth(), 1).getDay()) / 7,
	);
}
export function shiftDate(s: string, days: number): string {
	const d = parseYmd(s);
	d.setDate(d.getDate() + days);
	return ymd(d);
}

/* ── 티켓 ── */
const TICKET_RE = /^[A-Z][A-Z0-9]*-\d+$/;
export function isTicket(k: string): boolean {
	return TICKET_RE.test((k || "").trim().toUpperCase());
}
export function ticketUrl(meta: Meta, k: string): string {
	const base = (meta.jiraBase || "").trim().replace(/\/+$/, "");
	if (!base) return "";
	const path = /\/browse$/i.test(base) ? base : base + "/browse";
	return path + "/" + encodeURIComponent((k || "").trim().toUpperCase());
}

/* ── 빈 골격 ── */
export const emptyBlock = (): Block => ({
	spaces: [],
	issues: "없음",
	collab: "없음",
});
export function emptyDoc(meta: Meta, date: string): Doc {
	return {
		date,
		owner: meta.owner,
		preamble: "",
		sections: [
			{ title: "일일 진행 업무", kind: "list", items: [] },
			{ title: "데일리 스크럼", kind: "scrum" },
			{ title: "메모", kind: "raw", body: "" },
		],
		scrum: { prev: emptyBlock(), today: emptyBlock() },
	};
}

/* ── 콘텐츠 존재 판정(초기화 버튼용) ── */
export function listHasContent(sec: { items?: ListItem[] }): boolean {
	return (sec.items || []).some(
		(it) =>
			(it.key || "").trim() ||
			(it.desc || "").trim() ||
			(it.subs || []).some((s) => (s || "").trim()),
	);
}
export function rawHasContent(sec: { body?: string }): boolean {
	return !!(sec.body || "").trim();
}
export function normalizeDoc(d: Doc): void {
	if (!d.scrum) d.scrum = { prev: emptyBlock(), today: emptyBlock() };
	(["prev", "today"] as Which[]).forEach((w) => {
		d.scrum[w] = Object.assign(emptyBlock(), d.scrum[w]);
		(d.scrum[w].spaces || []).forEach((sp) =>
			(sp.tasks || []).forEach((t) => {
				if (!t.subs) t.subs = [];
			}),
		);
	});
	if (!d.sections || !d.sections.length)
		d.sections = emptyDoc(
			{ today: null, owner: d.owner, jiraBase: "" },
			d.date,
		).sections;
	d.sections.forEach((s) => {
		if (s.kind === "list") {
			if (!s.items) s.items = [];
			s.items.forEach((it) => {
				if (!it.subs) it.subs = [];
				if (it.progress == null) it.progress = "";
				if (it.due == null) it.due = "";
				if (it.space == null) it.space = "";
			});
		} else if (s.kind === "raw" && s.body == null) s.body = "";
	});
}

/* ── 일일 진행(마스터) ↔ 스크럼 연결 ── */
export function listSection(
	doc: Doc,
): (Section & { kind: "list" }) | undefined {
	return doc.sections.find((x) => x.kind === "list") as
		| (Section & { kind: "list" })
		| undefined;
}
export function todayDailyItems(doc: Doc): ListItem[] {
	const s = listSection(doc);
	return s ? s.items || [] : [];
}
// 일일 항목 ↔ 스크럼 태스크 매칭 ID. 티켓 키 우선, 없으면 설명.
export function itemId(it?: { key?: string; desc?: string } | null): string {
	if (!it) return "";
	const key = (it.key || "").trim().toUpperCase();
	if (key) return "k:" + key;
	const desc = (it.desc || "").trim();
	return desc ? "d:" + desc : "";
}
/* ── 티켓 → 일일 항목 보장 ── */
export function ticketToItem(t: {
	key?: string;
	summary?: string;
	due?: string;
}): ListItem {
	return {
		done: false,
		key: (t.key || "").trim().toUpperCase(),
		desc: (t.summary || "").trim(),
		progress: "",
		due: t.due || "",
		subs: [],
	};
}
// 일일 진행(마스터)에 티켓 보장 — 이미 있으면 재사용. { item, added } 반환.
export function ensureDailyItem(
	doc: Doc,
	t: { key?: string; summary?: string; due?: string },
): { item: ListItem; added: boolean } | { error: string } {
	const sec = listSection(doc);
	if (!sec) return { error: "일일 진행 업무 섹션이 없어요" };
	if (!sec.items) sec.items = [];
	const item = ticketToItem(t);
	if (!itemId(item)) return { error: "티켓 정보가 비어 있어요" };
	const existing = sec.items.find((it) => itemId(it) === itemId(item));
	if (existing) return { item: existing, added: false };
	sec.items.push(item);
	return { item, added: true };
}

// 티켓 우선순위 — Jira 표준 순서(Highest=1 … Lowest=5). 대소문자 무시.
const PRIORITY_RANK: Record<string, number> = {
	highest: 1,
	high: 2,
	medium: 3,
	low: 4,
	lowest: 5,
};
// 정렬용 랭크: 표준 5단계 → 1..5, 표준 외(커스텀) → 6, 미지정 → 최대(맨 아래).
function priorityRank(name: string | undefined): number {
	const n = (name || "").trim().toLowerCase();
	if (!n) return Number.MAX_SAFE_INTEGER;
	return PRIORITY_RANK[n] ?? 6;
}
// 배지용 레벨: 표준 5단계만 1..5, 그 외(커스텀/미지정) → 0(배지 없음).
export function priorityLevel(name: string): number {
	const r = priorityRank(name);
	return r <= 5 ? r : 0;
}

export type Kanban = { title: string; cat: string; items: Ticket[] };
// 티켓 정렬 모드 — priority=우선도 높은 순(기본) / latest=최신(updated) 순 / due=마감 임박 순.
export type TicketSort = "priority" | "latest" | "due";
// Jira updated(ISO) → ms. 미지정/파싱 실패 → 0(맨 뒤로).
function updatedMs(t: Ticket): number {
	const s = (t.updated || "").trim();
	if (!s) return 0;
	const ms = Date.parse(s);
	return Number.isNaN(ms) ? 0 : ms;
}
// 티켓 정렬 — mode 의 1차 키 → (priority 한정 우선도 동일 시 마감 임박) → 키 내림차순 꼬리.
export function sortTickets(list: Ticket[], mode: TicketSort = "priority"): Ticket[] {
	return [...list].sort((a, b) => {
		if (mode === "latest") {
			const d = updatedMs(b) - updatedMs(a); // 최신 먼저
			if (d) return d;
		} else if (mode === "due") {
			const da = (a.due || "").trim();
			const db = (b.due || "").trim();
			if (da !== db) {
				if (!da) return 1; // 마감 없음 → 아래로
				if (!db) return -1;
				return da < db ? -1 : 1; // YYYY-MM-DD 는 사전순 = 시간순
			}
		} else {
			const d = priorityRank(a.priority) - priorityRank(b.priority);
			if (d) return d;
			const da = (a.due || "").trim();
			const db = (b.due || "").trim();
			if (da !== db) {
				if (!da) return 1;
				if (!db) return -1;
				return da < db ? -1 : 1;
			}
		}
		// 공통 꼬리 — 티켓 이름 내림차순
		return (b.key || "").localeCompare(a.key || "", undefined, {
			numeric: true,
			sensitivity: "base",
		});
	});
}
export function kanbanColumns(list: Ticket[], mode: TicketSort = "priority"): Kanban[] {
	const cols: [string, string][] = [
		["indeterminate", "진행 중"],
		["new", "할 일"],
		["done", "완료"],
	];
	const seen: Record<string, boolean> = {};
	const out: Kanban[] = cols.map(([cat, title]) => {
		const items = sortTickets(
			list.filter((t) => (t.statusCat || "") === cat),
			mode,
		);
		items.forEach((t) => (seen[t.key] = true));
		return { title, cat, items };
	});
	const rest = sortTickets(list.filter((t) => !seen[t.key]), mode);
	if (rest.length) out.push({ title: "기타", cat: "rest", items: rest });
	return out;
}

/* ── config ── */
export function normCfg(c?: Partial<Config> | null): Config {
	const s = c || {};
	return {
		owner: s.owner || "",
		jiraBase: s.jiraBase || "",
	};
}

/* ── space autocomplete ── */
// 과거 라벨 + 현재 문서 라벨 합치기(대소문자 무시 중복 제거, 과거 순서 유지).
export function mergeSpaceLabels(
	history: string[],
	doc: Doc | null | undefined,
): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	const push = (raw: string) => {
		const t = (raw || "").trim();
		const k = t.toLowerCase();
		if (!t || seen.has(k)) return;
		seen.add(k);
		out.push(t);
	};
	for (const s of history || []) push(s);
	if (doc?.scrum) {
		for (const w of ["prev", "today"] as const) {
			for (const sp of doc.scrum[w]?.spaces || []) push(sp.label || "");
		}
	}
	if (doc?.sections) {
		for (const sec of doc.sections)
			if (sec.kind === "list")
				for (const it of sec.items || []) push(it.space || "");
	}
	return out;
}

/* ── 일일 진행 업무 스페이스 그룹핑 (데일리 스크럼처럼 보여주기) ── */
export type ListGroup = {
	label: string; // "" = 무그룹(기본 영역)
	items: { it: ListItem; index: number }[]; // index = 원본 배열상 절대 위치(순번 배지·드래그에 사용)
};
// 원본 배열 순서/인덱스는 보존하면서 space 별로 묶음. 무그룹("")은 항상 첫 번째, 이후 최초 등장 순.
export function groupListItems(items: ListItem[]): ListGroup[] {
	const order: string[] = [""];
	const bucket = new Map<string, { it: ListItem; index: number }[]>([["", []]]);
	items.forEach((it, index) => {
		const label = (it.space || "").trim();
		let arr = bucket.get(label);
		if (!arr) {
			arr = [];
			bucket.set(label, arr);
			order.push(label);
		}
		arr.push({ it, index });
	});
	return order.map((label) => ({ label, items: bucket.get(label) ?? [] }));
}
// 그룹(스페이스) 라벨 일괄 수정 — 해당 라벨을 쓰는 모든 항목의 space 를 새 값으로 변경.
export function renameListSpace(
	items: ListItem[],
	oldLabel: string,
	newLabel: string,
): void {
	const from = (oldLabel || "").trim();
	const to = (newLabel || "").trim();
	for (const it of items) if ((it.space || "").trim() === from) it.space = to;
}
// 스페이스(그룹) 순서 이동 — 명명된 스페이스 블록을 통째로 위/아래로 옮긴다.
// 무그룹("")은 항상 맨 위로 고정되므로 순서 변경 대상에서 제외한다.
export function moveListSpace(
	items: ListItem[],
	label: string,
	dir: -1 | 1,
): boolean {
	const groups = groupListItems(items);
	const named = groups.slice(1); // 무그룹 제외
	const from = named.findIndex((g) => g.label === (label || "").trim());
	if (from < 0) return false;
	const to = from + dir;
	if (to < 0 || to >= named.length) return false;
	const [moved] = named.splice(from, 1);
	named.splice(to, 0, moved);
	// 재조립: 무그룹 항목 먼저, 이후 새 순서의 명명 그룹(각 그룹 내부 순서는 유지)
	const rebuilt: ListItem[] = [
		...groups[0].items.map((x) => x.it),
		...named.flatMap((g) => g.items.map((x) => x.it)),
	];
	items.splice(0, items.length, ...rebuilt);
	return true;
}
// 단일 항목 스페이스 이동 — 드래그로 다른 스페이스(또는 무그룹)에 떨어뜨릴 때 사용.
// 원본 배열 순서는 그대로 둬 groupListItems 가 space 로 묶을 때 번호/순서가 자연스럽게 유지되게 한다.
export function moveItemToSpace(
	items: ListItem[],
	fromIndex: number,
	spaceLabel: string,
): boolean {
	const it = items[fromIndex];
	if (!it) return false;
	it.space = (spaceLabel || "").trim();
	return true;
}

// 배열 안 순서 이동 — place=before|after 로 목표 인덱스 기준 삽입.
// (before만 쓰면 마지막 행에 드롭해도 맨 끝이 될 수 없음)
export function moveArrayItem<T>(
	arr: T[],
	from: number,
	target: number,
	place: "before" | "after" = "before",
): boolean {
	if (from < 0 || from >= arr.length || target < 0 || target >= arr.length) {
		return false;
	}
	if (place === "before" && from === target) return false;
	if (place === "after" && from === target) return false;
	const [moved] = arr.splice(from, 1);
	const insertAt =
		place === "before"
			? from < target
				? target - 1
				: target
			: from < target
				? target
				: target + 1;
	arr.splice(insertAt, 0, moved);
	return true;
}

// 같은(또는 지정) 스페이스의 맨 끝으로 이동 — 스페이스 빈 영역 드롭용.
export function moveItemToSpaceEnd(
	items: ListItem[],
	fromIndex: number,
	spaceLabel: string,
): boolean {
	const it = items[fromIndex];
	if (!it) return false;
	const space = (spaceLabel || "").trim();
	let lastInSpace = -1;
	for (let i = 0; i < items.length; i++) {
		if ((items[i].space || "").trim() === space) lastInSpace = i;
	}
	if (fromIndex === lastInSpace) {
		it.space = space;
		return false;
	}
	const [moved] = items.splice(fromIndex, 1);
	moved.space = space;
	lastInSpace = -1;
	for (let i = 0; i < items.length; i++) {
		if ((items[i].space || "").trim() === space) lastInSpace = i;
	}
	items.splice(lastInSpace + 1, 0, moved);
	return true;
}
