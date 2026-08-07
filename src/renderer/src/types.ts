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
	updated?: string;
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
		// 업무등록(티켓 생성)
		createMeta: () => Promise<{
			ok: boolean;
			error?: string;
			site?: string;
			projects?: {
				id: string;
				key: string;
				name: string;
				issueTypes: { id: string; name: string; subtask: boolean }[];
			}[];
		}>;
		// 프로젝트+이슈타입의 생성 필드 메타(required·type·allowedValues)
		createFields: (
			project: string,
			issueType: string,
		) => Promise<{
			ok: boolean;
			error?: string;
			fields?: {
				key: string;
				name: string;
				required: boolean;
				type: string;
				system: string;
				allowedValues: { id: string; name: string; value?: string }[];
			}[];
		}>;
		// 티켓 생성 실행
		createIssue: (payload: {
			projectKey: string;
			issueTypeId: string;
			fields: Record<string, unknown>;
		}) => Promise<{
			ok: boolean;
			key?: string;
			url?: string;
			error?: string;
		}>;
		// 프로젝트 배정 가능 사용자(담당자/보고자 드롭박스용). current=로그인 accountId.
		users: (project: string) => Promise<{
			ok: boolean;
			error?: string;
			current?: string;
			users?: {
				accountId: string;
				displayName: string;
				emailAddress?: string;
				active?: boolean;
			}[];
		}>;
		// 프로젝트 내 이슈 검색(상위 항목/부모용) — 키/제목으로 검색.
		searchIssues: (project: string, q?: string) => Promise<{
			ok: boolean;
			error?: string;
			issues?: {
				key: string;
				summary: string;
				type?: string;
				status?: string;
				url?: string;
			}[];
		}>;
		// 티켓 상세(수정 폼 초기값)
		get: (key: string) => Promise<any>;
		// 수정 가능 필드 메타
		editMeta: (key: string) => Promise<{
			ok: boolean;
			error?: string;
			fields?: {
				key: string;
				name: string;
				required: boolean;
				type: string;
				system: string;
				allowedValues: { id: string; name: string; value?: string }[];
			}[];
		}>;
		// 티켓 수정(변경할 필드만)
		edit: (key: string, fields: Record<string, unknown>) => Promise<{
			ok: boolean;
			key?: string;
			error?: string;
		}>;
	};
	me: () => Promise<{ user: string; isSetup: boolean } | null>;
	/** Microsoft Graph 보조 연결(Atlassian 로그인 유지). */
	microsoft: {
		status: () => Promise<{
			configured?: boolean;
			connected?: boolean;
			displayName?: string;
			email?: string;
			scopes?: string[];
			error?: string;
		} | null>;
		connect: () => Promise<{ ok: boolean; error?: string }>;
		disconnect: () => Promise<{ ok: boolean; error?: string }>;
		/** 서버 프록시 Graph 호출(테스트 탭). */
		graph: (opts: {
			method?: string;
			path: string;
			body?: unknown;
			headers?: Record<string, string>;
		}) => Promise<{
			ok: boolean;
			status: number;
			url?: string;
			ms?: number;
			body: unknown;
			error?: string;
		}>;
	};
	agent: {
		generate: (opts?: unknown) => Promise<any>;
	};
	exportLog: (
		from: string,
		to: string,
		format: "md" | "json",
	) => Promise<{ status: number; body: any }>;
};

declare global {
	interface Window {
		api: Api;
	}
}
