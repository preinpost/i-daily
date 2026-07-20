// main/index.ts — Electron 메인 프로세스.
// 창 생성 + 단일 IPC 채널(api) + DB(userData 경로) + window.open→외부 브라우저 + 자동 업데이트.
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../shared/store.ts";
import { route } from "../shared/api.ts";
import { setupAutoUpdater } from "./update.ts";
import { setupJira } from "./jira.ts";
import { setupAgent } from "./agent.ts";
import { setupLunch } from "./lunch.ts";

const APP_NAME = "i-daily";
const USER = process.env.IDAILY_USER ?? "local"; // 데스크톱=단일 유저
let db: Database.Database;

let mainWindow: BrowserWindow | null = null;
let isDirty = false; // 렌더러가 알려주는 “저장 안 됨” 상태
let quitting = false; // Cmd+Q / app.quit() 진행 중인지 (창만 닫기 vs 앵 종료 구분)

// 실제로 창을 파괴하고, Cmd+Q였다면 앵까지 종료. (destroy 는 close 핸들러를 우회)
function proceedClose(): void {
	const w = mainWindow;
	mainWindow = null;
	w?.destroy();
	if (quitting) app.quit();
}

// 메뉴바/About 이름. (독 라벨 "Electron"은 개발 시 Electron.app 번들명 한계 — dist 패키징 후 i-daily)
app.setName(APP_NAME);

// build/icon.png — dev: 프로젝트 루트, pack: resources. mac 독은 dock.setIcon, win/linux는 BrowserWindow.icon.
function appIconPath(): string | undefined {
	const candidates = [
		join(__dirname, "../../build/icon.png"), // electron-vite out/main → 프로젝트/build
		join(process.cwd(), "build/icon.png"),
		join(process.resourcesPath ?? "", "icon.png"),
	];
	return candidates.find((p) => existsSync(p));
}

function createWindow(): void {
	const icon = appIconPath();
	const win = new BrowserWindow({
		width: 1180,
		height: 820,
		minWidth: 720,
		minHeight: 560,
		title: APP_NAME,
		...(icon ? { icon } : {}),
		autoHideMenuBar: true,
		backgroundColor: "#f6f7f9",
		webPreferences: {
			preload: join(__dirname, "../preload/index.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
		},
	});

	mainWindow = win;

	// 저장 안 된 변경이 있으면 닫기를 막고 네이티브 다이얼로그로 물음(Cmd+Q 포함).
	win.on("close", (e) => {
		if (!isDirty) return; // 깨끗하면 그대로 종료
		e.preventDefault();
		const choice = dialog.showMessageBoxSync(win, {
			type: "warning",
			buttons: ["저장 후 종료", "저장 안 함", "취소"],
			defaultId: 0,
			cancelId: 2,
			noLink: true,
			title: APP_NAME,
			message: "저장하지 않은 변경이 있습니다.",
			detail: "종료하기 전에 변경 내용을 저장할까요?",
		});
		if (choice === 2) {
			quitting = false;
			return;
		} // 취소 → 유지
		if (choice === 1) {
			proceedClose();
			return;
		} // 저장 안 함 → 종료
		win.webContents.send("app:save-and-quit"); // 저장 후 종료 → 렌더러가 저장 후 confirmQuit
	});
	win.on("closed", () => {
		if (mainWindow === win) mainWindow = null;
	});

	// client.js의 window.open(Jira 티켓·바로가기)은 앵 내 새 창이 아니라 기본 브라우저로.
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:\/\//.test(url)) shell.openExternal(url);
		return { action: "deny" };
	});

	const devUrl = process.env.ELECTRON_RENDERER_URL; // electron-vite dev 서버
	if (devUrl) win.loadURL(devUrl);
	else win.loadFile(join(__dirname, "../renderer/index.html"));
}

app.whenReady().then(() => {
	// 개발 모드: 기본 Electron 원자 아이콘 대신 build/icon.png 사용
	const icon = appIconPath();
	if (process.platform === "darwin" && icon && app.dock) app.dock.setIcon(icon);

	// 패키지 앱 번들은 읽기전용 → DB는 반드시 쓰기 가능한 userData 경로에.
	const dbPath =
		process.env.DB_PATH ?? join(app.getPath("userData"), "i-daily.db");
	db = openDb(dbPath);

	// 프런트 api(method,path,body) → route → {status, body}. 전송만 HTTP→IPC로 교체.
	ipcMain.handle(
		"api",
		(_e, req: { method: string; path: string; body: unknown }) =>
			route(req.method, req.path, req.body, USER, db),
	);

	// 렌더러 ↔ 종료 조율: dirty 상태 수신 + 저장 완료 후 종료 확정.
	ipcMain.on("app:set-dirty", (_e, v: boolean) => {
		isDirty = !!v;
	});
	ipcMain.on("app:confirm-quit", () => proceedClose());
	app.on("before-quit", () => {
		quitting = true;
	});

	setupJira(db, USER); // Jira OAuth(3LO) + REST. IPC jira:* 등록.

	setupAgent(db, USER); // 주간업무보고 에이전트. IPC agent:* 등록.

	setupLunch(db, USER); // 점심 탭 맛집 검색(카카오 로컬). IPC lunch:* 등록.

	setupAutoUpdater(); // GitHub Release 체크(패키지 앱만). IPC update:* 등록.

	createWindow();
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
