// web-api.ts — 브라우저 전용 window.api 구현.
// fetch 기반 request(일지 CRUD) + 도메인 라우트 호출(jira/agent) — 모두 동일 오리진 /api/* HTTP.
import type { Api } from "./types";

// 동일 오리진 /api/* 로 HTTP 호출. Hono(Workers) 서버가 처리.
async function request(
	method: string,
	path: string,
	body?: unknown,
): Promise<{ status: number; body: any }> {
	const opt: RequestInit = { method, headers: {}, credentials: "include" };
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

// 도메인 라우트(/api/jira·agent) 호출 — 동일 경로 HTTP.
// 컴포넌트가 window.api.jira.tickets() 를 쓰듯, 웹은 GET /api/jira/tickets 를 부른다.
async function get(path: string): Promise<any> {
	return (await request("GET", path)).body;
}
async function post(path: string, body?: unknown): Promise<any> {
	return (await request("POST", path, body)).body;
}
async function put(path: string, body?: unknown): Promise<any> {
	return (await request("PUT", path, body)).body;
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

export const webApi: Api = {
	request,

	// 도메인 라우트가 서버에 구현됨 — 동일 경로 HTTP 호출.
	jira: {
		status: () => get("/api/jira/status"),
		connect: async () => {
			// Better Auth Atlassian social — 전체 페이지 리다이렉트.
			const r = await fetch("/api/auth/sign-in/social", {
				method: "POST",
				credentials: "include",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ provider: "atlassian", callbackURL: "/" }),
			});
			const j = (await r.json().catch(() => ({}))) as {
				url?: string;
				error?: string;
			};
			if (j.url && isAtlassianAuthorize(j.url)) {
				location.href = j.url;
				return { ok: true, authorizeUrl: j.url };
			}
			return { ok: false, error: j.error || `sign-in failed (${r.status})` };
		},
		logout: async () => {
			await fetch("/api/auth/sign-out", {
				method: "POST",
				credentials: "include",
			}).catch(() => undefined);
			return post("/api/jira/logout");
		},
		tickets: () => get("/api/jira/tickets"),
		setDue: (key: string, due: string) =>
			put("/api/jira/due", { key, due }),
		transitions: (key: string) =>
			get("/api/jira/transitions?key=" + encodeURIComponent(key)),
		transition: (key: string, transitionId?: string) =>
			post("/api/jira/transition", { key, transitionId }),
	},
	me: () => get("/api/me"),
	agent: {
		generate: (opts?: unknown) => post("/api/agent/generate", opts),
	},
};
