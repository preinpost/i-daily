// main/lunch.ts — 점심 탭 맛집 검색. 카카오 로컬 API(키워드로 장소 검색) 호출.
//   lunch:search → { query, lat, lng, radius, size } 로 Kakao dapi 호출 → documents[] 정제.
//
// 카카오 로컬 API는 평점을 JSON으로 주지 않는다. 각 결과의 place_url 이 카카오맵
// 상세 페이지(별점·리뷰·사진)로 연결되므로, 앱 안에선 이름·카테고리·거리·주소·전화를
// 보여주고 평점은 링크 클릭으로 확인한다.
//
// REST 키는 DB config(kakaoRestKey)에서 읽는다. 키가 없으면 클라이언트에 안내.
import { ipcMain, type Net } from "electron";
import type Database from "better-sqlite3";
import { readConfig } from "../shared/store.ts";

let _db: Database.Database;
let _user = "local";
let _net: Net | null = null;

// electron net 은 app ready 후 사용 가능. 지연 획득.
function net(): Net {
	if (!_net) _net = (require("electron") as typeof import("electron")).net;
	return _net!;
}

export function setupLunch(db: Database.Database, user: string): void {
	_db = db;
	_user = user;
	ipcMain.handle("lunch:search", (_e, opts: SearchOpts) => search(opts));
}

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

export type SearchError = {
	ok: false;
	error: string;
	needKey?: boolean;
};

export async function search(
	opts: SearchOpts,
): Promise<SearchResult | SearchError> {
	const cfg = readConfig(_db, _user);
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
	const size = Math.max(1, Math.min(15, Number(opts.size) || 15));

	const params = new URLSearchParams({
		query,
		category_group_code: "FD6", // 음식점
		x: String(lng),
		y: String(lat),
		radius: String(radius),
		size: String(size),
		sort: "distance",
	});
	const url = `https://dapi.kakao.com/v2/local/search/keyword.json?${params}`;

	try {
		const r = await request(url, key);
		if (r.status !== 200) {
			const msg = parseKakaoError(r.body, r.status);
			return { ok: false, error: msg };
		}
		const docs = (r.json?.documents || []) as KakaoDoc[];
		const places: Place[] = docs.map(toPlace).filter(Boolean) as Place[];
		return { ok: true, places, count: places.length, query };
	} catch (e) {
		return { ok: false, error: msg(e) };
	}
}

// electron.net 으로 GET (메인 프로세스라 fetch 대신 net 사용 — 프록시/인증서 일관성).
function request(
	url: string,
	key: string,
): Promise<{ status: number; body: string; json: any }> {
	return new Promise((resolve, reject) => {
		const req = net().request({
			method: "GET",
			url,
			redirect: "follow",
		});
		req.setHeader("Authorization", `KakaoAK ${key}`);
		req.setHeader("Accept", "application/json");
		let body = "";
		req.on("response", (resp) => {
			resp.on("data", (d: Buffer) => (body += d.toString("utf8")));
			resp.on("end", () => {
				let json: any = null;
				try {
					json = body ? JSON.parse(body) : null;
				} catch {
					/* keep null */
				}
				resolve({ status: resp.statusCode, body, json });
			});
		});
		req.on("error", (e) => reject(e));
		req.end();
	});
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
