import { useEffect, useRef, useState } from "react";
import { useEditor } from "../context/EditorContext";
import { useToast } from "./Toast";
import { useContextMenu } from "./ContextMenu";
import {
	copyListItemToScrum,
	ensureDailyItem,
	kanbanColumns,
} from "../lib/model";
import type { Ticket, Which } from "../types";

export function TicketsPane({ active }: { active: boolean }) {
	const { doc, commit } = useEditor();
	const toast = useToast();
	const openMenu = useContextMenu();
	const [state, setState] = useState<{
		loading: boolean;
		error?: string;
		tickets: Ticket[];
		site?: string;
	}>({
		loading: true,
		tickets: [],
	});
	const loaded = useRef(false);

	async function load(force?: boolean) {
		const jira = window.api?.jira;
		if (!jira) return;
		if (loaded.current && !force) return;
		loaded.current = true;
		setState((s) => ({ ...s, loading: true, error: undefined }));
		let r: any = null;
		try {
			r = await jira.tickets();
		} catch (e) {
			r = { ok: false, error: String(e) };
		}
		if (!r || !r.ok) {
			loaded.current = false;
			setState({
				loading: false,
				error: (r && r.error) || "알 수 없는 오류",
				tickets: [],
			});
			return;
		}
		setState({ loading: false, tickets: r.tickets || [], site: r.site });
	}

	useEffect(() => {
		if (active) load(false);
	}, [active]);

	// ⌘R / Ctrl+R / F5 → 티켓 새로고침 (티켓 화면에서만)
	useEffect(() => {
		if (!active) return;
		const onKey = (e: KeyboardEvent) => {
			const isRefresh =
				e.key === "F5" ||
				((e.metaKey || e.ctrlKey) && (e.key === "r" || e.key === "R"));
			if (!isRefresh) return;
			const t = e.target as HTMLElement | null;
			if (
				t &&
				(t.tagName === "INPUT" ||
					t.tagName === "TEXTAREA" ||
					t.isContentEditable)
			)
				return;
			e.preventDefault();
			load(true);
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [active]);

	function addToDaily(t: Ticket) {
		const r = ensureDailyItem(doc, t);
		if ("error" in r) return toast(r.error);
		commit();
		toast(
			r.added
				? t.key + " → 일일 진행 업무 등록"
				: t.key + " 이미 일일에 있어요",
		);
	}
	function addToScrum(which: Which, t: Ticket) {
		const r = ensureDailyItem(doc, t);
		if ("error" in r) return toast(r.error);
		const res = copyListItemToScrum(doc.scrum, which, r.item, null);
		toast(res.msg);
		if (res.ok || r.added) commit();
	}

	return (
		<div
			hidden={!active}
			className="fixed inset-x-0 bottom-0 top-tabh z-50 flex flex-col overflow-y-auto bg-bg"
		>
			<div className="mx-auto w-full max-w-[1200px] px-5 pb-12 pt-5">
				<div className="mb-3.5 flex items-center gap-3">
					<h2 className="m-0 text-xl font-extrabold text-ink">🎫 내 티켓</h2>
					<span className="text-xs text-ink-2">
						{state.site ? "@ " + state.site : ""}
					</span>
					<div className="flex-1" />
					<button
						type="button"
						className="btn btn-ghost"
						title="새로고침 (⌘R / Ctrl+R / F5)"
						onClick={() => load(true)}
					>
						↻ 새로고침
					</button>
				</div>

				{state.loading ? (
					<p className="px-0.5 py-3 text-[13px] text-ink-2">불러오는 중…</p>
				) : state.error ? (
					<p className="px-0.5 py-3 text-[13px] text-danger">
						불러오기 실패: {state.error} — ⚙️ 설정에서 Jira 연결을 확인하세요.
					</p>
				) : !state.tickets.length ? (
					<p className="px-0.5 py-3 text-[13px] text-ink-2">
						내게 할당된 티켓이 없습니다.
					</p>
				) : (
					<div className="grid grid-cols-3 items-start gap-3.5">
						{kanbanColumns(state.tickets).map((col) => (
							<div
								key={col.cat}
								className="flex min-w-0 flex-col rounded-xl border border-line bg-panel-2 p-2.5"
							>
								<div className="mb-2.5 flex items-center gap-2 border-b border-line px-1 pb-2.5">
									<span
										className={
											"text-[12px] font-extrabold uppercase tracking-[0.04em] " +
											(col.cat === "indeterminate"
												? "text-accent"
												: col.cat === "done"
													? "text-ink-2"
													: "text-ink")
										}
									>
										{col.title}
									</span>
									<span className="rounded-full border border-line bg-panel px-2 py-px text-[11px] font-bold text-ink-2">
										{col.items.length}
									</span>
								</div>
								<div className="flex flex-col gap-2">
									{!col.items.length ? (
										<div className="py-3.5 text-center text-[12px] text-ink-2 opacity-70">
											없음
										</div>
									) : (
										col.items.map((t) => (
											<div
												key={t.key}
												role="link"
												tabIndex={0}
												className="flex cursor-context-menu flex-col gap-[5px] rounded-[9px] border border-line bg-panel p-[10px_11px] text-ink hover:border-accent"
												onClick={() => {
													if (t.url) window.open(t.url, "_blank", "noopener");
												}}
												onKeyDown={(e) => {
													if ((e.key === "Enter" || e.key === " ") && t.url) {
														e.preventDefault();
														window.open(t.url, "_blank", "noopener");
													}
												}}
												onContextMenu={(e) => {
													e.preventDefault();
													openMenu(e.clientX, e.clientY, [
														{
															label: "일일 진행 업무에 추가",
															onClick: () => addToDaily(t),
														},
														{
															label: "전일 진행 업무에 추가",
															onClick: () => addToScrum("prev", t),
														},
														{
															label: "금일 진행 업무에 추가",
															onClick: () => addToScrum("today", t),
														},
													]);
												}}
											>
												<div className="flex items-baseline justify-between gap-2">
													<span className="whitespace-nowrap font-mono text-[12px] font-bold text-accent">
														{t.key}
													</span>
													{t.due && (
														<span className="whitespace-nowrap text-[11px] text-ink-2">
															~{t.due}
														</span>
													)}
												</div>
												<div className="clamp-3 text-[13px] leading-[1.35] text-ink">
													{t.summary}
												</div>
												<div className="truncate text-[11px] text-ink-2">
													{[t.status, t.type, t.priority]
														.filter(Boolean)
														.join(" · ")}
												</div>
											</div>
										))
									)}
								</div>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
