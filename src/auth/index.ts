// auth/index.ts — Workers용 Better Auth factory (D1 + Atlassian + MCP OAuth AS).
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import {
	betterAuthOptions,
	ATLASSIAN_EXTRA_SCOPES,
	MICROSOFT_EXTRA_SCOPES,
} from "./options.ts";
import * as authSchema from "./schema.ts";
import {
	writeJiraAuth,
	migrateConfig,
	readConfig,
	writeConfig,
} from "../shared/store-drizzle.ts";
import { SETUP_USER } from "../shared/backend.ts";

export type AppAuth = ReturnType<typeof createAuth>;

export type McpProps = {
	accountId: string;
	name: string;
};

function secret(env: Env): string {
	const s = (env.BETTER_AUTH_SECRET || "").trim();
	if (s.length >= 32) return s;
	return "dev-secret-at-least-32-characters-long!!";
}

export function publicBaseURL(env: Env): string {
	return (env.BETTER_AUTH_URL || "").trim().replace(/\/$/, "") || "http://localhost:5173";
}

/** Better Auth issuer (= baseURL + basePath). */
export function authIssuerURL(env: Env): string {
	return `${publicBaseURL(env)}/api/auth`;
}

/** MCP resource identifier (OAuth aud). */
export function mcpResourceURL(env: Env): string {
	return `${publicBaseURL(env)}/mcp`;
}

/** Vite 프록시(changeOrigin)로 Host 가 8787 이 되어도 BA baseURL 기준으로 요청 URL 재작성. */
export function rewriteToPublicURL(request: Request, env: Env): Request {
	const base = publicBaseURL(env);
	const u = new URL(request.url);
	const b = new URL(base);
	if (u.origin === b.origin) return request;
	u.protocol = b.protocol;
	u.host = b.host;
	return new Request(u.toString(), request);
}

/** 웹(Vite 5173) ↔ API(wrangler 8787) 로컬 분리 + baseURL. */
function trustedOrigins(env: Env): string[] {
	const base = publicBaseURL(env);
	return [
		...new Set([
			base,
			"http://localhost:5173",
			"http://127.0.0.1:5173",
			"http://localhost:8787",
			"http://127.0.0.1:8787",
		]),
	];
}

/** 요청마다 Env 바인딩으로 auth 인스턴스 생성. */
export function createAuth(env: Env) {
	const db = drizzle(env.DB);
	const base = publicBaseURL(env);
	return betterAuth({
		...betterAuthOptions,
		database: drizzleAdapter(db, {
			provider: "sqlite",
			schema: authSchema,
		}),
		baseURL: base,
		secret: secret(env),
		trustedOrigins: trustedOrigins(env),
		socialProviders: {
			atlassian: {
				clientId: (env.JIRA_CLIENT_ID || "").trim(),
				clientSecret: (env.JIRA_CLIENT_SECRET || "").trim(),
				scope: [...ATLASSIAN_EXTRA_SCOPES],
				mapProfileToUser: (profile) => ({
					email:
						profile.email ||
						`${profile.account_id.replaceAll(":", "_")}@users.atlassian.local`,
					name: profile.name || profile.account_id,
				}),
			},
			// 로그인 대체 아님 — 설정 탭에서 link-social 로 Graph 토큰만 연결.
			microsoft: {
				clientId: (env.MICROSOFT_CLIENT_ID || "").trim(),
				clientSecret: (env.MICROSOFT_CLIENT_SECRET || "").trim(),
				tenantId: (env.MICROSOFT_TENANT_ID || "organizations").trim() || "organizations",
				// User.Read 는 graph URI 로 명시(액세스 토큰 aud=Graph).
				// prompt:consent 는 매 연결마다 동의 화면을 강제 → 사용자 동의 금지
				// 테넌트에선 곧바로 「관리자 승인 필요」가 된다. 계정 선택만.
				disableDefaultScope: true,
				scope: [
					"openid",
					"profile",
					"email",
					"offline_access",
					"https://graph.microsoft.com/User.Read",
					...MICROSOFT_EXTRA_SCOPES,
				],
				prompt: "select_account",
				mapProfileToUser: (profile) => {
					const id = String(profile.oid || profile.sub || "unknown");
					const email =
						profile.email ||
						profile.preferred_username ||
						profile.upn ||
						`${id.replaceAll(":", "_")}@users.microsoft.local`;
					return {
						email,
						name: profile.name || profile.preferred_username || id,
					};
				},
			},
		},
		databaseHooks: {
			account: {
				create: {
					after: async (acc) => {
						if (acc.providerId === "atlassian") {
							await syncJiraAuthFromAccount(env, acc);
						}
					},
				},
				update: {
					after: async (acc) => {
						if (acc.providerId === "atlassian") {
							await syncJiraAuthFromAccount(env, acc);
						}
					},
				},
			},
		},
		plugins: [
			// issuer 를 BA basePath 포함 URL 로 고정 (MCP RFC 8414 issuer 검증).
			jwt({
				jwt: {
					issuer: authIssuerURL(env),
				},
			}),
			oauthProvider({
				loginPage: "/sign-in",
				consentPage: "/consent",
				allowDynamicClientRegistration: true,
				allowUnauthenticatedClientRegistration: true,
				validAudiences: [base, mcpResourceURL(env)],
				// well-known 은 SERVER_ONLY → Worker 에서 metadata helper 로 서빙.
				silenceWarnings: {
					oauthAuthServerConfig: true,
					openidConfig: true,
				},
			}),
		],
	});
}

