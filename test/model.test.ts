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
	emptyDoc,
	dailyItemsOf,
	parseTeamsPaste,
	parseTeamsTaskLine,
} from "../src/shared/model.ts";
import { kanbanColumns } from "../src/renderer/src/lib/model.ts";

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
