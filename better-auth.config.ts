/**
 * Better Auth CLI config — `npx @better-auth/cli@latest generate`
 * Workers 런타임용 auth 는 src/auth/index.ts.
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuthOptions, ATLASSIAN_EXTRA_SCOPES } from "./src/auth/options.ts";
import * as authSchema from "./src/auth/schema.ts";

// CLI 전용: 로컬 더미 DB. 스키마 생성만 목적.
const client = createClient({ url: "file:./.ba-cli.sqlite" });
const db = drizzle(client);

export const auth = betterAuth({
	...betterAuthOptions,
	database: drizzleAdapter(db, {
		provider: "sqlite",
		schema: authSchema,
	}),
	baseURL: process.env.BETTER_AUTH_URL || "http://localhost:5173",
	secret: process.env.BETTER_AUTH_SECRET || "dev-secret-at-least-32-characters!!",
	socialProviders: {
		atlassian: {
			clientId: process.env.JIRA_CLIENT_ID || "cli",
			clientSecret: process.env.JIRA_CLIENT_SECRET || "cli",
			scope: [...ATLASSIAN_EXTRA_SCOPES],
		},
	},
	plugins: [
		jwt(),
		oauthProvider({
			loginPage: "/sign-in",
			consentPage: "/consent",
			allowDynamicClientRegistration: true,
			allowUnauthenticatedClientRegistration: true,
		}),
	],
});
