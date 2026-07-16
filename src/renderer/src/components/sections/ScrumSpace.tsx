import { useEditor } from "../../context/EditorContext";
import { useToast } from "../Toast";
import { copyListItemToScrum, dailyOptions } from "../../lib/model";
import { useCopyZone } from "../../lib/useDnd";
import { ScrumTask } from "./ScrumTask";
import type { Block, Space, Which } from "../../types";

export function ScrumSpace({
  space: sp,
  block,
  which,
  index,
}: {
  space: Space;
  block: Block;
  which: Which;
  index: number;
}) {
  const { doc, config, commit } = useEditor();
  const toast = useToast();

  // 이 스페이스에 일일 항목 드롭 → 이 스페이스로 복사
  const { over, props } = useCopyZone((item) => {
    const r = copyListItemToScrum(doc.scrum, config, which, item, sp);
    toast(r.msg);
    if (r.ok) commit();
  });

  return (
    <div
      className={
        "mb-2.5 rounded-[10px] border border-dashed border-line bg-panel p-2.5 " + (over ? "dragover-copy" : "")
      }
      {...props}
    >
      <div className="mb-2 flex items-center gap-2">
        <input
          className="font-semibold"
          list="spaceList"
          placeholder="스페이스 (예: backend)"
          value={sp.label || ""}
          onChange={(e) => {
            sp.label = e.target.value;
            commit();
          }}
        />
        <button
          type="button"
          className="btn btn-tiny btn-ghost"
          title="일일 진행 업무에 등록된 항목 중에서 선택"
          onClick={() => {
            if (!dailyOptions(doc).length) return toast("일일 진행 업무에 먼저 항목을 추가하세요");
            sp.tasks.push({ key: "", desc: "", progress: "", due: "", subs: [] });
            commit();
          }}
        >
          + 티켓/업무
        </button>
        <button
          type="button"
          className="btn btn-icon btn-tiny"
          title="스페이스 삭제"
          onClick={() => {
            block.spaces.splice(index, 1);
            commit();
          }}
        >
          ✕
        </button>
      </div>

      {sp.tasks.map((t, ti) => (
        <ScrumTask key={ti} task={t} space={sp} block={block} index={ti} />
      ))}
    </div>
  );
}
