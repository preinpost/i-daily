import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useToast } from "./Toast";
import { api } from "../lib/api";
import type { Config } from "../types";
import { THIS_WEEK_HEADER, NEXT_WEEK_HEADER } from "../../../shared/report";

type Result = {
  ok: boolean;
  from: string;
  to: string;
  count: number;
  text: string;
  thisWeek: string;
  nextWeek: string;
  deterministic?: string;
  usedAgent?: string | null;
  warn?: string;
} | null;

const fieldCls = "rounded-[9px] bg-panel-2 px-3 py-[9px] text-[13px]";

type DiffRow = { t: "eq" | "add" | "del"; text: string };

// 라인 단위 LCS diff — 집계 원문(a) → 에이전트 결과(b) 변경점을 표시.
function diffLines(a: string, b: string): DiffRow[] {
  const x = a.split("\n");
  const y = b.split("\n");
  const n = x.length;
  const m = y.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) rows.push({ t: "eq", text: x[i++] }), j++;
    else if (dp[i + 1][j] >= dp[i][j + 1]) rows.push({ t: "del", text: x[i++] });
    else rows.push({ t: "add", text: y[j++] });
  }
  while (i < n) rows.push({ t: "del", text: x[i++] });
  while (j < m) rows.push({ t: "add", text: y[j++] });
  return rows;
}

function Spinner() {
  return (
    <span
      className="inline-block h-[14px] w-[14px] animate-spin rounded-full border-2 border-current border-t-transparent align-[-2px]"
      aria-hidden
    />
  );
}

