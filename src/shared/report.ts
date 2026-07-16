// report.ts — 주간업무보고(Fri~Thu) 집계. 순수 로직(부작용 없음 → 테스트 대상).
// 하이브리드 원칙: 티켓키·진척%·마감일 등 "숫자/식별자"는 여기서 결정적으로 확정하고,
// 에이전트는 buildAgentPrompt()가 준 digest의 서술만 다듬는다(숫자 변조 금지 규칙 포함).
import { fmtMeta, type TaskRow } from "./model.ts";

// ───────────────────────── 기간 계산 (전주 금 ~ 금주 목) ─────────────────────────
// 로컬 날짜 기준(TZ 안전). Thu=4. 기준일이 속한 보고주기의 목요일(to)과 그 6일 전 금요일(from).
//  - 목요일 실행 → to=오늘, from=지난 금요일
//  - 금요일 실행 → 새 주기 시작 → to=다음 목요일, from=오늘(금)
function toYmd(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}
function addDays(d: Date, n: number): Date {
	const c = new Date(d.getFullYear(), d.getMonth(), d.getDate());
	c.setDate(c.getDate() + n);
	return c;
}
export function weekWindow(ref: Date = new Date()): {
	from: string;
	to: string;
} {
	const dow = ref.getDay(); // 0=일 … 4=목 … 6=토
	const untilThu = (4 - dow + 7) % 7; // 기준일 이후(포함) 첫 목요일까지 일수
	const to = addDays(ref, untilThu); // 보고주기 끝 = 목요일
	const from = addDays(to, -6); // 시작 = 그 주 금요일
	return { from: toYmd(from), to: toYmd(to) };
}

// ───────────────────────── digest 집계 ─────────────────────────
export type DigestTask = {
	key: string; // 티켓키(확정, 변조 금지)
	desc: string; // 대표 서술
	progress: number | null; // 주간 최대 진척%
	due: string; // 최신 마감(YYYY-MM-DD 또는 원문)
	dates: string[]; // 이 항목이 등장한 날짜들(오름차순)
	notes: string[]; // 부가 서술(중복 제거) — 요일별 파편
	subs: string[]; // 하위 항목 — 최신 날짜의 subs(가장 완성된 상태)
};
export type DigestSpace = { label: string; tasks: DigestTask[] };
// 요일별 원본 로그(병합 전) — 에이전트가 서술을 더 정확히 병합하도록 참고용으로 함께 전달.
export type RawEntry = {
	side: string;
	space: string;
	key: string;
	desc: string;
	progress: number | null;
	due: string;
	subs: string[];
};
export type RawDay = { date: string; entries: RawEntry[] };
export type WeeklyDigest = {
	from: string;
	to: string;
	owner: string;
	spaces: DigestSpace[];
	count: number;
	raw: RawDay[];
};

// side ∈ prev|today|daily. 'prev'(전일 재기술)는 중복이라 제외 — 실제 수행분(today/daily)만.
const isWorkSide = (s: string) => s === "today" || s === "daily";
const NO_SPACE = "기타";

