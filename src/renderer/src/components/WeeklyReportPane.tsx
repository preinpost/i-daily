import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { useToast } from "./Toast";
import { api } from "../lib/api";
import {
	THIS_WEEK_HEADER,
	NEXT_WEEK_HEADER,
} from "../../../shared/report";

type Result = {
	ok: boolean;
	from: string;
	to: string;
	count: number;
	text: string;
	thisWeek: string;
	nextWeek: string;
	warn?: string;
} | null;

type SavedMeta = { from: string; to: string; updatedAt: string };

const fieldCls = "rounded-[9px] bg-panel-2 px-3 py-[9px] text-[13px]";

function Spinner() {
	return (
		<span
			className="inline-block h-[14px] w-[14px] animate-spin rounded-full border-2 border-current border-t-transparent align-[-2px]"
			aria-hidden
		/>
	);
}

function fmtUpdated(iso: string): string {
	try {
		return new Date(iso).toLocaleString("ko-KR", {
			month: "numeric",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	} catch {
		return iso;
	}
}

export function WeeklyReportPane({ active }: { active: boolean }) {
	const toast = useToast();
	const [from, setFrom] = useState("");
	const [to, setTo] = useState("");
	const [busy, setBusy] = useState(false);
	const [saving, setSaving] = useState(false);
	const [res, setRes] = useState<Result>(null);
	const [seeded, setSeeded] = useState(false);
	const [saved, setSaved] = useState<SavedMeta[]>([]);
	const [selectedKey, setSelectedKey] = useState("");
	const thisWeekRef = useRef<HTMLTextAreaElement>(null);
	const nextWeekRef = useRef<HTMLTextAreaElement>(null);

	async function refreshSaved() {
		const r = await api<{ reports: SavedMeta[] }>("GET", "/api/weekly-reports");
		if (r.ok && r.json?.reports) setSaved(r.json.reports);
	}

	useEffect(() => {
		if (active) void refreshSaved();
	}, [active]);

	// 처음 열릴 때 기본 기간(Fri~Thu)으로 1회 자동 집계.
	useEffect(() => {
		if (active && !seeded) {
			setSeeded(true);
			void gen();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [active, seeded]);

	useLayoutEffect(() => {
		for (const el of [thisWeekRef.current, nextWeekRef.current]) {
			if (!el) continue;
			el.style.height = "auto";
			el.style.height = el.scrollHeight + "px";
		}
	}, [res?.thisWeek, res?.nextWeek, active]);

	async function gen() {
		if (!window.api?.agent || busy) return;
		setBusy(true);
		setSelectedKey("");
		try {
			const opts: { from?: string; to?: string } = {};
			if (from) opts.from = from;
			if (to) opts.to = to;
			const r = await window.api.agent.generate(opts);
			setRes(r);
			if (r?.from) setFrom(r.from);
			if (r?.to) setTo(r.to);
		} catch (e) {
			toast("집계 실패: " + (e instanceof Error ? e.message : String(e)));
		} finally {
			setBusy(false);
		}
	}

	async function save() {
		if (!res || saving) return;
		setSaving(true);
		try {
			const r = await api<any>("PUT", "/api/weekly-reports", {
				from: res.from,
				to: res.to,
				thisWeek: res.thisWeek,
				nextWeek: res.nextWeek,
			});
			if (r.ok) {
				toast("주간보고 저장됨");
				setSelectedKey(`${res.from}|${res.to}`);
				await refreshSaved();
			} else toast("저장 실패");
		} finally {
			setSaving(false);
		}
	}

	async function loadSaved(item: SavedMeta) {
		const r = await api<any>(
			"GET",
			`/api/weekly-reports/${item.from}/${item.to}`,
		);
		if (!r.ok || !r.json) {
			toast("불러오기 실패");
			return;
		}
		setFrom(r.json.from);
		setTo(r.json.to);
		setRes({
			ok: true,
			from: r.json.from,
			to: r.json.to,
			count: 0,
			text: r.json.text || "",
			thisWeek: r.json.thisWeek || "",
			nextWeek: r.json.nextWeek || "",
		});
		setSelectedKey(`${item.from}|${item.to}`);
		toast("저장된 주간보고 불러옴");
	}

	async function removeSaved(item: SavedMeta, e: MouseEvent) {
		e.stopPropagation();
		if (!confirm(`${item.from} ~ ${item.to} 저장본을 삭제할까요?`)) return;
		const r = await api<any>(
			"DELETE",
			`/api/weekly-reports/${item.from}/${item.to}`,
		);
		if (r.ok) {
			toast("삭제됨");
			if (selectedKey === `${item.from}|${item.to}`) setSelectedKey("");
			await refreshSaved();
		} else toast("삭제 실패");
	}

	async function copy(header: string, body: string) {
		const text = body.trim() ? `${header}\n${body.trim()}` : "";
		if (!text) return;
		try {
			await navigator.clipboard.writeText(text);
			toast(`${header} 복사됨 — Teams 채팅에 붙여넣기`);
		} catch {
			toast("복사 실패");
		}
	}

	return (
		<div
			hidden={!active}
			className="fixed inset-x-0 bottom-0 top-tabh z-50 flex bg-bg"
		>
			{/* 왼쪽: 기존 집계·편집 */}
			<div className="min-w-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-5 pb-16 pt-7">
					<h2 className="m-0 text-xl font-extrabold text-ink">📋 주간업무보고</h2>
					<p className="tint-accent m-0 rounded-[10px] px-3.5 py-2.5 text-[13px] text-ink">
						전주 금요일 ~ 금주 목요일 사이의 진행 업무를 스페이스별로 뭉쳐 Teams
						붙여넣기용으로 만듭니다.
						<br />
						MCP로도 호출할 수 있어요 — 예: "i-daily로 이번주 업무일지 생성해줘"
						<br />
						<span className="text-ink-2">
							오른쪽에서 주별로 저장본을 다시 볼 수 있습니다.
						</span>
					</p>

					<div className="flex flex-wrap items-end gap-3">
						<label className="flex flex-col gap-1.5">
							<span className="text-[13px] font-bold text-ink">시작 (금)</span>
							<input
								className={fieldCls}
								type="date"
								value={from}
								onChange={(e) => setFrom(e.target.value)}
							/>
						</label>
						<label className="flex flex-col gap-1.5">
							<span className="text-[13px] font-bold text-ink">끝 (목)</span>
							<input
								className={fieldCls}
								type="date"
								value={to}
								onChange={(e) => setTo(e.target.value)}
							/>
						</label>
						<button
							type="button"
							className="btn btn-primary"
							onClick={() => gen()}
							disabled={busy}
						>
							{busy ? (
								<>
									<Spinner /> 집계 중…
								</>
							) : (
								"집계"
							)}
						</button>
						<button
							type="button"
							className="btn btn-ghost"
							onClick={() => save()}
							disabled={!res || saving}
							title="현재 금주/차주 텍스트를 DB에 저장"
						>
							{saving ? (
								<>
									<Spinner /> 저장 중…
								</>
							) : (
								"💾 저장"
							)}
						</button>
					</div>

					{res && (
						<div className="flex flex-col gap-4">
							<div className="text-[13px] text-ink-2">
								{res.from} ~ {res.to}
								{res.count ? ` · ${res.count}건` : ""}
							</div>
							<section className="flex flex-col gap-1.5">
								<div className="flex items-center gap-2">
									<h3 className="m-0 text-[13px] font-bold text-ink">
										{THIS_WEEK_HEADER}
									</h3>
									<button
										type="button"
										className="btn btn-ghost ml-auto"
										onClick={() => copy(THIS_WEEK_HEADER, res.thisWeek)}
										disabled={!res.thisWeek.trim()}
									>
										📋 복사
									</button>
								</div>
								<textarea
									ref={thisWeekRef}
									wrap="soft"
									className={
										fieldCls +
										" resize-none overflow-hidden whitespace-pre-wrap break-words font-mono leading-relaxed placeholder:text-ink-2"
									}
									value={res.thisWeek}
									onChange={(e) =>
										setRes({ ...res, thisWeek: e.target.value })
									}
									placeholder="(해당 기간 항목 없음)"
									spellCheck={false}
								/>
							</section>
							<section className="flex flex-col gap-1.5">
								<div className="flex items-center gap-2">
									<h3 className="m-0 text-[13px] font-bold text-ink">
										{NEXT_WEEK_HEADER}{" "}
										<span className="font-normal text-ink-2">
											(진척도/완료날짜 한번 더 확인)
										</span>
									</h3>
									<button
										type="button"
										className="btn btn-ghost ml-auto"
										onClick={() => copy(NEXT_WEEK_HEADER, res.nextWeek)}
										disabled={!res.nextWeek.trim()}
									>
										📋 복사
									</button>
								</div>
								<textarea
									ref={nextWeekRef}
									wrap="soft"
									className={
										fieldCls +
										" resize-none overflow-hidden whitespace-pre-wrap break-words font-mono leading-relaxed placeholder:text-ink-2"
									}
									value={res.nextWeek}
									onChange={(e) =>
										setRes({ ...res, nextWeek: e.target.value })
									}
									placeholder="(해당 기간 항목 없음)"
									spellCheck={false}
								/>
							</section>
							{res.warn && (
								<small className="text-xs text-amber-600">{res.warn}</small>
							)}
						</div>
					)}
				</div>
			</div>

			{/* 오른쪽: 저장된 주 목록 */}
			<aside className="flex w-[260px] shrink-0 flex-col border-l border-line bg-panel">
				<div className="flex items-center gap-2 border-b border-line px-3.5 py-3">
					<span className="text-[13px] font-bold text-ink">저장된 주간</span>
					<button
						type="button"
						className="btn btn-ghost ml-auto px-2 py-1 text-[12px]"
						onClick={() => refreshSaved()}
						title="목록 새로고침"
					>
						↻
					</button>
				</div>
				<div className="flex-1 overflow-y-auto p-2">
					{saved.length === 0 ? (
						<p className="m-0 px-2 py-4 text-center text-[12px] text-ink-2">
							아직 저장본이 없습니다.
							<br />
							집계 후 저장하거나 MCP
							<br />
							<code className="text-[11px]">save_weekly_report</code>
						</p>
					) : (
						<ul className="m-0 flex list-none flex-col gap-1 p-0">
							{saved.map((item) => {
								const key = `${item.from}|${item.to}`;
								const on = selectedKey === key;
								return (
									<li key={key}>
										<button
											type="button"
											onClick={() => loadSaved(item)}
											className={
												"flex w-full flex-col gap-0.5 rounded-[9px] px-3 py-2.5 text-left transition " +
												(on
													? "bg-accent/15 text-ink"
													: "text-ink hover:bg-panel-2")
											}
										>
											<span className="text-[12.5px] font-semibold">
												{item.from.slice(5)} ~ {item.to.slice(5)}
											</span>
											<span className="flex items-center gap-1 text-[11px] text-ink-2">
												{fmtUpdated(item.updatedAt)}
												<span
													role="button"
													tabIndex={0}
													className="ml-auto rounded px-1 hover:bg-rose-500/15 hover:text-rose-600"
													onClick={(e) => removeSaved(item, e)}
													onKeyDown={(e) => {
														if (e.key === "Enter" || e.key === " ")
															removeSaved(
																item,
																e as unknown as MouseEvent,
															);
													}}
													title="삭제"
												>
													✕
												</span>
											</span>
										</button>
									</li>
								);
							})}
						</ul>
					)}
				</div>
			</aside>
		</div>
	);
}
