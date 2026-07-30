import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEditor } from "../../context/EditorContext";
import { useToast } from "../Toast";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import { api } from "../../lib/api";
import {
	groupListItems,
	itemId,
	listHasContent,
	moveListSpace,
	renameListSpace,
} from "../../lib/model";
import { autoGrow, confirmReset } from "../../lib/ui";
import { useListItemDrop, useSpaceDrop, useSubReorder } from "../../lib/useDnd";
import { DragHandle } from "../DragHandle";
import { GoButton } from "../GoButton";
import { SubList } from "../SubList";
import type { ListItem, Section } from "../../types";

type ListSec = Section & { kind: "list" };

type PrevEntry = { progress: number | ""; from: string; desc: string };

// 실제 지라 티켓 키 형태만 서버로 보낸다(임의 메모성 키는 무시).
const JIRA_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;

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
				space: src.space || "", // 어제 스페이스 그룹 유지
			});
			added++;
		});
		if (!added) return toast("이미 모두 일일에 있어요");
		commit();
		toast(`${r.json.from} 일일 ${added}건 가져옴 — 진척/마감 확인`);
	}

	const [groupModalOpen, setGroupModalOpen] = useState(false); // 새 스페이스 그룹 만들기 모달
	const groups = groupListItems(sec.items);
	const none = groups[0]; // 항상 첫 번째 = 무그룹("")
	const named = groups.slice(1);
	const allLabels = named.map((g) => g.label);
	// 무그룹 영역 드롭 — 다른 스페이스의 항목을 끌어다 놓으면 그룹 해제(무그룹으로 이동)
	const noneDrop = useSpaceDrop(sec.items, "", commit);

	function addItem(space: string) {
		sec.items.push({
			done: false,
			key: "",
			desc: "",
			progress: "",
			due: "",
			subs: [],
			space,
		});
		commit();
	}
	function addNewGroup(label: string) {
		const name = label.trim();
		if (!name) return;
		addItem(name);
		setGroupModalOpen(false);
		toast(`[${name}] 스페이스 추가`);
	}

	return (
		<div className="mb-[18px]">
			<div className="section-toolbar mb-3 flex flex-wrap items-center justify-between gap-2.5">
				<h3 className="m-0 text-[15px] font-bold tracking-[-0.02em]">
					{sec.title || "일일 진행 업무"}
				</h3>
				<div className="flex flex-wrap items-center gap-1.5">
					<button
						type="button"
						className="btn btn-tiny btn-ghost"
						title="직전 근무일의 '일일 진행 업무'에서 없는 항목만 가져옵니다 (진척·마감 유지, 완료 체크는 해제)"
						onClick={importYesterday}
					>
						어제 일일
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
					<button
						type="button"
						className="btn btn-tiny btn-ghost"
						title="데일리 스크럼처럼 이 섹션에도 스페이스(어느 업무 소속인지)를 만듭니다"
						onClick={() => setGroupModalOpen(true)}
					>
						+ 스페이스
					</button>
				</div>
			</div>

			<div
				className={
					"grid gap-2.5 " + (noneDrop.over ? "rounded-card ring-2 ring-accent/40" : "")
				}
				{...noneDrop.props}
			>
				{!sec.items.length && (
					<div className="rounded-[6px] border border-dashed border-line-strong bg-panel-2 p-4 text-center text-[13px] text-ink-2">
						+ 항목으로 오늘 한 일을 추가하세요
					</div>
				)}
				{none.items.map(({ it, index }) => (
					<ListItemRow
						key={index}
						sec={sec}
						it={it}
						index={index}
						prev={prevMap[itemId(it)]}
						spaceLabels={allLabels}
					/>
				))}
			</div>

			<button
				type="button"
				className="btn btn-tiny btn-ghost mt-2"
				onClick={() => addItem("")}
			>
				+ 항목
			</button>

			{named.map((g, gi) => (
				<ListSpaceGroup
					key={g.label}
					sec={sec}
					group={g}
					allLabels={allLabels}
					prevMap={prevMap}
					canUp={gi > 0}
					canDown={gi < named.length - 1}
				/>
			))}

			{/* 이슈·협업은 일일 진행 업무(마스터)에 두고, 스크럼 생성 시 금일 블록으로 반영 */}
			<div className="mt-3 grid gap-x-3 gap-y-2.5 sm:grid-cols-2">
				<MultiLineField
					label="이슈 사항"
					value={doc.scrum.today.issues || ""}
					onChange={(v) => {
						doc.scrum.today.issues = v;
						commit();
					}}
				/>
				<MultiLineField
					label="협업 및 기타"
					value={doc.scrum.today.collab || ""}
					onChange={(v) => {
						doc.scrum.today.collab = v;
						commit();
					}}
				/>
			</div>

			{groupModalOpen && (
				<NewListSpaceModal
					onClose={() => setGroupModalOpen(false)}
					onSubmit={addNewGroup}
				/>
			)}
		</div>
	);
}

