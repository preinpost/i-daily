// auth/pages.ts — MCP OAuth용 로그인/동의 HTML (SPA 밖, Workers 직서빙).

// 이 두 페이지는 callbackURL 등 흐름 제어값을 HTML 안에 굽어서 내려준다.
// 캐싱되면 서버를 고쳐도 브라우저가 옛 흐름을 계속 쓰므로 반드시 no-store.
const AUTH_PAGE_HEADERS: HeadersInit = {
	"content-type": "text/html; charset=utf-8",
	"Cache-Control": "no-store, no-cache, must-revalidate",
	Pragma: "no-cache",
};

export function signInPage(origin: string): Response {
	const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>i-daily 로그인</title>
<style>
  body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;line-height:1.5}
  button{font:inherit;padding:.6rem 1rem;cursor:pointer}
  .muted{color:#666;font-size:.9rem}
</style></head><body>
<h1>i-daily</h1>
<p>Atlassian 계정으로 로그인합니다. (웹·MCP 공통)</p>
<button id="btn" type="button">Atlassian으로 계속</button>
<p class="muted" id="status"></p>
<script type="module">
  const params = new URLSearchParams(location.search);
  // MCP authorize → /sign-in?…signed… 이면 oauth_query 로 넘겨야 로그인 후 인가가 이어짐.
  const oauth_query = location.search.replace(/^\\?/, "") || undefined;
  // client_id 가 있으면 MCP 인가 흐름(웹 로그인이 아니다).
  const isMcpFlow = params.has("client_id");
  // MCP 흐름은 로그인 후 authorize 로 재진입시킨다.
  // 그때는 세션 쿠키가 있으므로 authorize 가 바로 /consent 로 보낸다.
  // 앱 로그인은 기존대로 앱 루트로 돌아간다.
  const resumeURL =
    ${JSON.stringify(origin + "/api/auth/oauth2/authorize?")} + (oauth_query || "");
  const callbackURL =
    params.get("callbackURL") ||
    (isMcpFlow ? resumeURL : ${JSON.stringify(origin + "/")});
  document.getElementById("btn").onclick = async () => {
    const st = document.getElementById("status");
    st.textContent = "이동 중…";
    const body = { provider: "atlassian", callbackURL };
    if (oauth_query && isMcpFlow) body.oauth_query = oauth_query;
    const r = await fetch("/api/auth/sign-in/social", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (j.url) { location.href = j.url; return; }
    if (j.redirect_uri) { location.href = j.redirect_uri; return; }
    st.textContent = j.message || j.error || ("실패: " + r.status);
  };
</script>
</body></html>`;
	return new Response(html, { headers: AUTH_PAGE_HEADERS });
}

export function consentPage(): Response {
	const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>i-daily 권한 동의</title>
<style>
  body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;line-height:1.5}
  button{font:inherit;padding:.6rem 1rem;cursor:pointer;margin-right:.5rem}
  .muted{color:#666;font-size:.9rem}
</style></head><body>
<h1>앱 접근 허용</h1>
<p>MCP 클라이언트가 i-daily 읽기 권한을 요청합니다.</p>
<p class="muted">client: <code id="client"></code><br/>scope: <code id="scope"></code></p>
<button id="yes" type="button">허용</button>
<button id="no" type="button">거부</button>
<p class="muted" id="status"></p>
<script type="module">
  const q = new URLSearchParams(location.search);
  document.getElementById("client").textContent = q.get("client_id") || "(unknown)";
  document.getElementById("scope").textContent = q.get("scope") || "read";
  async function decide(accept) {
    const st = document.getElementById("status");
    st.textContent = "처리 중…";
    const r = await fetch("/api/auth/oauth2/consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        accept,
        scope: q.get("scope") || undefined,
        oauth_query: location.search.replace(/^\\?/, "") || undefined,
      }),
    });
    const j = await r.json().catch(() => ({}));
    const next = j.redirect_uri || j.url || j.redirect;
    if (next) { location.href = next; return; }
    if (r.redirected) return;
    st.textContent = j.message || j.error || ("응답 " + r.status);
  }
  document.getElementById("yes").onclick = () => decide(true);
  document.getElementById("no").onclick = () => decide(false);
</script>
</body></html>`;
	return new Response(html, { headers: AUTH_PAGE_HEADERS });
}
