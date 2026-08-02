// auth/options.ts — Better Auth 공유 옵션(환경 비의존).
import type { BetterAuthOptions } from "better-auth";

/** Atlassian 3LO — 기존 i-daily Jira 스코프와 동일(+ BA 기본 read:jira-user·offline_access). */
export const ATLASSIAN_EXTRA_SCOPES = [
	"read:jira-work",
	"write:jira-work",
	"read:me",
] as const;

/**
 * Microsoft Graph — BA/명시 스코프 위에 추가.
 * 회사 테넌트가 사용자 동의를 막아 두면, 여기 넣는 권한마다 관리자 동의가 필요하다.
 * Chat/Files 등은 관리자 동의 받은 뒤에만 추가할 것.
 * 스코프 변경 후 설정에서 Microsoft **다시 연결** 필요.
 */
export const MICROSOFT_EXTRA_SCOPES = [
	// Chat.Read / Chat.ReadWrite 는 이 테넌트에서 관리자 승인 필요 → 제외.
	"https://graph.microsoft.com/Chat.ReadBasic",
	"https://graph.microsoft.com/TeamsAppInstallation.ReadForChat",
	// OneDrive 파일 읽기 (엑셀 workbook API 포함). Files.Read.All 은 관리자 승인 → 제외.
	"https://graph.microsoft.com/Files.Read",
] as const;

export const betterAuthOptions = {
	appName: "i-daily",
	basePath: "/api/auth",
	emailAndPassword: { enabled: false },
	account: {
		accountLinking: {
			enabled: true,
			// BA link 조건: trusted 이거나 provider emailVerified.
			// Entra ID 토큰은 email_verified 가 자주 비어 untrusted 면
			// "Unable to link account - untrusted provider" 로 콜백이 실패한다.
			// Microsoft 는 UI 상 link-social 전용(로그인 버튼 없음).
			// Atlassian 가짜 로컬 이메일 ↔ 회사 MS 메일 불일치 허용.
			trustedProviders: ["atlassian", "microsoft"],
			allowDifferentEmails: true,
		},
	},
} satisfies BetterAuthOptions;
