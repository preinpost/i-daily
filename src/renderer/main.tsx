// main.tsx — 웹(브라우저) 진입. fetch 기반 webApi 를 설치한다.
// 컴포넌트 코드(App 등)는 무수정 재사용 — 전부 window.api?.X 로 접근.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./src/App";
import { ToastProvider } from "./src/components/Toast";
import { ContextMenuProvider } from "./src/components/ContextMenu";
import { webApi } from "./src/web-api";
import "./styles.css";

// (이 파일은 웹에서만 로드됨.)
if (!(globalThis as unknown as { api?: unknown }).api) {
	(globalThis as unknown as { api: typeof webApi }).api = webApi;
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<ToastProvider>
			<ContextMenuProvider>
				<App />
			</ContextMenuProvider>
		</ToastProvider>
	</StrictMode>,
);