// 티켓키(또는 서술)로 전역 dedupe — 같은 티켓이 일일/스크럼 양쪽에 있어도 1건으로 병합.
// 스페이스는 row.space 그대로 쓰고, 비어있으면 "기타".
// 진척=최댓값, 마감=최신, 날짜/노트=합집합.
type ResolvedTask = DigestTask & { space: string };
export function buildWeeklyDigest(
	rows: TaskRow[],
	owner = "",
	from = "",
	to = "",
): WeeklyDigest {
	const byKey = new Map<string, ResolvedTask>();
	const order: string[] = [];

	for (const r of rows) {
		if (!isWorkSide(r.side)) continue;
		const key = (r.key || "").trim();
		const desc = (r.desc || "").trim();
		if (!key && !desc) continue;
		const dedupe = (key || desc).toUpperCase();
		const rowSpace = (r.space || "").trim();

		const cur = byKey.get(dedupe);
		if (!cur) {
			byKey.set(dedupe, {
				key,
				desc,
				progress: typeof r.progress === "number" ? r.progress : null,
				due: r.due || "",
				dates: r.date ? [r.date] : [],
				notes: desc ? [desc] : [],
				subs: (r.subs || []).slice(),
				space: rowSpace,
			});
			order.push(dedupe);
		} else {
			if (typeof r.progress === "number")
				cur.progress =
					cur.progress == null
						? r.progress
						: Math.max(cur.progress, r.progress);
			if (r.due && r.due > cur.due) cur.due = r.due;
			if (r.date && !cur.dates.includes(r.date)) cur.dates.push(r.date);
			if (!cur.desc && desc) cur.desc = desc;
			if (desc && !cur.notes.includes(desc)) cur.notes.push(desc);
			if (r.subs && r.subs.length) cur.subs = r.subs.slice(); // 최신(날짜순 마지막) 하위 항목이 이김
			if (!cur.space && rowSpace) cur.space = rowSpace; // 스페이스 보완
		}
	}

	// 병합된 항목들을 스페이스별로 묶음(처음 등장 순서 유지).
	const spaceOrder: string[] = [];
	const bySpace = new Map<string, DigestTask[]>();
	for (const dk of order) {
		const t = byKey.get(dk)!;
		const label = t.space || NO_SPACE;
		t.dates.sort();
		if (!bySpace.has(label)) {
			bySpace.set(label, []);
			spaceOrder.push(label);
		}
		bySpace
			.get(label)!
			.push({
				key: t.key,
				desc: t.desc,
				progress: t.progress,
				due: t.due,
				dates: t.dates,
				notes: t.notes,
				subs: t.subs,
			});
	}
	const spaces: DigestSpace[] = spaceOrder.map((label) => ({
		label,
		tasks: bySpace.get(label)!,
	}));
	return { from, to, owner, spaces, count: byKey.size, raw: buildRaw(rows) };
}

// 요일별 원본 로그(work side만, 날짜 오름차순). 병합 전 상태를 그대로 보존.
function buildRaw(rows: TaskRow[]): RawDay[] {
	const byDate = new Map<string, RawEntry[]>();
	const order: string[] = [];
	for (const r of rows) {
		if (!isWorkSide(r.side)) continue;
		const key = (r.key || "").trim();
		const desc = (r.desc || "").trim();
		if (!key && !desc) continue;
		const date = r.date || "";
		if (!byDate.has(date)) {
			byDate.set(date, []);
			order.push(date);
		}
		byDate.get(date)!.push({
			side: r.side,
			space: (r.space || "").trim(),
			key,
			desc,
			progress: typeof r.progress === "number" ? r.progress : null,
			due: r.due || "",
			subs: (r.subs || []).slice(),
		});
	}
	return order.sort().map((date) => ({ date, entries: byDate.get(date)! }));
}

// ───────────────────────── 결정적 렌더(에이전트 없이도 붙여넣기 가능한 fallback) ─────────────────────────
// 하우스 스타일: 스페이스 헤더 `[..]`, 최상위 `ㅇ[키] 서술 (진척%, ~M/D)`, 요일 파편은 `  - ` 하위 불릿.
export function renderDigestText(d: WeeklyDigest): string {
	const L: string[] = [];
	if (!d.spaces.length) {
		L.push("(해당 기간 항목 없음)");
		return L.join("\n");
	}
	d.spaces.forEach((sp, i) => {
		if (i > 0) L.push(""); // 스페이스 블록 사이에만 빈 줄
		L.push(`[${sp.label}]`);
		for (const t of sp.tasks) {
			const head = t.key
				? `[${t.key}]${t.desc ? " " + t.desc : ""}`
				: t.desc || "(내용)";
			L.push(`ㅇ${head}${fmtMeta(t.progress, t.due)}`);
			// 하위 불릿: 실제 subs 우선, 없으면 요일별 notes 파편으로 대체.
			const subs = t.subs.length
				? t.subs
				: t.notes.filter((n) => n && n !== t.desc);
			for (const s of subs) L.push(`  - ${s}`);
		}
	});
	return L.join("\n");
}

