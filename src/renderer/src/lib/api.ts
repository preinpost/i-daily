// 전송 래퍼 — 기존 client.js 의 api(method,path,body) 를 그대로 옮김.
// window.api.request(IPC) → { ok, status, json } 로 정규화.

export type ApiRes<T = any> = { ok: boolean; status: number; json: T | null };

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<ApiRes<T>> {
  const res = await window.api.request(method, path, body);
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    json: res.body == null ? null : (res.body as T),
  };
}
