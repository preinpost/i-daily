import { test, expect } from "./tiny.ts";
import {
	parseScrum,
	renderScrum,
	parseList,
	renderList,
	parseDoc,
	serializeDoc,
	dailyToBlock,
	renderScrumHtml,
	todayStr,
	kstParts,
	appendDailyTasks,
	appendMemo,
	emptyDoc,
	dailyItemsOf,
	parseTeamsPaste,
	parseTeamsTaskLine,
} from "../src/shared/model.ts";
import {
	kanbanColumns,
	moveArrayItem,
	moveItemToSpaceEnd,
	priorityLevel,
} from "../src/renderer/src/lib/model.ts";

// jiraBase 는 렌더 함수에 인자로 전달(전역 아님). host만 — /browse/ 는 자동.
const JIRA = "https://jira.test";

// ── KST 날짜 보정 (Workers 등 UTC 런타임에서 KST 00~09시 어긋남 방지) ──
test("todayStr: UTC 자정~09시(KST 다음날)에도 KST 날짜 반환", () => {
	// UTC 2026-07-21 23:58 = KST 2026-07-22 08:58 → 22일
	expect(todayStr(new Date("2026-07-21T23:58:00Z"))).toBe("2026-07-22");
});
test("todayStr: KST 자정 경계 — 15:00Z 이전은 당일, 이후는 다음날", () => {
	// UTC 14:59:59 = KST 23:59:59 → 21일
	expect(todayStr(new Date("2026-07-21T14:59:59Z"))).toBe("2026-07-21");
	// UTC 15:00:00 = KST 00:00:00 → 22일
	expect(todayStr(new Date("2026-07-21T15:00:00Z"))).toBe("2026-07-22");
});
test("kstParts: 월말 넘침 · 요일(KST 기준)", () => {
	// UTC 2026-07-31 16:00 = KST 2026-08-01 01:00 (토)
	const p = kstParts(new Date("2026-07-31T16:00:00Z"));
	expect(p).toEqual({ y: 2026, m: 8, day: 1, dow: 6 });
});

test("scrum 왕복: 태스크·하위·마감 연도추론 보존", () => {
	const md = [
		"**[금일 진행 업무]**",
		"- 업무 계획",
		"  + **[backend]**",
		"    + [OPIT-1756](https://x/OPIT-1756) merge (30%, ~7/17)",
		"        + 미 merge 항목 정리",
		"- 이슈 사항: 없음",
		"- 협업 및 기타: 없음",
	].join("\n");
	const s = parseScrum(md, 2026);
	const t = s.today.spaces[0].tasks[0];
	expect(t.key).toBe("OPIT-1756");
	expect(t.due).toBe("2026-07-17"); // ~7/17 → 노트 연도(2026)로 추론
	expect(t.progress).toBe(30);
	expect(t.subs).toEqual(["미 merge 항목 정리"]);
	const out = renderScrum(JIRA, s);
	expect(out).toContain(
		"+ [OPIT-1756](https://jira.test/browse/OPIT-1756) merge (30%, ~7/17)",
	);
	expect(out).toContain("        + 미 merge 항목 정리");
});

test("체크리스트: [x]/[ ]/평불릿 파싱, 렌더는 평불릿(체크박스 없음)", () => {
	const items = parseList(
		"- [x] done one\n- [ ] [OPIT-1](u) two\n    - sub\n- three",
	);
	expect(items.length).toBe(3);
	expect(items[1].key).toBe("OPIT-1");
	expect(items[1].subs).toEqual(["sub"]);
	const out = renderList(JIRA, items);
	expect(out).not.toContain("[x]");
	expect(out).not.toContain("[ ]");
	expect(out).toContain("- done one");
});

