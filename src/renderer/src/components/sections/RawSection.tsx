import { useEditor } from "../../context/EditorContext";
import { useToast } from "../Toast";
import { rawHasContent } from "../../lib/model";
import { confirmReset } from "../../lib/ui";
import type { Section } from "../../types";

type RawSec = Section & { kind: "raw" };

export function RawSection({ sec, onRemove }: { sec: RawSec; onRemove: () => void }) {
  const { commit } = useEditor();
  const toast = useToast();

  return (
    <div className="mb-[22px]">
      <div className="mb-2 flex items-center gap-2">
        <input
          className="max-w-[280px] font-[650] text-[15px]"
          value={sec.title || ""}
          placeholder="섹션 이름"
          onChange={(e) => {
            sec.title = e.target.value;
            commit();
          }}
        />
        <button
          type="button"
          className="btn btn-tiny btn-ghost"
          title="이 섹션 본문을 비웁니다 (저장 전이면 새로고침으로 복구)"
          onClick={() => {
            const label = sec.title || "메모";
            if (!rawHasContent(sec)) return toast("이미 비어 있어요");
            if (!confirmReset(label)) return;
            sec.body = "";
            commit();
            toast(label + " 초기화");
          }}
        >
          초기화
        </button>
        <button type="button" className="btn btn-icon btn-tiny" title="섹션 삭제" onClick={onRemove}>
          ✕
        </button>
      </div>
      <textarea
        className="min-h-[76px] resize-y font-mono text-[13.5px] leading-[1.6]"
        value={sec.body || ""}
        placeholder="마크다운으로 자유롭게…"
        onChange={(e) => {
          sec.body = e.target.value;
          commit();
        }}
      />
    </div>
  );
}
