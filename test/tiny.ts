// bun:test → node:test 전환용 미니 shim. Jest 스타일 expect를 유지해 테스트 본문은 무손상.
import { strictEqual, deepStrictEqual, ok } from "node:assert";
export { test } from "node:test";

export function expect(actual: any) {
  return {
    toBe: (e: any) => strictEqual(actual, e),
    toEqual: (e: any) => deepStrictEqual(actual, e),
    toContain: (e: any) => ok(actual.includes(e), `expected ${JSON.stringify(actual)} to contain ${JSON.stringify(e)}`),
    not: {
      toContain: (e: any) => ok(!actual.includes(e), `expected NOT to contain ${JSON.stringify(e)}`),
    },
  };
}
