import { useEditor } from "../context/EditorContext";
import { isTicket, ticketUrl } from "../lib/model";

// 티켓 키가 유효할 때만 보이는 ↗ 열기 버튼.
// hidden 대신 invisible 로 폭을 예약해 placeholder/입력 시 레이아웃이 흔들리지 않게 한다.
export function GoButton({ getKey }: { getKey: () => string }) {
	const { meta } = useEditor();
	const key = getKey();
	const ok = isTicket(key);
	if (!ok) return null;
	return (
		<button
			type="button"
			className="btn btn-tiny btn-ghost btn-go h-7 w-7 shrink-0 px-0 leading-none"
			title={`Jira에서 ${(key || "").trim().toUpperCase()} 열기`}
			onClick={() => {
				if (isTicket(getKey()))
					window.open(ticketUrl(meta, getKey()), "_blank", "noopener");
			}}
		>
			↗
		</button>
	);
}
