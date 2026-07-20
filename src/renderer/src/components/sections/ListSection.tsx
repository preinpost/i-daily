import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEditor } from "../../context/EditorContext";
import { useToast } from "../Toast";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import { api } from "../../lib/api";
import {
	copyListItemToScrum,
	itemId,
	listHasContent,
	syncScrumFromDailyChange,
} from "../../lib/model";
import { autoGrow, confirmReset } from "../../lib/ui";
import { useReorder } from "../../lib/useDnd";
import { DragHandle } from "../DragHandle";
import { GoButton } from "../GoButton";
import { SubList } from "../SubList";
import type { ListItem, Section, Space } from "../../types";

type ListSec = Section & { kind: "list" };

type PrevEntry = { progress: number | ""; from: string; desc: string };

export function ListSection({
	sec,
	curDate,
}: {
	sec: ListSec;
	curDate: string;
}) {
	const { doc, commit } = useEditor();
	const toast = useToast();
	if (!sec.items) sec.items = [];

	// 직전 근무일의 일일 진행 업무를 티켓ID(없으면 설명) 기준으로 매핑 — 같은 항목의 전날 진척도 표시용
	const [prevMap, setPrevMap] = useState<Record<string, PrevEntry>>({});
	useEffect(() => {
		let alive = true;
		(async () => {
			const r = await api<any>("GET", `/api/day/${curDate}/prev-daily`);
			if (!alive) return;
			if (!r.ok || !r.json || !Array.isArray(r.json.items))
				return setPrevMap({});
			const from: string = r.json.from || "";
			const m: Record<string, PrevEntry> = {};
			(r.json.items as ListItem[]).forEach((it) => {
				const id = itemId(it);
				if (!id) return;
				m[id] = { progress: it.progress ?? "", from, desc: it.desc || "" };
			});
			setPrevMap(m);
		})();
		return () => {
			alive = false;
		};
	}, [curDate]);

	async function importYesterday() {
		const r = await api<any>("GET", `/api/day/${curDate}/prev-daily`);
		if (!r.ok || !r.json || !r.json.count)
			return toast("가져올 어제 일일 기록이 없어요");
		const incoming: ListItem[] = (r.json.items || []).filter(
			(it: ListItem) => (it.key || "").trim() || (it.desc || "").trim(),
		);
		if (!incoming.length) return toast("가져올 어제 일일 기록이 없어요");
		const hasId = (id: string) =>
			(sec.items || []).some((it) => itemId(it) === id);
		let added = 0;
		incoming.forEach((src) => {
			const id = itemId(src);
			if (!id || hasId(id)) return; // 이미 있으면 스킵(진척·마감 보존)
			sec.items.push({
				done: false, // 새 날이므로 완료 해제
				key: src.key || "",
				desc: src.desc || "",
				progress: typeof src.progress === "number" ? src.progress : "",
				due: src.due || "",
				subs: (src.subs || []).slice(),
			});
			added++;
		});
		if (!added) return toast("이미 모두 일일에 있어요");
		commit();
		toast(`${r.json.from} 일일 ${added}건 가져옴 — 진척/마감 확인`);
	}

	return (
		<div className="mb-[22px]">
			<h3 className="mb-2.5 mt-0 flex items-center gap-[7px] text-[15px] tracking-[-0.2px]">
				<span>{sec.title || "일일 진행 업무"}</span>
				<div className="flex-1" />
				<button
					type="button"
					className="btn btn-tiny btn-ghost"
					title="직전 근무일의 '일일 진행 업무'에서 없는 항목만 가져옵니다 (진척·마감 유지, 완료 체크는 해제)"
					onClick={importYesterday}
				>
					↧ 어제 일일
				</button>
				<button
					type="button"
					className="btn btn-tiny btn-ghost"
					title="이 섹션 항목을 비웁니다 (저장 전이면 새로고침으로 복구)"
					onClick={() => {
						const label = sec.title || "일일 진행 업무";
						if (!listHasContent(sec)) return toast("이미 비어 있어요");
						if (!confirmReset(label)) return;
						sec.items = [];
						commit();
						toast(label + " 초기화");
					}}
				>
					초기화
				</button>
			</h3>

			<div className="grid gap-1.5">
				{!sec.items.length && (
					<div className="p-3.5 text-center text-[13px] text-ink-2">
						+ 항목으로 오늘 한 일을 추가하세요 (전일/금일 드롭다운 원본)
					</div>
				)}
				{sec.items.map((it, i) => (
					<ListItemRow
						key={i}
						sec={sec}
						it={it}
						index={i}
						scrum={doc.scrum}
						prev={prevMap[itemId(it)]}
					/>
				))}
			</div>

			<button
				type="button"
				className="btn btn-tiny btn-ghost mt-1.5"
				onClick={() => {
					sec.items.push({
						done: false,
						key: "",
						desc: "",
						progress: "",
						due: "",
						subs: [],
					});
					commit();
				}}
			>
				+ 항목
			</button>
		</div>
	);
}

