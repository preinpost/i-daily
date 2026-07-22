import type { DragEvent } from "react";
import { drag, resetDrag } from "../lib/dnd";
import type { ListItem, Task } from "../types";

// ⠿ 드래그 핸들 — 같은 배열 안 순서 변경 전용.
export function DragHandle({
	arr,
	index,
	className,
}: {
	arr: (Task | ListItem)[];
	index: number;
	className?: string;
}) {
	return (
		<span
			className={
				"draghandle flex-none select-none px-[3px] text-[13px] leading-none text-ink-2 " +
				(className || "")
			}
			draggable
			title="드래그해서 순서 변경"
			onDragStart={(e: DragEvent) => {
				drag.arr = arr;
				drag.from = index;
				e.dataTransfer.effectAllowed = "move";
				try {
					e.dataTransfer.setData("text/plain", String(index));
				} catch {
					/* noop */
				}
				(e.currentTarget as HTMLElement)
					.closest(".drag-row")
					?.classList.add("dragging");
			}}
			onDragEnd={() => {
				resetDrag();
				document
					.querySelectorAll(".dragging")
					.forEach((n) => n.classList.remove("dragging"));
			}}
		>
			⠿
		</span>
	);
}
