// auth/options.ts — Better Auth 공유 옵션(환경 비의존).
import type { BetterAuthOptions } from "better-auth";

/** Atlassian 3LO — 기존 i-daily Jira 스코프와 동일(+ BA 기본 read:jira-user·offline_access). */
export const ATLASSIAN_EXTRA_SCOPES = [
	"read:jira-work",
	"write:jira-work",
	"read:me",
] as const;

export const betterAuthOptions = {
	appName: "i-daily",
	basePath: "/api/auth",
	emailAndPassword: { enabled: false },
	account: {
		accountLinking: {
			enabled: true,
			trustedProviders: ["atlassian"],
		},
	},
} satisfies BetterAuthOptions;
