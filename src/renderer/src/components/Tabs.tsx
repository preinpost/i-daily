export type View = "log" | "tickets" | "lunch" | "report" | "config";

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
				"cursor-pointer rounded-[9px] border-0 px-3.5 py-2 text-[14px] font-semibold " +
				(view === v
					? "bg-accent text-accent-ink"
					: "bg-transparent text-ink-2 hover:bg-panel-2")
			}
			onClick={() => onView(v)}
		>
			{label}
		</button>
	);
	return (
		<nav className="sticky top-0 z-[100] flex h-tabh items-center gap-1 border-b border-line bg-panel px-2.5">
			{tab("log", "📋 업무일지")}
			{tab("tickets", "🎫 내 티켓", "내게 할당된 Jira 티켓")}
			{tab("lunch", "🍽️ 점심", "팀원이랑 맛있는 식사 — 주변 음식점")}
			{tab("report", "📄 주간보고", "전주 금~금주 목 주간업무보고 생성")}
			<div className="flex-1" />
			{tab("config", "⚙️ 설정", "설정")}
		</nav>
	);
}
