// sw.js — 최소 서비스워커. PWA 설치 가능(installable) 조건 충족 + 앱 셸 오프라인 폴백.
// 주의: /api/* 는 절대 캐시하지 않는다(인증/데이터). 정적 자원만 캐시.
const CACHE = "i-daily-v1";
const SHELL = [
	"/",
	"/manifest.webmanifest",
	"/icons/icon-192.png",
	"/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(SHELL))
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(
					keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
				),
			)
			.then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", (event) => {
	const req = event.request;
	if (req.method !== "GET") return;

	let url;
	try {
		url = new URL(req.url);
	} catch {
		return;
	}
	// 동일 출처가 아니거나 API 요청은 네트워크 그대로.
	if (url.origin !== self.location.origin || url.pathname.startsWith("/api/"))
		return;

	// 페이지 내비게이션: 네트워크 우선, 실패 시 캐시된 셸(/) 폴백.
	if (req.mode === "navigate") {
		event.respondWith(
			fetch(req).catch(() =>
				caches.match("/").then((r) => r || Response.error()),
			),
		);
		return;
	}

	// 정적 자원: 캐시 우선, 없으면 네트워크(성공 시 캐시에 저장).
	event.respondWith(
		caches.match(req).then(
			(cached) =>
				cached ||
				fetch(req).then((res) => {
					if (res.ok && res.type === "basic") {
						const clone = res.clone();
						caches.open(CACHE).then((cache) => cache.put(req, clone));
					}
					return res;
				}),
		),
	);
});
