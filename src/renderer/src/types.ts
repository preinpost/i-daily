// 렌더러 도메인 타입. 전송 경계(JSON) 형태는 shared/model.ts 가 단일 원천 —
// 중복 선언 대신 그대로 re-export 하고, 렌더러 전용 타입만 여기서 정의한다.
export type {
	Task,
	Space,
	Block,
	Scrum,
	ListItem,
	Section,
	Doc,
	Shortcut,
	Config,
} from "../../shared/model";

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

// window.api 브릿지 — 브라우저에선 fetch 기반 web-api.ts 가 구현.
export type Api = {
	request: (
		method: string,
		path: string,
		body?: unknown,
	) => Promise<{ status: number; body: any }>;
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
};

declare global {
	interface Window {
		api: Api;
	}
}