type AccountLike = {
	providerId: string;
	accountId: string;
	userId?: string;
	accessToken?: string | null;
	refreshToken?: string | null;
	accessTokenExpiresAt?: Date | null;
	scope?: string | null;
};

async function resolveAtlassianSite(accessToken: string): Promise<{
	cloudId: string;
	siteUrl: string;
	siteName: string;
}> {
	const r = await fetch(
		"https://api.atlassian.com/oauth/token/accessible-resources",
		{
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: "application/json",
			},
		},
	);
	if (!r.ok) {
		return { cloudId: "", siteUrl: "", siteName: "" };
	}
	const list = (await r.json()) as Array<{
		id?: string;
		url?: string;
		name?: string;
	}>;
	const first = list?.[0];
	return {
		cloudId: (first?.id || "").trim(),
		siteUrl: (first?.url || "").trim(),
		siteName: (first?.name || "").trim(),
	};
}

/** Better Auth account 토큰 → 기존 jira_auth(account_id 키) + setup 이관 + settings 동기화. */
async function syncJiraAuthFromAccount(env: Env, acc: AccountLike) {
	const accountId = String(acc.accountId || "").trim();
	const accessToken = String(acc.accessToken || "").trim();
	if (!accountId || !accessToken) return;
	const db = drizzle(env.DB);
	await migrateConfig(db, SETUP_USER, accountId).catch(() => undefined);
	const site = await resolveAtlassianSite(accessToken);
	const expiresAt = acc.accessTokenExpiresAt
		? acc.accessTokenExpiresAt.getTime()
		: Date.now() + 55 * 60 * 1000;
	await writeJiraAuth(db, accountId, {
		accessToken,
		refreshToken: String(acc.refreshToken || ""),
		expiresAt,
		cloudId: site.cloudId,
		siteUrl: site.siteUrl,
		siteName: site.siteName,
	});

	// settings(config) 동기화: jiraBase(필수)는 site.siteUrl, owner는 user 테이블에서 보강.
	// 누락 시 isConfigured=false → 새로고침마다 "설정을 먼저 등록하세요" 토스트가 뜸.
	const cur = await readConfig(db, accountId);
	let owner = cur.owner;
	if (!owner.trim() && acc.userId) {
		const u = await db
			.select({ name: authSchema.user.name })
			.from(authSchema.user)
			.where(eq(authSchema.user.id, acc.userId))
			.get();
		owner = (u?.name || "").trim();
	}
	await writeConfig(db, accountId, {
		owner: owner || cur.owner,
		jiraBase: site.siteUrl || cur.jiraBase,
	});
}

/** 세션 → 도메인 user 키(Atlassian account_id). 기존 D1 데이터 호환. */
export async function resolveDomainUser(
	env: Env,
	auth: AppAuth,
	request: Request,
): Promise<string> {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user?.id) return SETUP_USER;
	const db = drizzle(env.DB);
	const row = await db
		.select({ accountId: authSchema.account.accountId })
		.from(authSchema.account)
		.where(
			and(
				eq(authSchema.account.userId, session.user.id),
				eq(authSchema.account.providerId, "atlassian"),
			),
		)
		.get();
	return row?.accountId?.trim() || SETUP_USER;
}

/**
 * MCP Bearer 토큰 → accountId/name.
 *
 * introspect 대신 userinfo 를 쓴다.
 * introspect 는 client_secret_basic/post 로 클라이언트 인증을 요구하는데(RFC 7662),
 * MCP Inspector 등은 DCR public client(secret 없음)라 절대 통과할 수 없다.
 * userinfo 는 Bearer 토큰만으로 access token 을 검증한다.
 */
export async function resolveMcpProps(
	env: Env,
	auth: AppAuth,
	request: Request,
): Promise<{ accountId: string; name: string } | null> {
	const hdr = request.headers.get("authorization") || "";
	const m = hdr.match(/^Bearer\s+(\S+)/i);
	if (!m) return null;
	const token = m[1];
	try {
		const result = await auth.api.oauth2UserInfo({
			headers: new Headers({ authorization: `Bearer ${token}` }),
		});
		if (!result) return null;
		const sub = String(
			(result as { sub?: string; userId?: string }).sub ||
				(result as { userId?: string }).userId ||
				"",
		).trim();
		if (!sub) return null;
		const db = drizzle(env.DB);
		const row = await db
			.select({
				accountId: authSchema.account.accountId,
				userId: authSchema.account.userId,
			})
			.from(authSchema.account)
			.where(
				and(
					eq(authSchema.account.userId, sub),
					eq(authSchema.account.providerId, "atlassian"),
				),
			)
			.get();
		if (!row?.accountId) {
			// sub 가 이미 account_id 인 경우
			const byAccount = await db
				.select({
					accountId: authSchema.account.accountId,
					userId: authSchema.account.userId,
				})
				.from(authSchema.account)
				.where(
					and(
						eq(authSchema.account.accountId, sub),
						eq(authSchema.account.providerId, "atlassian"),
					),
				)
				.get();
			if (!byAccount?.accountId) return null;
			const u = await db
				.select({ name: authSchema.user.name })
				.from(authSchema.user)
				.where(eq(authSchema.user.id, byAccount.userId))
				.get();
			return { accountId: byAccount.accountId, name: u?.name || "" };
		}
		const u = await db
			.select({ name: authSchema.user.name })
			.from(authSchema.user)
			.where(eq(authSchema.user.id, row.userId))
			.get();
		return { accountId: row.accountId, name: u?.name || "" };
	} catch {
		return null;
	}
}