// 일일 진행 업무의 스페이스 그룹 박스 — 데일리 스크럼 ScrumSpace 와 같은 느낌(라벨 입력, +항목, 그룹 해제).
function ListSpaceGroup({
	sec,
	group,
	allLabels,
	prevMap,
	canUp,
	canDown,
}: {
	sec: ListSec;
	group: import("../../lib/model").ListGroup;
	allLabels: string[];
	prevMap: Record<string, PrevEntry>;
	canUp: boolean;
	canDown: boolean;
}) {
	const { commit } = useEditor();
	const toast = useToast();
	// 박스(빈 영역/라벨 줄 포함) 드롭 — 항목을 끌어다 놓으면 이 스페이스로 이동
	const spaceDrop = useSpaceDrop(sec.items, group.label, commit);

	return (
		<div
			className={
				"space-card mt-3 " +
				(spaceDrop.over ? "ring-2 ring-accent/40" : "")
			}
			{...spaceDrop.props}
		>
			<div className="space-card-hd">
				<input
					className="min-w-0 flex-1 border-0 bg-transparent px-0 py-0 text-[13.5px] font-bold"
					list="spaceList"
					placeholder="스페이스 (예: backend)"
					value={group.label}
					onChange={(e) => {
						renameListSpace(sec.items, group.label, e.target.value);
						commit();
					}}
				/>
				<div className="flex items-center gap-1">
					<button
						type="button"
						className="btn btn-icon btn-tiny"
						disabled={!canUp}
						title="스페이스 순서 위로"
						onClick={() => {
							if (moveListSpace(sec.items, group.label, -1)) commit();
						}}
					>
						↑
					</button>
					<button
						type="button"
						className="btn btn-icon btn-tiny"
						disabled={!canDown}
						title="스페이스 순서 아래로"
						onClick={() => {
							if (moveListSpace(sec.items, group.label, 1)) commit();
						}}
					>
						↓
					</button>
					<button
						type="button"
						className="btn btn-tiny btn-ghost"
						onClick={() => {
							sec.items.push({
								done: false,
								key: "",
								desc: "",
								progress: "",
								due: "",
								subs: [],
								space: group.label,
							});
							commit();
						}}
					>
						+ 항목
					</button>
					<button
						type="button"
						className="btn btn-icon btn-tiny"
						title="스페이스 해제(항목은 무그룹으로 이동, 삭제되지 않음)"
						onClick={() => {
							renameListSpace(sec.items, group.label, "");
							commit();
							toast(`[${group.label}] 스페이스 해제`);
						}}
					>
						✕
					</button>
				</div>
			</div>

			<div className="space-card-bd">
				{group.items.map(({ it, index }) => (
					<ListItemRow
						key={index}
						sec={sec}
						it={it}
						index={index}
						prev={prevMap[itemId(it)]}
						spaceLabels={allLabels}
					/>
				))}
			</div>
		</div>
	);
}

