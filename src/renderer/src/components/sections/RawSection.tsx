import { useEffect, useState } from "react";
import { useEditor } from "../../context/EditorContext";
import { MarkdownEditor } from "../MarkdownEditor";
import { useToast } from "../Toast";
import { rawHasContent } from "../../lib/model";
import { confirmReset } from "../../lib/ui";
import type { Section } from "../../types";

type RawSec = Section & { kind: "raw" };

export function RawSection({ sec, onRemove }: { sec: RawSec; onRemove: () => void }) {
  const { commit } = useEditor();
  const toast = useToast();
  // 접기 상태는 문서 데이터가 아닌 UI 상태 — 섹션 제목 기준으로 localStorage 에만 남긴다.
  const key = "i-daily:raw-collapsed:" + (sec.title || "");
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(key) === "1");
    } catch {
      setCollapsed(false);
    }
  }, [key]);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      if (next) localStorage.setItem(key, "1");
      else localStorage.removeItem(key);
    } catch {}
  };
  const lines = (sec.body || "").split("\n").filter((l) => l.trim()).length;

  return (
    <div className="mb-[22px]">
      <div className="mb-2 flex items-center gap-2">
        <button
          type="button"
          className="btn btn-icon btn-tiny inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center p-0 text-[17px] leading-none"
          title={collapsed ? "펼치기" : "접기"}
          aria-expanded={!collapsed}
          onClick={toggle}
        >
          {/* 글리프를 바꾸면 폭이 달라져 헤더가 흔들림 — 같은 ▾ 를 회전만 시킨다. */}
          <span
            className="inline-block transition-transform duration-150"
            style={{ transform: collapsed ? "rotate(-90deg)" : "none" }}
          >
            ▾
          </span>
        </button>
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
        {/* 접힌 상태 안내는 별도 블록 대신 헤더 끝에 — 새 줄이 생기며 뒤 내용이 밀리지 않도록. */}
        {collapsed && (
          <span className="text-[12.5px] text-ink-2">
            {lines ? `${lines}줄 접힘` : "비어 있음"}
          </span>
        )}
      </div>
      {/* 언마운트 대신 grid-rows 0fr↔1fr 로 높이만 줌인다 — 에디터 상태/스크롤 유지. */}
      <div
        className="grid transition-[grid-template-rows] duration-150 ease-out"
        style={{ gridTemplateRows: collapsed ? "0fr" : "1fr" }}
        aria-hidden={collapsed}
      >
        <div className="min-h-0 overflow-hidden">
          <MarkdownEditor
            value={sec.body || ""}
            placeholder="마크다운으로 자유롭게…"
            onChange={(md) => {
              sec.body = md;
              commit();
            }}
          />
        </div>
      </div>
    </div>
  );
}
