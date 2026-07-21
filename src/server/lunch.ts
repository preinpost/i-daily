// server/lunch.ts — 점심 탭 맛집 검색 (서버 측). 카카오 로컬 API 호출.
//   POST /api/lunch/search → { query, lat, lng, radius, size } 로 Kakao dapi 호출 → documents[] 정제.
// config(kakaoRestKey·좌표) 는 Backend.readConfig() 로 주입.
//
// 카카오 로컬 API는 평점을 JSON으로 주지 않는다. 각 결과의 place_url 이 카카오맵
// 상세 페이지(별점·리뷰·사진)로 연결되므로, 앱 안에선 이름·카테고리·거리·주소·전화를
// 보여주고 평점은 링크 클릭으로 확인한다.
import type { Backend } from "../shared/backend.ts";

export type SearchOpts = {
	query?: string;
	lat?: number | string;
	lng?: number | string;
	radius?: number | string;
	size?: number;
};

export type Place = {
	name: string;
	category: string;
	phone: string;
	address: string;
	roadAddress: string;
	placeUrl: string;
	x: string;
	y: string;
	distance: string;
};

export type SearchResult = {
	ok: true;
	places: Place[];
	count: number;
	query: string;
};
export type SearchError = { ok: false; error: string; needKey?: boolean };

// 점심 목록에서 제외할 카테고리 키워드(카카오 category_name 기준).
const DESSERT_KEYWORDS = [
	"카페",
	"디저트",
	"베이커리",
	"제과",
	"빵",
	"도넛",
	"아이스크림",
	"빙수",
	"커피",
	"찍집",
	"주스",
	"샐러드",
];

function isDessert(category: string): boolean {
	if (!category) return false;
	const c = category.replace(/\s/g, "");
	if (c.includes("음식점>카페") || c.includes("음식점>간식")) return true;
	return DESSERT_KEYWORDS.some((k) => c.includes(k));
}
function wantsDessert(query: string): boolean {
	const q = query.replace(/\s/g, "");
	return DESSERT_KEYWORDS.some((k) => q.includes(k));
}

function toPlace(d: KakaoDoc): Place | null {
	const name = (d.place_name || "").trim();
	if (!name) return null;
	return {
		name,
		category: (d.category_name || "").trim(),
		phone: (d.phone || "").trim(),
		address: (d.address_name || "").trim(),
		roadAddress: (d.road_address_name || "").trim(),
		placeUrl: (d.place_url || "").trim(),
		x: (d.x || "").trim(),
		y: (d.y || "").trim(),
		distance: String(d.distance ?? ""),
	};
}

function parseKakaoError(body: string, status: number): string {
	let msg = `카카오 API 오류(HTTP ${status})`;
	try {
		const j = JSON.parse(body);
		if (j?.msg) msg += ` — ${j.msg}`;
		else if (j?.message) msg += ` — ${j.message}`;
	} catch {
		if (body) msg += ` — ${body.slice(0, 120)}`;
	}
	if (status === 401)
		msg = "카카오 REST API 키가 유효하지 않습니다(401). ⚙️ 설정에서 확인.";
	if (status === 429)
		msg = "카카오 API 호출 한도를 초과했습니다(429). 잠시 후 다시 시도.";
	return msg;
}

function msg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

type KakaoDoc = {
	place_name?: string;
	category_name?: string;
	phone?: string;
	address_name?: string;
	road_address_name?: string;
	place_url?: string;
	x?: string;
	y?: string;
	distance?: string | number;
};

// 카카오 로컬 키워드 검색 → 정제된 places. config(키·좌표)는 Backend 에서 읽는다.
export async function searchLunch(
	backend: Backend,
	opts: SearchOpts,
): Promise<SearchResult | SearchError> {
	const cfg = await backend.readConfig();
	const key = (cfg.kakaoRestKey || "").trim();
	if (!key)
		return {
			ok: false,
			error:
				"카카오 REST API 키가 없습니다. ⚙️ 설정 → 점심 에서 키를 등록하세요.",
			needKey: true,
		};

	const lat = Number(opts.lat);
	const lng = Number(opts.lng);
	if (!isFinite(lat) || !isFinite(lng) || !lat || !lng)
		return {
			ok: false,
			error:
				"사무실 좌표(위도/경도)가 없습니다. ⚙️ 설정 → 점심 에서 좌표를 등록하세요.",
		};

	const query = (opts.query || "음식점").trim();
	const radius = Math.max(100, Math.min(20000, Number(opts.radius) || 1000));
	const want = Math.max(1, Math.min(45, Number(opts.size) || 45));
	const maxPage = Math.min(3, Math.ceil(want / 15));

	try {
		const docs: KakaoDoc[] = [];
		for (let page = 1; page <= maxPage; page++) {
			const params = new URLSearchParams({
				query,
				category_group_code: "FD6",
				x: String(lng),
				y: String(lat),
				radius: String(radius),
				size: "15",
				page: String(page),
				sort: "distance",
			});
			const url = `https://dapi.kakao.com/v2/local/search/keyword.json?${params}`;
			const r = await fetch(url, {
				headers: {
					Authorization: `KakaoAK ${key}`,
					Accept: "application/json",
				},
			});
			if (r.status !== 200) {
				if (page === 1)
					return {
						ok: false,
						error: parseKakaoError(await r.text(), r.status),
					};
				break;
			}
			const j: any = await r.json();
			const pageDocs = (j?.documents || []) as KakaoDoc[];
			docs.push(...pageDocs);
			if (j?.meta?.is_end || pageDocs.length < 15) break;
		}

		let places: Place[] = docs.map(toPlace).filter(Boolean) as Place[];
		if (!wantsDessert(query))
			places = places.filter((p) => !isDessert(p.category));
		return { ok: true, places, count: places.length, query };
	} catch (e) {
		return { ok: false, error: msg(e) };
	}
}
