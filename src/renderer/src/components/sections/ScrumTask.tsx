import { useEditor } from "../../context/EditorContext";
import {
	applyDailyMaster,
	dailyItemLabel,
	dailyOptions,
	dailyOrder,
	findDailyById,
	isMissing,
	itemId,
	usedIdsInBlock,
} from "../../lib/model";
import { useReorder } from "../../lib/useDnd";
import { DragHandle } from "../DragHandle";
import { GoButton } from "../GoButton";
import type { Block, Space, Task } from "../../types";

export function ScrumTask({
	task: t,
	space: sp,
	block,
	index,
}: {
	task: Task;
	space: Space;
	block: Block;
	index: number;
}) {
	const { doc, commit } = useEditor();
	if (!t.subs) t.subs = [];

	// 일일에 있으면 키/설명/하위를 마스터에서 끌어옴(진척·마감 유지)
	const linked = findDailyById(doc, itemId(t));
	if (linked) applyDailyMaster(t, linked);

	const warn = isMissing(t);
	const curId = itemId(t);
	const order = dailyOrder(doc, curId);
	const used = usedIdsInBlock(block, t);
	const daily = dailyOptions(doc);
	const orphan = curId && !findDailyById(doc, curId);
	const { over, props } = useReorder(sp.tasks, index, commit);

	return (
		<div
			className={
				"drag-row relative mb-[7px] grid grid-cols-[minmax(160px,1.2fr)_1fr_auto] gap-x-2 gap-y-1.5 rounded-lg p-2 pl-5 " +
				(warn
					? "bg-warn-bg outline outline-[1.5px] outline-[color-mix(in_srgb,var(--warn)_60%,transparent)] "
					: "bg-panel-2 ") +
				(over ? "dragover" : "")
			}
			{...props}
		>
			<DragHandle
				arr={sp.tasks}
				index={index}
				className="!absolute left-0.5 top-2 !px-0"
			/>

			<label className="flex min-w-0 flex-col gap-[3px] text-xs text-ink-2">
				<span className="flex items-center gap-1">
					<span>일일 업무</span>
					<GoButton getKey={() => t.key} />
				</span>
				<span className="flex min-w-0 items-center gap-1.5">
					<span
						className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--accent)_18%,var(--chip))] text-[12.5px] font-bold tabular-nums text-accent"
						title={
							order != null
								? `일일 진행 업무 ${order}번`
								: "일일 진행 업무에 연결되지 않음"
						}
					>
						{order ?? "–"}
					</span>
					<select
						className="min-w-0 flex-1 text-[13px]"
						value={curId}
						onChange={(e) => {
							const id = e.target.value;
							if (!id) {
								t.key = "";
								t.desc = "";
								t.subs = [];
								t.progress = "";
								t.due = "";
							} else {
								const src = findDailyById(doc, id);
								if (src) {
									applyDailyMaster(t, src);
									t.progress =
										typeof src.progress === "number" ? src.progress : "";
									t.due = src.due || "";
								}
							}
							commit();
						}}
					>
						<option value="">— 일일 업무 선택 —</option>
						{daily.map((it) => {
							const id = itemId(it);
							// 순번은 원형 뱃지로 표시 — 드롭다운 텍스트에는 넣지 않음
							return (
								<option
									key={id}
									value={id}
									disabled={used.has(id) && id !== curId}
								>
									{dailyItemLabel(it)}
								</option>
							);
						})}
						{orphan && (
							<option value={curId}>
								{dailyItemLabel(t) + " (일일에 없음)"}
							</option>
						)}
					</select>
				</span>
			</label>

			<label className="flex min-w-0 flex-col gap-[3px] text-xs text-ink-2">
				<span>설명</span>
				<div
					className={
						"min-h-[30px] break-words rounded-md border border-dashed border-line p-[5px_8px] text-[13px] leading-[1.4] " +
						(t.desc ? "text-ink" : "text-ink-2 italic")
					}
				>
					{t.desc || (curId ? "" : "일일 진행 업무에서 선택하세요")}
				</div>
			</label>

			<button
				type="button"
				className="btn btn-icon btn-tiny col-start-3 self-start"
				title="업무 삭제"
				onClick={() => {
					sp.tasks.splice(index, 1);
					commit();
				}}
			>
				✕
			</button>

			<div className="col-span-full flex flex-wrap items-center gap-2">
				<span className="flex items-center gap-1 whitespace-nowrap text-[12.5px] text-ink-2">
					진척
					<input
						className="w-[58px] text-right"
						type="number"
						min={0}
						max={100}
						placeholder="%"
						title="이 블록(전일/금일) 전용 진척 — 일일과 독립"
						value={t.progress === 0 ? "0" : t.progress || ""}
						onChange={(e) => {
							t.progress = e.target.value === "" ? "" : Number(e.target.value);
							commit();
						}}
					/>
					%
				</span>
				<span className="flex flex-1 items-center gap-1 whitespace-nowrap text-[12.5px] text-ink-2">
					마감
					<input
						className="!max-w-none w-full flex-1"
						type="date"
						title="이 블록(전일/금일) 전용 마감 — 일일과 독립"
						value={t.due || ""}
						onChange={(e) => {
							t.due = e.target.value;
							commit();
						}}
					/>
				</span>
			</div>

			{warn && (
				<div className="col-span-full text-xs text-warn">
					⚠ 진척률·마감일을 채워 주세요 (규정 2)
				</div>
			)}

			{t.subs.some((s) => (s || "").trim()) && (
				<div className="col-span-full">
					{t.subs
						.filter((s) => (s || "").trim())
						.map((s, i) => (
							<div
								key={i}
								className="sub-bullet mt-1 ml-2 flex items-center gap-1.5"
							>
								<span className="flex-1 text-[13px] text-ink-2">{s}</span>
							</div>
						))}
				</div>
			)}
		</div>
	);
}