test("체크리스트: 스페이스 그룹 렌더·파싱 왕복(무그룹 먼저, 그룹별 헤더·하위)", () => {
	const items = [
		{ done: false, key: "", desc: "unlabeled", subs: [] },
		{
			done: false,
			key: "OPIT-2",
			desc: "backend work",
			progress: 30 as number | "",
			due: "2026-07-17",
			subs: ["sub note"],
			space: "backend",
		},
		{
			done: false,
			key: "",
			desc: "frontend work",
			subs: [],
			space: "frontend",
		},
	];
	const out = renderList(JIRA, items as any);
	expect(out).toBe(
		[
			"- unlabeled",
			"  + **[backend]**",
			"    + [OPIT-2](https://jira.test/browse/OPIT-2) backend work (30%, ~7/17)",
			"        + sub note",
			"  + **[frontend]**",
			"    + frontend work",
		].join("\n"),
	);
	const parsed = parseList(out, 2026);
	expect(parsed.map((it) => it.space)).toEqual(["", "backend", "frontend"]);
	expect(parsed[1].key).toBe("OPIT-2");
	expect(parsed[1].progress).toBe(30);
	expect(parsed[1].due).toBe("2026-07-17");
	expect(parsed[1].subs).toEqual(["sub note"]);
	expect(parsed[2].desc).toBe("frontend work");
});

test("dailyToBlock: 항목의 space 그대로 복수 스페이스로 그룹핑(최초 등장 순)", () => {
	const block = dailyToBlock([
		{ done: false, key: "A-1", desc: "a", subs: [], space: "backend" },
		{ done: false, key: "", desc: "b", subs: [] },
		{ done: false, key: "A-2", desc: "c", subs: [], space: "backend" },
	]);
	expect(block.spaces.map((s) => s.label)).toEqual(["backend", ""]);
	expect(block.spaces[0].tasks.map((t) => t.desc)).toEqual(["a", "c"]);
	expect(block.spaces[1].tasks.map((t) => t.desc)).toEqual(["b"]);
});

test("parseDoc: 섹션 순서·kind, 스크럼 구조화, raw 통과, 미지 섹션 보존", () => {
	const md =
		"## 일일 진행 업무\n- did a\n\n## 데일리 스크럼\n\n**[금일 진행 업무]**\n- 이슈 사항: 없음\n- 협업 및 기타: 없음\n\n## 메모\nfree text\n\n## 회고\n- good";
	const doc = parseDoc(md, "2026-07-10");
	expect(doc.sections.map((s) => [s.title, s.kind])).toEqual([
		["일일 진행 업무", "list"],
		["데일리 스크럼", "scrum"],
		["메모", "raw"],
		["회고", "raw"],
	]);
	const memo = doc.sections.find((s) => s.title === "메모") as any;
	expect(memo.body).toBe("free text");
	expect(serializeDoc(JIRA, doc)).toContain("## 회고"); // 미지 섹션 보존
});

test("dailyToBlock: done→100, 단일 스페이스 그룹핑, 하위 보존", () => {
	const block = dailyToBlock([
		{ done: true, key: "", desc: "no ticket", subs: [] },
		{ done: false, key: "OPIT-9", desc: "with ticket", subs: ["a"] },
	]);
	expect(block.spaces.length).toBe(1);
	expect(block.spaces[0].label).toBe("");
	expect(block.spaces[0].tasks.map((t) => t.desc)).toEqual([
		"no ticket",
		"with ticket",
	]);
	expect(block.spaces[0].tasks[0].progress).toBe(100);
	expect(block.spaces[0].tasks[1].progress).toBe("");
	expect(block.spaces[0].tasks[1].subs).toEqual(["a"]);
});

test("renderScrumHtml: 굵은 헤더 · 중첩 ul · 티켓 링크", () => {
	const s = parseScrum(
		"**[금일 진행 업무]**\n  + **[sp]**\n    + [K-1](https://x/K-1) d (50%, ~7/1)\n- 이슈 사항: 없음\n- 협업 및 기타: 없음",
		2026,
	);
	const html = renderScrumHtml(JIRA, s);
	expect(html).toContain("<b>[금일 진행 업무]</b>");
	expect(html).toContain('<a href="https://jira.test/browse/K-1">[K-1]</a>');
	expect(html).toContain("<ul>");
});

