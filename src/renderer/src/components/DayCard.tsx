import { SectionList } from "./sections/SectionList";

export function DayCard({
	curDate,
	onShift,
	onPickDate,
	onCarry,
	teams,
	onCopy,
	onCopyMd,
}: {
	curDate: string;
	onShift: (days: number) => void;
	onPickDate: (date: string) => void;
	onCarry: () => void;
	teams: string;
	onCopy: () => void;
	onCopyMd: () => void;
}) {
	return (
		<section className="mt-5 overflow-hidden rounded-card border border-line bg-panel shadow-card">
			<div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4">
				<h2 className="m-0 flex items-center gap-[9px] text-base tracking-[-0.2px]">
					📓 데일리 업무일지
				</h2>
				<div className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
					<button
						type="button"
						className="btn btn-tiny btn-ghost"
						title="하루 전"
						onClick={() => onShift(-1)}
					>
						‹
					</button>
					<input
						type="date"
						value={curDate}
						onChange={(e) => e.target.value && onPickDate(e.target.value)}
					/>
					<button
						type="button"
						className="btn btn-tiny btn-ghost"
						title="하루 뒤"
						onClick={() => onShift(1)}
					>
						›
					</button>
				</div>
				<div className="flex-1" />
				<div className="flex flex-wrap gap-2">
					<button
						type="button"
						className="btn btn-ghost"
						title="옵시디언 일지(〔Wn〕 D(요일).md)에 붙여넣을 수 있도록 전체 내용을 마크다운으로 복사합니다"
						onClick={onCopyMd}
					>
						📄 마크다운 복사
					</button>
					<button
						type="button"
						className="btn btn-ghost"
						title="직전 근무일 '금일 진행 업무'를 이 날짜 '전일'로 이월하고 초안을 채웁니다"
						onClick={onCarry}
					>
						↧ 전일 이월
					</button>
				</div>
			</div>

			<div className="p-5">
				<SectionList curDate={curDate} />

				<div className="mb-2 mt-[22px] flex items-center gap-2.5">
					<h3 className="m-0 text-sm">Teams 붙여넣기용 (데일리 스크럼)</h3>
					<span className="text-xs text-ink-2">채팅방에 그대로 복붙</span>
					<div className="flex-1" />
					<button type="button" className="btn btn-primary" onClick={onCopy}>
						📋 복사
					</button>
				</div>
				<pre className="m-0 overflow-x-auto whitespace-pre rounded-xl border border-line bg-mono p-4 font-mono text-[13px] leading-[1.55] text-ink">
					{teams}
				</pre>
			</div>
		</section>
	);
}
