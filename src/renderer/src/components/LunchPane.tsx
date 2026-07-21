// LunchPane — 점심 탭. 카카오 로컬 API로 사무실 주변 음식점을 거리순으로 보여준다.
// 평점은 카카오맵 상세 페이지(place_url)에 있으므로, 각 식당의 "카카오맵에서 보기"
// 링크로 연결해 별점·리뷰·사진을 확인한다.
import { useEffect, useRef, useState } from "react";
import type { Config } from "../types";

type Place = {
	name: string;
	category: string;
	phone: string;
	address: string;
	roadAddress: string;
	placeUrl: string;
	distance: string;
};

// 음식 종류 칩 → 카카오 키워드 검색어. "전체"는 음식점(FD6) 전체.
const CHIPS: { label: string; query: string }[] = [
	{ label: "전체", query: "음식점" },
	{ label: "한식", query: "한식" },
	{ label: "중식", query: "중식" },
	{ label: "일식", query: "일식" },
	{ label: "양식", query: "양식" },
	{ label: "치킨", query: "치킨" },
	{ label: "분식", query: "분식" },
	{ label: "구이", query: "고기 구이" },
	{ label: "해산물", query: "해산물" },
	{ label: "카페", query: "카페" },
];

export function LunchPane({
	active,
	config,
}: {
	active: boolean;
	config: Config;
}) {
	const [query, setQuery] = useState("음식점");
	const [state, setState] = useState<{
		loading: boolean;
		error?: string;
		needKey?: boolean;
		places: Place[];
	}>({ loading: false, places: [] });
	const [picks, setPicks] = useState<Place[]>([]);
	const [picking, setPicking] = useState(false);
	const didAuto = useRef(false);

	// 여러 음식 카테고리(카페·디저트 제외)를 각각 검색해 모은 뒤 중복 제거,
	// 그 풀에서 무작위 3곳을 뽑는다. 거리순 단일 검색보다 종류가 고르게 섞인다.
	const RANDOM_CATEGORIES = [
		"한식",
		"중식",
		"일식",
		"양식",
		"치킨",
		"분식",
		"고기 구이",
		"해산물",
	];

	async function pickRandom() {
		const lunch = window.api?.lunch;
		if (!lunch || picking) return;
		setPicking(true);
		try {
			const results = await Promise.all(
				RANDOM_CATEGORIES.map((q) =>
					lunch
						.search({
							query: q,
							lat: config.lunchLat,
							lng: config.lunchLng,
							radius: config.lunchRadius || "1000",
							size: 45,
						})
						.catch(() => null),
				),
			);
			// 카테고리별 결과 합치기 + placeUrl(없으면 이름)으로 중복 제거
			const seen = new Set<string>();
			const pool: Place[] = [];
			for (const r of results) {
				if (!r || !(r as any).ok) continue;
				for (const p of ((r as any).places || []) as Place[]) {
					const id = p.placeUrl || p.name;
					if (seen.has(id)) continue;
					seen.add(id);
					pool.push(p);
				}
			}
			if (!pool.length) {
				// 가져온 게 없으면 현재 목록으로 폴백
				pool.push(...state.places);
			}
			if (!pool.length) return;
			for (let i = pool.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[pool[i], pool[j]] = [pool[j], pool[i]];
			}
			setPicks(pool.slice(0, Math.min(3, pool.length)));
		} finally {
			setPicking(false);
		}
	}

	const hasKey = !!config.kakaoRestKey.trim();
	const hasCoords = !!config.lunchLat.trim() && !!config.lunchLng.trim();

	async function load(q: string) {
		const lunch = window.api?.lunch;
		if (!lunch) return;
		setQuery(q);
		setState((s) => ({
			...s,
			loading: true,
			error: undefined,
			needKey: false,
		}));
		let r: any = null;
		try {
			r = await lunch.search({
				query: q,
				lat: config.lunchLat,
				lng: config.lunchLng,
				radius: config.lunchRadius || "1000",
				size: 45,
			});
		} catch (e) {
			r = { ok: false, error: String(e) };
		}
		setPicks([]);
		if (!r || !r.ok) {
			setState({
				loading: false,
				error: r?.error || "알 수 없는 오류",
				needKey: r?.needKey,
				places: [],
			});
			return;
		}
		setState({ loading: false, places: r.places || [] });
	}

	// 활성화 시 자동 1회 검색(키·좌표 있을 때만)
	useEffect(() => {
		if (active && !didAuto.current && hasKey && hasCoords) {
			didAuto.current = true;
			load("음식점");
		}
	}, [active]); // eslint-disable-line react-hooks/exhaustive-deps

	// ⌘R / Ctrl+R / F5 → 새로고침(점심 화면에서만)
	useEffect(() => {
		if (!active) return;
		const onKey = (e: KeyboardEvent) => {
			const isRefresh =
				e.key === "F5" ||
				((e.metaKey || e.ctrlKey) && (e.key === "r" || e.key === "R"));
			if (!isRefresh) return;
			const t = e.target as HTMLElement | null;
			if (
				t &&
				(t.tagName === "INPUT" ||
					t.tagName === "TEXTAREA" ||
					t.isContentEditable)
			)
				return;
			e.preventDefault();
			load(query);
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [active]); // eslint-disable-line react-hooks/exhaustive-deps

	return (
		<div
			hidden={!active}
			className="fixed inset-x-0 bottom-0 top-tabh z-50 flex flex-col overflow-y-auto bg-bg"
		>
			<div className="mx-auto w-full max-w-[1200px] px-5 pb-12 pt-5">
				<div className="mb-3.5 flex items-center gap-3">
					<h2 className="m-0 text-xl font-extrabold text-ink">
						🍽️ 점심 — 팀원이랑 맛있는 식사
					</h2>
					<span className="text-xs text-ink-2">
						{hasCoords
							? `반경 ${config.lunchRadius || "1000"}m · 거리순`
							: "좌표 미설정"}
					</span>
					<div className="flex-1" />
					<button
						type="button"
						className="btn btn-ghost"
						title="여러 카테고리를 모아 무작위 3곳 뽑기(카페 제외)"
						disabled={!hasKey || !hasCoords || picking}
						onClick={pickRandom}
					>
						{picking ? "🎲 끑러는 중…" : "🎲 랜덤 3곳"}
					</button>
					<button
						type="button"
						className="btn btn-ghost"
						title="새로고침 (⌘R / Ctrl+R / F5)"
						onClick={() => load(query)}
					>
						↻ 새로고침
					</button>
				</div>

				{/* 🎲 랜덤 추천 3곳 */}
				{picks.length > 0 && (
					<div className="tint-accent mb-3.5 rounded-[12px] p-[12px_14px]">
						<div className="mb-2 flex items-center gap-2">
							<span className="text-[14px] font-extrabold text-ink">
								🎲 오늘의 랜덤 추천
							</span>
							<button
								type="button"
								className="cursor-pointer rounded-[6px] border-0 bg-panel-2 px-2.5 py-[3px] text-[11px] font-bold text-accent hover:underline disabled:opacity-50"
								disabled={picking}
								onClick={pickRandom}
							>
								{picking ? "끑러는 중…" : "다시 돌리기 ↻"}
							</button>
							<div className="flex-1" />
							<button
								type="button"
								className="cursor-pointer border-0 bg-transparent p-0 text-[11px] text-ink-2 hover:underline"
								onClick={() => setPicks([])}
							>
								닫기 ✕
							</button>
						</div>
						<ol className="m-0 grid list-none grid-cols-1 gap-2.5 p-0 sm:grid-cols-3">
							{picks.map((p, i) => (
								<li
									key={(p.placeUrl || p.name) + "pick" + i}
									className="flex flex-col gap-[5px] rounded-[11px] border border-accent bg-panel p-[11px_13px]"
								>
									<div className="flex items-baseline justify-between gap-2">
										<span className="text-[14px] font-extrabold text-ink">
											{p.name}
										</span>
										{p.distance && (
											<span className="whitespace-nowrap text-[12px] font-bold text-accent">
												{fmtDist(p.distance)}
											</span>
										)}
									</div>
									{p.category && (
										<span className="text-[12px] text-ink-2">{p.category}</span>
									)}
									{p.placeUrl && (
										<button
											type="button"
											className="mt-1 cursor-pointer self-start rounded-[6px] border-0 bg-panel-2 px-2.5 py-[3px] text-[11px] font-bold text-accent hover:underline"
											onClick={() =>
												window.open(p.placeUrl, "_blank", "noopener")
											}
										>
											카카오맵에서 보기 ⭐
										</button>
									)}
								</li>
							))}
						</ol>
					</div>
				)}

				{/* 검색어 + 종류 칩 */}
				<div className="mb-3.5 flex flex-wrap items-center gap-2">
					<form
						className="flex items-center gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							if (query.trim()) load(query.trim());
						}}
					>
						<input
							className="rounded-[9px] bg-panel-2 px-3 py-[8px] text-[13px]"
							placeholder="검색어 (예: 김치찌개, 샐러드)"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							style={{ width: 200 }}
						/>
						<button type="submit" className="btn btn-ghost">
							검색
						</button>
					</form>
					<div className="flex flex-wrap gap-1.5">
						{CHIPS.map((c) => (
							<button
								key={c.label}
								type="button"
								title={c.query + " 검색"}
								className={
									"cursor-pointer rounded-full border-0 px-3 py-[5px] text-[12px] font-semibold " +
									(query === c.query
										? "bg-accent text-accent-ink"
										: "bg-panel-2 text-ink-2 hover:bg-panel")
								}
								onClick={() => load(c.query)}
							>
								{c.label}
							</button>
						))}
					</div>
				</div>

				{!hasKey || !hasCoords ? (
					<p className="tint-accent m-0 rounded-[10px] px-3.5 py-2.5 text-[13px] text-ink">
						⚙️ 설정 → 점심 에서 <b>카카오 REST API 키</b>와 <b>사무실 좌표</b>를
						등록하세요. 키는{" "}
						<button
							type="button"
							className="cursor-pointer border-0 bg-transparent p-0 font-inherit text-accent underline"
							onClick={() =>
								window.open(
									"https://developers.kakao.com/console/my-app",
									"_blank",
									"noopener",
								)
							}
						>
							developers.kakao.com
						</button>{" "}
						에서 발급(플랫폼 → Web → 사이트 도메인 등록 후 REST API 키).
					</p>
				) : state.loading ? (
					<p className="px-0.5 py-3 text-[13px] text-ink-2">불러오는 중…</p>
				) : state.error ? (
					<p className="px-0.5 py-3 text-[13px] text-danger">{state.error}</p>
				) : !state.places.length ? (
					<p className="px-0.5 py-3 text-[13px] text-ink-2">
						주변 음식점이 없습니다. 반경을 늘리거나 검색어를 바꿔보세요.
					</p>
				) : (
					<ol className="m-0 grid list-none grid-cols-1 gap-2.5 p-0 sm:grid-cols-2">
						{state.places.map((p, i) => (
							<li
								key={(p.placeUrl || p.name) + i}
								className="flex flex-col gap-[5px] rounded-[11px] border border-line bg-panel p-[11px_13px] hover:border-accent"
							>
								<div className="flex items-baseline justify-between gap-2">
									<span className="flex items-baseline gap-2">
										<span className="text-[11px] font-bold text-ink-2">
											{i + 1}
										</span>
										<span className="text-[14px] font-extrabold text-ink">
											{p.name}
										</span>
									</span>
									{p.distance && (
										<span className="whitespace-nowrap text-[12px] font-bold text-accent">
											{fmtDist(p.distance)}
										</span>
									)}
								</div>
								{p.category && (
									<span className="text-[12px] text-ink-2">{p.category}</span>
								)}
								{p.roadAddress && (
									<span className="text-[12px] text-ink-2">
										📍 {p.roadAddress}
									</span>
								)}
								<div className="mt-1 flex items-center gap-2">
									{p.phone && (
										<span className="text-[11px] text-ink-2">☎ {p.phone}</span>
									)}
									{p.placeUrl && (
										<button
											type="button"
											className="cursor-pointer rounded-[6px] border-0 bg-panel-2 px-2.5 py-[3px] text-[11px] font-bold text-accent hover:underline"
											onClick={() =>
												window.open(p.placeUrl, "_blank", "noopener")
											}
										>
											카카오맵에서 보기 ⭐
										</button>
									)}
								</div>
							</li>
						))}
					</ol>
				)}

				<p className="mt-4 text-[11px] text-ink-2">
					평점·리뷰·사진은 카카오맵 상세 페이지에 있습니다. “카카오맵에서
					보기”로 확인하세요. 데이터: 카카오 로컬 API.
				</p>
			</div>
		</div>
	);
}

// 거리(m 문자열) → "350m" / "1.2km"
function fmtDist(d: string): string {
	const n = Number(d);
	if (!isFinite(n) || !n) return d || "";
	if (n < 1000) return `${Math.round(n)}m`;
	return `${(n / 1000).toFixed(1)}km`;
}