test("renderScrum/Html: 빈 스페이스 라벨을 [?] 아닌 [스페이스 없음]으로 표시", () => {
	// space 미지정 항목 → dailyToBlock 은 label="" 그룹으로 묶음
	const block = dailyToBlock([
		{ done: false, key: "OPIT-1", desc: "no space", subs: [] },
	]);
	expect(block.spaces[0].label).toBe("");
	const s = {
		prev: block,
		today: { spaces: [], issues: "없음", collab: "없음" },
	};
	const md = renderScrum(JIRA, s as any);
	expect(md).toContain("**[스페이스 없음]**");
	expect(md).not.toContain("[?]");
	const html = renderScrumHtml(JIRA, s as any);
	expect(html).toContain("[스페이스 없음]");
	expect(html).not.toContain("[?]");
});

// ── 내 티켓 정렬 ── 마감 임박 우선 · 마감 없음 최하단 · 동일 마감이면 키 내림차순
test("kanbanColumns: 마감 임박 순 · 마감 없으면 맨 아래 · 동일 마감은 키 내림차순", () => {
	const mk = (key: string, due: string, statusCat = "new") =>
		({ key, due, statusCat, summary: "", status: "", url: "" }) as any;
	const cols = kanbanColumns([
		mk("AB-1", ""),
		mk("AB-9", "2026-03-10"),
		mk("AB-2", "2026-01-05"),
		mk("AB-10", "2026-01-05"),
		mk("AB-3", ""),
	]);
	const todo = cols.find((c) => c.cat === "new")!;
	expect(todo.items.map((t: any) => t.key).join(",")).toBe(
		"AB-10,AB-2,AB-9,AB-3,AB-1",
	);
});

// ── 내 티켓 정렬 ── 우선순위 높은 순이 젤 먼저(마감/키보다 우선)
test("kanbanColumns: 우선순위 높은 순이 첫 조건 — 마감이 빨라도 낮은 우선순위가 뒤로", () => {
	const mk = (key: string, priority: string, due: string, statusCat = "new") =>
		({ key, priority, due, statusCat, summary: "", status: "", url: "" }) as any;
	const cols = kanbanColumns([
		mk("AB-1", "Low", "2026-01-01"), // 마감이 제일 빠르지만 낮은 우선순위
		mk("AB-2", "Highest", ""), // 우선순위 최상 · 마감 없음
		mk("AB-3", "high", "2026-06-01"), // 대소문자 무시
		mk("AB-4", "Medium", "2026-03-01"),
		mk("AB-5", "", "2026-02-01"), // 우선순위 없음 → 맨 아래
		mk("AB-6", "CustomPrio", "2026-02-01"), // 표준 외 → Lowest 아래
	]);
	const todo = cols.find((c) => c.cat === "new")!;
	expect(todo.items.map((t: any) => t.key).join(",")).toBe(
		"AB-2,AB-3,AB-4,AB-1,AB-6,AB-5",
	);
});

// ── 우선순위 배지 레벨 ── 표준 5단계만 1..5, 커스텀/미지정은 0
test("priorityLevel: 표준 5단계(Highest=1 … Lowest=5), 그 외 0", () => {
	expect(priorityLevel("Highest")).toBe(1);
	expect(priorityLevel("highest")).toBe(1); // 대소문자 무시
	expect(priorityLevel("High")).toBe(2);
	expect(priorityLevel("Medium")).toBe(3);
	expect(priorityLevel("Low")).toBe(4);
	expect(priorityLevel("Lowest")).toBe(5);
	expect(priorityLevel("CustomPrio")).toBe(0);
	expect(priorityLevel("")).toBe(0);
});

// ── 정렬 모드(latest/due) ── 헤더의 정렬 선택이 칸반 컬럼 안 순서를 바꾼다
test("kanbanColumns: 최신순(latest) — updated 최신부터, 미지정은 맨 아래", () => {
	const mk = (key: string, updated: string, statusCat = "new") =>
		({ key, updated, statusCat, summary: "", status: "", url: "" }) as any;
	const cols = kanbanColumns(
		[
			mk("AB-1", "2026-01-01T09:00:00.000+0000"),
			mk("AB-2", "2026-06-01T09:00:00.000+0000"),
			mk("AB-3", ""),
			mk("AB-4", "2026-03-01T09:00:00.000+0000"),
		],
		"latest",
	);
	const todo = cols.find((c) => c.cat === "new")!;
	expect(todo.items.map((t: any) => t.key).join(",")).toBe("AB-2,AB-4,AB-1,AB-3");
});

