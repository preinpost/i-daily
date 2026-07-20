// 순수 로직 · 문서 헬퍼 — 기존 client.js 의 전역 함수들을 인자 기반 순수 함수로 옮김.
// 부작용(toast·렌더) 없음. 컴포넌트가 doc/scrum 을 변형한 뒤 bump() 로 리렌더.
import type {
	Block,
	Config,
	Doc,
	ListItem,
	Meta,
	Scrum,
	Section,
	Space,
	Task,
	Ticket,
	Which,
} from "../types";

type CopySrc = {
	key?: string;
	desc?: string;
	progress?: number | "";
	due?: string;
	subs?: string[];
};

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
export function blockHasContent(b?: Block): boolean {
	if (!b) return false;
	if ((b.issues || "").trim() && (b.issues || "").trim() !== "없음")
		return true;
	if ((b.collab || "").trim() && (b.collab || "").trim() !== "없음")
		return true;
	return (b.spaces || []).some(
		(sp) =>
			(sp.label || "").trim() ||
			(sp.tasks || []).some(
				(t) =>
					(t.key || "").trim() ||
					(t.desc || "").trim() ||
					(t.subs || []).some((s) => (s || "").trim()),
			),
	);
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
export function snapListItem(it: ListItem): Task {
	return {
		key: it.key || "",
		desc: it.desc || "",
		progress: typeof it.progress === "number" ? it.progress : "",
		due: it.due || "",
		subs: (it.subs || []).slice(),
	};
}
export function listItemToTask(it: ListItem): Task {
	return snapListItem(it);
}
// 일일 항목 ↔ 스크럼 태스크 매칭 ID. 티켓 키 우선, 없으면 설명.
export function itemId(it?: { key?: string; desc?: string } | null): string {
	if (!it) return "";
	const key = (it.key || "").trim().toUpperCase();
	if (key) return "k:" + key;
	const desc = (it.desc || "").trim();
	return desc ? "d:" + desc : "";
}
export function dailyItemLabel(
	it: { key?: string; desc?: string },
	order?: number | null,
): string {
	const k = (it.key || "").trim();
	const d = (it.desc || "").trim();
	const base = k && d ? k + " · " + d : k || d || "(빈 항목)";
	return order != null && order > 0 ? order + ". " + base : base;
}
// 일일 진행 업무에서의 1-based 순번. 없으면 null (스크럼 고아 항목 등).
export function dailyOrder(doc: Doc, id: string): number | null {
	if (!id) return null;
	const idx = todayDailyItems(doc).findIndex((it) => itemId(it) === id);
	return idx >= 0 ? idx + 1 : null;
}
export function dailyOptions(doc: Doc): ListItem[] {
	return todayDailyItems(doc).filter((it) => !!itemId(it));
}
export function findDailyById(doc: Doc, id: string): ListItem | null {
	if (!id) return null;
	return dailyOptions(doc).find((it) => itemId(it) === id) || null;
}
export function usedIdsInBlock(block: Block, exceptTask?: Task): Set<string> {
	const s = new Set<string>();
	(block.spaces || []).forEach((sp) =>
		(sp.tasks || []).forEach((t) => {
			if (exceptTask && t === exceptTask) return;
			const id = itemId(t);
			if (id) s.add(id);
		}),
	);
	return s;
}
// 일일 마스터 → 스크럼 태스크의 키/설명/하위만 동기화(진척·마감은 유지).
export function applyDailyMaster(
	t: Task,
	src: { key?: string; desc?: string; subs?: string[] },
): void {
	if (!t || !src) return;
	t.key = src.key || "";
	t.desc = src.desc || "";
	t.subs = (src.subs || []).slice();
}
// 일일 항목이 바뀌면 같은 ID 를 쓰던 전일/금일 태스크를 따라가게 함.
export function syncScrumFromDailyChange(
	scrum: Scrum,
	prevId: string,
	it: ListItem,
): void {
	const newId = itemId(it);
	(["prev", "today"] as Which[]).forEach((which) => {
		(scrum[which].spaces || []).forEach((sp) =>
			(sp.tasks || []).forEach((t) => {
				const tid = itemId(t);
				if ((prevId && tid === prevId) || (newId && tid === newId))
					applyDailyMaster(t, it);
			}),
		);
	});
}
export function isScrumDup(block: Block, it: ListItem): boolean {
	const id = itemId(it);
	if (!id) return false;
	return usedIdsInBlock(block).has(id);
}
// 일일 진행 항목 → 스크럼 블록으로 복사. 결과 { ok, msg } 반환(토스트는 호출부).
// targetSp 없으면 라벨 없는 스페이스에 넣거나 새로 만든다.
export function copyListItemToScrum(
	scrum: Scrum,
	which: Which,
	it: CopySrc,
	targetSp?: Space | null,
): { ok: boolean; msg: string } {
	if (!itemId(it)) return { ok: false, msg: "빈 항목은 복사할 수 없어요" };
	const block = scrum[which];
	if (isScrumDup(block, it as ListItem))
		return {
			ok: false,
			msg: "이미 " + (which === "prev" ? "전일" : "금일") + "에 있어요",
		};
	let sp = targetSp || null;
	if (!sp) {
		sp = (block.spaces || []).find((s) => !(s.label || "").trim()) || null;
		if (!sp) {
			sp = { label: "", tasks: [] };
			block.spaces.push(sp);
		}
	}
	sp.tasks.push({
		key: it.key || "",
		desc: it.desc || "",
		progress: typeof it.progress === "number" ? it.progress : "",
		due: it.due || "",
		subs: (it.subs || []).slice(),
	});
	return {
		ok: true,
		msg:
			(it.key || it.desc) +
			" → " +
			(which === "prev" ? "전일" : "금일") +
			" 등록",
	};
}

export function isMissing(t: Task): boolean {
	return (
		(t.progress === "" || t.progress == null || t.due === "") &&
		!!(t.key || t.desc)
	);
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

export type Kanban = { title: string; cat: string; items: Ticket[] };
export function kanbanColumns(list: Ticket[]): Kanban[] {
	const cols: [string, string][] = [
		["indeterminate", "진행 중"],
		["new", "할 일"],
		["done", "완료"],
	];
	const seen: Record<string, boolean> = {};
	const out: Kanban[] = cols.map(([cat, title]) => {
		const items = list.filter((t) => (t.statusCat || "") === cat);
		items.forEach((t) => (seen[t.key] = true));
		return { title, cat, items };
	});
	const rest = list.filter((t) => !seen[t.key]);
	if (rest.length) out.push({ title: "기타", cat: "rest", items: rest });
	return out;
}

/* ── config ── */
export function normCfg(c?: Partial<Config> | null): Config {
	const s = c || {};
	return {
		owner: s.owner || "",
		jiraBase: s.jiraBase || "",
		jiraClientId: s.jiraClientId || "",
		jiraClientSecret: s.jiraClientSecret || "",
		reportAgent: s.reportAgent || "",
		reportPrompt: s.reportPrompt || "",
		kakaoRestKey: s.kakaoRestKey || "",
		lunchLat: s.lunchLat || "",
		lunchLng: s.lunchLng || "",
		lunchRadius: s.lunchRadius || "1000",
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
	return out;
}
