// worker/index.ts — Cloudflare Workers 엔트리.
// env.DB(D1) → Drizzle → 세션 해석 → d1Backend(user) → buildApp. /api/* 만 처리.
// 정적 React(SPA) 는 wrangler assets 가 자동 서빙(not_found_handling: SPA).
// 인증: sid 쿠키 → sessions D1 → user(account_id). 없으면 SETUP("setup").
import { drizzle } from "drizzle-orm/d1";
import { buildApp } from "../server/app.ts";
import { d1Backend, resolveUser } from "../shared/store-drizzle.ts";

// Env(DB·ASSETS) 는 wrangler types 가 생성한 worker-configuration.d.ts 의 전역 인터페이스.

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		// /api/* 만 Hono 앱으로. 그 외(정적 자원/SPA)는 assets 바인딩에 위임.
		let pathname: string;
		try {
			pathname = new URL(request.url).pathname;
		} catch {
			return new Response("Bad Request", { status: 400 });
		}
		if (pathname.startsWith("/api/")) {
			const db = drizzle(env.DB);
			// 요청 쿠키에서 sid → sessions 조회 → user. 없으면 SETUP_USER.
			const user = await resolveUser(db, request);
			const app = buildApp(d1Backend(db, user), db, env);
			return app.fetch(request);
		}
		return env.ASSETS.fetch(request);
	},
};