test("kanbanColumns: 마감순(due) — 마감 임박부터, 마감 없으면 아래", () => {
	const mk = (key: string, due: string, statusCat = "new") =>
		({ key, due, statusCat, summary: "", status: "", url: "" }) as any;
	const cols = kanbanColumns(
		[
			mk("AB-1", ""),
			mk("AB-2", "2026-03-10"),
			mk("AB-3", "2026-01-05"),
			mk("AB-4", "2026-01-05"),
		],
		"due",
	);
	const todo = cols.find((c) => c.cat === "new")!;
	expect(todo.items.map((t: any) => t.key).join(",")).toBe("AB-4,AB-3,AB-2,AB-1");
});

// ── Teams 붙여넣기 → 일일 진행 ─────────────────────────
test("parseTeamsTaskLine: Jira 키만 key, [고객명]은 desc 유지, 진척률", () => {
	const a = parseTeamsTaskLine(
		"[OPIT-1534] DB Migration 재검토 (100%)",
		2026,
	)!;
	expect(a.key).toBe("OPIT-1534");
	expect(a.desc).toBe("DB Migration 재검토");
	expect(a.progress).toBe(100);
	const b = parseTeamsTaskLine(
		"[국가정보자원관리원] 시연 QnA 작성 (100%)",
		2026,
	)!;
	expect(b.key).toBe("");
	expect(b.desc).toBe("[국가정보자원관리원] 시연 QnA 작성");
	expect(b.progress).toBe(100);
});

test("parseTeamsPaste: Teams 평문 — 금일만 항목·이슈·협업(> 하위), 전일 무시", () => {
	const text = [
		"[전일 진행 업무]",
		"업무 계획",
		"[OPIT-1534] v3.1.2에서 v3.4.0으로 DB Migration 재검토 (100%)",
		"[국가정보자원관리원] 시연 QnA 작성 (100%)",
		"이슈 사항: 없음",
		"협업 및 기타:",
		"[OPIT-1413] 전일 협업 (70%)",
		"> 전일 하위",
		"[금일 진행 업무]",
		"업무 계획",
		"[한국수자원공사] 출장 결과 정리 및 공유 (100%)",
		"[OPIT-1776] Cyborg 조사 (50%)",
		"이슈 사항: 없음",
		"협업 및 기타:",
		"[OPIT-1413][인증>앱]에서[역할] 조회 문제 해결 (70%)",
		"> 인프라엔지니어링팀 피드백 지연",
	].join("\n");
	const r = parseTeamsPaste(text, 2026);
	expect(r.items.map((it) => [it.key, it.desc, it.progress])).toEqual([
		["", "[한국수자원공사] 출장 결과 정리 및 공유", 100],
		["OPIT-1776", "Cyborg 조사", 50],
	]);
	expect(r.issues).toBe("");
	expect(r.collab).toBe(
		"[OPIT-1413][인증>앱]에서[역할] 조회 문제 해결 (70%)\n\t인프라엔지니어링팀 피드백 지연",
	);
});

test("parseTeamsPaste: 헤더 없으면 전체를 금일로, 마크다운 스크럼도 금일만", () => {
	const flat = parseTeamsPaste(
		"[OPIT-1] alone (10%)\n이슈 사항: 네트워크\n> 재시도",
		2026,
	);
	expect(flat.items).toEqual([
		{
			done: false,
			key: "OPIT-1",
			desc: "alone",
			progress: 10,
			due: "",
			subs: [],
			space: "",
		},
	]);
	expect(flat.issues).toBe("네트워크\n\t재시도");

	const md = parseTeamsPaste(
		[
			"**[전일 진행 업무]**",
			"- 업무 계획",
			"  + **[backend]**",
			"    + [OPIT-9](https://x/OPIT-9) yesterday (100%)",
			"- 이슈 사항: 없음",
			"- 협업 및 기타: 없음",
			"",
			"**[금일 진행 업무]**",
			"- 업무 계획",
			"  + **[frontend]**",
			"    + [OPIT-2](https://x/OPIT-2) today (30%, ~7/17)",
			"        + sub note",
			"- 이슈 사항: 없음",
			"- 협업 및 기타: 리뷰 요청",
		].join("\n"),
		2026,
	);
	expect(md.items.length).toBe(1);
	expect(md.items[0].key).toBe("OPIT-2");
	expect(md.items[0].space).toBe("frontend");
	expect(md.items[0].progress).toBe(30);
	expect(md.items[0].due).toBe("2026-07-17");
	expect(md.items[0].subs).toEqual(["sub note"]);
	expect(md.collab).toBe("리뷰 요청");
});

