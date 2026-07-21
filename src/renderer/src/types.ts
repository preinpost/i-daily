// 렌더러 도메인 타입 — 백엔드 shared/model.ts 의 형태를 미러링(전송 경계에서 JSON).

export type Task = {
	key: string;
	desc: string;
	progress: number | "";
	due: string;
	subs?: string[];
};
export type Space = { label: string; tasks: Task[] };
export type Block = { spaces: Space[]; issues: string; collab: string };
export type Scrum = { prev: Block; today: Block };
export type ListItem = {
	done: boolean;
	key: string;
	desc: string;
	progress?: number | "";
	due?: string;
	subs?: string[];
};
export type Section =
	| { title: string; kind: "scrum" }
	| { title: string; kind: "list"; items: ListItem[] }
	| { title: string; kind: "raw"; body: string };
export type Doc = {
	date: string;
	owner: string;
	preamble: string;
	sections: Section[];
	scrum: Scrum;
};
export type Shortcut = { name: string; url: string };

export type Config = {
	owner: string;
	jiraBase: string;
	reportAgent: string;
	reportPrompt: string;
	lunchLat: string;
	lunchLng: string;
	lunchRadius: string;
};

export type Meta = { today: string | null; owner: string; jiraBase: string };

export type Ticket = {
	key: string;
	summary?: string;
	status?: string;
	statusCat?: string;
	type?: string;
	priority?: string;
	due?: string;
	url?: string;
};

export type Which = "prev" | "today";

export type UpdateStatus = {
	state: string;
	version?: string;
	releaseNotes?: string | null;
	percent?: number;
	transferred?: number;
	total?: number;
	message?: string;
};

// preload 가 노출한 window.api 브릿지.
export type Api = {
	request: (
		method: string,
		path: string,
		body?: unknown,
	) => Promise<{ status: number; body: any }>;
	lifecycle: {
		setDirty: (v: boolean) => void;
		confirmQuit: () => void;
		onSaveAndQuit: (cb: () => void) => () => void;
	};
	jira: {
		status: () => Promise<any>;
		connect: () => Promise<any>;
		logout: () => Promise<any>;
		tickets: () => Promise<any>;
	};
	me: () => Promise<{ user: string; isSetup: boolean } | null>;
	agent: {
		scan: () => Promise<any>;
		generate: (opts?: unknown) => Promise<any>;
		defaultPrompt: () => Promise<string>;
	};
	lunch: {
		search: (opts: unknown) => Promise<any>;
	};
	update: {
		getVersion: () => Promise<string>;
		getStatus: () => Promise<UpdateStatus>;
		check: () => Promise<UpdateStatus>;
		download: () => Promise<UpdateStatus>;
		install: () => Promise<void>;
		onStatus: (cb: (s: UpdateStatus) => void) => () => void;
	};
};

declare global {
	interface Window {
		api: Api;
	}
}
