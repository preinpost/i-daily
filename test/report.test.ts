import { test, expect } from "./tiny.ts";
import { weekWindow, buildWeeklyDigest, renderDigestText, buildAgentPrompt } from "../src/shared/report.ts";
import { setConfig, type TaskRow } from "../src/shared/model.ts";

// ── 기간 계산: 전주 금 ~ 금주 목 ──
test("weekWindow: 목요일 실행 → to=오늘, from=지난 금요일", () => {
  const thu = new Date(2026, 6, 16); // 2026-07-16 목
  expect(weekWindow(thu)).toEqual({ from: "2026-07-10", to: "2026-07-16" });
});
test("weekWindow: 금요일 실행 → 새 주기(to=다음 목, from=오늘 금)", () => {
  const fri = new Date(2026, 6, 17); // 2026-07-17 금
  expect(weekWindow(fri)).toEqual({ from: "2026-07-17", to: "2026-07-23" });
});
test("weekWindow: 월요일 실행 → from=지난 금, to=이번 목", () => {
  const mon = new Date(2026, 6, 13); // 2026-07-13 월
  expect(weekWindow(mon)).toEqual({ from: "2026-07-10", to: "2026-07-16" });
});

const rows = (): TaskRow[] => [
  { date: "2026-07-14", side: "today", space: "cloudit", key: "CLOUD-432", desc: "이슈 분석", progress: 50, due: "2026-07-23" },
  { date: "2026-07-15", side: "daily", space: "cloudit", key: "CLOUD-432", desc: "패치 적용", progress: 100, due: "2026-07-20" },
  { date: "2026-07-15", side: "prev", space: "cloudit", key: "CLOUD-432", desc: "전일 재기술(제외돼야)", progress: 40, due: "" },
  { date: "2026-07-14", side: "today", space: "온보딩", key: "OPIT-1730", desc: "openstackit 분석", progress: 100, due: "2026-07-15" },
];

test("digest: prev 제외 · 키 dedupe · 진척 최댓값 · 마감 최신 · 날짜/노트 합집합", () => {
  const d = buildWeeklyDigest(rows(), "서재홍", "2026-07-10", "2026-07-16");
  expect(d.count).toBe(2);
  const cloud = d.spaces.find((s) => s.label === "cloudit")!;
  const t = cloud.tasks[0];
  expect(t.key).toBe("CLOUD-432");
  expect(t.progress).toBe(100);           // max(50,100)
  expect(t.due).toBe("2026-07-23");       // 최신
  expect(t.dates).toEqual(["2026-07-14", "2026-07-15"]);
  expect(t.notes).toEqual(["이슈 분석", "패치 적용"]);
});

test("digest: 일일(space 없음) + 스크럼(space) 같은 티켓 → 전역 병합(중복/기타 버킷 없음)", () => {
  const rs: TaskRow[] = [
    { date: "2026-07-13", side: "daily", space: "", key: "OPIT-1770", desc: "openstack 설치방법 분석", progress: 60, due: "2026-07-17" },
    { date: "2026-07-14", side: "today", space: "openstackit", key: "OPIT-1770", desc: "배포 분석", progress: 60, due: "2026-07-17" },
  ];
  const d = buildWeeklyDigest(rs);
  expect(d.count).toBe(1);
  expect(d.spaces.length).toBe(1);
  expect(d.spaces[0].label).toBe("openstackit");
});

test("digest: space 비어도 guessSpace(prefix)로 스페이스 보완", () => {
  setConfig({ spaceRules: [{ prefix: "QAOP", space: "qa" }] });
  const rs: TaskRow[] = [
    { date: "2026-07-13", side: "daily", space: "", key: "QAOP-441", desc: "프로젝트 이름 누락 수정", progress: 95, due: "2026-07-21" },
  ];
  const d = buildWeeklyDigest(rs);
  expect(d.spaces[0].label).toBe("qa");
  setConfig(null); // 리셋
});

