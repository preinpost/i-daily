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

// children 이 있으면 서브메뉴. 함수면 hover 시점에 비동기로 항목을 불러온다.
export type MenuItem =
	| {
			label: string;
			onClick?: () => void;
			children?: MenuItem[] | (() => Promise<MenuItem[]>);
			disabled?: boolean;
	  }
	| { sep: true };
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
          <MenuList items={menu.items} close={close} />
        </div>
      )}
    </CtxMenuCtx.Provider>
  );
}

// 한 단계의 메뉴 목록. children 이 있는 항목은 hover 시 서브메뉴를 편다.
function MenuList({ items, close }: { items: MenuItem[]; close: () => void }) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  return (
    <>
      {items.map((it, i) =>
        "sep" in it ? (
          <div key={i} className="my-1 mx-0.5 h-px bg-line" />
        ) : it.children ? (
          <div
            key={i}
            className="ctxrow"
            onMouseEnter={() => setOpenIdx(i)}
            onMouseLeave={() => setOpenIdx((v) => (v === i ? null : v))}
          >
            <button type="button" className="ctxitem" onClick={(e) => e.stopPropagation()}>
              <span>{it.label}</span>
              <span className="text-ink-2">▸</span>
            </button>
            {openIdx === i && <SubMenu source={it.children} close={close} />}
          </div>
        ) : (
          <button
            key={i}
            type="button"
            className="ctxitem"
            disabled={it.disabled}
            onMouseEnter={() => setOpenIdx(null)}
            onClick={(e) => {
              e.stopPropagation();
              close();
              it.onClick?.();
            }}
          >
            {it.label}
          </button>
        ),
      )}
    </>
  );
}

// 서브메뉴 — 배열이면 즉시, 함수면 열릴 때 한 번 await 해서 채운다.
function SubMenu({
  source,
  close,
}: {
  source: MenuItem[] | (() => Promise<MenuItem[]>);
  close: () => void;
}) {
  const isStatic = Array.isArray(source);
  const [items, setItems] = useState<MenuItem[] | null>(isStatic ? source : null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isStatic) return;
    let alive = true;
    (source as () => Promise<MenuItem[]>)()
      .then((r) => alive && setItems(r))
      .catch((e) => alive && setError(String((e as Error)?.message || e)));
    return () => {
      alive = false;
    };
  }, [source, isStatic]);

  // 오른쪽 공간이 부족하면 왼쪽으로 뒤집는다.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.classList.remove("flip");
    if (el.getBoundingClientRect().right > window.innerWidth - 8) el.classList.add("flip");
  }, [items, error]);

  return (
    <div ref={ref} className="ctxmenu ctxsub">
      {error ? (
        <div className="px-3 py-2 text-[12px] text-danger">{error}</div>
      ) : !items ? (
        <div className="px-3 py-2 text-[12px] text-ink-2">불러오는 중…</div>
      ) : !items.length ? (
        <div className="px-3 py-2 text-[12px] text-ink-2">가능한 항목 없음</div>
      ) : (
        <MenuList items={items} close={close} />
      )}
    </div>
  );
}
