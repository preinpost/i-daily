// backend.ts — route() 가 저장소에 접근하는 추상 seam.
// better-sqlite3(Electron/로컬) 과 D1(Workers) 를同一个 인터페이스 뒤에 숨긴다.
// route()는 이 인터페이스만 의존하므로, 전송·DB 드라이버가 바뀌어도 라우팅 로직은 무손상.
import type { Store, Config, TaskFilter, TaskRow } from "./model.ts";

export interface Backend {
	/** 요청 유저(=DB user 키). 응답 본문에 포함되므로 노출. */
	readonly user: string;
	/** 하루치 Doc 왕복 + 바로가기. 이미 async 인터페이스. */
	store: Store;
	/** 파생 쿼리(에이전트·대시보드). side ∈ prev|today|daily. */
	queryTasks(filter: TaskFilter): Promise<TaskRow[]>;
	/** 과거 일지에서 학습한 스크럼 스페이스 라벨(자동완성 후보). */
	listSpaceLabels(): Promise<string[]>;
	/** user별 config(JSON 한 행) 읽기. */
	readConfig(): Promise<Config>;
	/** config 부분 갱신 → 병합 저장. */
	writeConfig(cfg: Partial<Config>): Promise<Config>;
	/** settings 행 존재 여부(최초 실행 → 설정 페이지 유도). */
	hasConfig(): Promise<boolean>;
}
