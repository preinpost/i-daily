// env.d.ts — 생성 파일(worker-configuration.d.ts)에 없는 secret 을 인터페이스 병합으로 보강.
// wrangler types 는 로컬 .dev.vars 가 있을 때만 string secret 을 Env 에 넣는다.
// CI(Release) 는 .dev.vars 없이 types 를 재생성하므로, 여기서 전역 Env 에 선언 병합한다.
interface Env {
	// Atlassian OAuth 2.0 (3LO) — Better Auth socialProviders.atlassian 공용.
	JIRA_CLIENT_ID: string;
	JIRA_CLIENT_SECRET: string;
	/** (레거시) 예전 /api/jira/callback 고정값. BA 콜백은 /api/auth/callback/atlassian. */
	JIRA_REDIRECT_URI?: string;

	/** Better Auth 공개 base URL (예: https://i-daily….workers.dev). 비우면 localhost 기본. */
	BETTER_AUTH_URL?: string;
	/** Better Auth 서명 시크릿(≥32자). */
	BETTER_AUTH_SECRET: string;
}
