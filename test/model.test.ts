import { test, expect } from "./tiny.ts";
import {
  parseScrum, renderScrum, parseList, renderList, parseDoc, serializeDoc,
  dailyToBlock, renderScrumHtml, setConfig,
} from "../src/shared/model.ts";

// config 주입(jiraBase·spaceRules) — route()가 호출별로 _cfg를 리셋하므로 렌더 검증 전에 매번 설정.
const withCfg = () => setConfig({
  jiraBase: "https://jira.test",   // host만 — /browse/ 는 자동
  spaceRules: [{ prefix: "OPIT", space: "backend" }, { prefix: "QAOP", space: "backend" }],
});

test("scrum 왕복: 태스크·하위·마감 연도추론 보존", () => {
  withCfg();
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
  expect(t.due).toBe("2026-07-17");   // ~7/17 → 노트 연도(2026)로 추론
  expect(t.progress).toBe(30);
  expect(t.subs).toEqual(["미 merge 항목 정리"]);
  const out = renderScrum(s);
  expect(out).toContain("+ [OPIT-1756](https://jira.test/browse/OPIT-1756) merge (30%, ~7/17)");
  expect(out).toContain("        + 미 merge 항목 정리");
});

test("체크리스트: [x]/[ ]/평불릿 파싱, 렌더는 평불릿(체크박스 없음)", () => {
  const items = parseList("- [x] done one\n- [ ] [OPIT-1](u) two\n    - sub\n- three");
  expect(items.length).toBe(3);
  expect(items[1].key).toBe("OPIT-1");
  expect(items[1].subs).toEqual(["sub"]);
  const out = renderList(items);
  expect(out).not.toContain("[x]");
  expect(out).not.toContain("[ ]");
  expect(out).toContain("- done one");
});

test("parseDoc: 섹션 순서·kind, 스크럼 구조화, raw 통과, 미지 섹션 보존", () => {
  const md = "## 일일 진행 업무\n- did a\n\n## 데일리 스크럼\n\n**[금일 진행 업무]**\n- 이슈 사항: 없음\n- 협업 및 기타: 없음\n\n## 메모\nfree text\n\n## 회고\n- good";
  const doc = parseDoc(md, "2026-07-10");
  expect(doc.sections.map((s) => [s.title, s.kind])).toEqual([
    ["일일 진행 업무", "list"], ["데일리 스크럼", "scrum"], ["메모", "raw"], ["회고", "raw"],
  ]);
  const memo = doc.sections.find((s) => s.title === "메모") as any;
  expect(memo.body).toBe("free text");
  expect(serializeDoc(doc)).toContain("## 회고");   // 미지 섹션 보존
});

test("dailyToBlock: done→100, guessSpace 그룹핑, 하위 보존", () => {
  withCfg();
  const block = dailyToBlock([
    { done: true, key: "", desc: "no ticket", subs: [] },
    { done: false, key: "OPIT-9", desc: "with ticket", subs: ["a"] },
  ]);
  const labels = block.spaces.map((s) => s.label);
  expect(labels).toContain("");            // 티켓 없음 → 라벨 없는 스페이스
  expect(labels).toContain("backend"); // OPIT → backend
  const opit = block.spaces.find((s) => s.label === "backend")!.tasks[0];
  expect(opit.progress).toBe("");
  expect(opit.subs).toEqual(["a"]);
  expect(block.spaces.find((s) => s.label === "")!.tasks[0].progress).toBe(100);
});

test("renderScrumHtml: 굵은 헤더 · 중첩 ul · 티켓 링크", () => {
  withCfg();
  const s = parseScrum("**[금일 진행 업무]**\n  + **[sp]**\n    + [K-1](https://x/K-1) d (50%, ~7/1)\n- 이슈 사항: 없음\n- 협업 및 기타: 없음", 2026);
  const html = renderScrumHtml(s);
  expect(html).toContain("<b>[금일 진행 업무]</b>");
  expect(html).toContain('<a href="https://jira.test/browse/K-1">[K-1]</a>');
  expect(html).toContain("<ul>");
});
