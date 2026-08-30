import React, { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Clock,
  CheckCircle2,
  FileSearch,
  Receipt,
  GitCommit,
  AlertTriangle,
  Building2,
  Search,
  ListFilter,
  Layers,
  ArrowRight,
} from "lucide-react";

export interface AgentTraceStep {
  stepIndex: number;
  toolName: string;
  arguments: Record<string, unknown>;
  result: unknown;
  timestamp: string;
}

interface ReasoningTraceProps {
  trace: AgentTraceStep[];
  hitStepBudget?: boolean;
  className?: string;
}

/** Human-friendly tool category label */
function toolLabel(toolName: string): string {
  const labels: Record<string, string> = {
    get_exception_details: "Discrepancy Inspection",
    get_amazon_deduction_context: "Amazon Fee Analysis",
    get_transaction_chain: "Payment Chain Trace",
    search_evidence: "Evidence & Ticket Search",
    get_bank_credit: "Bank Credit Verification",
    list_candidate_batches: "Batch Candidate Screening",
    get_narration_history: "Narration Pattern Check",
    get_mission_summary: "Mission Exposure Summary",
    list_open_exceptions: "Open Exceptions Query",
    request_human_review: "Escalated for Human Review",
  };
  return labels[toolName] || toolName.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
}

/** Tool icon mapping */
function ToolIcon({ toolName, size = 13 }: { toolName: string; size?: number }) {
  switch (toolName) {
    case "get_exception_details":
      return <Receipt size={size} className="text-[#18324b]" />;
    case "get_amazon_deduction_context":
      return <Layers size={size} className="text-[#c99548]" />;
    case "get_transaction_chain":
      return <GitCommit size={size} className="text-[#2e5962]" />;
    case "search_evidence":
      return <Search size={size} className="text-[#29745d]" />;
    case "get_bank_credit":
      return <Building2 size={size} className="text-[#18324b]" />;
    case "list_candidate_batches":
    case "list_open_exceptions":
      return <ListFilter size={size} className="text-[#5d7b82]" />;
    case "get_narration_history":
      return <FileSearch size={size} className="text-[#869b9d]" />;
    case "request_human_review":
      return <AlertTriangle size={size} className="text-[#b04b43]" />;
    default:
      return <CheckCircle2 size={size} className="text-[#29745d]" />;
  }
}

/** Human-readable summary of tool arguments */
function summariseArgs(toolName: string, args: Record<string, unknown>): string {
  if (!args || Object.keys(args).length === 0) return "";

  switch (toolName) {
    case "get_exception_details":
      return `Exception ID: ${String(args.exception_id || "").slice(0, 8)}…`;
    case "get_amazon_deduction_context":
      return `Amazon Ref: ${String(args.exception_id || "").slice(0, 8)}…`;
    case "get_transaction_chain":
      return `Order Ref: "${String(args.order_ref || "")}"`;
    case "search_evidence": {
      const filters = args.filters as any;
      const parts: string[] = [`Query: "${args.query || ""}"`];
      if (filters?.amount_min !== undefined || filters?.amount_max !== undefined) {
        parts.push(`₹${filters.amount_min ?? "?"}–₹${filters.amount_max ?? "?"}`);
      }
      if (filters?.customer_email) parts.push(filters.customer_email);
      return parts.join(" · ");
    }
    case "get_bank_credit":
      return `Bank Credit: ${String(args.id || "").slice(0, 8)}…`;
    case "list_candidate_batches": {
      const dr = args.date_range as any;
      return `Tolerance: ±₹${args.amount_tolerance ?? 0}${dr?.from ? ` (${dr.from} to ${dr.to})` : ""}`;
    }
    case "get_narration_history":
      return `Source: ${String(args.source || "")}`;
    case "get_mission_summary":
      return `Mission: ${String(args.mission_id || "").slice(0, 8)}…`;
    case "list_open_exceptions": {
      const filters = args.filters as any;
      const parts = [`Mission: ${String(args.mission_id || "").slice(0, 8)}…`];
      if (filters?.exception_type) parts.push(`Type: ${filters.exception_type}`);
      if (filters?.min_difference) parts.push(`Min: ₹${filters.min_difference}`);
      return parts.join(" · ");
    }
    case "request_human_review":
      return `Reason: "${String(args.reason || "").slice(0, 50)}…"`;
    default: {
      const entries = Object.entries(args)
        .map(([k, v]) => `${k}: ${typeof v === "object" ? "..." : String(v)}`)
        .slice(0, 2);
      return entries.join(" · ");
    }
  }
}

