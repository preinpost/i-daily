import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ToastProvider } from "./components/Toast";
import { ContextMenuProvider } from "./components/ContextMenu";
import "../styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <ContextMenuProvider>
        <App />
      </ContextMenuProvider>
    </ToastProvider>
  </StrictMode>,
);
