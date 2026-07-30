import { useState } from "react";
import { SectionList } from "./sections/SectionList";
import { TeamsImportModal } from "./TeamsImportModal";

export function DayCard({
	curDate,
	today,
	onShift,
	onPickDate,
	onGenerateScrum,
	teams,
	onCopy,
	onCopyMd,
}: {
	curDate: string;
	today?: string | null;
	onShift: (days: number) => void;
	onPickDate: (date: string) => void;
	onGenerateScrum: () => void;
	teams: string;
	onCopy: () => void;
	onCopyMd: () => void;
}) {
	const [teamsImportOpen, setTeamsImportOpen] = useState(false);

	return (
		<section className="mt-4 overflow-hidden rounded-card border border-line bg-panel shadow-card">
			<div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3.5">
				<div className="flex flex-wrap items-center gap-3">
					<h2 className="m-0 text-[15.5px] font-bold tracking-[-0.02em]">
						데일리 업무일지
					</h2>
					<div className="inline-flex items-center gap-1 rounded-[6px] border border-line bg-panel p-0.5">
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
							className="min-w-[118px] border-0 bg-transparent px-2.5 py-1 text-center font-bold tabular-nums"
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
					{today && curDate !== today && (
						<button
							type="button"
							className="btn btn-tiny btn-ghost"
							title="오늘 날짜로 이동"
							onClick={() => onPickDate(today)}
						>
							오늘로
						</button>
					)}
				</div>
				<div className="flex flex-wrap gap-2">
					<button
						type="button"
						className="btn btn-ghost"
						title="옵시디언 일지(〔Wn〕 D(요일).md)에 붙여넣을 수 있도록 전체 내용을 마크다운으로 복사합니다"
						onClick={onCopyMd}
					>
						마크다운 복사
					</button>
					<button
						type="button"
						className="btn btn-ghost"
						title="Teams 데일리 스크럼 텍스트를 붙여넣어 금일 진행 업무를 일일 진행 업무로 가져옵니다"
						onClick={() => setTeamsImportOpen(true)}
					>
						Teams에서 복사
					</button>
				</div>
			</div>

			<div className="p-4">
				<SectionList
					curDate={curDate}
					onGenerateScrum={onGenerateScrum}
					teamsBlock={
						<>
							<div
								id="teams-output"
								className="mb-2 mt-[18px] flex items-center gap-2.5"
							>
								<h3 className="m-0 text-[14.5px] font-bold">
									Teams 붙여넣기용
								</h3>
								<span className="hint-pill">채팅방에 그대로 복붙</span>
								<div className="flex-1" />
								<button
									type="button"
									className="btn btn-primary"
									onClick={onCopy}
								>
									복사
								</button>
							</div>
							<pre className="mx-0 mb-[18px] mt-0 min-h-[120px] overflow-x-auto whitespace-pre-wrap rounded-[6px] border border-line bg-panel-2 p-4 font-mono text-[12.5px] leading-[1.65] text-ink">
								{teams}
							</pre>
						</>
					}
				/>
			</div>
			{teamsImportOpen && (
				<TeamsImportModal onClose={() => setTeamsImportOpen(false)} />
			)}
		</section>
	);
}
