import { WD, parseYmd, weekOfMonth } from "../lib/model";
import { Shortcuts } from "./Shortcuts";
import type { Meta } from "../types";

export function TopHeader({
  curDate,
  meta,
  saveCls,
  saveNote,
  onSave,
  onRevert,
}: {
  curDate: string;
  meta: Meta;
  saveCls: string;
  saveNote: string;
  onSave: () => void;
  onRevert: () => void;
}) {
  const canRevert = saveCls === "dirty";
  const d = parseYmd(curDate);
  // YYYY-MM-DD 문자열 비교로 과거만 판별 (미래·오늘은 라벨 없음)
  const isPast = !!meta.today && curDate < meta.today;
  const hdrDate =
    `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()} (${WD[d.getDay()]})` + (isPast ? " · 지난 기록" : "");
  const hdrSub = `${d.getMonth() + 1}월 ${weekOfMonth(d)}째 주` + (meta.owner ? " · " + meta.owner : "");

  return (
    <header className="topbar sticky top-tabh z-20 border-b border-line">
      <div className="mx-auto flex max-w-[1080px] flex-wrap items-center gap-3 px-[18px] py-2">
        <div className="flex cursor-default select-none items-center gap-2 text-[15px] font-bold tracking-[-0.2px]">
          <span className="brand-dot" /> i-daily
          <span className="text-[11px] font-medium tabular-nums text-ink-2">v{__APP_VERSION__}</span>
        </div>

        <div className="ml-auto text-right leading-tight">
          <div className="text-[14px] font-semibold tabular-nums">{hdrDate}</div>
          <div className="text-[11.5px] text-ink-2">{hdrSub}</div>
        </div>

        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-xs text-ink-2">
            <span className={"savedot " + saveCls} />
            <span>{saveNote}</span>
          </span>
          <button
            type="button"
            className="btn btn-ghost px-2.5 py-[5px] text-[13px]"
            title="저장하지 않은 변경을 버리고 마지막 저장 상태로 되돌리기"
            onClick={onRevert}
            disabled={!canRevert}
            style={canRevert ? undefined : { opacity: 0.4, cursor: "default" }}
          >
            ↩︎ 되돌리기
          </button>
          <button
            type="button"
            className="btn btn-primary px-2.5 py-[5px] text-[13px]"
            title="서버에 저장 (⌘S)"
            onClick={onSave}
          >
            💾 저장
          </button>
        </div>
      </div>
      <Shortcuts />
    </header>
  );
}