function ListItemRow({
	sec,
	it,
	index,
	scrum,
	prev,
}: {
	sec: ListSec;
	it: ListItem;
	index: number;
	scrum: import("../../types").Scrum;
	prev?: PrevEntry;
}) {
	const { commit } = useEditor();
	const toast = useToast();
	const openMenu = useContextMenu();
	const [spaceOpen, setSpaceOpen] = useState(false); // 새 스페이스 모달
	if (!it.subs) it.subs = [];
	const descRef = useRef<HTMLTextAreaElement>(null);
	const keyPrevId = useRef(itemId(it));
	const descPrevId = useRef(itemId(it));
	const { over, props } = useReorder(sec.items, index, commit);

	useEffect(() => {
		autoGrow(descRef.current);
	});

	const syncSubs = () => syncScrumFromDailyChange(scrum, itemId(it), it);

	// 우클릭 → 데일리 스크럼 '금일 진행 업무'로 추가. 각 스페이스는 마지막에 배치.
	function addToToday(sp: Space | null) {
		const r = copyListItemToScrum(scrum, "today", it, sp);
		toast(r.msg);
		if (r.ok) commit();
	}
	// 새 스페이스를 만들어 이 항목을 등록. 중복이면 방금 만든 빈 스페이스는 롤백.
	function addToNewSpace(label: string) {
		const name = label.trim();
		if (!name) return;
		const sp: Space = { label: name, tasks: [] };
		scrum.today.spaces.push(sp);
		const r = copyListItemToScrum(scrum, "today", it, sp);
		setSpaceOpen(false);
		if (!r.ok) {
			scrum.today.spaces.pop();
			return toast(r.msg);
		}
		commit();
		toast(`[${name}] 스페이스에 등록`);
	}
	function onRowContextMenu(e: React.MouseEvent) {
		if (!itemId(it)) return; // 빈 항목은 네이티브 메뉴 유지
		e.preventDefault();
		const items: MenuItem[] = [
			{ label: "금일 진행 업무에 추가", onClick: () => addToToday(null) },
		];
		const labeled = (scrum.today.spaces || []).filter((s) =>
			(s.label || "").trim(),
		);
		if (labeled.length) {
			items.push({ sep: true });
			for (const s of labeled)
				items.push({
					label: `[${s.label}]에 추가`,
					onClick: () => addToToday(s),
				});
		}
		items.push({ sep: true });
		items.push({
			label: "＋ 새 스페이스에 등록…",
			onClick: () => setSpaceOpen(true),
		});
		openMenu(e.clientX, e.clientY, items);
	}

	return (
		<div
			className={
				"drag-row flex flex-wrap items-center gap-2 rounded-lg bg-panel-2 p-2 " +
				(over ? "dragover" : "")
			}
			{...props}
			onContextMenu={onRowContextMenu}
		>
			<DragHandle arr={sec.items} index={index} kind="list" />

			<span
				className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--accent)_18%,var(--chip))] text-[12.5px] font-bold tabular-nums text-accent"
				title={`일일 진행 업무 ${index + 1}번`}
			>
				{index + 1}
			</span>

			<span className="flex flex-none items-center gap-0.5">
				<input
					className="likey w-[104px] flex-none uppercase"
					placeholder="티켓"
					value={it.key || ""}
					onFocus={() => (keyPrevId.current = itemId(it))}
					onChange={(e) => {
						it.key = e.target.value.trim().toUpperCase();
						commit();
					}}
					onBlur={() => {
						syncScrumFromDailyChange(scrum, keyPrevId.current, it);
						keyPrevId.current = itemId(it);
						commit();
					}}
				/>
				<GoButton getKey={() => it.key} />
			</span>

			<textarea
				ref={descRef}
				className="min-h-[34px] min-w-[130px] flex-1 resize-none self-center overflow-hidden whitespace-pre-wrap break-words leading-[1.45]"
				rows={1}
				placeholder="한 일"
				value={it.desc || ""}
				onFocus={() => (descPrevId.current = itemId(it))}
				onChange={(e) => {
					const v = e.target.value.replace(/\n/g, ""); // 개행은 저장 안 함(한 줄 유지)
					it.desc = v;
					autoGrow(e.target);
					commit();
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter") e.preventDefault();
				}}
				onBlur={() => {
					syncScrumFromDailyChange(scrum, descPrevId.current, it);
					descPrevId.current = itemId(it);
					commit();
				}}
			/>

			<span className="flex flex-none items-center gap-1 whitespace-nowrap text-[12.5px] text-ink-2">
				진척
				<span className="relative inline-flex w-[58px] flex-col items-center">
					<input
						className="w-full text-right"
						type="number"
						min={0}
						max={100}
						placeholder="%"
						value={it.progress === 0 ? "0" : it.progress || ""}
						onChange={(e) => {
							it.progress = e.target.value === "" ? "" : Number(e.target.value);
							commit();
						}}
					/>
					{prev && typeof prev.progress === "number" && (
						<span
							className="pointer-events-none absolute left-1/2 top-[calc(100%+1px)] -translate-x-1/2 whitespace-nowrap text-[11px] font-medium leading-none text-sky-500"
							title={`${prev.from} 진척도`}
						>
							전일 {prev.progress}%
						</span>
					)}
				</span>
				%
			</span>

			<span className="flex flex-none items-center gap-1 whitespace-nowrap text-[12.5px] text-ink-2">
				마감
				<input
					type="date"
					value={it.due || ""}
					onChange={(e) => {
						it.due = e.target.value;
						commit();
					}}
				/>
			</span>

			<button
				type="button"
				className="btn btn-tiny btn-ghost"
				onClick={() => {
					it.subs!.push("");
					syncSubs();
					commit();
				}}
			>
				+하위
			</button>

			<button
				type="button"
				className="btn btn-icon btn-tiny"
				title="삭제"
				onClick={() => {
					sec.items.splice(index, 1);
					commit(); // 스크럼 항목은 남김(고아 → 드롭다운 '일일에 없음')
				}}
			>
				✕
			</button>

			<SubList subs={it.subs} onSync={syncSubs} />

			{spaceOpen && (
				<NewSpaceModal
					title={dailyItemTitle(it)}
					onClose={() => setSpaceOpen(false)}
					onSubmit={addToNewSpace}
				/>
			)}
		</div>
	);
}

