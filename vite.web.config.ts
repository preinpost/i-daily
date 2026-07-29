// vite.web.config.ts — 웹(Workers) 빌드. 산출: dist/web/ (SPA). wrangler assets 가 서빙.
// React + Tailwind 플러그인.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8"));

export default defineConfig({
	plugins: [react(), tailwindcss()],
	define: {
		__APP_VERSION__: JSON.stringify(pkg.version),
	},
	// root 를 renderer 로 → http://localhost:5173/ 에서 index.html 서빙.
	// styles.css 의 @source "./src" 로 컴포넌트를 스캔.
	root: resolve(__dirname, "src/renderer"),
	build: {
		outDir: resolve(__dirname, "dist/web"),
		emptyOutDir: true,
	},
	resolve: {
		alias: { "@": resolve(__dirname, "src") },
	},
	server: {
		fs: { allow: [resolve(__dirname, "src")] },
		proxy: {
			"/api": { target: "http://127.0.0.1:8787", changeOrigin: true },
			"/mcp": { target: "http://127.0.0.1:8787", changeOrigin: true },
			// OAuth 엔드포인트 폴백 — 클라이언트가 issuer 대신 루트 경로로 칠 때
			// SPA(index.html)가 삼키지 않도록 반드시 워커로 넘긴다.
			"/register": { target: "http://127.0.0.1:8787", changeOrigin: true },
			"/authorize": { target: "http://127.0.0.1:8787", changeOrigin: true },
			"/token": { target: "http://127.0.0.1:8787", changeOrigin: true },
			"/userinfo": { target: "http://127.0.0.1:8787", changeOrigin: true },
			"/revoke": { target: "http://127.0.0.1:8787", changeOrigin: true },
			"/introspect": { target: "http://127.0.0.1:8787", changeOrigin: true },
			"/sign-in": { target: "http://127.0.0.1:8787", changeOrigin: true },
			"/consent": { target: "http://127.0.0.1:8787", changeOrigin: true },
			"/.well-known": { target: "http://127.0.0.1:8787", changeOrigin: true },
		},
	},
});