test("parseTeamsPaste: 스페이스 [라벨] + 티켓 아래 평문 줄은 subs", () => {
	const text = [
		"[전일 진행 업무]",
		"업무 계획",
		"[CONE Watcher N]",
		"[IIPQ-10] [CONE Watcher N] 가이드(위키) 페이지 버전 관리 (100%, ~7/29)",
		"AX네이티브테크실 요청사항",
		"Cloudflare D1 -> MongoDB로 교체",
		"이슈 사항: 없음",
		"협업 및 기타",
		"CONE Watcher N 가이드 관련 회의",
		"[금일 진행 업무]",
		"업무 계획",
		"[CONE Watcher N]",
		"[IIPQ-10] [CONE Watcher N] 가이드(위키) 페이지 버전 관리(수정 이력) 기능 추가 (90%, ~7/31)",
		"AX네이티브테크실 요청사항",
		"Cloudflare D1 -> MongoDB로 교체",
		"가이드 export/import 기능 추가",
		"개인정보 처리방침 버전으로 관리할 수 있도록 개발",
		"가이드 문서 작성 시 publish 개념 도입",
		"모바일 페이지 대응",
		"[IIPQ-11] [CONE Watcher N] 위니텍 1,2월 청구서 불러오기 (20%, ~8/5)",
		"AX네이티브테크실 요청사항",
		"이노그리드 계정에 청구서 데이터 추가",
		"이슈 사항: 없음",
		"협업 및 기타: 없음",
	].join("\n");
	const r = parseTeamsPaste(text, 2026);
	expect(r.items.length).toBe(2);
	expect(r.items[0].key).toBe("IIPQ-10");
	expect(r.items[0].desc).toBe(
		"[CONE Watcher N] 가이드(위키) 페이지 버전 관리(수정 이력) 기능 추가",
	);
	expect(r.items[0].progress).toBe(90);
	expect(r.items[0].due).toBe("2026-07-31");
	expect(r.items[0].space).toBe("CONE Watcher N");
	expect(r.items[0].subs).toEqual([
		"AX네이티브테크실 요청사항",
		"Cloudflare D1 -> MongoDB로 교체",
		"가이드 export/import 기능 추가",
		"개인정보 처리방침 버전으로 관리할 수 있도록 개발",
		"가이드 문서 작성 시 publish 개념 도입",
		"모바일 페이지 대응",
	]);
	expect(r.items[1].key).toBe("IIPQ-11");
	expect(r.items[1].desc).toBe(
		"[CONE Watcher N] 위니텍 1,2월 청구서 불러오기",
	);
	expect(r.items[1].progress).toBe(20);
	expect(r.items[1].due).toBe("2026-08-05");
	expect(r.items[1].space).toBe("CONE Watcher N");
	expect(r.items[1].subs).toEqual([
		"AX네이티브테크실 요청사항",
		"이노그리드 계정에 청구서 데이터 추가",
	]);
	expect(r.issues).toBe("");
	expect(r.collab).toBe("");
});

