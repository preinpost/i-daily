import { useCallback, useEffect, useRef, useState } from "react";
import { useEditor } from "../context/EditorContext";
import { useToast } from "./Toast";
import { useContextMenu, type MenuItem } from "./ContextMenu";
import { ensureDailyItem, kanbanColumns, priorityLevel, type TicketSort } from "../lib/model";
import type { Ticket } from "../types";

/* ── 숨긴 티켓 (localStorage) ── */
const HIDDEN_KEY = "hidden-tickets";
function loadHidden(): Set<string> {
	try {
		return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || "[]"));
	} catch {
		return new Set();
	}
}
function saveHidden(s: Set<string>): void {
	localStorage.setItem(HIDDEN_KEY, JSON.stringify([...s]));
}

/* ── 정렬 모드 (localStorage) ── */
const SORT_KEY = "ticket-sort";
const SORT_OPTIONS: { value: TicketSort; label: string; title: string }[] = [
	{ value: "priority", label: "우선도순", title: "우선도 높은 순으로 보기" },
	{ value: "latest", label: "최신순", title: "최신(업데이트) 티켓부터 보기" },
	{ value: "due", label: "마감순", title: "마감 임박 순으로 보기" },
];
function loadSort(): TicketSort {
	const v = localStorage.getItem(SORT_KEY);
	return v === "latest" || v === "due" || v === "priority" ? v : "priority";
}

/* ── 전이 후보 캐시 ──
   서브메뉴를 열 다음 기다리지 않도록, 티켓별 전이 목록을 메모리에 든다.
   값이 아니라 Promise 를 담아 "로딩 중 중복 요청"까지 하나로 합친다.
   실패는 캐시하지 않고(다음 시도에 재조회), 새로고침/전이 실행 시 무효화한다. */
type Trans = { id: string; name: string; to: string; cat: string };

// 칸반 3열과 같은 축 — 메뉴에서도 할일/진행중/완료 순서로 보여준다.
const CAT_ORDER = ["new", "indeterminate", "done"];
// 상태 카테고리 이모지 — 칸반 컬럼 헤더(텍스트 뒤)·전이 서브메뉴 공용.
const CAT_ICON: Record<string, string> = {
	new: "📝",
	indeterminate: "🔄",
	done: "✅",
	rest: "📦",
};
// 워크플로우가 준 순서 대신 카테고리 순으로 정렬(안정 정렬).
function sortByCat(list: Trans[]): Trans[] {
	const rank = (c: string) => {
		const i = CAT_ORDER.indexOf(c);
		return i < 0 ? CAT_ORDER.length : i;
	};
	return [...list].sort((a, b) => rank(a.cat) - rank(b.cat));
}

// 목록 로드 직후 백그라운드로 달군다 — 동시 요청은 Jira 를 밀지 않게 제한.
const WARM_CONCURRENCY = 4;

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
	const transCache = useRef(new Map<string, Promise<Trans[]>>());

	// 캐시 적중이면 즉시, 아니면 1회 조회 후 저장.
	const fetchTransitions = useCallback((key: string): Promise<Trans[]> => {
		const cache = transCache.current;
		const hit = cache.get(key);
		if (hit) return hit;
		const p = (async () => {
			const r = await window.api?.jira?.transitions(key);
			if (!r || !r.ok) throw new Error(r?.error || "불러오기 실패");
			return r.transitions || [];
		})();
		p.catch(() => cache.delete(key));
		cache.set(key, p);
		return p;
	}, []);
	const [hidden, setHidden] = useState<Set<string>>(loadHidden);
	const [showHidden, setShowHidden] = useState(false);
	const [sort, setSort] = useState<TicketSort>(loadSort);
	const changeSort = useCallback((m: TicketSort) => {
		setSort(m);
		localStorage.setItem(SORT_KEY, m);
	}, []);

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
		transCache.current.clear();
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

	const hideTicket = useCallback((t: Ticket) => {
		setHidden((prev) => {
			const next = new Set(prev);
			next.add(t.key);
			saveHidden(next);
			return next;
		});
		toast(t.key + " 숨김 처리");
	}, []);

	// 전이 실행 → 성공 시 목록 새로고침(칸반 컬럼이 옮겨간다).
	const runTransition = useCallback(
		async (t: Ticket, tr: Trans) => {
			const r = await window.api?.jira?.transition(t.key, tr.id);
			if (!r || !r.ok)
				return toast(
					t.key + " 상태 변경 실패: " + (r?.error || "알 수 없는 오류"),
				);
			toast(t.key + " → " + (tr.to || tr.name));
			// 상태가 바뀌었으니 해당 티켓의 캐시는 버린다.
			transCache.current.delete(t.key);
			load(true);
		},
		[],
	);

	// 서브메뉴용 항목 — 캐시가 따뜻하면 await 없이 바로 끝난다.
	// 현재 상태로 가는 전이(자기 자신)는 의미가 없으므로 걸러낸다.
	const loadTransitions = useCallback(
		(t: Ticket) => async (): Promise<MenuItem[]> => {
			const list = await fetchTransitions(t.key);
			return sortByCat(list)
				.filter((tr) => !tr.to || tr.to !== t.status)
				.map((tr) => ({
					label:
						(CAT_ICON[tr.cat] || "•") +
						" " +
						(tr.to || tr.name) +
						(tr.to && tr.name && tr.to !== tr.name ? `  (${tr.name})` : ""),
					onClick: () => void runTransition(t, tr),
				}));
		},
		[runTransition, fetchTransitions],
	);

	const unhideTicket = useCallback((t: Ticket) => {
		setHidden((prev) => {
			const next = new Set(prev);
			next.delete(t.key);
			saveHidden(next);
			return next;
		});
		toast(t.key + " 다시 표시");
	}, []);

