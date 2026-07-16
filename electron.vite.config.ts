import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";

// 진입점은 electron-vite 관례로 자동 탐지: src/main/index.ts · src/preload/index.ts · src/renderer/index.html.
// externalizeDepsPlugin: better-sqlite3(네이티브)를 번들하지 않고 require로 외부화.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    // src/renderer/index.html 이 진입. React(TSX) + Tailwind 로 번들됨.
    plugins: [react(), tailwindcss()],
  },
});
