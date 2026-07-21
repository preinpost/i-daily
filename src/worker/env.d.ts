// env.d.ts — 생성 파일(worker-configuration.d.ts)에 없는 secret 을 인터페이스 병합으로 보강.
// AI_ENC_KEY 는 wrangler secret(로컬은 .dev.vars)이라 `wrangler types` 출력에 안 들어올 수 있어
// 여기서 전역 Env 에 선언 병합한다. (wrangler types 재생성해도 이 파일은 유지)
interface Env {
	// BYOK API 키 암호화용 마스터키 — 32바이트 base64.
	// 생성: `openssl rand -base64 32`
	// 등록: 로컬 .dev.vars / 원격 `wrangler secret put AI_ENC_KEY`
	AI_ENC_KEY: string;
}
