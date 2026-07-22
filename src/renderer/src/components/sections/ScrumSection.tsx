import { useEditor } from "../../context/EditorContext";
import { useToast } from "../Toast";
import { api } from "../../lib/api";
import { ticketUrl, todayDailyItems } from "../../lib/model";
import { confirmReset } from "../../lib/ui";
import { emptyBlock, fmtMeta, parseMetaLines } from "../../../../shared/model";
import type { Block, Task } from "../../types";

// 전일 블록의 이슈·협업 읽기 전용 렌더 — 2레벨(메인 + ↳ 하위) 구조.
function MetaRead({ label, value }: { label: string; value: string }) {
	const items = parseMetaLines(value);
	if (!items.length) return null;
	return (
		<div className="px-2 py-1 text-[12px] text-ink-2">
			<div className="mb-0.5 font-bold tracking-[0.02em]">{label}</div>
			<div className="grid gap-[2px] pl-1">
				{items.map((it, i) => (
					<div key={i}>
						<div className="flex items-baseline gap-1.5 leading-[1.5] text-ink">
							<span className="flex-none opacity-60">+</span>
							<span className="min-w-0 break-words">{it.text}</span>
						</div>
						{it.subs.map((s, si) => (
							<div
								key={si}
								className="flex items-baseline gap-1.5 pl-3 leading-[1.5]"
							>
								<span className="flex-none opacity-60">↳</span>
								<span className="min-w-0 break-words">{s}</span>
							</div>
						))}
					</div>
				))}
			</div>
		</div>
	);
}

// 스페이스·태스크 수 집계(내용 있는 것만).
const taskCount = (b: Block): number =>
	(b.spaces || []).reduce(
		(n, sp) => n + (sp.tasks || []).filter((t) => t.key || t.desc).length,
		0,
	);

export function ScrumSection({
	title,
	curDate,
	onGenerate,
}: {
	title: string;
	curDate: string;
	onGenerate: () => void;
}) {
	const { doc, meta, commit } = useEditor();
	const toast = useToast();
	const scrum = doc.scrum;
	const prevCount = taskCount(scrum.prev);
	const dailyCount = todayDailyItems(doc).filter(
		(it) => (it.key || "").trim() || (it.desc || "").trim(),
	).length;

	async function importPrev() {
		if (
			prevCount &&
			!confirm("전일 진행 업무를 직전 근무일의 '일일 진행 업무'로 덮어쓸까요?")
		)
			return;
		const r = await api<any>("GET", `/api/day/${curDate}/prev-daily`);
		if (r.ok && r.json && r.json.block && r.json.count) {
			scrum.prev = r.json.block;
			commit();
			toast(`${r.json.from} 일일 ${r.json.count}건 가져옴 — 진척/마감 확인`);
		} else toast("가져올 어제 일일 기록이 없어요");
	}

	return (
		<div className="mb-[22px]">
			<h3 className="mb-2.5 mt-0 flex items-center gap-[7px] text-[15px] tracking-[-0.2px]">
				<span>{title}</span>
				<span className="rounded-full bg-chip px-2 py-0.5 text-[11px] text-ink-2">
					버튼 전용 · 입력 없음
				</span>
			</h3>

			<div className="rules mb-3.5 rounded-[10px] border border-line bg-panel-2 p-[10px_12px] text-[12.5px] text-ink-2">
				<details>
					<summary>
						회사 규정 체크리스트{" "}
						<span className="font-normal text-ink-2">(펼치기)</span>
					</summary>
					<ol className="mt-2 grid list-decimal gap-[3px] pl-[18px]">
						<li>
							모든 업무는 <b>일일 진행 업무에 먼저 등록</b> → 스크럼은 아래
							버튼으로 생성 (티켓 중복 입력 금지)
						</li>
						<li>
							각 항목에 <b>진척률(%)·마감일</b> 필수 — 형식{" "}
							<span className="kbd">(N%, ~M/D)</span>, 일일 진행 업무에서 입력
						</li>
						<li>
							<b>전일</b> = 어제 일일(실제로 <b>한</b> 일) / <b>금일</b> = 오늘
							일일(실제로 <b>할</b> 일)
						</li>
						<li>
							계획 외 추가로 한 일은 일일 진행 업무에 등록 →{" "}
							<b>익일 전일에 자동 반영</b>
						</li>
						<li>
							<b>해소된 이슈</b>는 일일 진행 업무 아래 이슈 사항에서 제거
						</li>
						<li>
							출근 후 <b>30분 이내</b> 공유가 목표
						</li>
					</ol>
				</details>
			</div>

			<div className="overflow-hidden rounded-xl border border-line bg-panel-2">
				{/* ── 1단계: 전일 진행 업무 ← 어제 일일 ── */}
				<div className="border-b border-line p-[12px_14px]">
					<div className="flex flex-wrap items-center gap-2">
						<StepBadge n={1} />
						<div className="min-w-0">
							<div className="text-[13.5px] font-[650] leading-tight">
								전일 진행 업무
							</div>
							<div className="text-xs text-ink-2">
								직전 근무일의 일일 진행 업무를 가져옵니다
							</div>
						</div>
						<div className="flex-1" />
						{prevCount > 0 && (
							<button
								type="button"
								className="btn btn-tiny btn-ghost"
								title="가져온 전일 진행 업무를 비웁니다"
								onClick={() => {
									if (!confirmReset("전일 진행 업무")) return;
									scrum.prev = emptyBlock();
									commit();
									toast("전일 진행 업무 초기화");
								}}
							>
								비우기
							</button>
						)}
						<button
							type="button"
							className="btn btn-tiny btn-ghost"
							title="직전 근무일의 '일일 진행 업무'를 전일 진행 업무로 가져옵니다"
							onClick={importPrev}
						>
							↧ 어제 일일 가져오기
						</button>
					</div>

					{!prevCount ? (
						<div className="mt-2.5 rounded-[10px] border border-dashed border-line p-3.5 text-center text-xs text-ink-2">
							아직 가져온 전일 기록이 없어요 —{" "}
							<b className="text-ink">↧ 어제 일일 가져오기</b>를 누르세요
						</div>
					) : (
						<div className="mt-2.5 rounded-[10px] border border-line bg-panel p-2">
							<div className="mb-1 flex items-center gap-1.5 px-1 text-[11px] font-bold text-ink-2">
								<span>{prevCount}건</span>
								<span className="font-normal opacity-75">
									· 읽기 전용 — 수정은 해당 날짜 일일 진행 업무에서
								</span>
							</div>
							<ReadOnlyBlock block={scrum.prev} jiraBase={meta.jiraBase} />
						</div>
					)}
				</div>

				{/* ── 2단계: 금일 진행 업무 ← 오늘 일일 → Teams 텍스트 ── */}
				<div className="p-[12px_14px]">
					<div className="flex flex-wrap items-center gap-2">
						<StepBadge n={2} />
						<div className="min-w-0">
							<div className="text-[13.5px] font-[650] leading-tight">
								금일 진행 업무
							</div>
							<div className="text-xs text-ink-2">
								오늘 일일 진행 업무{" "}
								<b className={dailyCount ? "text-accent" : ""}>
									{dailyCount}건
								</b>
								+ 이슈·협업 → 아래 Teams 텍스트로 생성
							</div>
						</div>
						<div className="flex-1" />
						<button
							type="button"
							className="btn btn-primary"
							title="오늘 일일 진행 업무로 금일 진행 업무를 만들고 Teams 붙여넣기 텍스트를 즉시 생성합니다"
							onClick={onGenerate}
						>
							📋 데일리 스크럼 생성
						</button>
					</div>
					<p className="mb-0 mt-2 px-1 text-[11.5px] leading-[1.5] text-ink-2">
						이슈 사항·협업 및 기타는 <b>일일 진행 업무</b> 섹션 아래에서
						입력하면 생성 시 함께 반영됩니다.
					</p>
				</div>
			</div>
		</div>
	);
}

