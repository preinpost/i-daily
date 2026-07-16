// 드래그 공유 상태 — 기존 client.js 의 모듈 전역(dragArr 등)을 미러링.
// 같은 배열 안: 순서 이동(move). 일일 진행 → 스크럼: 복사(copy).
import type { ListItem, Task } from "../types";

type DragState = {
  arr: (Task | ListItem)[] | null;
  from: number;
  kind: "list" | null;
  item: Task | null; // list 드래그 시 복사용 스냅샷
};

export const drag: DragState = { arr: null, from: -1, kind: null, item: null };

export function resetDrag(): void {
  drag.arr = null;
  drag.from = -1;
  drag.kind = null;
  drag.item = null;
}

// 하위 항목(문자열 배열) 순서 이동 전용 드래그 상태 — 상위 리스트/스크럼 드래그와 분리.
type SubDragState = { arr: string[] | null; from: number };

export const subDrag: SubDragState = { arr: null, from: -1 };

export function resetSubDrag(): void {
  subDrag.arr = null;
  subDrag.from = -1;
}
