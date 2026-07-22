import { useState, type DragEvent } from "react";
import { drag, subDrag, resetSubDrag } from "./dnd";
import type { ListItem, Task } from "../types";

// 같은 배열 안 순서 이동(move) 드롭.
export function useReorder(
	arr: (Task | ListItem)[],
	index: number,
	onDrop: () => void,
) {
	const [over, setOver] = useState(false);
	return {
		over,
		props: {
			onDragOver: (e: DragEvent) => {
				if (drag.arr !== arr) return; // 다른 배열끼리는 이동 금지
				e.preventDefault();
				e.dataTransfer.dropEffect = "move";
				setOver(true);
			},
			onDragLeave: () => setOver(false),
			onDrop: (e: DragEvent) => {
				if (drag.arr !== arr) return;
				e.preventDefault();
				setOver(false);
				const from = drag.from;
				const to = index;
				if (from < 0 || from === to) return;
				const it = arr.splice(from, 1)[0];
				arr.splice(from < to ? to - 1 : to, 0, it); // 제거로 당겨진 인덱스 보정
				onDrop();
			},
		},
	};
}

// 하위 항목(문자열 배열) 안 순서 이동(move) — 핸들 drag 이벤트.
export function useSubReorder(
	arr: string[],
	index: number,
	onDrop: () => void,
) {
	const [over, setOver] = useState(false);
	return {
		over,
		handleProps: {
			draggable: true,
			onDragStart: (e: DragEvent) => {
				subDrag.arr = arr;
				subDrag.from = index;
				e.dataTransfer.effectAllowed = "move";
				try {
					e.dataTransfer.setData("text/plain", String(index));
				} catch {
					/* noop */
				}
			},
			onDragEnd: () => resetSubDrag(),
		},
		rowProps: {
			onDragOver: (e: DragEvent) => {
				if (subDrag.arr !== arr) return;
				e.preventDefault();
				e.dataTransfer.dropEffect = "move";
				setOver(true);
			},
			onDragLeave: () => setOver(false),
			onDrop: (e: DragEvent) => {
				if (subDrag.arr !== arr) return;
				e.preventDefault();
				setOver(false);
				const from = subDrag.from;
				const to = index;
				if (from < 0 || from === to) return;
				const it = arr.splice(from, 1)[0];
				arr.splice(from < to ? to - 1 : to, 0, it);
				onDrop();
			},
		},
	};
}