function StepBadge({ n }: { n: number }) {
	return (
		<span className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--accent)_18%,var(--chip))] text-[12.5px] font-bold tabular-nums text-accent">
			{n}
		</span>
	);
}

// 가져온 전일 블록의 읽기 전용 미리보기 — 스페이스별 그룹 + 티켓 링크 + 진척/마감.
function ReadOnlyBlock({
	block,
	jiraBase,
}: {
	block: Block;
	jiraBase: string;
}) {
	const spaces = (block.spaces || []).filter(
		(sp) =>
			(sp.label || "").trim() || (sp.tasks || []).some((t) => t.key || t.desc),
	);
	const metaOf = (label: string, extra: string) =>
		`${label}${extra ? " · " + extra : ""}`;
	const issues = (block.issues || "").trim();
	const collab = (block.collab || "").trim();
	return (
		<div className="grid gap-1">
			{spaces.map((sp, si) => (
				<div
					key={si}
					className="rounded-lg px-2 py-1.5 transition-colors hover:bg-panel-2"
				>
					<div className="mb-1 text-[11px] font-bold tracking-[0.02em] text-ink-2">
						[{sp.label || "스페이스 없음"}]
					</div>
					{(sp.tasks || [])
						.filter((t) => t.key || t.desc)
						.map((t, ti) => (
							<ReadOnlyTask key={ti} t={t} jiraBase={jiraBase} />
						))}
				</div>
			))}
			<MetaRead label="이슈 사항" value={issues} />
			<MetaRead label="협업 및 기타" value={collab} />
		</div>
	);

	function ReadOnlyTask({ t, jiraBase }: { t: Task; jiraBase: string }) {
		const key = (t.key || "").trim();
		const url = key ? ticketUrl({ today: null, owner: "", jiraBase }, key) : "";
		const keyCls = "flex-none font-mono text-[12px] font-bold text-accent";
		const keyEl = !key ? null : url ? (
			<a
				href={url}
				target="_blank"
				rel="noreferrer noopener"
				className={keyCls + " hover:underline"}
				title={metaOf("Jira에서 열기", key)}
			>
				[{key}]
			</a>
		) : (
			<span className={keyCls}>[{key}]</span>
		);
		return (
			<div className="flex items-baseline gap-1.5 py-[1.5px] pl-1 text-[12.5px] leading-[1.5]">
				<span className="flex-none text-ink-2 opacity-60">+</span>
				{keyEl}
				<span className="min-w-0 break-words text-ink">
					{(t.desc || "").trim()}
				</span>
				<span className="flex-none whitespace-nowrap text-[11.5px] text-ink-2">
					{fmtMeta(t.progress, t.due)}
				</span>
			</div>
		);
	}
}
