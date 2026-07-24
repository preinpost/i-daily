import { test, expect } from "./tiny.ts";
import {
	weekWindow,
	buildWeeklyDigest,
	renderDigestText,
	splitDigestText,
} from "../src/shared/report.ts";
import type { TaskRow } from "../src/shared/model.ts";

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
test("weekWindow: KST 금요일 오전(UTC는 아직 목요일) → 새 주기로 어긋남 없음", () => {
	// UTC 2026-07-23 23:30 (목) = KST 2026-07-24 08:30 (금) → 새 주기 시작
	expect(weekWindow(new Date("2026-07-23T23:30:00Z"))).toEqual({
		from: "2026-07-24",
		to: "2026-07-30",
	});
});

const rows = (): TaskRow[] => [
	{
		date: "2026-07-14",
		side: "today",
		space: "cloudit",
		key: "CLOUD-432",
		desc: "이슈 분석",
		progress: 50,
		due: "2026-07-23",
	},
	{
		date: "2026-07-15",
		side: "daily",
		space: "cloudit",
		key: "CLOUD-432",
		desc: "패치 적용",
		progress: 100,
		due: "2026-07-20",
	},
	{
		date: "2026-07-15",
		side: "prev",
		space: "cloudit",
		key: "CLOUD-432",
		desc: "전일 재기술(제외돼야)",
		progress: 40,
		due: "",
	},
	{
		date: "2026-07-14",
		side: "today",
		space: "온보딩",
		key: "OPIT-1730",
		desc: "openstackit 분석",
		progress: 100,
		due: "2026-07-15",
	},
];

test("digest: prev 제외 · 키 dedupe · 진척 최댓값 · 마감 가장 마지막 기록 · 날짜/노트 합집합", () => {
	const d = buildWeeklyDigest(rows(), "서재홍", "2026-07-10", "2026-07-16");
	expect(d.count).toBe(2);
	const cloud = d.spaces.find((s) => s.label === "cloudit")!;
	const t = cloud.tasks[0];
	expect(t.key).toBe("CLOUD-432");
	expect(t.progress).toBe(100); // max(50,100)
	expect(t.due).toBe("2026-07-20"); // 가장 마지막에 기록된 업무(07-15)의 마감 — 더 이른 날짜로 바뀌어도 반영
	expect(t.dates).toEqual(["2026-07-14", "2026-07-15"]);
	expect(t.notes).toEqual(["이슈 분석", "패치 적용"]);
});

test("digest: 마감은 가장 나중에 기록된 값 · 같은 날짜면 실제 수행(daily)이 계획(today)을 이김", () => {
	// 같은 날 계획(today)엔 옛 마감 7/23, 실제 수행(daily)엔 늘춘 마감 7/28 → daily(7/28)가 이겨야 함.
	const delayed: TaskRow[] = [
		{ date: "2026-07-23", side: "today", space: "c", key: "CLOUD-1", desc: "작업", progress: 50, due: "2026-07-23" },
		{ date: "2026-07-23", side: "daily", space: "c", key: "CLOUD-1", desc: "작업", progress: 60, due: "2026-07-28" },
	];
	expect(buildWeeklyDigest(delayed).spaces[0].tasks[0].due).toBe("2026-07-28");
	// 앞당긴 경우도 실제 수행(daily)이 기준: today 7/28(옛), daily 7/23 → 7/23.
	const earlier: TaskRow[] = [
		{ date: "2026-07-23", side: "daily", space: "c", key: "CLOUD-2", desc: "작업", progress: 60, due: "2026-07-23" },
		{ date: "2026-07-23", side: "today", space: "c", key: "CLOUD-2", desc: "작업", progress: 50, due: "2026-07-28" },
	];
	expect(buildWeeklyDigest(earlier).spaces[0].tasks[0].due).toBe("2026-07-23");
	// 입력 순서가 뒤섞여도 가장 늘은 날짜(cross-day)가 이김.
	const crossDay: TaskRow[] = [
		{ date: "2026-07-24", side: "daily", space: "c", key: "CLOUD-3", desc: "작업", progress: 90, due: "2026-07-28" },
		{ date: "2026-07-20", side: "daily", space: "c", key: "CLOUD-3", desc: "작업", progress: 30, due: "2026-07-23" },
	];
	expect(buildWeeklyDigest(crossDay).spaces[0].tasks[0].due).toBe("2026-07-28");
});

