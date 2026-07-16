import type { DragEvent } from "react";
import { drag, resetDrag } from "../lib/dnd";
import { snapListItem } from "../lib/model";
import type { ListItem, Task } from "../types";

// ⠿ 드래그 핸들. kind="list" 는 스크럼으로 복사 가능(스냅샷 저장).
export function DragHandle({
  arr,
  index,
  kind,
  className,
}: {
  arr: (Task | ListItem)[];
  index: number;
  kind?: "list";
  className?: string;
}) {
  return (
    <span
      className={"draghandle flex-none select-none px-[3px] text-[13px] leading-none text-ink-2 " + (className || "")}
      draggable
      title={kind === "list" ? "드래그: 순서 변경 · 스크럼(전일/금일)에 등록" : "드래그해서 순서 변경"}
      onDragStart={(e: DragEvent) => {
        drag.arr = arr;
        drag.from = index;
        drag.kind = kind || null;
        drag.item = kind === "list" ? snapListItem(arr[index] as ListItem) : null;
        e.dataTransfer.effectAllowed = kind === "list" ? "copyMove" : "move";
        try {
          e.dataTransfer.setData("text/plain", String(index));
        } catch {
          /* noop */
        }
        (e.currentTarget as HTMLElement).closest(".drag-row")?.classList.add("dragging");
      }}
      onDragEnd={() => {
        resetDrag();
        document.querySelectorAll(".dragging").forEach((n) => n.classList.remove("dragging"));
      }}
    >
      ⠿
    </span>
  );
}
