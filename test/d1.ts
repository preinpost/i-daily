// d1.ts — 테스트용 로컬 D1. Miniflare(workerd) 로 실제 D1 을 띄워
// drizzle(d1) 로 감싼다. 프로덕션과 동일한 store-drizzle 경로(db.batch 포함)를 검증.
// 파일당 인스턴스 1개를 공유하고, freshDb() 호출마다 테이블을 비워 테스트 간 격리.
import { after } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Miniflare } from "miniflare";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { migrate } from "drizzle-orm/d1/migrator";
import { sql } from "drizzle-orm";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

// 마이그레이션이 만든 실제 테이블(뷰 task_rows·drizzle 내부표 제외). 매 테스트 초기화 대상.
const TABLES = [
	"days", "sections", "blocks", "spaces", "tasks", "list_items",
	"shortcuts", "settings", "jira_auth", "ai_auth", "oauth_states", "sessions",
];

let mf: Miniflare | null = null;
let db: DrizzleD1Database | null = null;

/** 스키마 적용된 D1 drizzle 인스턴스(테이블 비운 상태) 반환. */
export async function freshDb(): Promise<DrizzleD1Database> {
	if (!db) {
		mf = new Miniflare({ modules: true, script: "export default {};", d1Databases: ["DB"] });
		const d1 = await mf.getD1Database("DB");
		db = drizzle(d1 as any);
		await migrate(db, { migrationsFolder: MIGRATIONS });
		after(async () => {
			await mf?.dispose();
			mf = null;
			db = null;
		});
	}
	for (const t of TABLES) await db.run(sql.raw(`DELETE FROM ${t}`));
	return db;
}
