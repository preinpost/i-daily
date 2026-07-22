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
} from "../src/shared/model.ts";

// jiraBase 는 렌더 함수에 인자로 전달(전역 아님). host만 — /browse/ 는 자동.
const JIRA = "https://jira.test";

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