// 항목 라벨(티켓 · 설명) — 모달 안내문용.
function dailyItemTitle(it: ListItem): string {
	const k = (it.key || "").trim();
	const d = (it.desc || "").trim();
	return k && d ? `${k} · ${d}` : k || d || "이 항목";
}

// 새 스페이스 이름 입력 모달. 자체 입력 상태를 가져 타이핑마다 행 리렌더 없음.
function NewSpaceModal({
	title,
	onSubmit,
	onClose,
}: {
	title: string;
	onSubmit: (name: string) => void;
	onClose: () => void;
}) {
	const [name, setName] = useState("");
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => {
		ref.current?.focus();
	}, []);
	const submit = () => {
		if (name.trim()) onSubmit(name);
	};
	return createPortal(
		<div
			className="fixed inset-0 z-[200] flex items-center justify-center bg-black/45 p-4"
			onMouseDown={onClose}
		>
			<div
				className="w-full max-w-[400px] rounded-xl border border-line bg-panel p-4 shadow-2xl"
				onMouseDown={(e) => e.stopPropagation()}
			>
				<h4 className="m-0 mb-1 text-[15px] font-bold text-ink">
					새 스페이스에 등록
				</h4>
				<p className="mb-3 mt-0 text-[12.5px] leading-[1.5] text-ink-2">
					금일 진행 업무에 새 스페이스를 만들어{" "}
					<b className="text-ink">{title}</b> 항목을 추가합니다.
				</p>
				<input
					ref={ref}
					className="w-full"
					list="spaceList"
					placeholder="스페이스 이름 (예: backend)"
					value={name}
					onChange={(e) => setName(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							submit();
						} else if (e.key === "Escape") onClose();
					}}
				/>
				<div className="mt-3.5 flex justify-end gap-2">
					<button type="button" className="btn btn-ghost" onClick={onClose}>
						취소
					</button>
					<button
						type="button"
						className="btn btn-primary"
						disabled={!name.trim()}
						onClick={submit}
					>
						등록
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
