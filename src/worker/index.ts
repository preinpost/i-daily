// worker/index.ts — Cloudflare Workers 엔트리 (방향 B, 1단계 PoC).
// env.DB(D1) → Drizzle → d1Backend → routeWith. /api/* 만 처리.
// 정적 React(SPA) 는 wrangler assets 가 자동 서빙(not_found_handling: SPA).
// 인증 없음 → 임시 단일 유저("local"). 3단계에서 Atlassian OAuth account_id 로 교체.
import { drizzle } from "drizzle-orm/d1";
import { buildApp } from "../server/app.ts";
import { d1Backend } from "../shared/store-drizzle.ts";

// Env(DB·ASSETS) 는 wrangler types 가 생성한 worker-configuration.d.ts 의 전역 인터페이스.

// PoC 단일 유저. 3단계에서 세션 기반 account_id 로 대체.
const POC_USER = "local";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		// /api/* 만 Hono 앱으로. 그 외(정적 자원/SPA)는 assets 바인딩에 위임.
		// request.url 은 Workers 에서 항상 유효하지만, 파싱은 안전하게 감싼다.
		let pathname: string;
		try {
			pathname = new URL(request.url).pathname;
		} catch {
			return new Response("Bad Request", { status: 400 });
		}
		if (pathname.startsWith("/api/")) {
			const db = drizzle(env.DB);
			const app = buildApp(() => ({ backend: d1Backend(db, POC_USER), db }));
			return app.fetch(request);
		}
		return env.ASSETS.fetch(request);
	},
};
