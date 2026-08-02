// worker/index.ts — Cloudflare Workers 엔트리.
// Better Auth(/api/auth · .well-known) + MCP(/mcp) + 기존 Hono /api/* · SPA.
import { drizzle } from "drizzle-orm/d1";
import {
	oauthProviderAuthServerMetadata,
	oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { buildApp } from "../server/app.ts";
import { d1Backend } from "../shared/store-drizzle.ts";
import {
	createAuth,
	resolveDomainUser,
	resolveMcpProps,
	publicBaseURL,
	authIssuerURL,
	mcpResourceURL,
	rewriteToPublicURL,
} from "../auth/index.ts";
import { signInPage, consentPage } from "../auth/pages.ts";
import { handleMcpRequest } from "../mcp/server.ts";

const CORS_HEADERS: HeadersInit = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers":
		"Authorization, Content-Type, MCP-Protocol-Version",
	"Access-Control-Expose-Headers": "WWW-Authenticate",
};

const MCP_SCOPES = "openid profile email offline_access";

/**
 * issuer 기준 경로로 들어오는 OAuth 요청을 Better Auth 실제 경로로 연결한다.
 * 이 매핑이 없으면 루트 경로가 정적 자산(SPA) 으로 떨어진다.
 */
const OAUTH_PATH_ALIASES: Record<string, string> = Object.fromEntries(
	[
		["authorize", "oauth2/authorize"],
		["token", "oauth2/token"],
		["userinfo", "oauth2/userinfo"],
		["revoke", "oauth2/revoke"],
		["introspect", "oauth2/introspect"],
		["register", "oauth2/register"],
	].flatMap(([name, target]) => [
		[`/${name}`, `/api/auth/${target}`],
		[`/api/auth/${name}`, `/api/auth/${target}`],
	]),
);

function withCors(res: Response): Response {
	const headers = new Headers(res.headers);
	for (const [k, v] of Object.entries(CORS_HEADERS)) {
		if (!headers.has(k)) headers.set(k, v);
	}
	return new Response(res.body, {
		status: res.status,
		statusText: res.statusText,
		headers,
	});
}

function json(data: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set("content-type", "application/json");
	headers.set(
		"Cache-Control",
		"public, max-age=15, stale-while-revalidate=15, stale-if-error=86400",
	);
	return withCors(new Response(JSON.stringify(data), { ...init, headers }));
}

/** RFC 9728 — MCP Inspector discovery. */
function protectedResourceMetadata(env: Env): Response {
	const resource = mcpResourceURL(env);
	const issuer = authIssuerURL(env);
	return json({
		resource,
		authorization_servers: [issuer],
		bearer_methods_supported: ["header"],
		scopes_supported: MCP_SCOPES.split(" "),
		resource_name: "i-daily MCP",
	});
}

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		let pathname: string;
		try {
			pathname = new URL(request.url).pathname;
		} catch {
			return new Response("Bad Request", { status: 400 });
		}

		if (request.method === "OPTIONS") {
			return withCors(new Response(null, { status: 204 }));
		}

		const auth = createAuth(env);
		const pub = rewriteToPublicURL(request, env);
		const base = publicBaseURL(env);

		// MCP OAuth UI
		if (pathname === "/sign-in") {
			return signInPage(base);
		}
		if (pathname === "/consent") {
			return consentPage();
		}

		// AS metadata — issuer 는 http://…/api/auth.
		// 루트 /.well-known/oauth-authorization-server 는 서빙하지 않음
		// (RFC 8414: 루트 discovery 의 expected issuer 는 origin → /api/auth 와 mismatch).
		if (
			pathname === "/.well-known/oauth-authorization-server/api/auth" ||
			pathname === "/api/auth/.well-known/oauth-authorization-server"
		) {
			return withCors(await oauthProviderAuthServerMetadata(auth)(pub));
		}

		// OIDC discovery (MCP 클라이언트가 path-insert 로도 조회함)
		if (
			pathname === "/.well-known/openid-configuration/api/auth" ||
			pathname === "/api/auth/.well-known/openid-configuration"
		) {
			return withCors(await oauthProviderOpenIdConfigMetadata(auth)(pub));
		}

		// 잘못된 루트 AS discovery → 명시적 404 (issuer mismatch 방지)
		if (
			pathname === "/.well-known/oauth-authorization-server" ||
			pathname === "/.well-known/openid-configuration"
		) {
			return withCors(
				new Response(JSON.stringify({ error: "not_found" }), {
					status: 404,
					headers: { "content-type": "application/json" },
				}),
			);
		}

		// Protected resource metadata (MCP)
		if (
			pathname === "/.well-known/oauth-protected-resource" ||
			pathname === "/.well-known/oauth-protected-resource/mcp"
		) {
			return protectedResourceMetadata(env);
		}

		// OAuth 엔드포인트 폴백 — 일부 MCP 클라이언트(예: MCP Inspector)는
		// AS metadata 의 *_endpoint 를 안 보고 issuer 에 경로를 붙여버린다.
		//   new URL('/authorize', 'http://host/api/auth') → http://host/authorize
		// 이걸 놓치면 SPA fallback 이 삼켜 앱 화면이 뜨고 인가가 증발한다.
		const aliased = OAUTH_PATH_ALIASES[pathname];
		if (aliased) {
			const u = new URL(pub.url);
			u.pathname = aliased;
			return withCors(await auth.handler(new Request(u.toString(), pub)));
		}

		// Better Auth API (+ 기타 .well-known 이 있으면 handler)
		if (pathname.startsWith("/api/auth") || pathname.startsWith("/.well-known/")) {
			return withCors(await auth.handler(pub));
		}

		// MCP (Bearer)
		if (pathname === "/mcp" || pathname.startsWith("/mcp/")) {
			const props = await resolveMcpProps(env, auth, pub);
			if (!props) {
				// MCP 2025-11-25: Bearer + resource_metadata + scope
				const meta = `${base}/.well-known/oauth-protected-resource/mcp`;
				return withCors(
					new Response(
						JSON.stringify({
							error: "unauthorized",
							error_description: "Bearer token required",
						}),
						{
							status: 401,
							headers: {
								"content-type": "application/json",
								"WWW-Authenticate": `Bearer resource_metadata="${meta}", scope="${MCP_SCOPES}"`,
							},
						},
					),
				);
			}
			return withCors(await handleMcpRequest(pub, env, ctx, props));
		}

		if (pathname.startsWith("/api/")) {
			const db = drizzle(env.DB);
			const user = await resolveDomainUser(env, auth, pub);
			const app = buildApp(d1Backend(db, user), db, { env, auth });
			return app.fetch(pub);
		}

		return env.ASSETS.fetch(request);
	},
};
