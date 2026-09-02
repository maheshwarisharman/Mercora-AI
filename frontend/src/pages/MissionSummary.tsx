import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  ArrowUpRight,
  Bot,
  Check,
  CircleAlert,
  Clock3,
  Database,
  ExternalLink,
  FileWarning,
  MessageSquare,
  RefreshCw,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  User,
  WalletCards,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { ReasoningTrace, type AgentTraceStep } from "../components/ReasoningTrace";
import { MarkdownContent } from "../components/MarkdownContent";

type HealthVerdict = "healthy" | "needs_review" | "critical";

interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
  toolCallId?: string;
}

interface QAMessage {
  role: "user" | "assistant";
  content: string;
  trace?: AgentTraceStep[];
  hitStepBudget?: boolean;
  citedExceptionIds?: string[];
  citedEvidenceIds?: string[];
  couldNotAnswer?: boolean;
  isLoading?: boolean;
}

export interface MissionSummaryAggregate {
  missionId: string;
  dateRange: { from: string; to: string };
  orderCounts: { total: number; bySource: Record<string, number> };
  salesBySource: Record<string, { orderCount: number; grossSales: number }>;
  totals: Record<"grossSales" | "totalFees" | "totalRefunds" | "statutoryWithholding" | "netExpected" | "netReceived" | "variance", number>;
  matchHealth: {
    overallMatchRatePct: number;
    bySource: Record<string, { matchRatePct: number; unmatchedValue: number; unmatchedCount: number }>;
  };
  deductionsByCategory: Array<{ category: string; value: number; count: number }>;
  exceptions: {
    byType: Record<string, number>;
    byStatus: { open: number; resolved: number; requiresHumanReview: number };
    topOpen: Array<{ id: string; type: string; amount: number; ageDays: number }>;
  };
  cod: { remittanceCount: number; avgSettlementLagDays: number; rtoCount: number; rtoValue: number };
  amazon: { unmatchedOrderCount: number; unresolvedUnknownDeductions: number; resolvedUnknownDeductions: number };
  timeSeries: Array<{ bucket: string; matchedValue: number; unmatchedValue: number }>;
}

export interface MissionSummaryNarrative {
  healthVerdict: HealthVerdict;
  headline: string;
  insights: Array<{ text: string; metricRef: string; severity: "info" | "warning" | "critical" }>;
  recommendedActions: Array<{ text: string; relatedExceptionIds?: string[] }>;
}

interface MissionSummaryResponse {
  mission_id: string;
  generated_at: string;
  aggregate_json: MissionSummaryAggregate;
  narrative_json: MissionSummaryNarrative;
  model: string;
  prompt_version: string;
}

interface MissionSummaryProps {
  mission: { id: string; objective?: string | null; status: string; period_start: string; period_end: string };
  onBack: () => void;
  onOpenException?: (exceptionId: string) => void;
}

const currency = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const number = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

function formatMoney(value: number) {
  return currency.format(Number(value) || 0).replace("₹", "₹");
}

function compactMoney(value: number) {
  const amount = Number(value) || 0;
  if (Math.abs(amount) >= 10000000) return `₹${(amount / 10000000).toFixed(1)}Cr`;
  if (Math.abs(amount) >= 100000) return `₹${(amount / 100000).toFixed(1)}L`;
  if (Math.abs(amount) >= 1000) return `₹${(amount / 1000).toFixed(1)}k`;
  return formatMoney(amount);
}

function titleCase(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function resolvePath(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (!value || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[key];
  }, root);
}

function MetricValue({ aggregate, metricRef }: { aggregate: MissionSummaryAggregate; metricRef: string }) {
  const value = resolvePath(aggregate, metricRef);
  const key = metricRef.split(".").at(-1) || "metric";
  if (typeof value !== "number") return null;
  const display = key.toLowerCase().includes("rate") || key.toLowerCase().includes("pct")
    ? `${value.toFixed(1)}%`
    : key.toLowerCase().includes("value") || key.toLowerCase().includes("sales") || key.toLowerCase().includes("received") || key.toLowerCase().includes("variance")
      ? compactMoney(value)
      : key.toLowerCase().includes("days")
        ? `${value.toFixed(1)} days`
        : number.format(value);
  return <span className="summary-metric-value">{display}</span>;
}