// ───────────────────────── 에이전트 스킬 프롬프트(내장) ─────────────────────────
// 하이브리드 핵심: 숫자/티켓키는 절대 바꾸지 말고 서술만 다듬으라는 강한 제약.
// 기본값은 override 가능. 플레이스홀더 {from} {to} {owner} 치환, {data}가 있으면 그 자리에, 없으면 맨 뜼에 집계 JSON 첨부.
export const DEFAULT_REPORT_PROMPT = [
	"너는 연구개발센터 주간업무보고를 다듬는 도우미다. 아래 [집계 데이터]를 Microsoft Teams 채팅에",
	"그대로 붙여넣을 수 있는 아래 '출력 스타일'로만 정리해라.",
	"",
	"## 절대 규칙 (위반 금지)",
	"- 티켓키(예: OPIT-1730, CLOUD-432), 진척%, 마감일(~날짜) 는 데이터에 있는 값을 한 글자도 바꾸지 마라.",
	"- 없는 티켓·수치·날짜를 새로 만들지 마라. 데이터에 없으면 쓰지 마라.",
	"- 스페이스([...]) 구조와 소속을 유지해라.",
	"",
	"## 입력 데이터",
	"- [집계 데이터] = 확정 병합본. 티켓키·진척%·마감·subs 최종값은 반드시 이 값을 그대로 사용.",
	"- [원본 로그] = 요일별 원본(병합 전). 서술 병합·검토 참고용이며 수치는 [집계 데이터] 우선.",
	"",
	"## 다듬기 지침",
	"- 같은 항목이 여러 날 등장하면 원본 로그의 요일별 파편을 자연스러운 주간 서술 한 문장으로 병합해라.",
	"- 의미가 구분되는 세부 작업은 하위 불릿(`  - `)로 나눠 적되, 새 티켓·수치는 지어내지 마라.",
	"- 군더더기·중복 표현을 정리하되 사실은 보존해라. 한국어 존댓말 없이 간결한 개조식(-임/-함/명사형).",
	"- 출력은 붙여넣기용 순수 텍스트만. 코드블록/설명/머리말 붙이지 마라.",
	"",
	"## 출력 스타일 (이 형식을 정확히 따를 것)",
	"- 스페이스 헤더는 대괄호: `[스페이스명]`",
	"- 최상위 업무는 글머리 `ㅇ` 로 시작: `ㅇ[티켓키] 서술 (진척%, ~M/D)`",
	"- 하위 항목: `  - 서술 (진척%)`  /  더 깊게: `    > 서술`",
	"- 진척/마감: 둘 다 `(100%, ~7/23)`, 진척만 `(50%)`, 없으면 생략",
	"- 항목 사이엔 빈 줄 없이 붙이고, 스페이스 블록 사이에만 빈 줄 1개",
	"",
	"## 예시 (형식만 참고, 내용은 데이터로)",
	"[Openstackit 3.4]",
	"ㅇ[OPIT-1482] Instance HA GPU 복구 로직 추가 (70%, ~7/31)",
	"  - GPU 인스턴스 탐지 로직 구현 (100%, ~7/24)",
	"  - GPU 인스턴스 HA 테스트 (60%, ~7/31)",
	"    > 입력방법 변경에 따른 화면 수정 (100%)",
	"",
	"## 출력은 첫 줄부터 스페이스 헤더([...])로 시작. 상단 제목/기간 헤더는 붙이지 마라.",
].join("\n");

export function buildAgentPrompt(
	d: WeeklyDigest,
	customPrompt?: string,
): string {
	const tpl =
		customPrompt && customPrompt.trim() ? customPrompt : DEFAULT_REPORT_PROMPT;
	const digestJson = JSON.stringify(digestForPrompt(d), null, 2);
	const rawJson = JSON.stringify(d.raw ?? [], null, 2);
	const dataBlock = [
		"## [집계 데이터] (확정 — 티켓키·진척·마감·subs는 이 값 그대로)",
		digestJson,
		"",
		"## [원본 로그] (요일별 원본 — 서술 병합·검토 참고용, 수치는 집계 우선)",
		rawJson,
	].join("\n");
	const filled = tpl
		.split("{from}")
		.join(d.from)
		.split("{to}")
		.join(d.to)
		.split("{owner}")
		.join(d.owner || "");
	return filled.includes("{data}")
		? filled.split("{data}").join(dataBlock)
		: filled + "\n\n" + dataBlock;
}

// 프롬프트에 넣을 최소 데이터(모델 노이즈 축소).
function digestForPrompt(d: WeeklyDigest) {
	return {
		from: d.from,
		to: d.to,
		owner: d.owner,
		spaces: d.spaces.map((sp) => ({
			space: sp.label,
			tasks: sp.tasks.map((t) => ({
				key: t.key || undefined,
				desc: t.desc || undefined,
				progress: t.progress ?? undefined,
				due: t.due || undefined,
				dates: t.dates,
				subs: t.subs.length ? t.subs : undefined,
				notes: t.subs.length
					? undefined
					: t.notes.length
						? t.notes
						: [t.desc].filter(Boolean),
			})),
		})),
	};
}
