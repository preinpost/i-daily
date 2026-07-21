// drizzle.config.ts — drizzle-kit 설정.
// schema.ts → migrations/*.sql 생성. D1 dialect(sqlite) 사용.
// 적용은 wrangler d1 migrations apply 로 (로컬/원격 각각).
import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "sqlite",
	driver: "d1-http", // CF D1 대상. 로컬 better-sqlite3 도 동일 SQL 로 호환.
	schema: "./src/shared/schema.ts",
	out: "./migrations",
});
