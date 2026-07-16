// GitHub Releases 기반 자동 업데이트 (electron-updater).
// 패키징된 앱에서만 동작. 개발 모드(app.isPackaged=false)는 no-op.
//
// 필요 조건:
//  - electron-builder.yml publish.provider=github + package.json repository
//  - Release 자산에 latest.yml / latest-mac.yml / latest-linux.yml (+ blockmap) 포함
//  - mac: zip 타깃(이미 있음). 코드 서명·공증 없으면 설치 단계에서 OS가 막을 수 있음
//  - win: nsis 설치본(portable은 자동 업데이트 비대상)
//  - linux: AppImage
import { app, BrowserWindow, ipcMain } from "electron";
import { autoUpdater, type ProgressInfo, type UpdateInfo } from "electron-updater";

export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string; releaseNotes?: string | null }
  | { state: "not-available"; version: string }
  | { state: "downloading"; version: string; percent: number; transferred: number; total: number }
  | { state: "downloaded"; version: string }
  | { state: "error"; message: string };

let status: UpdateStatus = { state: "idle" };
let started = false;

function broadcast(payload: UpdateStatus): void {
  status = payload;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("update:status", payload);
  }
}

function notesOf(info: UpdateInfo): string | null {
  const n = info.releaseNotes;
  if (!n) return null;
  if (typeof n === "string") return n;
  if (Array.isArray(n)) return n.map((x) => x.note || "").filter(Boolean).join("\n");
  return null;
}

/** 앱 준비 후 1회 호출. IPC 핸들러 등록 + (패키지 앱이면) 시작 시 체크. */
export function setupAutoUpdater(): void {
  if (started) return;
  started = true;

  ipcMain.handle("update:get-status", () => status);
  ipcMain.handle("update:get-version", () => app.getVersion());
  ipcMain.handle("update:check", async () => {
    if (!app.isPackaged) {
      broadcast({ state: "not-available", version: app.getVersion() });
      return status;
    }
    try {
      await autoUpdater.checkForUpdates();
    } catch (e) {
      broadcast({ state: "error", message: errMsg(e) });
    }
    return status;
  });
  ipcMain.handle("update:download", async () => {
    if (!app.isPackaged) return status;
    try {
      await autoUpdater.downloadUpdate();
    } catch (e) {
      broadcast({ state: "error", message: errMsg(e) });
    }
    return status;
  });
  ipcMain.handle("update:install", () => {
    if (!app.isPackaged) return;
    // isSilent=false, isForceRunAfter=true — 설치 후 앱 재실행
    autoUpdater.quitAndInstall(false, true);
  });

  if (!app.isPackaged) return; // dev는 피드 조회 스킵

  autoUpdater.autoDownload = false;          // 사용자가 배너에서 확인 후 다운로드
  autoUpdater.autoInstallOnAppQuit = true;   // 다운로드 후 종료 시 자동 설치
  autoUpdater.allowPrerelease = false;

  autoUpdater.on("checking-for-update", () => {
    broadcast({ state: "checking" });
  });
  autoUpdater.on("update-available", (info: UpdateInfo) => {
    broadcast({
      state: "available",
      version: info.version,
      releaseNotes: notesOf(info),
    });
  });
  autoUpdater.on("update-not-available", (info: UpdateInfo) => {
    broadcast({ state: "not-available", version: info.version });
  });
  autoUpdater.on("download-progress", (p: ProgressInfo) => {
    const ver = status.state === "available" || status.state === "downloading"
      ? status.version
      : "";
    broadcast({
      state: "downloading",
      version: ver,
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
    });
  });
  autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
    broadcast({ state: "downloaded", version: info.version });
  });
  autoUpdater.on("error", (err: Error) => {
    broadcast({ state: "error", message: errMsg(err) });
  });

  // 시작 직후 네트워크 안정 대기 후 체크, 이후 4시간마다.
  const CHECK_MS = 4 * 60 * 60 * 1000;
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((e) => {
      broadcast({ state: "error", message: errMsg(e) });
    });
  }, 5_000);
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => { /* 주기 체크 실패는 조용히 */ });
  }, CHECK_MS).unref?.();
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
