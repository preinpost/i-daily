import { useState, type DragEvent } from "react";
import { drag, subDrag, resetSubDrag } from "./dnd";
import { moveItemToSpace } from "./model";
import type { ListItem } from "../types";

// 일일 진행 업무 행 드롭 — 같은 스페이스면 순서 이동, 다른 스페이스면 그 행의 스페이스로 이동.
// 드래그는 DragHandle 이 drag.arr=원본 배열, drag.from=원본 인덱스로 시작.
export function useListItemDrop(
	arr: ListItem[],
	index: number,
	it: ListItem,
	onDrop: () => void,
) {
	const [over, setOver] = useState(false);
	return {
		over,
		props: {
			onDragOver: (e: DragEvent) => {
				if (drag.arr !== arr) return; // 다른 배열(스크럼 등)끼리는 이동 금지
				e.preventDefault();
				e.dataTransfer.dropEffect = "move";
				setOver(true);
			},
			onDragLeave: () => setOver(false),
			onDrop: (e: DragEvent) => {
				if (drag.arr !== arr) return;
				e.preventDefault();
				e.stopPropagation(); // 스페이스 그룹 컨테이너의 space-drop 으로 bubble 방지
				setOver(false);
				const from = drag.from;
				if (from < 0 || from === index) return;
				const fromIt = arr[from];
				if (!fromIt) return;
				const targetSpace = (it.space || "").trim();
				const fromSpace = (fromIt.space || "").trim();
				if (fromSpace === targetSpace) {
					// 같은 스페이스: 순서 이동
					const moved = arr.splice(from, 1)[0];
					arr.splice(from < index ? index - 1 : index, 0, moved);
				} else {
					// 다른 스페이스: 대상 행의 스페이스로 이동
					moveItemToSpace(arr, from, targetSpace);
				}
				onDrop();
			},
		},
	};
}

// 스페이스 그룹 컨테이너(박스/무그룹 영역) 드롭 — 빈 영역에 떨어뜨려도 해당 스페이스로 이동.
export function useSpaceDrop(
	arr: ListItem[],
	spaceLabel: string,
	onDrop: () => void,
) {
	const [over, setOver] = useState(false);
	return {
		over,
		props: {
			onDragOver: (e: DragEvent) => {
				if (drag.arr !== arr) return;
				e.preventDefault();
				e.dataTransfer.dropEffect = "move";
				setOver(true);
			},
			onDragLeave: (e: DragEvent) => {
				// 자식(행) 위로 이동해 bubble 로 떠나는 leave 는 무시(깜빡임 방지)
				if (e.currentTarget.contains(e.relatedTarget as Node)) return;
				setOver(false);
			},
			onDrop: (e: DragEvent) => {
				if (drag.arr !== arr) return;
				e.preventDefault();
				setOver(false);
				const from = drag.from;
				if (from < 0) return;
				const fromIt = arr[from];
				if (!fromIt) return;
				if ((fromIt.space || "").trim() === (spaceLabel || "").trim()) return; // 이미 같은 스페이스면 no-op(행 드롭이 순서 처리)
				moveItemToSpace(arr, from, spaceLabel);
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
