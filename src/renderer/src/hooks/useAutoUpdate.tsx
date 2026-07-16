import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useToast } from "../components/Toast";
import type { UpdateStatus } from "../types";

type Banner = {
  show: boolean;
  text: string;
  error?: boolean;
  ok?: boolean;
  actionLabel?: string;
  actionMode?: string;
  dismissable?: boolean;
};

const HIDDEN: Banner = { show: false, text: "" };

// GitHub Release 자동 업데이트 — 기존 client.js bindAutoUpdate 포팅.
export function useAutoUpdate(): { version: string; checkNow: () => void; banner: ReactNode } {
  const toast = useToast();
  const [version, setVersion] = useState("");
  const [banner, setBanner] = useState<Banner>(HIDDEN);
  const dismissedFor = useRef<string | null>(null);
  const quiet = useRef(true); // 시작 자동 체크는 조용히

  const show = useCallback((text: string, opts: Partial<Banner> = {}) => {
    setBanner({ show: true, text, ...opts });
  }, []);
  const hide = useCallback(() => setBanner(HIDDEN), []);

  const onStatus = useCallback(
    (s?: UpdateStatus) => {
      if (!s || !s.state) return;
      if (s.state === "checking") {
        if (!quiet.current) show("업데이트 확인 중…");
        return;
      }
      if (s.state === "available") {
        if (dismissedFor.current === s.version) return;
        show("새 버전 v" + s.version + " 사용 가능", {
          actionLabel: "다운로드",
          actionMode: "download",
          dismissable: true,
        });
        return;
      }
      if (s.state === "downloading") {
        const pct = Math.max(0, Math.min(100, Math.round(s.percent || 0)));
        show("v" + (s.version || "?") + " 다운로드 중… " + pct + "%");
        return;
      }
      if (s.state === "downloaded") {
        show("v" + s.version + " 다운로드 완료 — 재시작하면 적용됩니다", {
          actionLabel: "지금 재시작",
          actionMode: "install",
          dismissable: true,
          ok: true,
        });
        return;
      }
      if (s.state === "not-available") {
        if (!quiet.current) {
          hide();
          toast("이미 최신 버전입니다 (v" + s.version + ")");
        }
        quiet.current = true;
        return;
      }
      if (s.state === "error") {
        if (!quiet.current) {
          show("업데이트 확인 실패: " + (s.message || "알 수 없음"), { error: true, dismissable: true });
        }
        quiet.current = true;
      }
    },
    [show, hide, toast],
  );

  useEffect(() => {
    const up = window.api?.update;
    if (!up) return;
    up.getVersion().then((v) => v && setVersion(v)).catch(() => {});
    const off = up.onStatus(onStatus);
    up.getStatus().then(onStatus).catch(() => {});
    return off;
  }, [onStatus]);

  const checkNow = useCallback(() => {
    const up = window.api?.update;
    if (!up) return;
    quiet.current = false;
    dismissedFor.current = null;
    show("업데이트 확인 중…");
    up.check();
  }, [show]);

  const onAction = () => {
    const up = window.api?.update;
    if (!up) return;
    if (banner.actionMode === "download") {
      setBanner((b) => ({ ...b, actionLabel: undefined, actionMode: undefined, text: "다운로드 시작…" }));
      up.download();
    } else if (banner.actionMode === "install") {
      up.install();
    }
  };

  const onDismiss = () => {
    const up = window.api?.update;
    up?.getStatus()
      .then((s) => {
        if (s && (s.state === "available" || s.state === "downloaded") && s.version) dismissedFor.current = s.version;
      })
      .catch(() => {});
    hide();
  };

  const node: ReactNode = banner.show ? (
    <div
      className={
        "upd sticky top-0 z-[110] flex flex-wrap items-center gap-x-3.5 gap-y-2.5 px-3.5 py-2 text-[13px] font-semibold text-ink" +
        (banner.error ? " is-error" : "") +
        (banner.ok ? " is-ok" : "")
      }
    >
      <span className="min-w-[160px] flex-1">{banner.text}</span>
      <div className="flex items-center gap-1.5">
        {banner.actionLabel && (
          <button type="button" className="btn btn-primary text-[12.5px]" onClick={onAction}>
            {banner.actionLabel}
          </button>
        )}
        {banner.dismissable && (
          <button type="button" className="btn btn-ghost text-[12.5px] text-ink-2" onClick={onDismiss}>
            나중에
          </button>
        )}
      </div>
    </div>
  ) : null;

  return { version, checkNow, banner: node };
}