function DonutChart({ items }: { items: MissionSummaryAggregate["deductionsByCategory"] }) {
  const total = items.reduce((sum, item) => sum + Math.abs(item.value), 0);
  const colors = ["#18324b", "#2e5962", "#5d7b82", "#869b9d", "#b4c2bd", "#d1a969"];
  const stops = items.map((item, index) => {
    const startValue = items.slice(0, index).reduce((sum, prior) => sum + Math.abs(prior.value), 0);
    const endValue = startValue + Math.abs(item.value);
    const start = total ? (startValue / total) * 360 : 0;
    const end = total ? (endValue / total) * 360 : 0;
    return `${colors[index % colors.length]} ${start}deg ${end}deg`;
  });
  return (
    <div className="summary-donut-wrap">
      <div className="summary-donut" style={{ background: stops.length ? `conic-gradient(${stops.join(", ")})` : "#e5e9e5" }}>
        <div className="summary-donut-hole">
          <span>Total deductions</span>
          <strong>{compactMoney(total)}</strong>
        </div>
      </div>
      <div className="summary-legend">
        {items.length ? items.map((item, index) => (
          <div className="summary-legend-row" key={item.category}>
            <span className="summary-legend-label"><i style={{ background: colors[index % colors.length] }} />{titleCase(item.category)}</span>
            <span>{compactMoney(item.value)} <em>{total ? `${Math.round((Math.abs(item.value) / total) * 100)}%` : "0%"}</em></span>
          </div>
        )) : <p className="summary-empty-copy">No deductions were recorded in this mission.</p>}
      </div>
    </div>
  );
}