test("parseTeamsPaste: (~N%, M/D) · zero-pad 마감도 파싱", () => {
	const text = [
		"[금일 진행 업무]",
		"업무 계획",
		"[OPIT-1836] 유지보수 큐 갱신 (~100%, 07/31)",
		"[OPIT-1864] [나이스(NEIS)] 액션 이력 무한 로딩 (~30%, 08/05)",
		"[OPIT-1] 표준 형식 (40%, ~7/12)",
		"이슈 사항 : 없음",
		"협업 및 기타",
		"온콜 대응(100%, ~07/31)",
	].join("\n");
	const r = parseTeamsPaste(text, 2026);
	expect(r.items.map((it) => [it.key, it.progress, it.due])).toEqual([
		["OPIT-1836", 100, "2026-07-31"],
		["OPIT-1864", 30, "2026-08-05"],
		["OPIT-1", 40, "2026-07-12"],
	]);
	expect(r.items[1].desc).toContain("[나이스(NEIS)]");
	expect(r.issues).toBe("");
	expect(r.collab).toBe("온콜 대응(100%, ~07/31)");

	// 줄 단위: ~ 위치·zero-pad 변형
	expect(parseTeamsTaskLine("[K-1] a (~50%, 07/31)", 2026)?.due).toBe(
		"2026-07-31",
	);
	expect(parseTeamsTaskLine("[K-1] a (50%, ~07/31)", 2026)?.due).toBe(
		"2026-07-31",
	);
	expect(parseTeamsTaskLine("[K-1] a (50%, 7/31)", 2026)?.due).toBe(
		"2026-07-31",
	);
});

// ── MCP/에이전트용 일일 항목 append ──
test("appendDailyTasks: list 섹션에 구조화 항목 추가·빈 항목 스킵·키 대문자", () => {
	const doc = emptyDoc("2026-07-10", "홍길동");
	const added = appendDailyTasks(doc, [
		{
			done: false,
			key: "opit-1",
			desc: "a",
			progress: 40,
			due: "2026-07-12",
			subs: ["하위1"],
			space: "backend",
		},
		{ done: false, key: "", desc: "", progress: "", due: "", subs: [] },
		{ done: false, key: "", desc: "메모만", progress: "", due: "", subs: [] },
	]);
	expect(added.length).toBe(2);
	expect(added[0].key).toBe("OPIT-1");
	expect(added[0].subs).toEqual(["하위1"]);
	expect(dailyItemsOf(doc).map((x) => x.desc)).toEqual(["a", "메모만"]);
});

// ── MCP/에이전트용 메모 append ──
test("appendMemo: 기존 메모에 이어 붙이고, 없는 섹션은 생성", () => {
	const doc = emptyDoc("2026-07-10", "홍길동");
	// 기본 '메모' 섹션에 append(첫 추가)
	expect(appendMemo(doc, "첫 메모")).toBe("첫 메모");
	expect(appendMemo(doc, "둘째 메모")).toBe("둘째 메모");
	expect((doc.sections.find((s) => s.title === "메모") as any).body).toBe(
		"첫 메모\n\n둘째 메모",
	);

	// 새 섹션 생성 후 추가 — 기존 메모와 별개 섹션
	const created = appendMemo(doc, "별도 기록", "회의 노트");
	expect(created).toBe("별도 기록");
	const sec = doc.sections.find((s) => s.title === "회의 노트") as any;
	expect(sec.kind).toBe("raw");
	expect(sec.body).toBe("별도 기록");
	// 같은 섹션에 다시 추가 → append
	expect(appendMemo(doc, "회의 이어서", "회의 노트")).toBe("회의 이어서");
	expect(sec.body).toBe("별도 기록\n\n회의 이어서");

	// 빈 텍스트는 무시
	expect(appendMemo(doc, "   ")).toBe("");
	expect((doc.sections.find((s) => s.title === "메모") as any).body).toBe(
		"첫 메모\n\n둘째 메모",
	);
});

// ── 업무일지 내보내기(멀티데이 조립) ──
import {
	datesInRange,
	composeExportMarkdown,
	composeExportJson,
	type ExportDay,
} from "../src/shared/model.ts";

function mkDay(date: string, body: string): ExportDay {
	const doc = parseDoc(body, date, "홍길동");
	return { date, doc, markdown: serializeDoc(JIRA, doc) };
}

test("datesInRange: from~to 포함 필터 + 오름차순", () => {
	const all = ["2026-07-09", "2026-07-10", "2026-07-11", "2026-07-15", "2026-08-01"];
	expect(datesInRange(all, "2026-07-10", "2026-07-15")).toEqual([
		"2026-07-10",
		"2026-07-11",
		"2026-07-15",
	]);
	expect(datesInRange(all, "2026-07-16", "2026-07-31")).toEqual([]);
});

