// Login.tsx — 미로그인(=/api/me isSetup) 상태에서 앱 대신 보여주는 전체화면 인증 게이트.
// Jira(Atlassian) OAuth 로그인 버튼만 제공. 로그인 성공 시 팝업이 postMessage 로
// 메인창에 알리고(App 의 리스너), 메인창이 location.reload → isSetup=false → 앱 표시.
import { useEffect, useState } from "react";
import { useToast } from "./Toast";

export function Login() {
	const toast = useToast();
	const [busy, setBusy] = useState(false);
	// 서버 전역 OAuth 클라이언트(client id/secret) 설정 여부 — 미설정이면 로그인 불가 안내.
	const [configured, setConfigured] = useState<boolean | null>(null);

	useEffect(() => {
		const j = window.api?.jira;
		if (!j) return;
		j.status()
			.then((s: { configured?: boolean } | null) =>
				setConfigured(!!s?.configured),
			)
			.catch(() => setConfigured(false));
	}, []);

	async function login() {
		const j = window.api?.jira;
		if (!j) return;
		setBusy(true);
		try {
			const r = await j.connect();
			// connect 는 인가 URL 을 새 팝업으로 연다. 성공 콜백은 postMessage 로 App 이 처리.
			if (r && r.replaced) return; // 재시도로 대체됨
			if (!(r && (r.ok || r.authorizeUrl))) {
				toast("로그인 시작 실패: " + ((r && r.error) || "알 수 없음"));
			}
		} catch {
			toast("로그인 실패 — 잠시 후 다시 시도하세요");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="fixed inset-0 z-[200] flex items-center justify-center bg-bg px-5">
			<div className="flex w-full max-w-[380px] flex-col items-center gap-5 text-center">
				<div className="text-4xl">📋</div>
				<h1 className="m-0 text-2xl font-extrabold text-ink">i-daily</h1>
				<p className="m-0 text-[14px] leading-relaxed text-ink-2">
					업무일지를 쓰려면 먼저 Jira(Atlassian) 계정으로 로그인하세요.
					로그인하면 이름·사이트 주소가 자동으로 설정됩니다.
				</p>

				<button
					type="button"
					className="btn btn-primary w-full justify-center py-2.5 text-[15px]"
					onClick={login}
					disabled={busy || configured === false}
				>
					{busy ? "로그인 창 여는 중…" : "🔗 Jira 로 로그인"}
				</button>

				{configured === false && (
					<p className="tint-accent m-0 rounded-[10px] px-3.5 py-2.5 text-xs text-ink">
						서버에 Jira OAuth 클라이언트가 설정되지 않았습니다. 배포자가{" "}
						<code className="rounded-[5px] bg-panel px-[5px] py-px font-mono">
							JIRA_CLIENT_ID
						</code>
						/{" "}
						<code className="rounded-[5px] bg-panel px-[5px] py-px font-mono">
							JIRA_CLIENT_SECRET
						</code>{" "}
						를 등록해야 로그인할 수 있어요.
					</p>
				)}

				<p className="m-0 text-xs text-ink-2">
					로그인 창(팝업)이 뜨지 않으면 브라우저의 팝업 차단을 확인하세요.
				</p>
			</div>
		</div>
	);
}
