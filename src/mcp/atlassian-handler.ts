// mcp/atlassian-handler.ts — MCP OAuth 의 Atlassian(3LO) identity bridge (PoC).
// MCP 클라이언트 → /authorize → Atlassian 로그인 → (웹과 동일) /api/jira/callback
// → MCP access token 발급. Atlassian access token 은 클라이언트에 넘기지 않는다.
//
// 콜백 URL 은 기존 Jira 웹 로그인과 공유한다. state 가 OAUTH_KV(MCP)에 있으면 MCP,
// 없으면 기존 Hono /api/jira/callback(웹 세션)으로 넘긴다 → Atlassian 콘솔에 URL 추가 불필요.
import type {
	AuthRequest,
	OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import type { McpProps } from "./server.ts";

const AUTHORIZE_URL = "https://auth.atlassian.com/authorize";
const TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const ME_URL = "https://api.atlassian.com/me";
// 신원만 — 일지 D1 읽기에 Jira API 불필요.
const SCOPES = "read:me";
const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_PREFIX = "mcp_oauth_state:";
const SHARED_CALLBACK = "/api/jira/callback";

type EnvWithOAuth = Env & { OAUTH_PROVIDER: OAuthHelpers };

type PendingState = {
	oauthReqInfo: AuthRequest;
	redirectUri: string;
	createdAt: number;
};

function clientCreds(env: Env): { clientId: string; clientSecret: string } {
	return {
		clientId: (env.JIRA_CLIENT_ID || "").trim(),
		clientSecret: (env.JIRA_CLIENT_SECRET || "").trim(),
	};
}

/** 웹 Jira 콜백과 동일 URL. MCP 전용 /callback 불필요. */
function mcpCallbackUri(request: Request, env: Env): string {
	const fixed = (
		env.MCP_ATLASSIAN_REDIRECT_URI ||
		env.JIRA_REDIRECT_URI ||
		""
	).trim();
	if (fixed) return fixed;
	return new URL(SHARED_CALLBACK, request.url).href;
}

function randomState(): string {
	const buf = new Uint8Array(16);
	crypto.getRandomValues(buf);
	return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * workers-oauth-provider auth code = `${userId}:${grantId}:${secret}`.
 * Atlassian account_id 는 종종 `712020:…` 처럼 `:` 를 포함 → split 이 깨져
 * `/token` 이 "Invalid authorization code format" 을 낸다. grant 키용으로만 이스케이프.
 */
function oauthUserId(accountId: string): string {
	return accountId.replaceAll(":", "_");
}

async function putState(
	kv: KVNamespace,
	state: string,
	payload: PendingState,
): Promise<void> {
	await kv.put(STATE_PREFIX + state, JSON.stringify(payload), {
		expirationTtl: Math.ceil(STATE_TTL_MS / 1000),
	});
}

async function peekState(
	kv: KVNamespace,
	state: string,
): Promise<boolean> {
	return (await kv.get(STATE_PREFIX + state)) != null;
}

async function takeState(
	kv: KVNamespace,
	state: string,
): Promise<PendingState | null> {
	const key = STATE_PREFIX + state;
	const raw = await kv.get(key);
	await kv.delete(key);
	if (!raw) return null;
	try {
		const p = JSON.parse(raw) as PendingState;
		if (!p?.oauthReqInfo?.clientId || !p.redirectUri) return null;
		if (Date.now() - p.createdAt > STATE_TTL_MS) return null;
		return p;
	} catch {
		return null;
	}
}

async function exchangeCode(
	clientId: string,
	clientSecret: string,
	code: string,
	redirectUri: string,
): Promise<string> {
	const r = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			grant_type: "authorization_code",
			client_id: clientId,
			client_secret: clientSecret,
			code,
			redirect_uri: redirectUri,
		}),
	});
	if (!r.ok) {
		throw new Error(`토큰 교환 실패 (${r.status}): ${await r.text()}`);
	}
	const j = (await r.json()) as { access_token?: string };
	if (!j.access_token) throw new Error("access_token 없음");
	return j.access_token;
}

async function resolveMe(
	accessToken: string,
): Promise<{ accountId: string; name: string }> {
	const r = await fetch(ME_URL, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/json",
		},
	});
	if (!r.ok) throw new Error(`/me 실패 (${r.status})`);
	const j = (await r.json()) as { account_id?: string; name?: string };
	return {
		accountId: (j.account_id || "").trim(),
		name: (j.name || "").trim(),
	};
}

