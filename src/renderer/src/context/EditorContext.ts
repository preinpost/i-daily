import { createContext, useContext } from "react";
import type { Config, Doc, Meta } from "../types";

// 편집 공유 컨텍스트 — doc 은 가변 객체(mutate 후 rerender/commit 으로 반영).
export type EditorCtx = {
  doc: Doc;
  meta: Meta;
  config: Config;
  commit: () => void; // 변경 표시(dirty) + 리렌더
  rerender: () => void; // 리렌더만
};

export const EditorContext = createContext<EditorCtx | null>(null);

export function useEditor(): EditorCtx {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error("useEditor must be used within EditorContext");
  return ctx;
}
