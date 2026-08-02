export type View = "log" | "tickets" | "report" | "ms" | "config";

export function Tabs({
	view,
	onView,
}: {
	view: View;
	onView: (v: View) => void;
}) {
	const tab = (v: View, label: string, title?: string) => (
		<button
			type="button"
			title={title}
			className={
				"inline-flex cursor-pointer items-center gap-1.5 rounded-[6px] border px-3.5 py-[7px] text-[13.5px] font-semibold transition-[background,color,border-color,box-shadow] duration-150 " +
				(view === v
					? "border-accent bg-accent text-accent-ink shadow-[0_1px_2px_rgba(37,99,235,0.25)]"
					: "border-transparent bg-transparent text-ink hover:bg-panel-2")
			}
			onClick={() => onView(v)}
		>
			{label}
		</button>
	);
	return (
		<nav className="border-b border-line bg-panel">
			<div className="mx-auto flex h-tabh max-w-[1120px] items-center gap-1.5 px-5">
				{tab("log", "업무일지")}
				{tab("tickets", "내 티켓", "내게 할당된 Jira 티켓")}
				{tab("report", "주간보고", "전주 금~금주 목 주간업무보고 생성")}
				{tab("ms", "Graph 테스트", "Microsoft Graph 실험/디버그")}
				<div className="flex-1" />
				<button
					type="button"
					title="설정"
					className={
						"inline-flex cursor-pointer items-center gap-1.5 rounded-[6px] border px-3 py-[7px] text-[13px] font-semibold transition-[background,color] duration-150 " +
						(view === "config"
							? "border-accent bg-accent text-accent-ink"
							: "border-line bg-panel text-ink-2 hover:bg-panel-2 hover:text-ink")
					}
					onClick={() => onView("config")}
				>
					설정
				</button>
			</div>
		</nav>
	);
}