export function WeeklyReportPane({
  active,
  config,
  onSaved,
}: {
  active: boolean;
  config: Config;
  onSaved: (cfg: Config, configured: boolean) => void;
}) {
  const toast = useToast();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState<null | "digest" | "agent">(null);
  const [res, setRes] = useState<Result>(null);
  const [seeded, setSeeded] = useState(false);
  const thisWeekRef = useRef<HTMLTextAreaElement>(null);
  const nextWeekRef = useRef<HTMLTextAreaElement>(null);
  const hasAgent = !!(config.reportProvider || "").trim();
  const [showDiff, setShowDiff] = useState(false);
  // 에이전트가 실제로 집계 원문을 바꿨을 때만 diff 제공.
  const canDiff = !!(res?.usedAgent && res.deterministic && res.deterministic !== res.text);

  // 커스텀 프롬프트(override) — 기본 숨김, 에이전트 선택 시에만 노출.
  const [showPrompt, setShowPrompt] = useState(false);
  const [promptText, setPromptText] = useState(config.reportPrompt || "");
  const [defaultPrompt, setDefaultPrompt] = useState("");
  const [savingPrompt, setSavingPrompt] = useState(false);
  const custom = !!(promptText || "").trim();

  // 처음 열릴 때 기본 기간(Fri~Thu)으로 1회 자동 집계(에이전트 없이).
  useEffect(() => {
    if (active && !seeded) {
      setSeeded(true);
      void gen(false);
    }
  }, [active, seeded]);

  // 내용 길이에 맞춰 각 textarea 높이 자동 조절(내부 스크롤로 잘리지 않게 → 페인이 스크롤).
  useLayoutEffect(() => {
    for (const el of [thisWeekRef.current, nextWeekRef.current]) {
      if (!el) continue;
      el.style.height = "auto";
      el.style.height = el.scrollHeight + "px";
    }
  }, [res?.thisWeek, res?.nextWeek, active, showDiff]);

  async function gen(useAgent: boolean) {
    if (!window.api?.agent || busy) return;
    setBusy(useAgent ? "agent" : "digest");
    try {
      const opts: any = { useAgent };
      if (from) opts.from = from;
      if (to) opts.to = to;
      const r = await window.api.agent.generate(opts);
      setRes(r);
      if (r?.from) setFrom(r.from);
      if (r?.to) setTo(r.to);
      if (r?.warn) toast(r.warn);
    } catch (e) {
      toast("생성 실패: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => setPromptText(config.reportPrompt || ""), [config.reportPrompt]);
  useEffect(() => {
    if (active && !defaultPrompt) window.api?.agent?.defaultPrompt().then(setDefaultPrompt).catch(() => {});
  }, [active, defaultPrompt]);

  async function savePrompt(next: string) {
    setSavingPrompt(true);
    try {
      const r = await api<any>("PUT", "/api/config", { ...config, reportPrompt: next.trim() });
      if (r.ok && r.json?.config) {
        onSaved(r.json.config, !!r.json.configured);
        toast(next.trim() ? "커스텀 프롬프트 저장됨" : "기본 프롬프트로 초기화됨");
      } else toast("프롬프트 저장 실패");
    } finally {
      setSavingPrompt(false);
    }
  }

  async function copy(header: string, body: string) {
    const text = body.trim() ? `${header}\n${body.trim()}` : "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast(`${header} 복사됨 — Teams 채팅에 붙여넣기`);
    } catch {
      toast("복사 실패");
    }
  }

  return (
    <div hidden={!active} className="fixed inset-x-0 bottom-0 top-tabh z-50 flex flex-col overflow-y-auto bg-bg">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-5 pb-16 pt-7">
        <h2 className="m-0 text-xl font-extrabold text-ink">📋 주간업무보고</h2>
        <p className="tint-accent m-0 rounded-[10px] px-3.5 py-2.5 text-[13px] text-ink">
          전주 금요일 ~ 금주 목요일 사이의 진행 업무를 스페이스별로 뭉쳐 Teams 붙여넣기용으로 만듭니다.
          숫자·티켓키는 집계가 확정하고, 에이전트는 서술만 다듬어요.
        </p>

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-bold text-ink">시작 (금)</span>
            <input className={fieldCls} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-bold text-ink">끝 (목)</span>
            <input className={fieldCls} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <button type="button" className="btn btn-ghost" onClick={() => gen(false)} disabled={!!busy}>
            {busy === "digest" ? <><Spinner /> 집계 중…</> : "집계"}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => gen(true)}
            disabled={!!busy || !hasAgent}
            title={hasAgent ? "에이전트로 서술 다듬기" : "⚙️ 설정에서 에이전트를 선택하세요"}
          >
            {busy === "agent" ? <><Spinner /> 생성 중…</> : "🤖 에이전트로 생성"}
          </button>
        </div>

        {hasAgent && (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              className="flex w-fit items-center gap-1.5 text-[13px] font-semibold text-ink-2 hover:text-accent"
              onClick={() => setShowPrompt((v) => !v)}
            >
              <span className="inline-block w-3">{showPrompt ? "▾" : "▸"}</span>
              프롬프트 커스터마이즈 (고급)
              {custom && <span className="tint-accent rounded-full px-1.5 py-px text-[10.5px] text-ink">커스텀</span>}
            </button>
            {showPrompt && (
              <div className="flex flex-col gap-2 rounded-[10px] border border-line p-3">
                <small className="text-xs text-ink-2">
                  에이전트에 보낼 지시문을 직접 편집합니다. 비워두면 내장 기본값 사용. 플레이스홀더{" "}
                  <code className="rounded bg-panel px-1 font-mono">{"{from}"}</code>{" "}
                  <code className="rounded bg-panel px-1 font-mono">{"{to}"}</code>{" "}
                  <code className="rounded bg-panel px-1 font-mono">{"{owner}"}</code> 치환,{" "}
                  집계 데이터(JSON)는 자동으로 맨 뜼에 붙습니다(<code className="rounded bg-panel px-1 font-mono">{"{data}"}</code> 로 위치 지정 가능).
                </small>
                <textarea
                  className={fieldCls + " min-h-[220px] resize-y font-mono text-[12px] leading-relaxed"}
                  value={promptText}
                  placeholder={defaultPrompt || "내장 기본 프롬프트 사용 중…"}
                  onChange={(e) => setPromptText(e.target.value)}
                  spellCheck={false}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className="btn btn-primary" onClick={() => savePrompt(promptText)} disabled={savingPrompt}>
                    💾 프롬프트 저장
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => setPromptText(defaultPrompt)}
                    disabled={!defaultPrompt}
                    title="내장 기본 프롬프트를 편집창으로 불러오기"
                  >
                    기본값 불러오기
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => { setPromptText(""); savePrompt(""); }}
                    disabled={savingPrompt || !custom}
                    title="커스텀 프롬프트를 지우고 내장 기본값으로"
                  >
                    초기화
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {busy === "agent" && (
          <div className="tint-accent flex items-center gap-2.5 rounded-[10px] px-3.5 py-2.5 text-[13px] text-ink">
            <Spinner />
            에이전트가 서술을 다듬는 중이에요… (수 초~수십 초 소요)
          </div>
        )}

        {res && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3 text-[13px] text-ink-2">
              <span>
                {res.from} ~ {res.to} · {res.count}건
                {res.usedAgent ? " · 🤖 " + res.usedAgent : ""}
              </span>
              {canDiff && (
                <button
                  type="button"
                  className="btn btn-ghost ml-auto"
                  onClick={() => setShowDiff((v) => !v)}
                  title="집계 원문 대비 에이전트가 다듬은 변경점 보기"
                >
                  {showDiff ? "📝 편집" : "🔍 diff"}
                </button>
              )}
            </div>
            {canDiff && showDiff ? (
              <pre className={fieldCls + " m-0 overflow-x-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed"}>
                {diffLines(res.deterministic || "", res.text).map((r, idx) => (
                  <div
                    key={idx}
                    className={
                      r.t === "add"
                        ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                        : r.t === "del"
                          ? "bg-rose-500/15 text-rose-700 line-through/0 dark:text-rose-300"
                          : "text-ink-2"
                    }
                  >
                    {(r.t === "add" ? "+ " : r.t === "del" ? "- " : "  ") + (r.text || "\u00A0")}
                  </div>
                ))}
              </pre>
            ) : (
              <>
                <section className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <h3 className="m-0 text-[13px] font-bold text-ink">{THIS_WEEK_HEADER}</h3>
                    <button
                      type="button"
                      className="btn btn-ghost ml-auto"
                      onClick={() => copy(THIS_WEEK_HEADER, res.thisWeek)}
                      disabled={!res.thisWeek.trim()}
                    >
                      📋 복사
                    </button>
                  </div>
                  <textarea
                    ref={thisWeekRef}
                    className={fieldCls + " resize-none overflow-hidden font-mono leading-relaxed placeholder:text-ink-2"}
                    value={res.thisWeek}
                    onChange={(e) => setRes({ ...res, thisWeek: e.target.value })}
                    placeholder="(해당 기간 항목 없음)"
                    spellCheck={false}
                  />
                </section>
                <section className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <h3 className="m-0 text-[13px] font-bold text-ink">{NEXT_WEEK_HEADER}</h3>
                    <button
                      type="button"
                      className="btn btn-ghost ml-auto"
                      onClick={() => copy(NEXT_WEEK_HEADER, res.nextWeek)}
                      disabled={!res.nextWeek.trim()}
                    >
                      📋 복사
                    </button>
                  </div>
                  <textarea
                    ref={nextWeekRef}
                    className={fieldCls + " resize-none overflow-hidden font-mono leading-relaxed placeholder:text-ink-2"}
                    value={res.nextWeek}
                    onChange={(e) => setRes({ ...res, nextWeek: e.target.value })}
                    placeholder="(해당 기간 항목 없음)"
                    spellCheck={false}
                  />
                </section>
              </>
            )}
            {res.warn && <small className="text-xs text-amber-600">{res.warn}</small>}
          </div>
        )}
      </div>
    </div>
  );
}