function TimeSeriesChart({ points }: { points: MissionSummaryAggregate["timeSeries"] }) {
  const max = Math.max(1, ...points.map((point) => Math.max(point.matchedValue, point.unmatchedValue)));
  return (
    <div className="summary-chart">
      <div className="summary-chart-key"><span><i className="matched" /> Reconciled</span><span><i className="outstanding" /> Outstanding</span></div>
      {points.length ? points.map((point) => (
        <div className="summary-bar-group" key={point.bucket}>
          <div className="summary-bars" aria-label={`${point.bucket}: ${formatMoney(point.matchedValue)} reconciled, ${formatMoney(point.unmatchedValue)} outstanding`}>
            <span className="summary-bar matched" style={{ height: `${Math.max(4, (point.matchedValue / max) * 100)}%` }} />
            <span className="summary-bar outstanding" style={{ height: `${Math.max(4, (point.unmatchedValue / max) * 100)}%` }} />
          </div>
          <span className="summary-bar-label">{new Date(point.bucket).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</span>
        </div>
      )) : <p className="summary-empty-copy">The trend will appear once event dates are available.</p>}
    </div>
  );
}

export const MissionSummary: React.FC<MissionSummaryProps> = ({ mission, onBack, onOpenException }) => {
  const { fetchWithAuth } = useAuth();
  const [summary, setSummary] = useState<MissionSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [regenerating, setRegenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pipelineStage, setPipelineStage] = useState<string | null>(null);

  const [qaMessages, setQaMessages] = useState<QAMessage[]>([]);
  const [qaInput, setQaInput] = useState("");
  const [qaConversationHistory, setQaConversationHistory] = useState<AgentMessage[]>([]);
  const [qaSending, setQaSending] = useState(false);
  const [qaError, setQaError] = useState<string | null>(null);
  const qaBottomRef = useRef<HTMLDivElement | null>(null);

  const handleAskQuestion = async () => {
    if (!mission || !qaInput.trim() || qaSending) return;

    const question = qaInput.trim();
    setQaInput("");
    setQaError(null);
    setQaSending(true);

    setQaMessages((prev) => [...prev, { role: "user", content: question }]);
    setQaMessages((prev) => [...prev, { role: "assistant", content: "", isLoading: true }]);

    try {
      const res = await fetchWithAuth(`/api/finance/missions/${mission.id}/ask`, {
        method: "POST",
        body: JSON.stringify({ question, conversationHistory: qaConversationHistory }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || "Q&A request failed");
      }

      const result = data.data;
      const assistantMsg: QAMessage = {
        role: "assistant",
        content: result.answer,
        trace: result.trace,
        hitStepBudget: result.hitStepBudget,
        citedExceptionIds: result.citedExceptionIds,
        citedEvidenceIds: result.citedEvidenceIds,
        couldNotAnswer: result.couldNotAnswer,
        isLoading: false,
      };

      setQaMessages((prev) => [...prev.slice(0, -1), assistantMsg]);
      setQaConversationHistory(result.updatedConversationHistory || []);
      setTimeout(() => qaBottomRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
    } catch (err: any) {
      setQaMessages((prev) => prev.slice(0, -1));
      setQaError(err.message || "Failed to get answer");
    } finally {
      setQaSending(false);
    }
  };

  const loadSummary = useCallback(async (regenerate = false) => {
    setError(null);
    if (regenerate) setRegenerating(true); else setLoading(true);
    try {
      const response = await fetchWithAuth(`/api/finance/missions/${mission.id}/summary${regenerate ? "/regenerate" : ""}`, { method: regenerate ? "POST" : "GET" });
      const body = await response.json();
      if (response.status === 409) {
        setPipelineStage(body.pipelineStage || mission.status);
        return;
      }
      if (!response.ok) throw new Error(body.message || "Unable to load mission summary");
      setSummary(body.data);
    } catch (loadError: any) {
      setError(loadError.message || "Unable to load mission summary");
    } finally {
      setLoading(false);
      setRegenerating(false);
    }
  }, [fetchWithAuth, mission.id, mission.status]);

  useEffect(() => { void loadSummary(); }, [loadSummary]);

  const aggregate = summary?.aggregate_json;
  const narrative = summary?.narrative_json;
  const totalDeductions = useMemo(() => aggregate?.deductionsByCategory.reduce((sum, item) => sum + Math.abs(item.value), 0) || 0, [aggregate]);
  const waterfall = aggregate ? [
    ["Gross sales", aggregate.totals.grossSales, "base"],
    ["Fees", -aggregate.totals.totalFees, "deduction"],
    ["Refunds & clawbacks", -aggregate.totals.totalRefunds, "deduction"],
    ["Statutory withholding", -aggregate.totals.statutoryWithholding, "deduction"],
    ["Net expected", aggregate.totals.netExpected, "total"],
  ] as const : [];

  if (loading) return <SummarySkeleton onBack={onBack} />;
  if (pipelineStage) return (
    <div className="summary-state-page">
      <button className="summary-back-link" onClick={onBack}><ArrowLeft size={16} /> Back to missions</button>
      <div className="summary-progress-card">
        <div className="summary-progress-mark"><Clock3 size={24} /></div>
        <p className="summary-eyebrow">Mission in progress</p>
        <h1>Your reconciliation is still running.</h1>
        <p>Mercora is currently in the <strong>{titleCase(pipelineStage)}</strong> stage. This report will become available as soon as the deterministic reconciliation pass is finished.</p>
        <div className="summary-progress-line"><span style={{ width: pipelineStage === "reconciling" ? "72%" : "36%" }} /></div>
        <button className="summary-secondary-button" onClick={() => void loadSummary()}><RefreshCw size={15} /> Check again</button>
      </div>
    </div>
  );
  if (error || !aggregate || !narrative) return (
    <div className="summary-state-page">
      <button className="summary-back-link" onClick={onBack}><ArrowLeft size={16} /> Back to missions</button>
      <div className="summary-progress-card summary-error-card"><div className="summary-progress-mark"><CircleAlert size={24} /></div><p className="summary-eyebrow">Report unavailable</p><h1>We couldn’t assemble this report.</h1><p>{error || "The mission returned an incomplete summary response."}</p><button className="summary-secondary-button" onClick={() => void loadSummary()}><RefreshCw size={15} /> Try again</button></div>
    </div>
  );

  return (
    <div className="summary-shell">
      <header className="summary-header">
        <button className="summary-back-link" onClick={onBack}><ArrowLeft size={16} /> Back to mission</button>
        <div className="summary-header-main">
          <div>
            <div className="summary-eyebrow"><span className="summary-kicker-dot" /> Reconciliation report <code>#{mission.id.slice(0, 8)}</code></div>
            <h1>{mission.objective || "Mission reconciliation"}</h1>
            <p className="summary-date">{aggregate.dateRange.from} <span>→</span> {aggregate.dateRange.to} <span className="summary-header-note">Deterministic financial snapshot</span></p>
          </div>
          <div className={`summary-verdict ${narrative.healthVerdict}`}><span className="summary-verdict-dot" /> {narrative.healthVerdict.replace("_", " ")}</div>
        </div>
        <div className="summary-headline"><Sparkles size={17} /><p>{narrative.headline}</p></div>
      </header>

      <section className="summary-stat-grid">
        <SummaryStat label="Gross sales" value={formatMoney(aggregate.totals.grossSales)} detail={`${number.format(aggregate.orderCounts.total)} orders across connected sources`} icon={<WalletCards size={17} />} />
        <SummaryStat label="Net received" value={formatMoney(aggregate.totals.netReceived)} detail={`${aggregate.matchHealth.overallMatchRatePct.toFixed(1)}% of sales in a complete bank chain`} icon={<ShieldCheck size={17} />} />
        <SummaryStat label="Open exceptions" value={number.format(aggregate.exceptions.byStatus.open)} detail={`${number.format(aggregate.exceptions.byStatus.requiresHumanReview)} require human review`} icon={<FileWarning size={17} />} tone="attention" />
        <SummaryStat label="Net variance" value={formatMoney(aggregate.totals.variance)} detail={aggregate.totals.variance < 0 ? "Received below expected" : "Received above expected"} icon={<ArrowUpRight size={17} />} tone={aggregate.totals.variance < 0 ? "negative" : "positive"} />
      </section>

      <div className="summary-main-grid">
        <main className="summary-content-column">
          <section className="summary-panel summary-waterfall-panel">
            <div className="summary-panel-heading"><div><p className="summary-eyebrow">Cash movement</p><h2>Where the money landed</h2></div><span className="summary-panel-meta">INR · mission total</span></div>
            <div className="summary-waterfall">
              {waterfall.map(([label, value, kind]) => <div className={`summary-waterfall-row ${kind}`} key={label}><span>{label}</span><strong>{formatMoney(value)}</strong></div>)}
            </div>
            <div className="summary-received-row"><span><Check size={15} /> Net actually received</span><strong>{formatMoney(aggregate.totals.netReceived)}</strong></div>
          </section>

          <section className="summary-panel-grid">
            <div className="summary-panel"><div className="summary-panel-heading"><div><p className="summary-eyebrow">Deductions</p><h2>Where value went</h2></div><span className="summary-panel-meta">{formatMoney(totalDeductions)}</span></div><DonutChart items={aggregate.deductionsByCategory} /></div>
            <div className="summary-panel"><div className="summary-panel-heading"><div><p className="summary-eyebrow">Reconciliation health</p><h2>Matched vs outstanding</h2></div><span className="summary-panel-meta">{aggregate.matchHealth.overallMatchRatePct.toFixed(1)}% matched</span></div><TimeSeriesChart points={aggregate.timeSeries} /></div>
          </section>

          <section className="summary-panel summary-insights-panel"><div className="summary-panel-heading"><div><p className="summary-eyebrow">Narrated readout</p><h2>What stands out</h2></div><span className="summary-trace-label"><Database size={13} /> Grounded in aggregate</span></div><div className="summary-insights-list">{narrative.insights.map((insight) => <div className={`summary-insight ${insight.severity}`} key={`${insight.metricRef}-${insight.text}`}><span className="summary-insight-icon">{insight.severity === "info" ? <Check size={15} /> : <AlertTriangle size={15} />}</span><div><p>{insight.text}</p><span className="summary-insight-source">{titleCase(insight.metricRef.split(".").at(-1) || "Metric")} <MetricValue aggregate={aggregate} metricRef={insight.metricRef} /></span></div></div>)}</div></section>

          <section className="summary-panel summary-actions-panel"><div className="summary-panel-heading"><div><p className="summary-eyebrow">Next moves</p><h2>Recommended actions</h2></div></div><div className="summary-actions-list">{narrative.recommendedActions.length ? narrative.recommendedActions.map((action, index) => <div className="summary-action-row" key={`${index}-${action.text}`}><span className="summary-action-index">{String(index + 1).padStart(2, "0")}</span><p>{action.text}</p>{action.relatedExceptionIds?.[0] && onOpenException ? <button onClick={() => onOpenException(action.relatedExceptionIds![0])}>Open exception <ExternalLink size={13} /></button> : null}</div>) : <p className="summary-empty-copy">No additional actions were recommended.</p>}</div></section>

          {/* SETTLEMENT Q&A PANEL */}
          <section className="summary-panel summary-qa-panel p-0 overflow-hidden">
            <div className="px-5 pt-5 pb-4 border-b border-[#dfe7e3] bg-[#f1f4f0]">
              <div className="flex items-center gap-2.5 mb-1">
                <div className="w-8 h-8 rounded-none bg-[#18324b] flex items-center justify-center shadow-none">
                  <Bot size={16} className="text-white" />
                </div>
                <div>
                  <h4 className="text-sm font-bold text-[#18324b]">Settlement Q&amp;A</h4>
                  <p className="text-xs text-[#567079]">
                    Ask anything about this mission — the agent uses its tools to answer and shows its reasoning.
                  </p>
                </div>
              </div>
            </div>

            {/* Message list */}
            <div className="px-5 py-4 space-y-4 max-h-[480px] overflow-y-auto bg-[#fbfcfa]">
              {qaMessages.length === 0 && (
                <div className="py-8 text-center">
                  <div className="w-12 h-12 rounded-none bg-[#eef3ef] flex items-center justify-center mx-auto mb-3">
                    <MessageSquare size={22} className="text-[#5d7b82]" />
                  </div>
                  <p className="text-sm font-semibold text-[#567079] mb-1">Ask about this mission</p>
                  <p className="text-xs text-[#567079] max-w-xs mx-auto">
                    Try: "What needs my attention?", "How much is unresolved?", or "Why did Razorpay settle less than expected?"
                  </p>
                </div>
              )}

              {qaMessages.map((msg, i) => (
                <div key={i} className={`flex gap-3 ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}>
                  {/* Avatar */}
                  <div className={`w-7 h-7 rounded-none flex items-center justify-center shrink-0 ${
                    msg.role === "user"
                      ? "bg-[#18324b] text-white"
                      : "bg-[#18324b] text-white"
                  }`}>
                    {msg.role === "user" ? <User size={13} /> : <Bot size={13} />}
                  </div>

                  {/* Bubble */}
                  <div className={`max-w-[80%] rounded-none px-4 py-3 text-sm shadow-none ${
                    msg.role === "user"
                      ? "bg-[#18324b] text-white rounded-none"
                      : "bg-[#fbfcfa] border border-[#dfe7e3] text-[#18324b] rounded-none"
                  }`}>
                    {msg.isLoading ? (
                      <div className="flex items-center gap-1.5 py-1">
                        {[0, 1, 2].map((d) => (
                          <div
                            key={d}
                            className="w-1.5 h-1.5 rounded-none bg-[#5d7b82] animate-bounce"
                            style={{ animationDelay: `${d * 0.15}s` }}
                          />
                        ))}
                      </div>
                    ) : (
                      <>
                        {/* Out-of-scope banner */}
                        {msg.couldNotAnswer && (
                          <div className="flex items-center gap-2 text-xs text-[#8a642b] bg-[#fff8eb] border border-[#e8d6b5] rounded-none px-3 py-2 mb-2">
                            <AlertCircle size={13} className="shrink-0" />
                            <span>Out of scope — I can only answer questions about this mission's reconciliation data.</span>
                          </div>
                        )}

                        <MarkdownContent content={msg.content} isUser={msg.role === "user"} />

                        {/* Cited exception chips */}
                        {msg.citedExceptionIds && msg.citedExceptionIds.length > 0 && (
                          <div className="flex flex-wrap items-center gap-1.5 mt-2.5 pt-2.5 border-t border-[#dfe7e3]">
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-[#567079]">Exceptions:</span>
                            {msg.citedExceptionIds.map((id) => (
                              <button
                                key={id}
                                onClick={() => onOpenException?.(id)}
                                className="text-[11px] font-mono font-semibold text-[#18324b] bg-[#eef3ef] hover:bg-[#eef3ef] border border-[#dfe7e3] rounded-none px-2.5 py-0.5 transition-colors cursor-pointer"
                                title="Click to view this exception"
                              >
                                #{id.slice(0, 8)}
                              </button>
                            ))}
                          </div>
                        )}

                        {/* Cited evidence chips */}
                        {msg.citedEvidenceIds && msg.citedEvidenceIds.length > 0 && (
                          <div className="flex flex-wrap items-center gap-1.5 mt-2 pt-2 border-t border-[#dfe7e3]">
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-[#567079]">Evidence:</span>
                            {msg.citedEvidenceIds.map((ref) => (
                              <span key={ref} className="text-[11px] font-mono font-semibold text-[#29745d] bg-[#eef3ef] border border-[#dfe7e3] rounded-none px-2.5 py-0.5">
                                {ref}
                              </span>
                            ))}
                          </div>
                        )}

                        {/* Reasoning trace */}
                        {msg.trace && msg.trace.length > 0 && (
                          <ReasoningTrace
                            trace={msg.trace}
                            hitStepBudget={msg.hitStepBudget}
                            className="mt-3"
                          />
                        )}

                        {/* Budget banner */}
                        {msg.hitStepBudget && !msg.couldNotAnswer && (
                          <div className="flex items-center gap-2 text-xs text-[#8a642b] bg-[#fff8eb] border border-[#e8d6b5] rounded-none px-3 py-2 mt-2">
                            <ShieldAlert size={13} className="shrink-0" />
                            <span>Investigation budget reached — answer may be incomplete.</span>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              ))}

              {/* Error */}
              {qaError && (
                <div className="flex items-center gap-2 text-xs text-[#b04b43] bg-[#fff1ef] border border-[#efd2cf] rounded-none px-4 py-3">
                  <AlertCircle size={14} className="shrink-0" />
                  <span>{qaError}</span>
                </div>
              )}

              <div ref={qaBottomRef} />
            </div>

            {/* Input row */}
            <div className="px-5 pb-5 pt-3 border-t border-[#dfe7e3] bg-[#f1f4f0] flex gap-2">
              <input
                type="text"
                id="qa-question-input"
                value={qaInput}
                onChange={(e) => setQaInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleAskQuestion(); } }}
                placeholder="Ask about this mission's reconciliation..."
                disabled={qaSending}
                className="flex-1 text-sm bg-[#fbfcfa] border border-[#dfe7e3] rounded-none px-4 py-2.5 text-[#18324b] placeholder:text-[#567079] focus:outline-none focus:ring-2 focus:ring-[#c99548] focus:border-transparent disabled:opacity-60 transition-all"
              />
              <button
                onClick={handleAskQuestion}
                disabled={qaSending || !qaInput.trim()}
                id="qa-send-button"
                aria-label="Send question"
                className="w-10 h-10 rounded-none bg-[#18324b] hover:bg-[#2e5962] disabled:opacity-40 disabled:cursor-not-allowed text-white flex items-center justify-center transition-colors shadow-none shrink-0"
              >
                {qaSending ? (
                  <div className="w-4 h-4 border-2 border-[#fbfcfa] border-t-transparent rounded-full animate-spin" />
                ) : (
                  <Send size={16} />
                )}
              </button>
            </div>
          </section>
        </main>

        <aside className="summary-rail">
          <section className="summary-panel summary-attention-panel"><div className="summary-panel-heading"><div><p className="summary-eyebrow">Priority queue</p><h2>Needs attention</h2></div><span className="summary-count-badge">{aggregate.exceptions.topOpen.length}</span></div><div className="summary-exception-list">{aggregate.exceptions.topOpen.length ? aggregate.exceptions.topOpen.map((exception) => <button className="summary-exception-row" key={exception.id} onClick={() => onOpenException?.(exception.id)}><span className="summary-exception-mark"><AlertTriangle size={14} /></span><span className="summary-exception-copy"><strong>{titleCase(exception.type)}</strong><em>{exception.ageDays} days open</em></span><span className="summary-exception-amount">{compactMoney(exception.amount)}<ArrowUpRight size={14} /></span></button>) : <div className="summary-clear-state"><Check size={20} /><p>No open exceptions</p><span>This mission is clear to close.</span></div>}</div><button className="summary-rail-link" onClick={onBack}>View all mission records <ArrowUpRight size={14} /></button></section>

          <section className="summary-panel summary-sources-panel"><div className="summary-panel-heading"><div><p className="summary-eyebrow">Source coverage</p><h2>By channel</h2></div></div>{["shopify", "cod", "amazon"].map((source) => { const stats = aggregate.matchHealth.bySource[source] || { matchRatePct: 0, unmatchedValue: 0, unmatchedCount: 0 }; const sales = aggregate.salesBySource[source] || { orderCount: 0, grossSales: 0 }; return <div className="summary-source-row" key={source}><div><strong>{titleCase(source)}</strong><span>{number.format(sales.orderCount)} orders · {compactMoney(sales.grossSales)} gross</span></div><div><strong>{stats.matchRatePct.toFixed(1)}%</strong><span>{number.format(stats.unmatchedCount)} open</span></div></div>; })}</section>

          <section className="summary-panel summary-cod-panel"><div className="summary-panel-heading"><div><p className="summary-eyebrow">Operations detail</p><h2>COD pulse</h2></div></div><div className="summary-mini-grid"><div><Clock3 size={15} /><strong>{aggregate.cod.avgSettlementLagDays.toFixed(1)}d</strong><span>Avg lag</span></div><div><RefreshCw size={15} /><strong>{number.format(aggregate.cod.remittanceCount)}</strong><span>Remittances</span></div><div><AlertTriangle size={15} /><strong>{number.format(aggregate.cod.rtoCount)}</strong><span>RTO events</span></div></div></section>
        </aside>
      </div>

      <footer className="summary-footer"><span>Generated {new Date(summary.generated_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })} · {summary.model} · v{summary.prompt_version}</span><button className="summary-regenerate" onClick={() => void loadSummary(true)} disabled={regenerating}><RefreshCw size={14} className={regenerating ? "summary-spin" : ""} /> {regenerating ? "Regenerating" : "Regenerate report"}</button></footer>
    </div>
  );
};

function SummaryStat({ label, value, detail, icon, tone = "default" }: { label: string; value: string; detail: string; icon: React.ReactNode; tone?: string }) { return <div className={`summary-stat ${tone}`}><div className="summary-stat-top"><span>{label}</span><i>{icon}</i></div><strong>{value}</strong><p>{detail}</p></div>; }

function SummarySkeleton({ onBack }: { onBack: () => void }) { return <div className="summary-shell summary-skeleton-shell"><button className="summary-back-link" onClick={onBack}><ArrowLeft size={16} /> All missions</button><div className="summary-skeleton-header"><span /><span /><span /></div><div className="summary-stat-grid">{[1, 2, 3, 4].map((item) => <div className="summary-skeleton-block" key={item} />)}</div><div className="summary-main-grid"><div className="summary-content-column"><div className="summary-skeleton-large" /><div className="summary-panel-grid"><div className="summary-skeleton-large" /><div className="summary-skeleton-large" /></div></div><div className="summary-skeleton-rail" /></div></div>; }