test("composeExportMarkdown: 제목 헤더 + ## 날짜 섹션 이어붙기", () => {
	const days = [
		mkDay(
			"2026-07-10",
			"## 데일리 스크럼\n\n**[금일 진행 업무]**\n  + **[backend]**\n    + [OPIT-1](https://x/OPIT-1) 작업\n- 이슈 사항: 없음\n- 협업 및 기타: 없음",
		),
		mkDay(
			"2026-07-11",
			"## 일일 진행 업무\n- [OPIT-2](https://x/OPIT-2) 배포\n\n## 데일리 스크럼\n\n**[금일 진행 업무]**\n- 이슈 사항: 없음\n- 협업 및 기타: 없음",
		),
	];
	const md = composeExportMarkdown(JIRA, "2026-07-10", "2026-07-11", days);
	expect(md.startsWith("# i-daily 업무일지 (2026-07-10 ~ 2026-07-11)")).toBe(true);
	expect(md).toContain("## 2026-07-10");
	expect(md).toContain("## 2026-07-11");
	expect(md).toContain("https://jira.test/browse/OPIT-1");
	expect(md).toContain("https://jira.test/browse/OPIT-2");
});

test("composeExportJson: 메타 + days 배열 + count", () => {
	const days = [mkDay("2026-07-10", "## 데일리 스크럼\n\n- 이슈 사항: 없음\n- 협업 및 기타: 없음")];
	const obj = composeExportJson("2026-07-10", "2026-07-10", days);
	expect(obj.from).toBe("2026-07-10");
	expect(obj.to).toBe("2026-07-10");
	expect(obj.count).toBe(1);
	expect(obj.days[0].date).toBe("2026-07-10");
	expect(obj.days[0].doc != null).toBe(true);
	expect(obj.days[0].markdown).toContain("데일리 스크럼");
	expect(typeof obj.exportedAt).toBe("string");
});

test("composeExportMarkdown: 빈 days 면 제목만", () => {
	const md = composeExportMarkdown(JIRA, "2026-07-01", "2026-07-31", []);
	expect(md.trim()).toBe("# i-daily 업무일지 (2026-07-01 ~ 2026-07-31)");
});

// ── DnD 순서 이동: 마지막 행 "뒤에" 놓으면 맨 끝으로 ──
test("moveArrayItem: after last → 맨 끝 (예전 before-only 로는 불가)", () => {
	const a = ["a", "b", "c", "d", "e"];
	expect(moveArrayItem(a, 0, 4, "after")).toBe(true);
	expect(a).toEqual(["b", "c", "d", "e", "a"]);
});

test("moveArrayItem: before mid / after mid", () => {
	const before = ["a", "b", "c", "d"];
	expect(moveArrayItem(before, 3, 1, "before")).toBe(true);
	expect(before).toEqual(["a", "d", "b", "c"]);

	const after = ["a", "b", "c", "d"];
	expect(moveArrayItem(after, 0, 1, "after")).toBe(true);
	expect(after).toEqual(["b", "a", "c", "d"]);
});

test("moveArrayItem: 같은 칸 before/after 는 no-op", () => {
	const a = ["a", "b", "c"];
	expect(moveArrayItem(a, 1, 1, "before")).toBe(false);
	expect(moveArrayItem(a, 1, 1, "after")).toBe(false);
	expect(a).toEqual(["a", "b", "c"]);
});

test("moveItemToSpaceEnd: 같은 스페이스 맨 끝으로", () => {
	const items = [
		{ done: false, key: "A", desc: "", space: "S", subs: [] },
		{ done: false, key: "B", desc: "", space: "S", subs: [] },
		{ done: false, key: "C", desc: "", space: "S", subs: [] },
		{ done: false, key: "X", desc: "", space: "Other", subs: [] },
	];
	expect(moveItemToSpaceEnd(items, 0, "S")).toBe(true);
	expect(items.map((it) => it.key)).toEqual(["B", "C", "A", "X"]);
	// 이미 해당 스페이스 마지막이면 no-op
	expect(moveItemToSpaceEnd(items, 2, "S")).toBe(false);
	expect(items.map((it) => it.key)).toEqual(["B", "C", "A", "X"]);
});
