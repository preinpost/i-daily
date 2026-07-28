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
		// 일지 마감일 → 실제 티켓 duedate 반영(없는 티켓·미연결은 skipped).
		setDue: (
			key: string,
			due: string,
		) => Promise<{ ok: boolean; key?: string; skipped?: string; error?: string }>;
		// 가능한 전이 목록. cat = 도착 상태의 statusCategory(new/indeterminate/done).
		transitions: (key: string) => Promise<{
			ok: boolean;
			key?: string;
			transitions?: { id: string; name: string; to: string; cat: string }[];
			error?: string;
		}>;
		// 전이 실행. transitionId 생략 시 후보가 하나일 때만 자동 선택.
		transition: (
			key: string,
			transitionId?: string,
		) => Promise<{ ok: boolean; key?: string; name?: string; error?: string }>;
	};
	me: () => Promise<{ user: string; isSetup: boolean } | null>;
	agent: {
		generate: (opts?: unknown) => Promise<any>;
		defaultPrompt: () => Promise<string>;
	};
	ai: {
		status: () => Promise<{
			hasKey: boolean;
			provider: string;
			model: string;
			baseUrl: string;
			encReady: boolean;
			providers: {
				id: string;
				label: string;
				defaultModel: string;
				keyHint: string;
				custom: boolean;
			}[];
		}>;
		test: (v: {
			provider: string;
			apiKey: string;
			baseUrl?: string;
		}) => Promise<{ ok: boolean; models: string[]; error?: string }>;
		saveKey: (v: {
			provider: string;
			model: string;
			apiKey: string;
			baseUrl?: string;
		}) => Promise<any>;
		clearKey: () => Promise<any>;
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
