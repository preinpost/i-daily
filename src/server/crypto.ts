// server/crypto.ts — BYOK API 키 양방향 암호화 (AES-256-GCM, Web Crypto).
//
// API 키는 provider 에 원문 그대로 다시 보내야 하므로 단방향 해시(argon2/bcrypt)가 아니라
// "복호화 가능한 대칭 암호화" 여야 한다. Cloudflare Workers 는 crypto.subtle 이 내장이라
// 외부 라이브러리 없이 동작한다.
//
// 저장 포맷: base64( iv(12B) ‖ ciphertext(+GCM tag) ). IV(nonce)는 매 암호화마다 랜덤.
// 마스터키: env.AI_ENC_KEY = 32바이트(base64). `wrangler secret put AI_ENC_KEY` 로 등록,
//           로컬은 .dev.vars. DB(ai_auth)엔 암호문만 저장 → DB 유출만으론 복호화 불가.

const IV_LEN = 12; // AES-GCM 권장 nonce 길이

function b64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function bytesToB64(bytes: Uint8Array): string {
	let bin = "";
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
	return btoa(bin);
}

async function importKey(encKeyB64: string): Promise<CryptoKey> {
	const raw = b64ToBytes(encKeyB64);
	if (raw.length !== 32) {
		throw new Error(
			`AI_ENC_KEY 는 32바이트(base64) 여야 합니다 (현재 ${raw.length}바이트).`,
		);
	}
	return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, [
		"encrypt",
		"decrypt",
	]);
}

// 평문 → base64(iv‖ciphertext). 저장 직전 호출.
export async function encryptSecret(
	encKeyB64: string,
	plain: string,
): Promise<string> {
	const key = await importKey(encKeyB64);
	const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
	const ct = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv },
			key,
			new TextEncoder().encode(plain) as BufferSource,
		),
	);
	const out = new Uint8Array(iv.length + ct.length);
	out.set(iv, 0);
	out.set(ct, iv.length);
	return bytesToB64(out);
}

// base64(iv‖ciphertext) → 평문. provider 호출 직전에만 호출(메모리 한정 사용).
export async function decryptSecret(
	encKeyB64: string,
	blob: string,
): Promise<string> {
	const key = await importKey(encKeyB64);
	const buf = b64ToBytes(blob);
	if (buf.length <= IV_LEN) throw new Error("암호문이 손상되었습니다.");
	const iv = buf.slice(0, IV_LEN);
	const ct = buf.slice(IV_LEN);
	const pt = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv },
		key,
		ct as BufferSource,
	);
	return new TextDecoder().decode(pt);
}
