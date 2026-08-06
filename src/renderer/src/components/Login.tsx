// Login.tsx — Better Auth Atlassian social 로그인 게이트.
import { useEffect, useState } from "react";
import { useToast } from "./Toast";

export function Login({ notice }: { notice?: string }) {
	const toast = useToast();
	const [busy, setBusy] = useState(false);
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
		setBusy(true);
		try {
			const r = await fetch("/api/auth/sign-in/social", {
				method: "POST",
				credentials: "include",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					provider: "atlassian",
					callbackURL: "/",
				}),
			});
			const j = (await r.json().catch(() => ({}))) as {
				url?: string;
				message?: string;
				error?: string;
			};
			if (j.url) {
				location.href = j.url;
				return;
			}
			toast("로그인 시작 실패: " + (j.message || j.error || r.status));
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
					{notice ?? "업무일지를 쓰려면 먼저 Jira(Atlassian) 계정으로 로그인하세요."}로그인하면 이름·사이트 주소가 자동으로 설정됩니다.
				</p>

				<button
					type="button"
					className="btn btn-primary w-full justify-center py-2.5 text-[15px]"
					onClick={login}
					disabled={busy || configured === false}
				>
					{busy ? "이동 중…" : "🔗 Jira 로 로그인"}
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
			</div>
		</div>
	);
}
