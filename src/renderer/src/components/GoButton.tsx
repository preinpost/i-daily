import { useEditor } from "../context/EditorContext";
import { isTicket, ticketUrl } from "../lib/model";

// 티켓 키가 유효할 때만 보이는 ↗ 열기 버튼.
export function GoButton({ getKey }: { getKey: () => string }) {
  const { meta } = useEditor();
  const key = getKey();
  const ok = isTicket(key);
  return (
    <button
      type="button"
      className="btn btn-tiny btn-ghost btn-go"
      hidden={!ok}
      title={ok ? `Jira에서 ${(key || "").trim().toUpperCase()} 열기` : ""}
      onClick={() => {
        if (isTicket(getKey())) window.open(ticketUrl(meta, getKey()), "_blank", "noopener");
      }}
    >
      ↗
    </button>
  );
}
