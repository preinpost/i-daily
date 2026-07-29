// env.d.ts — 생성 파일(worker-configuration.d.ts)에 없는 secret 을 인터페이스 병합으로 보강.
// wrangler types 는 로컬 .dev.vars 가 있을 때만 string secret 을 Env 에 넣는다.
// CI(Release) 는 .dev.vars 없이 types 를 재생성하므로, 여기서 전역 Env 에 선언 병합한다.
// (wrangler types 재생성해도 이 파일은 유지)
interface Env {
	// BYOK API 키 암호화용 마스터키 — 32바이트 base64.
	// 생성: `openssl rand -base64 32`
	// 등록: 로컬 .dev.vars / 원격 `wrangler secret put AI_ENC_KEY`
	AI_ENC_KEY: string;

	// Atlassian OAuth 2.0 (3LO) — 웹 Jira 로그인 + MCP 신원 bridge 공용.
	JIRA_CLIENT_ID: string;
	JIRA_CLIENT_SECRET: string;
	/** 웹·MCP 공유 Atlassian redirect (예: …/api/jira/callback). */
	JIRA_REDIRECT_URI: string;
	/** (선택) MCP 전용 redirect. 비우면 JIRA_REDIRECT_URI 사용. */
	MCP_ATLASSIAN_REDIRECT_URI?: string;

	// 카카오 로컬 API (점심 탭).
	KAKAO_REST_KEY: string;
}