test("digest: 하위 항목(subs)은 최신 날짜것이 이기고 렌더링됨", () => {
  const rs: TaskRow[] = [
    { date: "2026-07-13", side: "daily", space: "", key: "OPIT-1770", desc: "openstack 분석", progress: 20, due: "", subs: ["Jenkins 분석"] },
    { date: "2026-07-15", side: "daily", space: "", key: "OPIT-1770", desc: "openstack 분석", progress: 60, due: "2026-07-17",
      subs: ["openstackit-installer 패키지 분석", "신규 클러스터 설치 (v3.3)"] },
  ];
  const d = buildWeeklyDigest(rs);
  const t = d.spaces[0].tasks[0];
  expect(t.subs).toEqual(["openstackit-installer 패키지 분석", "신규 클러스터 설치 (v3.3)"]); // 최신이 이김
  const txt = renderDigestText(d);
  expect(txt).toContain("ㅇ[OPIT-1770] openstack 분석 (60%, ~7/17)");
  expect(txt).toContain("  - openstackit-installer 패키지 분석");
  expect(txt).not.toContain("Jenkins 분석"); // 예전 하위는 최신으로 대체됨
});

test("renderDigestText: Teams 붙여넣기용 스페이스 그룹 + 메타", () => {
  const d = buildWeeklyDigest(rows(), "서재홍", "2026-07-10", "2026-07-16");
  const txt = renderDigestText(d);
  expect(txt).not.toContain("[주간업무보고]"); // 상단 헤더 제거
  expect(txt).toContain("[cloudit]");
  expect(txt).toContain("ㅇ[CLOUD-432] 이슈 분석 (100%, ~7/23)"); // ㅇ 글머리 + fmtMeta M/D
  expect(txt).toContain("  - 패치 적용");                          // notes 파편 → 하위 불릿
  expect(txt).not.toContain("전일 재기술");
});

test("buildAgentPrompt: 변조금지 규칙 + 집계 데이터 포함", () => {
  const d = buildWeeklyDigest(rows(), "", "2026-07-10", "2026-07-16");
  const p = buildAgentPrompt(d);
  expect(p).toContain("한 글자도 바꾸지 마라");
  expect(p).toContain("CLOUD-432");
  expect(p).toContain("[집계 데이터]");
  expect(p).toContain("[원본 로그]");
});

test("digest.raw: 요일별 원본을 병합 없이 보존 + prompt에 포함", () => {
  const d = buildWeeklyDigest(rows(), "", "2026-07-10", "2026-07-16");
  // prev 제외, work side만 → 07-14(2건) + 07-15(1건) = 2일치
  expect(d.raw.map((r) => r.date)).toEqual(["2026-07-14", "2026-07-15"]);
  const day15 = d.raw.find((r) => r.date === "2026-07-15")!;
  expect(day15.entries[0].key).toBe("CLOUD-432");
  expect(day15.entries[0].desc).toBe("패치 적용"); // 원본 그대로(병합 안됨)
  const p = buildAgentPrompt(d);
  expect(p).toContain("패치 적용"); // 원본 로그에 들어감
});

test("buildAgentPrompt: 커스텀 override — {from}/{to}/{owner} 치환 + {data} 위치 + 집계 포함", () => {
  const d = buildWeeklyDigest(rows(), "김철수", "2026-07-10", "2026-07-16");
  const p = buildAgentPrompt(d, "기간 {from}~{to} 작성자 {owner}\n---\n{data}\n---\n끝");
  expect(p).toContain("기간 2026-07-10~2026-07-16 작성자 김철수");
  expect(p).toContain("CLOUD-432");          // {data} 자리에 집계 JSON
  expect(p).toContain("---\n끝");            // {data} 뒤 텍스트 보존
  expect(p).not.toContain("한 글자도 바꾸지 마라"); // 기본값 대체됨
});
