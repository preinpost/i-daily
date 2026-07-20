// preload/index.ts — 렌더러에 안전한 브릿지 하나만 노출(contextIsolation).
// window.api.request(method, path, body) → ipcMain 'api' 핸들러 → route().
// window.api.update.* → electron-updater 상태/동작.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

type UpdateStatus = {
	state: string;
	version?: string;
	releaseNotes?: string | null;
	percent?: number;
	transferred?: number;
	total?: number;
	message?: string;
};

contextBridge.exposeInMainWorld("api", {
	request: (method: string, path: string, body?: unknown) =>
		ipcRenderer.invoke("api", { method, path, body }),

	lifecycle: {
		setDirty: (v: boolean) => ipcRenderer.send("app:set-dirty", v),
		confirmQuit: () => ipcRenderer.send("app:confirm-quit"),
		onSaveAndQuit: (cb: () => void): (() => void) => {
			const handler = () => cb();
			ipcRenderer.on("app:save-and-quit", handler);
			return () => ipcRenderer.removeListener("app:save-and-quit", handler);
		},
	},

	jira: {
		status: (): Promise<any> => ipcRenderer.invoke("jira:status"),
		connect: (): Promise<any> => ipcRenderer.invoke("jira:connect"),
		logout: (): Promise<any> => ipcRenderer.invoke("jira:logout"),
		tickets: (): Promise<any> => ipcRenderer.invoke("jira:tickets"),
	},

	agent: {
		scan: (): Promise<any> => ipcRenderer.invoke("agent:scan"),
		generate: (opts?: unknown): Promise<any> =>
			ipcRenderer.invoke("agent:generate", opts),
		defaultPrompt: (): Promise<string> =>
			ipcRenderer.invoke("agent:default-prompt"),
	},

	lunch: {
		search: (opts: unknown): Promise<any> =>
			ipcRenderer.invoke("lunch:search", opts),
	},

	update: {
		getVersion: (): Promise<string> => ipcRenderer.invoke("update:get-version"),
		getStatus: (): Promise<UpdateStatus> =>
			ipcRenderer.invoke("update:get-status"),
		check: (): Promise<UpdateStatus> => ipcRenderer.invoke("update:check"),
		download: (): Promise<UpdateStatus> =>
			ipcRenderer.invoke("update:download"),
		install: (): Promise<void> => ipcRenderer.invoke("update:install"),
		onStatus: (cb: (status: UpdateStatus) => void): (() => void) => {
			const handler = (_e: IpcRendererEvent, status: UpdateStatus) =>
				cb(status);
			ipcRenderer.on("update:status", handler);
			return () => ipcRenderer.removeListener("update:status", handler);
		},
	},
});
