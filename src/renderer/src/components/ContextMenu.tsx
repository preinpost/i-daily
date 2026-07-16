import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type MenuItem = { label: string; onClick: () => void } | { sep: true };
type OpenFn = (x: number, y: number, items: MenuItem[]) => void;

const CtxMenuCtx = createContext<OpenFn>(() => {});
export const useContextMenu = () => useContext(CtxMenuCtx);

type State = { x: number; y: number; items: MenuItem[] } | null;

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<State>(null);
  const ref = useRef<HTMLDivElement>(null);

  const open: OpenFn = useCallback((x, y, items) => setMenu({ x, y, items }), []);
  const close = useCallback(() => setMenu(null), []);

  // 화면 밖으로 나가지 않게 위치 보정
  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const px = Math.min(menu.x, window.innerWidth - r.width - 8);
    const py = Math.min(menu.y, window.innerHeight - r.height - 8);
    ref.current.style.left = Math.max(8, px) + "px";
    ref.current.style.top = Math.max(8, py) + "px";
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    // 메뉴 내부 클릭은 무시 — capture 단계에서 먼저 닫아버리면 버튼이 언마운트되어
    // React onClick(등록 로직)이 실행되지 않는다. 닫기는 버튼 핸들러가 직접 수행.
    const onDocPointer = (e: MouseEvent) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      close();
    };
    const t = setTimeout(() => {
      document.addEventListener("click", onDocPointer, true);
      document.addEventListener("contextmenu", onDocPointer, true);
      document.addEventListener("keydown", onKey);
      window.addEventListener("blur", close);
      window.addEventListener("resize", close);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("click", onDocPointer, true);
      document.removeEventListener("contextmenu", onDocPointer, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [menu, close]);

  return (
    <CtxMenuCtx.Provider value={open}>
      {children}
      {menu && (
        <div ref={ref} className="ctxmenu" style={{ left: -9999, top: -9999 }}>
          {menu.items.map((it, i) =>
            "sep" in it ? (
              <div key={i} className="my-1 mx-0.5 h-px bg-line" />
            ) : (
              <button
                key={i}
                type="button"
                className="ctxitem"
                onClick={(e) => {
                  e.stopPropagation();
                  close();
                  it.onClick();
                }}
              >
                {it.label}
              </button>
            ),
          )}
        </div>
      )}
    </CtxMenuCtx.Provider>
  );
}
