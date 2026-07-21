// vite.web.config.ts — 웹(Workers) 빌드. 산출: dist/web/ (SPA). wrangler assets 가 서빙.
// React + Tailwind 플러그인.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	// root 를 renderer-web 으로 → http://localhost:5173/ 에서 index.html 서빙.
	// Tailwind 가 root 밖(renderer/src 컴포넌트) 도 스캔하도록 styles.css 의 @source 로 보충.
	root: resolve(__dirname, "src/renderer-web"),
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
		},
	},
});
