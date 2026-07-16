import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { Shortcut } from "../types";

export function Shortcuts() {
  const [items, setItems] = useState<Shortcut[]>([]);
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const urlRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<Shortcut[]>("GET", "/api/shortcuts").then((r) =>
      setItems(r.ok && Array.isArray(r.json) ? r.json : []),
    );
  }, []);

  useEffect(() => {
    if (adding) urlRef.current?.focus();
  }, [adding]);

  const save = (next: Shortcut[]) => {
    setItems(next);
    api("PUT", "/api/shortcuts", next);
  };

  // prompt() 는 Electron 렌더러에서 동작하지 않아 인라인 폼으로 추가.
  function submit() {
    let u = url.trim();
    if (!u) {
      cancel();
      return;
    }
    if (u.indexOf("://") === -1) u = "https://" + u;
    let n = name.trim();
    if (!n) n = u.replace("https://", "").replace("http://", "").split("/")[0];
    save([...items, { name: n, url: u }]);
    cancel();
  }
  function cancel() {
    setUrl("");
    setName("");
    setAdding(false);
  }

  return (
    <div className="mx-auto flex max-w-[1080px] flex-wrap items-center gap-1 px-[18px] pb-1.5">
      {items.map((s, i) => (
        <span key={i} className="group inline-flex items-center rounded-full border border-line bg-panel-2 text-xs">
          <a
            className="max-w-[220px] cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap py-0.5 pl-[9px] pr-[5px] text-ink no-underline"
            title={s.url}
            onClick={() => s.url && window.open(s.url, "_blank", "noopener")}
          >
            {s.name || s.url}
          </a>
          <button
            type="button"
            className="cursor-pointer border-0 bg-transparent py-0.5 pl-0.5 pr-2 text-[13px] leading-none text-ink-2 opacity-0 group-hover:opacity-50 hover:!opacity-100 hover:!text-danger"
            title="바로가기 삭제"
            onClick={(e) => {
              e.stopPropagation();
              save(items.filter((_, j) => j !== i));
            }}
          >
            ×
          </button>
        </span>
      ))}

      {adding ? (
        <span className="inline-flex items-center gap-1 rounded-full border border-line bg-panel-2 py-0.5 pl-2 pr-1">
          <input
            ref={urlRef}
            className="!w-[190px] !border-0 !bg-transparent !px-1 !py-0 text-xs"
            placeholder="URL (예: example.com)"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              else if (e.key === "Escape") cancel();
            }}
          />
          <input
            className="!w-[110px] !border-0 !bg-transparent !px-1 !py-0 text-xs"
            placeholder="이름(선택)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              else if (e.key === "Escape") cancel();
            }}
          />
          <button type="button" className="btn btn-tiny btn-primary" onClick={submit}>
            추가
          </button>
          <button type="button" className="btn btn-tiny btn-ghost" onClick={cancel}>
            ✕
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="cursor-pointer rounded-full border-0 bg-transparent px-[11px] py-1 text-[12.5px] text-ink-2"
          onClick={() => setAdding(true)}
        >
          + 바로가기
        </button>
      )}
    </div>
  );
}