test("digest: 일일(space 없음) + 스크럼(space) 같은 티켓 → 전역 병합(중복/기타 버킷 없음)", () => {
	const rs: TaskRow[] = [
		{
			date: "2026-07-13",
			side: "daily",
			space: "",
			key: "OPIT-1770",
			desc: "openstack 설치방법 분석",
			progress: 60,
			due: "2026-07-17",
		},
		{
			date: "2026-07-14",
			side: "today",
			space: "openstackit",
			key: "OPIT-1770",
			desc: "배포 분석",
			progress: 60,
			due: "2026-07-17",
		},
	];
	const d = buildWeeklyDigest(rs);
	expect(d.count).toBe(1);
	expect(d.spaces.length).toBe(1);
	expect(d.spaces[0].label).toBe("openstackit");
});

test("digest: space 비면 기타 버킷", () => {
	const rs: TaskRow[] = [
		{
			date: "2026-07-13",
			side: "daily",
			space: "",
			key: "QAOP-441",
			desc: "프로젝트 이름 누락 수정",
			progress: 95,
			due: "2026-07-21",
		},
	];
	const d = buildWeeklyDigest(rs);
	expect(d.spaces[0].label).toBe("기타");
});

test("digest: 하위 항목(subs)은 최신 날짜것이 이기고 렌더링됨", () => {
	const rs: TaskRow[] = [
		{
			date: "2026-07-13",
			side: "daily",
			space: "",
			key: "OPIT-1770",
			desc: "openstack 분석",
			progress: 20,
			due: "",
			subs: ["Jenkins 분석"],
		},
		{
			date: "2026-07-15",
			side: "daily",
			space: "",
			key: "OPIT-1770",
			desc: "openstack 분석",
			progress: 60,
			due: "2026-07-17",
			subs: ["openstackit-installer 패키지 분석", "신규 클러스터 설치 (v3.3)"],
		},
	];
	const d = buildWeeklyDigest(rs);
	const t = d.spaces[0].tasks[0];
	expect(t.subs).toEqual([
		"openstackit-installer 패키지 분석",
		"신규 클러스터 설치 (v3.3)",
	]); // 최신이 이김
	const txt = renderDigestText(d);
	expect(txt).toContain("ㅇ[OPIT-1770] openstack 분석 (60%, ~7/17)");
	expect(txt).toContain("  - openstackit-installer 패키지 분석");
	expect(txt).not.toContain("Jenkins 분석"); // 예전 하위는 최신으로 대체됨
});

test("renderDigestText: Teams 붙여넣기용 스페이스 그룹 + 메타", () => {
	const d = buildWeeklyDigest(rows(), "서재홍", "2026-07-10", "2026-07-16");
	const txt = renderDigestText(d);
	expect(txt).not.toContain("[주간업무보고]"); // 상단 헤더 제거
	expect(txt).toContain("금주 업무 내용"); // 섹션 헤더
	expect(txt).toContain("[cloudit]");
	expect(txt).toContain("ㅇ[CLOUD-432] 이슈 분석 (100%, ~7/20)"); // ㅇ 글머리 + fmtMeta M/D(가장 마지막 기록의 마감)
	expect(txt).toContain("  - 패치 적용"); // notes 파편 → 하위 불릿
	expect(txt).not.toContain("전일 재기술");
});

test("renderDigestText: 전부 100%면 차주 섹션 생략", () => {
	const d = buildWeeklyDigest(rows(), "", "2026-07-10", "2026-07-16"); // CLOUD-432·OPIT-1730 모두 100
	const txt = renderDigestText(d);
	expect(txt).toContain("금주 업무 내용");
	expect(txt).not.toContain("차주 업무 내용");
});

