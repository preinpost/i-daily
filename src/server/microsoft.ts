// server/microsoft.ts — Microsoft Graph 보조 연결(Atlassian 로그인 유지).
// 토큰은 Better Auth account 테이블에 저장. 연결은 /api/auth/link-social.
// Excel · Teams 등 기능은 getMicrosoftAccessToken() 으로 Graph 호출.
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { AppAuth } from "../auth/index.ts";
import * as authSchema from "../auth/schema.ts";

export type MicrosoftStatus = {
	configured: boolean;
	connected: boolean;
	displayName?: string;
	email?: string;
	scopes?: string[];
	/** 디버그용 — Application (client) ID 앞 8자. Azure 앱과 대조. */
	clientIdPrefix?: string;
	tenantId?: string;
	error?: string;
};

export function microsoftConfigured(env: Env): boolean {
	return !!(
		(env.MICROSOFT_CLIENT_ID || "").trim() &&
		(env.MICROSOFT_CLIENT_SECRET || "").trim()
	);
}

/** 세션 유저의 Microsoft access token (만료 시 BA 가 refresh). */
export async function getMicrosoftAccessToken(
	auth: AppAuth,
	request: Request,
): Promise<string | null> {
	try {
		const tok = await auth.api.getAccessToken({
			headers: request.headers,
			body: { providerId: "microsoft" },
		});
		const access = String(
			(tok as { accessToken?: string } | null)?.accessToken || "",
		).trim();
		return access || null;
	} catch {
		return null;
	}
}

/** Graph GET /me — 연결 상태 표시용. */
async function graphMe(accessToken: string): Promise<{
	displayName: string;
	email: string;
} | null> {
	const r = await fetch("https://graph.microsoft.com/v1.0/me", {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/json",
		},
	});
	if (!r.ok) return null;
	const me = (await r.json()) as {
		displayName?: string;
		mail?: string;
		userPrincipalName?: string;
	};
	return {
		displayName: (me.displayName || "").trim(),
		email: (me.mail || me.userPrincipalName || "").trim(),
	};
}