/** Formatter for INR amounts */
function formatInr(val: number | string | undefined | null): string {
  const num = Number(val);
  if (isNaN(num)) return "₹0.00";
  return `₹${num.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

interface MerchantInsight {
  headline: React.ReactNode;
  details?: React.ReactNode;
  badge?: { label: string; type: "positive" | "negative" | "gold" | "neutral" };
}

/** Extracts a high-impact 1-2 line merchant takeaway from tool results */
function extractMerchantTakeaway(toolName: string, result: any, args: Record<string, unknown>): MerchantInsight {
  if (!result) {
    return {
      headline: "No data returned from step.",
    };
  }

  if (typeof result === "object" && result !== null && "error" in result) {
    return {
      headline: <span className="text-[#b04b43] font-medium">Error: {String(result.error)}</span>,
      badge: { label: "Failed", type: "negative" },
    };
  }

  switch (toolName) {
    case "get_exception_details": {
      const ex = result.exception || {};
      const linkedEvents = Array.isArray(result.linked_events) ? result.linked_events : [];
      const diff = Number(ex.difference || 0);
      const diffLabel = diff > 0 ? `+${formatInr(diff)} discrepancy` : diff < 0 ? `${formatInr(diff)} discrepancy` : "Balanced (₹0.00)";
      const isDiscrepant = Math.abs(diff) > 0.01;

      return {
        headline: (
          <span>
            Discrepancy of <strong className={isDiscrepant ? "text-[#b04b43]" : "text-[#29745d]"}>{diffLabel}</strong> (Expected {formatInr(ex.expected_amount)} vs Actual {formatInr(ex.actual_amount)})
          </span>
        ),
        details: (
          <span>
            Identified {linkedEvents.length} linked event{linkedEvents.length !== 1 ? "s" : ""} across financial ledgers • Status: <span className="font-semibold text-[#18324b]">{ex.status || "unresolved"}</span>
          </span>
        ),
        badge: {
          label: isDiscrepant ? "Discrepancy" : "Matched",
          type: isDiscrepant ? "negative" : "positive",
        },
      };
    }

    case "get_amazon_deduction_context": {
      const line = result.amazon_line || {};
      const siblings = Array.isArray(result.settlement_siblings) ? result.settlement_siblings : [];
      const returnEvents = Array.isArray(result.known_return_events) ? result.known_return_events : [];
      const amountDesc = line.metadata?.amount_description || line.external_ref || "Amazon Settlement Line";

      return {
        headline: (
          <span>
            Amazon deduction <strong className="text-[#18324b] font-semibold">{amountDesc}</strong> for <strong className="text-[#b04b43]">{formatInr(line.amount)}</strong>
          </span>
        ),
        details: (
          <span>
            Linked to batch <span className="font-mono text-[#18324b]">{line.batch_ref || "N/A"}</span> • {siblings.length} settlement sibling(s) • {returnEvents.length} related return/refund event(s)
          </span>
        ),
        badge: { label: "Amazon Settlement", type: "gold" },
      };
    }

    case "get_transaction_chain": {
      const chain = Array.isArray(result.chain) ? result.chain : [];
      const match = result.match;
      const orderRef = result.order_ref || args.order_ref || "Order";

      if (chain.length === 0) {
        return {
          headline: `No recorded financial events found for order reference "${orderRef}".`,
          details: "Verified Shopify, payment gateway, and bank settlement streams.",
          badge: { label: "No Records", type: "neutral" },
        };
      }

      const stages = chain.map((e: any) => {
        const src = (e.source_system || e.event_type || "Event").toLowerCase();
        const amt = formatInr(e.amount);
        return `${src}: ${amt}`;
      });

      return {
        headline: (
          <div className="flex items-center flex-wrap gap-1.5 text-xs">
            <span className="font-medium text-[#18324b]">Chain ({chain.length} stages):</span>
            {stages.map((stage: string, idx: number) => (
              <React.Fragment key={idx}>
                <span className="bg-[#f1f4f0] text-[#18324b] border border-[#dfe7e3] px-1.5 py-0.5 font-mono text-[11px]">
                  {stage}
                </span>
                {idx < stages.length - 1 && <ArrowRight size={11} className="text-[#869b9d]" />}
              </React.Fragment>
            ))}
          </div>
        ),
        details: (
          <span>
            {match ? (
              <>
                Reconciliation status: <strong className="text-[#29745d]">{match.status || "Matched"}</strong> ({match.confidence ?? 100}% confidence match)
              </>
            ) : (
              "Events verified across lifecycle; no automated match rule has locked this chain yet."
            )}
          </span>
        ),
        badge: {
          label: match ? "Chain Matched" : `${chain.length} Events`,
          type: match ? "positive" : "neutral",
        },
      };
    }

    case "search_evidence": {
      const results = Array.isArray(result.results) ? result.results : [];
      const count = result.count ?? results.length;

      if (count === 0) {
        return {
          headline: `No matching tickets or refund records found for query "${result.query || args.query || ""}".`,
          details: "Searched merchant support desk and customer refund repository.",
          badge: { label: "0 Found", type: "neutral" },
        };
      }

      const top = results[0] || {};
      const sourceName = top.source_type === "support_ticket" ? "Support Ticket" : "Refund Record";

      return {
        headline: (
          <span>
            Found <strong className="text-[#18324b]">{count} evidence record{count !== 1 ? "s" : ""}</strong> • Top match: <strong className="text-[#29745d] font-mono">{top.source_ref}</strong> ({sourceName})
          </span>
        ),
        details: (
          <span>
            "{top.title}" {top.amount !== null && top.amount !== undefined ? `• ${formatInr(top.amount)}` : ""} (Relevance: {top.relevance_score}%)
          </span>
        ),
        badge: { label: `${count} Evidence Match${count !== 1 ? "es" : ""}`, type: "positive" },
      };
    }

    case "get_bank_credit": {
      const bank = result.bank_credit || {};
      return {
        headline: (
          <span>
            Bank Credit: <strong className="text-[#29745d] font-semibold">{formatInr(bank.amount)}</strong> settled on <span className="font-mono text-[#18324b]">{bank.event_date || "N/A"}</span>
          </span>
        ),
        details: (
          <span>
            Counterparty: <span className="text-[#18324b]">{bank.counterparty || bank.external_ref || "Bank deposit"}</span> • Source: {bank.source_system || "Bank"}
          </span>
        ),
        badge: { label: "Bank Credit", type: "positive" },
      };
    }

    case "list_candidate_batches": {
      const candidates = Array.isArray(result.candidates) ? result.candidates : [];
      if (candidates.length === 0) {
        return {
          headline: "No candidate settlement batches matched the requested date & tolerance criteria.",
          details: "Verified unmatched gateway settlements and COD remittances.",
          badge: { label: "0 Candidates", type: "neutral" },
        };
      }

      const top = candidates[0];
      return {
        headline: (
          <span>
            Evaluated <strong className="text-[#18324b]">{candidates.length} candidate batch{candidates.length !== 1 ? "es" : ""}</strong> • Best candidate: <span className="font-mono font-medium text-[#18324b]">{top.batch_reference}</span> ({formatInr(top.amount)})
          </span>
        ),
        details: (
          <span>
            Source: {top.source} • Date: {top.date} • Match Score: <strong className="text-[#29745d]">{top.score}%</strong>
          </span>
        ),
        badge: { label: `${candidates.length} Candidates`, type: "gold" },
      };
    }

    case "get_narration_history": {
      const examples = Array.isArray(result.examples) ? result.examples : [];
      return {
        headline: (
          <span>
            Found <strong className="text-[#18324b]">{examples.length} confirmed narration pattern{examples.length !== 1 ? "s" : ""}</strong> for <span className="font-medium text-[#18324b]">{result.source || "gateway"}</span>.
          </span>
        ),
        details: "Analyzed historical settlements to verify standard banking deposit formats.",
        badge: { label: "Pattern Verified", type: "neutral" },
      };
    }

    case "get_mission_summary": {
      const exposure = formatInr(result.unresolved_exposure_inr);
      return {
        headline: (
          <span>
            Mission health: <strong className="text-[#18324b]">{result.total_events ?? 0} events</strong> ({result.total_matches ?? 0} reconciled, {result.total_exceptions ?? 0} exceptions).
          </span>
        ),
        details: (
          <span>
            Total unresolved exposure: <strong className="text-[#b04b43]">{exposure}</strong>
          </span>
        ),
        badge: { label: "Mission Summary", type: "neutral" },
      };
    }

    case "list_open_exceptions": {
      const exList = Array.isArray(result.exceptions) ? result.exceptions : [];
      const count = result.count ?? exList.length;
      return {
        headline: (
          <span>
            Queried <strong className="text-[#18324b]">{count} open exception{count !== 1 ? "s" : ""}</strong> requiring attention.
          </span>
        ),
        details: exList[0] ? (
          <span>
            Highest impact item: <strong className="text-[#b04b43]">{formatInr(exList[0].difference)}</strong> ({exList[0].exception_type})
          </span>
        ) : (
          "No open exceptions matching the specified filters."
        ),
        badge: { label: `${count} Open`, type: count > 0 ? "negative" : "positive" },
      };
    }

    case "request_human_review": {
      const reason = result.reason || args.reason || "Ambiguous evidence requires human review.";
      return {
        headline: (
          <span className="text-[#b04b43] font-medium">
            Escalated to merchant finance team for manual verification.
          </span>
        ),
        details: (
          <span className="text-[#567079]">
            "{reason}"
          </span>
        ),
        badge: { label: "Human Review", type: "negative" },
      };
    }

    default: {
      if (typeof result === "string") {
        return {
          headline: result.length > 120 ? `${result.slice(0, 120)}…` : result,
        };
      }

      if (typeof result === "object") {
        const keys = Object.keys(result).filter((k) => typeof result[k] !== "object" || result[k] === null);
        const topSummary = keys.slice(0, 3).map((k) => `${k}: ${String(result[k])}`).join(" • ");
        return {
          headline: topSummary || "Step executed successfully.",
        };
      }

      return { headline: String(result) };
    }
  }
}

const TraceStep: React.FC<{ step: AgentTraceStep; index: number; isLast: boolean }> = ({
  step,
  index,
  isLast,
}) => {
  const insight = extractMerchantTakeaway(step.toolName, step.result, step.arguments);
  const argsSummary = summariseArgs(step.toolName, step.arguments);

  const badgeStyles = {
    positive: "bg-[#eef3ef] text-[#29745d] border-[#dfe7e3]",
    negative: "bg-[#fdf2f2] text-[#b04b43] border-[#f5c6cb]",
    gold: "bg-[#fbf7ee] text-[#c99548] border-[#ebd8b7]",
    neutral: "bg-[#f1f4f0] text-[#567079] border-[#dfe7e3]",
  };

  return (
    <div className="flex gap-3">
      {/* Connector column with sharp square step indicator */}
      <div className="flex flex-col items-center shrink-0">
        <div className="w-5 h-5 rounded-none flex items-center justify-center text-[10px] font-bold z-10 bg-[#18324b] text-[#fbfcfa] border border-[#18324b]">
          {index + 1}
        </div>
        {!isLast && <div className="w-px flex-1 bg-[#dfe7e3] my-1" />}
      </div>

      {/* Step card - Clean box design */}
      <div className="flex-1 mb-2.5 bg-[#fbfcfa] border border-[#dfe7e3] rounded-none overflow-hidden">
        {/* Step Header */}
        <div className="flex items-center justify-between px-3 py-2 bg-[#f1f4f0] border-b border-[#dfe7e3] text-left">
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            <div className="flex items-center gap-1.5 shrink-0">
              <ToolIcon toolName={step.toolName} size={13} />
              <span className="text-[11px] font-bold text-[#18324b] tracking-tight">
                {toolLabel(step.toolName)}
              </span>
            </div>

            {argsSummary && (
              <span className="text-[10px] font-mono text-[#567079] bg-[#fbfcfa] border border-[#dfe7e3] px-1.5 py-0.5 truncate max-w-[280px]">
                {argsSummary}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0 ml-2">
            {insight.badge && (
              <span className={`text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded-none ${badgeStyles[insight.badge.type]}`}>
                {insight.badge.label}
              </span>
            )}
            <span className="flex items-center gap-1 text-[10px] text-[#567079] font-mono">
              <Clock size={10} className="text-[#869b9d]" />
              {new Date(step.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
          </div>
        </div>

        {/* Merchant-focused 1-2 Line Insight Content */}
        <div className="px-3 py-2 text-xs text-[#18324b] bg-[#fbfcfa]">
          <div className="leading-snug text-[#18324b]">
            {insight.headline}
          </div>
          {insight.details && (
            <div className="mt-1 text-[11px] text-[#567079] leading-relaxed">
              {insight.details}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * ReasoningTrace — Collapsible merchant-first audit trace of agent tool calls.
 * Box-look design matching finance mission color palette.
 */
export const ReasoningTrace: React.FC<ReasoningTraceProps> = ({
  trace,
  hitStepBudget = false,
  className = "",
}) => {
  const [collapsed, setCollapsed] = useState(false);

  if (!trace || trace.length === 0) return null;

  return (
    <div className={`rounded-none border border-[#dfe7e3] bg-[#fbfcfa] overflow-hidden ${className}`}>
      {/* Box Header Banner */}
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center justify-between px-3.5 py-2 bg-[#f1f4f0] border-b border-[#dfe7e3] text-left hover:bg-[#eef3ef] transition-colors"
        aria-expanded={!collapsed}
      >
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 bg-[#18324b] text-[#c99548] flex items-center justify-center font-mono text-[9px] font-bold">
            ⚡
          </div>
          <span className="text-xs font-bold text-[#18324b] tracking-tight uppercase">
            Agent Reasoning & Evidence Trace
          </span>
          <span className="text-[10px] font-mono font-medium text-[#18324b] bg-[#fbfcfa] border border-[#dfe7e3] px-2 py-0.5 rounded-none">
            {trace.length} step{trace.length !== 1 ? "s" : ""}
          </span>
          {hitStepBudget && (
            <span className="text-[10px] font-semibold text-[#c99548] bg-[#fbf7ee] border border-[#ebd8b7] px-2 py-0.5 rounded-none">
              Budget Reached
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 text-xs text-[#567079]">
          <span className="text-[11px] font-mono">{collapsed ? "Show trace" : "Collapse"}</span>
          {collapsed ? <ChevronRight size={13} className="text-[#567079]" /> : <ChevronDown size={13} className="text-[#567079]" />}
        </div>
      </button>

      {/* Steps List */}
      {!collapsed && (
        <div className="p-3 bg-[#fbfcfa]">
          {trace.map((step, i) => (
            <TraceStep
              key={`${step.toolName}-${i}`}
              step={step}
              index={i}
              isLast={i === trace.length - 1}
            />
          ))}
        </div>
      )}
    </div>
  );
};