test("renderDigestText: 차주 섹션은 100% 아닌 항목만(진척 null 포함)", () => {
	const rs: TaskRow[] = [
		{
			date: "2026-07-14",
			side: "today",
			space: "cloudit",
			key: "CLOUD-1",
			desc: "완료 작업",
			progress: 100,
			due: "",
		},
		{
			date: "2026-07-14",
			side: "today",
			space: "cloudit",
			key: "CLOUD-2",
			desc: "진행 중 작업",
			progress: 60,
			due: "2026-07-30",
		},
		{
			date: "2026-07-15",
			side: "today",
			space: "온보딩",
			key: "OPIT-9",
			desc: "진척 미기록",
			progress: null,
			due: "",
		},
	];
	const d = buildWeeklyDigest(rs, "", "2026-07-10", "2026-07-16");
	const txt = renderDigestText(d);
	// 금주 섹션엔 전체 항목
	expect(txt).toContain("금주 업무 내용");
	expect(txt).toContain("ㅇ[CLOUD-1] 완료 작업 (100%)");
	expect(txt).toContain("ㅇ[CLOUD-2] 진행 중 작업 (60%, ~7/30)");
	expect(txt).toContain("ㅇ[OPIT-9] 진척 미기록");
	// 차주 섹션: 100% 아닌 것만 이월(60%·null), 100% 완료는 제외
	expect(txt).toContain("차주 업무 내용");
	const next = txt.split("차주 업무 내용")[1];
	expect(next).toContain("CLOUD-2");
	expect(next).toContain("OPIT-9"); // 진척 null 도 이월
	expect(next).not.toContain("CLOUD-1"); // 100% 완료 제외
});

test("splitDigestText: 금주/차주 본문 분할(섹션 헤더 줄 제외)", () => {
	const rs: TaskRow[] = [
		{
			date: "2026-07-14",
			side: "today",
			space: "cloudit",
			key: "CLOUD-1",
			desc: "완료",
			progress: 100,
			due: "",
		},
		{
			date: "2026-07-14",
			side: "today",
			space: "cloudit",
			key: "CLOUD-2",
			desc: "진행",
			progress: 60,
			due: "",
		},
	];
	const txt = renderDigestText(
		buildWeeklyDigest(rs, "", "2026-07-10", "2026-07-16"),
	);
	const { thisWeek, nextWeek } = splitDigestText(txt);
	// 본문만 남고 섹션 헤더 줄은 제거
	expect(thisWeek).not.toContain("금주 업무 내용");
	expect(thisWeek).toContain("CLOUD-1");
	expect(thisWeek).toContain("CLOUD-2");
	expect(nextWeek).not.toContain("차주 업무 내용");
	expect(nextWeek).toContain("CLOUD-2");
	expect(nextWeek).not.toContain("CLOUD-1"); // 100% 완료 제외
});

test("splitDigestText: 차주 섹션 없으면 nextWeek 빈 문자열", () => {
	const txt = renderDigestText(
		buildWeeklyDigest(rows(), "", "2026-07-10", "2026-07-16"),
	); // 모두 100%
	const { thisWeek, nextWeek } = splitDigestText(txt);
	expect(thisWeek).toContain("CLOUD-432");
	expect(nextWeek).toBe("");
});

test("digest.raw: 요일별 원본을 병합 없이 보존", () => {
	const d = buildWeeklyDigest(rows(), "", "2026-07-10", "2026-07-16");
	// prev 제외, work side만 → 07-14(2건) + 07-15(1건) = 2일치
	expect(d.raw.map((r) => r.date)).toEqual(["2026-07-14", "2026-07-15"]);
	const day15 = d.raw.find((r) => r.date === "2026-07-15")!;
	expect(day15.entries[0].key).toBe("CLOUD-432");
	expect(day15.entries[0].desc).toBe("패치 적용"); // 원본 그대로(병합 안됨)
});