type MetaRow = { text: string; subs: string[] };
// 편집용 파싱 — 빈 메인도 보존(추가 직후 input 유지). 탭(\t) 시작 = 하위.
function editParse(value: string): MetaRow[] {
	const v = (value || "").trim();
	if (!v || v === "없음") return [];
	const items: MetaRow[] = [];
	for (const raw of value.split("\n")) {
		const isSub = raw.startsWith("\t");
		const t = raw.replace(/^\t+/, "");
		if (isSub) {
			if (items.length) items[items.length - 1].subs.push(t);
		} else {
			items.push({ text: t, subs: [] });
		}
	}
	return items;
}
// 직렬화 — 빈 메인/빈 하위는 제외(저장·마크다운 출력용).
function editSerialize(items: MetaRow[]): string {
	const lines: string[] = [];
	for (const it of items) {
		if (!it.text.trim()) continue;
		lines.push(it.text);
		for (const s of it.subs) if (s.trim()) lines.push("\t" + s);
	}
	return lines.join("\n");
}
// 이슈·협업 입력 — 라벨 옆 +추가 로 메인 항목을 만들고, 각 항목에 +하위 로 메모를 단다.
// value 는 개행(\n) 문자열(하위=탭 prefix). 로컬 state 로 추가 직후 빈 input 유지.
function MultiLineField({
	label,
	value,
	onChange,
}: {
	label: string;
	value: string;
	onChange: (v: string) => void;
}) {
	const [items, setItems] = useState<MetaRow[]>(() => editParse(value));
	const last = useRef(value);
	useEffect(() => {
		if (value !== last.current) {
			setItems(editParse(value));
			last.current = value;
		}
	}, [value]);
	const emit = (next: MetaRow[]) => {
		setItems(next);
		const s = editSerialize(next);
		last.current = s;
		onChange(s);
	};
	const setMain = (i: number, t: string) => {
		const n = items.slice();
		n[i] = { ...n[i], text: t };
		emit(n);
	};
	const setSub = (i: number, si: number, t: string) => {
		const n = items.slice();
		const subs = n[i].subs.slice();
		subs[si] = t;
		n[i] = { ...n[i], subs };
		emit(n);
	};
	const addMain = () => emit(items.concat({ text: "", subs: [] }));
	const removeMain = (i: number) => {
		const n = items.slice();
		n.splice(i, 1);
		emit(n);
	};
	const addSub = (i: number) => {
		const n = items.slice();
		n[i] = { ...n[i], subs: n[i].subs.concat("") };
		emit(n);
	};
	const removeSub = (i: number, si: number) => {
		const n = items.slice();
		const subs = n[i].subs.slice();
		subs.splice(si, 1);
		n[i] = { ...n[i], subs };
		emit(n);
	};
	return (
		<div>
			<div className="mb-2 flex items-center gap-2">
				<span className="text-[12.5px] font-semibold text-ink-2">
					{label}{" "}
					<span className="font-medium opacity-70">— 데일리 스크럼에 반영</span>
				</span>
				<button
					type="button"
					className="btn btn-tiny btn-ghost ml-auto"
					title={`${label} 항목 추가`}
					onClick={addMain}
				>
					+ 추가
				</button>
			</div>
			{items.length === 0 ? (
				<p className="m-0 rounded-[6px] border border-dashed border-line-strong bg-panel-2 px-3 py-2.5 text-[12.5px] text-ink-2">
					+ 추가로 {label}을(를) 입력하세요
				</p>
			) : (
				<div className="grid gap-2">
					{items.map((it, i) => (
						<div key={i} className="task-row !gap-1.5 !py-2.5">
							<div className="task-main !gap-1.5">
								<input
									className="min-w-0 flex-1 border-0 bg-transparent px-0 py-0 text-[13.5px] font-semibold"
									placeholder={`${label} 항목`}
									value={it.text}
									onChange={(e) => setMain(i, e.target.value)}
								/>
								<div className="task-metrics !gap-1.5 !pt-0">
									<button
										type="button"
										className="btn btn-tiny btn-ghost"
										disabled={!it.text.trim()}
										title="이 항목에 하위 메모 추가"
										onClick={() => addSub(i)}
									>
										+하위
									</button>
									<button
										type="button"
										className="btn btn-icon btn-tiny"
										title="항목 삭제"
										onClick={() => removeMain(i)}
									>
										✕
									</button>
								</div>
							</div>
							{it.subs.length > 0 && (
								<div className="w-full pl-2">
									{it.subs.map((_s, si) => (
										<MetaSubRow
											key={si}
											subs={it.subs}
											index={si}
											onChangeText={(t) => setSub(i, si, t)}
											onRemove={() => removeSub(i, si)}
											onReorder={() => {
												const n = items.slice();
												n[i] = { ...n[i], subs: n[i].subs.slice() };
												emit(n);
											}}
										/>
									))}
								</div>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}

// 이슈·협업 하위 행 — 일일 SubList 와 동일한 드래그 순서 변경.
function MetaSubRow({
	subs,
	index,
	onChangeText,
	onRemove,
	onReorder,
}: {
	subs: string[];
	index: number;
	onChangeText: (t: string) => void;
	onRemove: () => void;
	onReorder: () => void;
}) {
	const { over, handleProps, rowProps } = useSubReorder(subs, index, onReorder);
	return (
		<div
			className={
				"sub-bullet drag-row flex items-center gap-1.5 py-1 " +
				(over ? "dragover" : "")
			}
			{...rowProps}
		>
			<span
				className="draghandle flex-none cursor-grab select-none px-[3px] text-[13px] leading-none text-ink-2"
				title="드래그해서 하위 순서 변경"
				{...handleProps}
			>
				⠿
			</span>
			<input
				className="flex-1 border-0 bg-transparent px-0 py-0 text-[13px] text-ink-2"
				placeholder="하위 항목"
				value={subs[index] || ""}
				onChange={(e) => onChangeText(e.target.value)}
			/>
			<button
				type="button"
				className="btn btn-icon btn-tiny flex-none text-[15px] leading-none"
				title="하위 삭제"
				onClick={onRemove}
			>
				−
			</button>
		</div>
	);
}

// 대상 없는 새 스페이스 이름 입력 모달 (ListSection 상단 "+ 스페이스" 버튼용).
function NewListSpaceModal({
	onSubmit,
	onClose,
}: {
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
					새 스페이스 만들기
				</h4>
				<p className="mb-3 mt-0 text-[12.5px] leading-[1.5] text-ink-2">
					일일 진행 업무에 새 스페이스를 만들고 빈 항목 하나를 등록합니다.
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

function ListItemRow({
	sec,
	it,
	index,
	prev,
	spaceLabels,
}: {
	sec: ListSec;
	it: ListItem;
	index: number;
	prev?: PrevEntry;
	spaceLabels?: string[]; // 이 항목을 이동할 수 있는 기존 스페이스 라벨 목록(자기 라벨 제외)
}) {
	const { commit } = useEditor();
	const toast = useToast();
	const openMenu = useContextMenu();
	const [groupOpen, setGroupOpen] = useState(false); // 새 스페이스 모달(이 항목 이동용)
	if (!it.subs) it.subs = [];
	const descRef = useRef<HTMLTextAreaElement>(null);
	const { over, props } = useListItemDrop(sec.items, index, it, commit);
	// 마감일 → 실제 티켓 duedate 반영. 연타(달력 조작) 대비 디바운스.
	const dueSyncRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (dueSyncRef.current) clearTimeout(dueSyncRef.current);
		},
		[],
	);
	function syncDueToJira(key: string, due: string) {
		if (!JIRA_KEY_RE.test(key)) return; // 실제 티켓 키가 아니면 무시
		if (dueSyncRef.current) clearTimeout(dueSyncRef.current);
		dueSyncRef.current = setTimeout(async () => {
			const r = await api<any>("PUT", "/api/jira/due", { key, due });
			const j = r.json;
			if (!r.ok || !j?.ok) {
				toast(`${key} 마감일 반영 실패 — ${j?.error || r.status}`);
				return;
			}
			if (j.skipped) return; // 없는 티켓·미연결·권한없음 → 조용히 무시
			toast(due ? `${key} 마감일 → ${due} 반영` : `${key} 마감일 해제`);
		}, 600);
	}

	useEffect(() => {
		autoGrow(descRef.current);
	});

	// 우클릭 → 스페이스(그룹) 이동. 데일리 스크럼은 일일 진행 업무에서 생성하므로
	// 스크럼으로의 개별 복사/등록은 없음.
	function onRowContextMenu(e: React.MouseEvent) {
		if (!itemId(it)) return; // 빈 항목은 네이티브 메뉴 유지
		e.preventDefault();
		const items: MenuItem[] = [];
		const curSpace = (it.space || "").trim();
		const others = (spaceLabels || []).filter((l) => l !== curSpace);
		for (const l of others)
			items.push({
				label: `[${l}] 스페이스로 이동`,
				onClick: () => {
					it.space = l;
					commit();
				},
			});
		if (others.length) items.push({ sep: true });
		items.push({
			label: "＋ 새 스페이스로 이동…",
			onClick: () => setGroupOpen(true),
		});
		if (curSpace)
			items.push({
				label: "그룹 해제(무그룹으로)",
				onClick: () => {
					it.space = "";
					commit();
				},
			});
		openMenu(e.clientX, e.clientY, items);
	}

	return (
		<div
			className={"task-row drag-row" + (over ? " dragover" : "")}
			{...props}
			onContextMenu={onRowContextMenu}
		>
			<div className="task-main">
				<DragHandle arr={sec.items} index={index} />

				<span className="task-title flex min-w-0 flex-1 items-center gap-1">
					<input
						className="likey task-key flex-none border-0 bg-transparent px-0 py-0 font-mono text-[12.5px] font-bold uppercase text-accent-text placeholder:normal-case placeholder:font-semibold placeholder:text-accent-text/45"
						placeholder="티켓"
						value={it.key || ""}
						size={Math.max(4, (it.key || "티켓").length)}
						onChange={(e) => {
							it.key = e.target.value.trim().toUpperCase();
							commit();
						}}
					/>
					<GoButton getKey={() => it.key} />
					<textarea
						ref={descRef}
						className="task-desc min-w-0 flex-1 resize-none border-0 bg-transparent px-0 py-0 text-[13.5px] font-semibold whitespace-pre-wrap break-words placeholder:font-medium placeholder:text-ink-2/55"
						rows={1}
						placeholder="한 일"
						value={it.desc || ""}
						onChange={(e) => {
							const v = e.target.value.replace(/\n/g, ""); // 개행은 저장 안 함(한 줄 유지)
							it.desc = v;
							autoGrow(e.target);
							commit();
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") e.preventDefault();
						}}
					/>
				</span>

				<div className="task-metrics">
					<span
						className={
							"metric-prev" +
							(prev && typeof prev.progress === "number" ? "" : " invisible")
						}
						title={
							prev && typeof prev.progress === "number"
								? `${prev.from} 진척도`
								: undefined
						}
						aria-hidden={!(prev && typeof prev.progress === "number")}
					>
						전일 {prev && typeof prev.progress === "number" ? prev.progress : 0}%
					</span>
					<span className="metric-progress-row">
						진척
						<input
							type="number"
							min={0}
							max={100}
							placeholder="0"
							value={it.progress === 0 ? "0" : it.progress || ""}
							onChange={(e) => {
								it.progress =
									e.target.value === "" ? "" : Number(e.target.value);
								commit();
							}}
						/>
						%
					</span>

					<span className="metric-deadline">
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
							aria-hidden="true"
						>
							<rect x="3" y="4" width="18" height="18" rx="2" />
							<path d="M16 2v4M8 2v4M3 10h18" />
						</svg>
						<input
							type="date"
							value={it.due || ""}
							title="티켓 키가 있으면 실제 Jira 이슈의 마감일도 함께 수정됩니다"
							onChange={(e) => {
								it.due = e.target.value;
								commit();
								syncDueToJira((it.key || "").trim().toUpperCase(), it.due);
							}}
						/>
					</span>

					<button
						type="button"
						className="btn btn-tiny btn-ghost"
						onClick={() => {
							it.subs!.push("");
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
							commit();
						}}
					>
						✕
					</button>
				</div>
			</div>

			<SubList subs={it.subs} />

			{groupOpen && (
				<NewListSpaceModal
					onClose={() => setGroupOpen(false)}
					onSubmit={(label) => {
						const name = label.trim();
						if (!name) return;
						it.space = name;
						setGroupOpen(false);
						commit();
						toast(`[${name}] 스페이스로 이동`);
					}}
				/>
			)}
		</div>
	);
}
