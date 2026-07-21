// web-api.ts — 브라우저 전용 window.api 구현.
// fetch 기반 request(일지 CRUD) + 도메인 라우트 호출(jira/lunch/agent).
// 자동업데이트(update.*) 는 웹에 없으므로 no-op 스텁 — 컴포넌트가 옵셔널 체이닝으로 스킵.
//
// 설계: 모든 컴포넌트가 window.api?.X 옵셔널 체이닝으로 접근하므로,
// request(=일지 CRUD)만 실제 구현하고 나머지는 앱이 죽지 않게 빈 스텁을 둔다.
// Jira/Lunch/Agent/Update/Lifecycle은 다음 단계(서버 이식)에서 채운다.
import type { Api } from "./types";

// 동일 오리진 /api/* 로 HTTP 호출. Hono(Workers) 서버가 처리.
async function request(
	method: string,
	path: string,
	body?: unknown,
): Promise<{ status: number; body: any }> {
	const opt: RequestInit = { method, headers: {} };
	if (body !== undefined && method !== "GET" && method !== "HEAD") {
		(opt.headers as Record<string, string>)["content-type"] =
			"application/json";
		opt.body = JSON.stringify(body);
	}
	const r = await fetch(path, opt);
	let json: any = null;
	const t = r.headers.get("content-type") || "";
	if (t.includes("application/json")) {
		json = await r.json().catch(() => null);
	} else {
		const txt = await r.text();
		json = txt || null;
	}
	return { status: r.status, body: json };
}

// 도메인 라우트(/api/jira·lunch·agent) 호출 — 동일 경로 HTTP.
// 컴포넌트가 window.api.jira.tickets() 를 쓰듯, 웹은 GET /api/jira/tickets 를 부른다.
async function get(path: string): Promise<any> {
	return (await request("GET", path)).body;
}
async function post(path: string, body?: unknown): Promise<any> {
	return (await request("POST", path, body)).body;
}

// Atlassian 인가 URL 만 신뢰(window.open open-redirect 방지).
// 정규식 대신 URL 호스트 비교 — 검증 의도가 정적 분석에도 드러난다.
const isAtlassianAuthorize = (u: string): boolean => {
	try {
		const x = new URL(u);
		return x.protocol === "https:" && x.hostname === "auth.atlassian.com";
	} catch {
		return false;
	}
};

// 자동업데이트(update.*) 는 웹에 없음 → no-op 스텁. 컴포넌트가 옵셔널 체이닝으로 호출해도 안전.
const noop = () => {};
const noopAsync = async () => null;

export const webApi: Api = {
	request,

	lifecycle: {
		setDirty: noop,
		confirmQuit: noop,
		onSaveAndQuit: () => noop, // 구독 해제 no-op
	},

	// 도메인 라우트가 서버에 구현됨 — IPC 대신 동일 경로 HTTP 호출.
	// 단, update.* 는 웹에 자동업데이트가 없으므로 유지(아래 스텁).
	jira: {
		status: () => get("/api/jira/status"),
		connect: async () => {
			const r = await get("/api/jira/connect");
			// 인가 URL 이 오면 새 창으로 열어 OAuth 진행. 콜백이 서버에서 토큰을 저장한다.
			// authorizeUrl 은 서버가 Atlassian 인가 URL 로 생성(신뢰). 호스트 검증으로 open-redirect 방지.
			if (r && r.ok && r.authorizeUrl && isAtlassianAuthorize(r.authorizeUrl)) {
				// isAtlassianAuthorize 로 https://auth.atlassian.com 호스트 검증后 open — open-redirect 아님.
				// pi-lens-ignore: no-open-redirect
				window.open(r.authorizeUrl, "jira-oauth", "width=600,height=700");
			}
			return r;
		},
		logout: () => post("/api/jira/logout"),
		tickets: () => get("/api/jira/tickets"),
	},
	me: () => get("/api/me"),
	agent: {
		scan: () => get("/api/agent/scan"),
		generate: (opts?: unknown) => post("/api/agent/generate", opts),
		defaultPrompt: () => get("/api/agent/default-prompt"),
	},
	lunch: {
		search: (opts: unknown) => post("/api/lunch/search", opts),
	},
	update: {
		getVersion: noopAsync as any,
		getStatus: noopAsync as any,
		check: noopAsync as any,
		download: noopAsync as any,
		install: noopAsync as any,
		onStatus: () => noop,
	},
};