function atlassianAuthorizeUrl(opts: {
	clientId: string;
	redirectUri: string;
	state: string;
}): string {
	const q = new URLSearchParams({
		audience: "api.atlassian.com",
		client_id: opts.clientId,
		scope: SCOPES,
		redirect_uri: opts.redirectUri,
		state: opts.state,
		response_type: "code",
		prompt: "consent",
	});
	return `${AUTHORIZE_URL}?${q}`;
}

async function finishMcpCallback(
	env: EnvWithOAuth,
	code: string,
	state: string,
): Promise<Response> {
	const pending = await takeState(env.OAUTH_KV, state);
	if (!pending) {
		return new Response("state 가 만료되었거나 유효하지 않습니다.", {
			status: 400,
		});
	}
	const { clientId, clientSecret } = clientCreds(env);
	if (!clientId || !clientSecret) {
		return new Response("OAuth 클라이언트 미설정", { status: 500 });
	}
	try {
		const accessToken = await exchangeCode(
			clientId,
			clientSecret,
			code,
			pending.redirectUri,
		);
		const me = await resolveMe(accessToken);
		if (!me.accountId) {
			return new Response("account_id 를 받지 못했습니다(read:me).", {
				status: 500,
			});
		}
		const props: McpProps = {
			accountId: me.accountId,
			name: me.name,
		};
		const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
			request: pending.oauthReqInfo,
			userId: oauthUserId(me.accountId),
			metadata: { label: me.name || me.accountId },
			scope: pending.oauthReqInfo.scope,
			props,
		});
		return Response.redirect(redirectTo, 302);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return new Response(`인증 실패: ${msg}`, { status: 500 });
	}
}

/**
 * OAuthProvider defaultHandler 용.
 * /authorize 항상 처리.
 * 콜백은 MCP state 가 있을 때만 가로채고, 없으면 null → 웹 Jira 콜백으로.
 */
export async function tryHandleMcpAuth(
	request: Request,
	env: EnvWithOAuth,
): Promise<Response | null> {
	const url = new URL(request.url);
	const path = url.pathname;

	if (path === "/authorize") {
		const app = new Hono<{ Bindings: EnvWithOAuth }>();
		app.get("/authorize", async (c) => {
			const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(
				c.req.raw,
			);
			if (!oauthReqInfo.clientId) {
				return c.text("Invalid OAuth request: missing client_id", 400);
			}
			const { clientId, clientSecret } = clientCreds(c.env);
			if (!clientId || !clientSecret) {
				return c.text(
					"JIRA_CLIENT_ID / JIRA_CLIENT_SECRET 이 서버에 없습니다.",
					500,
				);
			}
			const redirectUri = mcpCallbackUri(c.req.raw, c.env);
			const state = randomState();
			await putState(c.env.OAUTH_KV, state, {
				oauthReqInfo,
				redirectUri,
				createdAt: Date.now(),
			});
			return c.redirect(
				atlassianAuthorizeUrl({ clientId, redirectUri, state }),
				302,
			);
		});
		return app.fetch(request, env);
	}

	// 공유 콜백(+ 예전 /callback 호환). MCP state 없으면 웹 플로우에 양보.
	if (path !== SHARED_CALLBACK && path !== "/callback") return null;
	if (request.method !== "GET") return null;

	const err = url.searchParams.get("error");
	if (err) {
		// 웹과 공유 경로면 Hono 가 HTML 로 보여주도록 양보(MCP 전용이 아닐 수 있음).
		if (path === SHARED_CALLBACK) return null;
		return new Response(`Atlassian 인가 거부: ${err}`, { status: 400 });
	}

	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	if (!code || !state) {
		if (path === SHARED_CALLBACK) return null;
		return new Response("code/state 가 없습니다.", { status: 400 });
	}

	if (!(await peekState(env.OAUTH_KV, state))) {
		// 웹 Jira oauth_states(D1) 일 수 있음 → Hono 로.
		if (path === SHARED_CALLBACK) return null;
		return new Response("state 가 만료되었거나 유효하지 않습니다.", {
			status: 400,
		});
	}

	return finishMcpCallback(env, code, state);
}
