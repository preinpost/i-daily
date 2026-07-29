// worker/index.ts — Cloudflare Workers 엔트리.
// OAuthProvider 가 /mcp(토큰 필요) · /token · /register · .well-known 을 담당.
// defaultHandler: MCP /authorize + (공유) /api/jira/callback 가로채기 + 기존 /api/* · SPA.
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { drizzle } from "drizzle-orm/d1";
import { buildApp } from "../server/app.ts";
import { d1Backend, resolveUser } from "../shared/store-drizzle.ts";
import { mcpApiHandler } from "../mcp/server.ts";
import { tryHandleMcpAuth } from "../mcp/atlassian-handler.ts";

type EnvWithOAuth = Env & { OAUTH_PROVIDER: OAuthHelpers };

/** 기존 웹앱: /api/* → Hono, 그 외 → Assets(SPA). */
async function handleWebApp(
	request: Request,
	env: Env,
): Promise<Response> {
	let pathname: string;
	try {
		pathname = new URL(request.url).pathname;
	} catch {
		return new Response("Bad Request", { status: 400 });
	}
	if (pathname.startsWith("/api/")) {
		const db = drizzle(env.DB);
		const user = await resolveUser(db, request);
		const app = buildApp(d1Backend(db, user), db, env);
		return app.fetch(request);
	}
	return env.ASSETS.fetch(request);
}

const defaultHandler = {
	async fetch(
		request: Request,
		env: EnvWithOAuth,
		_ctx: ExecutionContext,
	): Promise<Response> {
		const auth = await tryHandleMcpAuth(request, env);
		if (auth) return auth;
		return handleWebApp(request, env);
	},
};

export default new OAuthProvider({
	apiRoute: "/mcp",
	apiHandler: mcpApiHandler,
	defaultHandler,
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register",
	// PoC: 읽기 스코프만 광고(클라이언트 힌트). 강제 검증은 툴이 읽기만 등록.
	scopesSupported: ["read"],
	accessTokenTTL: 3600,
	refreshTokenTTL: 30 * 24 * 60 * 60,
});
