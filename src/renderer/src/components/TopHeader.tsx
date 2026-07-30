import { WD, parseYmd, weekOfMonth } from "../lib/model";
import { Shortcuts } from "./Shortcuts";
import type { Meta } from "../types";

export function TopHeader({
	curDate,
	meta,
	saveCls,
	saveNote,
	onSave,
	onRevert,
}: {
	curDate: string;
	meta: Meta;
	saveCls: string;
	saveNote: string;
	onSave: () => void;
	onRevert: () => void;
}) {
	const canRevert = saveCls === "dirty";
	const d = parseYmd(curDate);
	// YYYY-MM-DD 문자열 비교로 과거만 판별 (미래·오늘은 라벨 없음)
	const isPast = !!meta.today && curDate < meta.today;
	const hdrDate =
		`${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()} (${WD[d.getDay()]})` +
		(isPast ? " · 지난 기록" : "");
	const hdrSub =
		`${d.getMonth() + 1}월 ${weekOfMonth(d)}째 주` +
		(meta.owner ? " · " + meta.owner : "");

	return (
		<header className="topbar border-b border-line bg-bg">
			<div className="mx-auto max-w-[1120px] px-5 pt-[14px]">
				<div className="flex flex-wrap items-start justify-between gap-4">
					<div>
						<div className="flex cursor-default select-none items-baseline gap-2 text-[18px] font-bold tracking-[-0.02em]">
							<span className="brand-dot self-center" />
							<span>i-daily</span>
							<span className="text-[11px] font-medium tabular-nums text-ink-2">
								v{__APP_VERSION__}
							</span>
						</div>
						<div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-2">
							<strong className="font-bold text-ink tabular-nums">
								{hdrDate}
							</strong>
							<span className="text-line-strong">·</span>
							<span>{hdrSub}</span>
							<span className="text-line-strong">·</span>
							<span className="inline-flex items-center gap-1.5">
								<span className={"savedot " + saveCls} />
								<span
									className={
										saveCls === "" || !saveCls
											? "font-semibold text-ok"
											: undefined
									}
								>
									{saveNote}
								</span>
							</span>
						</div>
					</div>

					<div className="flex items-center gap-2">
						<button
							type="button"
							className="btn btn-ghost px-2.5 py-[5px]"
							title="저장하지 않은 변경을 버리고 마지막 저장 상태로 되돌리기"
							onClick={onRevert}
							disabled={!canRevert}
							style={canRevert ? undefined : { opacity: 0.4, cursor: "default" }}
						>
							되돌리기
						</button>
						<button
							type="button"
							className="btn btn-primary px-3 py-[7px]"
							title="서버에 저장 (⌘S)"
							onClick={onSave}
						>
							저장
						</button>
					</div>
				</div>
			</div>
			<Shortcuts />
		</header>
	);
}