export async function microsoftStatus(
	env: Env,
	auth: AppAuth,
	request: Request,
): Promise<MicrosoftStatus> {
	const clientId = (env.MICROSOFT_CLIENT_ID || "").trim();
	const tenantId =
		(env.MICROSOFT_TENANT_ID || "organizations").trim() || "organizations";
	const clientIdPrefix = clientId ? clientId.slice(0, 8) : undefined;

	if (!microsoftConfigured(env)) {
		return { configured: false, connected: false, clientIdPrefix, tenantId };
	}

	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user?.id) {
		return { configured: true, connected: false, clientIdPrefix, tenantId };
	}

	try {
		const accounts = await auth.api.listUserAccounts({
			headers: request.headers,
		});
		const list = (accounts || []) as Array<{
			providerId?: string;
			scopes?: string[];
		}>;
		const ms = list.find((a) => a.providerId === "microsoft");
		if (!ms) {
			return { configured: true, connected: false, clientIdPrefix, tenantId };
		}

		const out: MicrosoftStatus = {
			configured: true,
			connected: true,
			scopes: Array.isArray(ms.scopes) ? ms.scopes : undefined,
			clientIdPrefix,
			tenantId,
		};

		const access = await getMicrosoftAccessToken(auth, request);
		if (access) {
			const me = await graphMe(access);
			if (me) {
				out.displayName = me.displayName;
				out.email = me.email;
			}
		}
		return out;
	} catch (e) {
		return {
			configured: true,
			connected: false,
			clientIdPrefix,
			tenantId,
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

/**
 * Microsoft account unlink (Jira/Atlassian 세션은 유지).
 * BA unlinkAccount 는 freshSession(기본 24h 이내 재로그인) 을 요구해서
 * "Session is not fresh" 가 자주 난다. 보조 연결 해제는 세션 유저의
 * provider=microsoft 행만 직접 삭제한다.
 */
export async function microsoftDisconnect(
	env: Env,
	auth: AppAuth,
	request: Request,
): Promise<{ ok: boolean; error?: string }> {
	try {
		const session = await auth.api.getSession({ headers: request.headers });
		const userId = session?.user?.id;
		if (!userId) {
			return { ok: false, error: "login required" };
		}
		const db = drizzle(env.DB);
		const whereMs = and(
			eq(authSchema.account.userId, userId),
			eq(authSchema.account.providerId, "microsoft"),
		);
		const existing = await db
			.select({ id: authSchema.account.id })
			.from(authSchema.account)
			.where(whereMs)
			.all();
		if (!existing.length) {
			return { ok: false, error: "microsoft account not linked" };
		}
		await db.delete(authSchema.account).where(whereMs);
		return { ok: true };
	} catch (e) {
		return {
			ok: false,
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

/** Graph 호스트만 허용(SSRF 방지). path 또는 전체 URL. */
export function resolveGraphUrl(pathOrUrl: string): string | null {
	const raw = String(pathOrUrl || "").trim();
	if (!raw) return null;
	try {
		if (/^https?:\/\//i.test(raw)) {
			const u = new URL(raw);
			if (u.protocol !== "https:") return null;
			const host = u.hostname.toLowerCase();
			if (
				host !== "graph.microsoft.com" &&
				host !== "graph.microsoft.us" &&
				!host.endsWith(".graph.microsoft.com")
			) {
				return null;
			}
			return u.toString();
		}
		// "/me" 또는 "me/messages" 또는 "v1.0/me"
		let p = raw.startsWith("/") ? raw : `/${raw}`;
		if (p.startsWith("/v1.0") || p.startsWith("/beta")) {
			return `https://graph.microsoft.com${p}`;
		}
		return `https://graph.microsoft.com/v1.0${p}`;
	} catch {
		return null;
	}
}

/**
 * Graph 호출 헬퍼 — 향후 Excel/Teams 기능 · 테스트 탭에서 재사용.
 * path 예: "/me", "/me/chats", "https://graph.microsoft.com/v1.0/me"
 */
export async function graphFetch(
	auth: AppAuth,
	request: Request,
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	const access = await getMicrosoftAccessToken(auth, request);
	if (!access) {
		return new Response(JSON.stringify({ error: "microsoft not connected" }), {
			status: 401,
			headers: { "content-type": "application/json" },
		});
	}
	const url = resolveGraphUrl(path);
	if (!url) {
		return new Response(JSON.stringify({ error: "invalid graph path" }), {
			status: 400,
			headers: { "content-type": "application/json" },
		});
	}
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${access}`);
	if (!headers.has("Accept")) headers.set("Accept", "application/json");
	return fetch(url, { ...init, headers });
}

export type GraphProxyInput = {
	method?: string;
	path?: string;
	body?: unknown;
	/** 추가 요청 헤더(Authorization 은 무시). */
	headers?: Record<string, string>;
};

export type GraphProxyResult = {
	ok: boolean;
	status: number;
	url?: string;
	ms?: number;
	body: unknown;
	error?: string;
};

/** 테스트 탭용 Graph 프록시 — 세션+MS 연결 필요. */
export async function microsoftGraphProxy(
	auth: AppAuth,
	request: Request,
	input: GraphProxyInput,
): Promise<GraphProxyResult> {
	const method = String(input.method || "GET").toUpperCase();
	if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
		return { ok: false, status: 400, body: null, error: "method not allowed" };
	}
	const url = resolveGraphUrl(String(input.path || ""));
	if (!url) {
		return { ok: false, status: 400, body: null, error: "invalid graph path" };
	}

	const headers: Record<string, string> = {};
	if (input.headers && typeof input.headers === "object") {
		for (const [k, v] of Object.entries(input.headers)) {
			if (/^authorization$/i.test(k)) continue;
			if (typeof v === "string") headers[k] = v;
		}
	}

	const init: RequestInit = { method, headers };
	if (method !== "GET" && method !== "DELETE" && input.body !== undefined) {
		if (typeof input.body === "string") {
			init.body = input.body;
			if (!headers["content-type"] && !headers["Content-Type"]) {
				headers["Content-Type"] = "application/json";
			}
		} else {
			init.body = JSON.stringify(input.body);
			headers["Content-Type"] = "application/json";
		}
	}

	const t0 = Date.now();
	const res = await graphFetch(auth, request, url, init);
	const ms = Date.now() - t0;
	const ct = res.headers.get("content-type") || "";
	let body: unknown;
	if (ct.includes("application/json")) {
		body = await res.json().catch(async () => await res.text());
	} else {
		const text = await res.text();
		body = text.length > 200_000 ? text.slice(0, 200_000) + "…(truncated)" : text;
	}
	return {
		ok: res.ok,
		status: res.status,
		url,
		ms,
		body,
		error: res.ok ? undefined : `Graph ${res.status}`,
	};
}