// 우선순위 형광펜 배지 — 표준 5단계(Highest=1 … Lowest=5)만 색칠, 그 외는 일반 텍스트.
function PriorityBadge({ value }: { value?: string }) {
	const name = (value || "").trim();
	if (!name) return null;
	const level = priorityLevel(name);
	if (!level) return <span className="truncate">{name}</span>;
	return (
		<span className="prio-badge" data-level={level}>
			{name}
		</span>
	);
}

	const visibleTickets = showHidden
		? state.tickets.filter((t) => hidden.has(t.key))
		: state.tickets.filter((t) => !hidden.has(t.key));

	// 목록이 뜼면 백그라운드로 전이 후보를 미리 달군다(동시 요청은 4개까지).
	// 여러 건을 연속으로 옮길 때의 "불러오는 중…" 대기를 없애는 게 목적.
	// done 열에서도 되돌릴 수 있으므로 모든 티켓을 대상으로 한다.
	const warmKeys = visibleTickets.map((t) => t.key).join(",");
	useEffect(() => {
		if (!active || showHidden || !warmKeys) return;
		const keys = warmKeys.split(",");
		let cancelled = false;
		let next = 0;
		const worker = async () => {
			while (!cancelled && next < keys.length) {
				const k = keys[next++];
				try {
					await fetchTransitions(k);
				} catch {
					/* 워밍 실패는 무시 — 실제 사용 시점에 다시 조회된다 */
				}
			}
		};
		for (let i = 0; i < WARM_CONCURRENCY; i++) void worker();
		return () => {
			cancelled = true;
		};
	}, [active, showHidden, warmKeys, fetchTransitions]);

	return (
		<div
			hidden={!active}
			className="fixed inset-x-0 bottom-0 top-[var(--chrome-offset,48px)] z-40 flex flex-col overflow-y-auto bg-bg"
		>
			<div className="mx-auto w-full max-w-[1120px] px-5 pb-12 pt-5">
				<div className="mb-4 flex flex-wrap items-center justify-between gap-3">
					<h2 className="m-0 inline-flex items-baseline gap-2 text-[18px] font-bold tracking-[-0.02em] text-ink">
						{showHidden ? "숨긴 업무" : "내 티켓"}
						{state.site && (
							<span className="text-[13px] font-medium text-ink-2">
								@ {state.site}
							</span>
						)}
					</h2>
					<div className="flex flex-wrap items-center gap-2">
						<div className="flex items-center gap-0.5 rounded-full border border-line bg-panel p-0.5">
							{SORT_OPTIONS.map((o) => (
								<button
									key={o.value}
									type="button"
									title={o.title}
									className={
										"rounded-full px-2.5 py-1 text-[11.5px] font-semibold transition-colors " +
										(sort === o.value
											? "bg-accent text-accent-ink"
											: "text-ink-2 hover:text-ink")
									}
									onClick={() => changeSort(o.value)}
								>
									{o.label}
								</button>
							))}
						</div>
						<button
							type="button"
							className={
								"btn btn-ghost" + (showHidden ? " text-accent-text" : "")
							}
							title="숨긴 업무 보기"
							onClick={() => setShowHidden((v) => !v)}
						>
							{showHidden
								? "← 티켓으로"
								: "숨긴 업무" + (hidden.size ? ` (${hidden.size})` : "")}
						</button>
						<button
							type="button"
							className="btn btn-ghost"
							title="새로고침 (⌘R / Ctrl+R / F5)"
							onClick={() => load(true)}
						>
							새로고침
						</button>
					</div>
				</div>

				{state.loading ? (
					<p className="px-0.5 py-3 text-[13px] text-ink-2">불러오는 중…</p>
				) : state.error ? (
					<p className="px-0.5 py-3 text-[13px] text-danger">
						불러오기 실패: {state.error} — 설정에서 Jira 연결을 확인하세요.
					</p>
				) : !visibleTickets.length ? (
					<p className="px-0.5 py-3 text-[13px] text-ink-2">
						{showHidden
							? "숨긴 업무가 없습니다."
							: "내게 할당된 티켓이 없습니다."}
					</p>
				) : (
					<div className="grid grid-cols-1 items-start gap-3.5 md:grid-cols-3">
						{kanbanColumns(visibleTickets, sort).map((col) => (
							<div
								key={col.cat}
								className="flex min-w-0 flex-col rounded-card border border-line bg-panel-2 p-2.5"
							>
								<div
									className="cat-head mb-2.5 flex items-center justify-between gap-2 rounded-[6px] px-2.5 py-1.5"
									data-cat={col.cat}
								>
									<span className="text-[13.5px] font-bold">
										{col.title} {CAT_ICON[col.cat] || ""}
									</span>
									<span className="inline-grid h-5 min-w-[22px] place-items-center rounded-full border border-line bg-panel px-1.5 text-[11.5px] font-bold tabular-nums text-ink-2">
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
												className={
													"flex cursor-context-menu flex-col gap-1.5 rounded-[6px] border border-line bg-panel px-3 py-2.5 text-ink shadow-card transition-[border-color,box-shadow] duration-150 hover:border-[color-mix(in_oklch,var(--accent)_28%,var(--line))] hover:shadow-panel " +
													(col.cat === "done" ? "opacity-90" : "")
												}
												onClick={() => {
													if (t.url) window.open(t.url, "_blank", "noopener");
												}}
												onMouseEnter={() => {
													// 카드에 마우스만 올려도 캐시를 채운다(우클릭 전 선행 로드).
													if (showHidden) return;
													void fetchTransitions(t.key).catch(() => {});
												}}
												onKeyDown={(e) => {
													if ((e.key === "Enter" || e.key === " ") && t.url) {
														e.preventDefault();
														window.open(t.url, "_blank", "noopener");
													}
												}}
												onContextMenu={(e) => {
													e.preventDefault();
													openMenu(
														e.clientX,
														e.clientY,
														showHidden
															? [
																	{
																		label: "다시 보이기",
																		onClick: () => unhideTicket(t),
																	},
																]
															: [
																	{
																		label: "일일 진행 업무에 추가",
																		onClick: () => addToDaily(t),
																	},
																	{
																		label: "상태 변경",
																		children: loadTransitions(t),
																	},
																	{ sep: true },
																	{
																		label: "업무 숨기기",
																		onClick: () => hideTicket(t),
																	},
																],
													);
												}}
											>
												<div className="flex items-center justify-between gap-2">
													<span className="whitespace-nowrap font-mono text-[12.5px] font-bold text-accent-text">
														{t.key}
													</span>
													{t.due && (
														<span className="whitespace-nowrap text-[11.5px] font-semibold tabular-nums text-ink-2">
															~{t.due}
														</span>
													)}
												</div>
												<div
													className={
														"clamp-3 text-[13px] font-semibold leading-[1.45] " +
														(col.cat === "done" ? "text-ink-2" : "text-ink")
													}
												>
													{t.summary}
												</div>
												<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] font-medium text-ink-2">
													{t.status && <span className="truncate">{t.status}</span>}
													{t.type && <span className="truncate">{t.type}</span>}
													{t.priority && <PriorityBadge value={t.priority} />}
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
