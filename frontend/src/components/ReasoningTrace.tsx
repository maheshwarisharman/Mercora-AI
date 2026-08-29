import React, { useState } from "react";
import { ChevronDown, ChevronRight, CheckCircle2, Clock } from "lucide-react";

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

/** Human-readable summary of tool arguments */
function summariseArgs(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "get_exception_details":
      return `exception ${String(args.exception_id || "").slice(0, 8)}…`;
    case "get_amazon_deduction_context":
      return `Amazon exception ${String(args.exception_id || "").slice(0, 8)}…`;
    case "get_transaction_chain":
      return `order ref "${args.order_ref}"`;
    case "search_evidence": {
      const filters = args.filters as any;
      const parts: string[] = [`"${args.query}"`];
      if (filters?.amount_min !== undefined || filters?.amount_max !== undefined) {
        parts.push(`₹${filters.amount_min ?? "?"} – ₹${filters.amount_max ?? "?"}`);
      }
      if (filters?.customer_email) parts.push(filters.customer_email);
      return parts.join(" · ");
    }
    case "get_mission_summary":
      return `mission ${String(args.mission_id || "").slice(0, 8)}…`;
    case "list_open_exceptions": {
      const filters = args.filters as any;
      const parts = [`mission ${String(args.mission_id || "").slice(0, 8)}…`];
      if (filters?.exception_type) parts.push(`type: ${filters.exception_type}`);
      if (filters?.min_difference) parts.push(`min ₹${filters.min_difference}`);
      return parts.join(" · ");
    }
    case "request_human_review":
      return `exception ${String(args.exception_id || "").slice(0, 8)}… — "${String(args.reason || "").slice(0, 60)}…"`;
    default:
      return JSON.stringify(args).slice(0, 80);
  }
}

/** Friendly label for tool name */
function toolLabel(toolName: string): string {
  const labels: Record<string, string> = {
    get_exception_details: "Reviewed the exception",
    get_amazon_deduction_context: "Checked Amazon's fee breakdown",
    get_transaction_chain: "Trace Transaction Chain",
    search_evidence: "Searched for supporting records",
    get_mission_summary: "Mission Summary",
    list_open_exceptions: "List Open Exceptions",
    request_human_review: "Escalate for Human Review",
  };
  return labels[toolName] || toolName;
}

/** Left border colour per tool */
function toolBorderClass(toolName: string): string {
  const colours: Record<string, string> = {
    get_exception_details: "border-blue-400",
    get_transaction_chain: "border-violet-400",
    search_evidence: "border-emerald-400",
    get_mission_summary: "border-amber-400",
    list_open_exceptions: "border-cyan-400",
    request_human_review: "border-rose-400",
  };
  return colours[toolName] || "border-slate-300";
}

const TraceStep: React.FC<{ step: AgentTraceStep; index: number; isLast: boolean }> = ({
  step,
  index,
  isLast,
}) => {
  const [expanded, setExpanded] = useState(false);

  const resultStr =
    typeof step.result === "string"
      ? step.result
      : JSON.stringify(step.result, null, 2);

  return (
    <div className="flex gap-3">
      {/* Connector column */}
      <div className="flex flex-col items-center shrink-0">
        <div
          className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold ring-2 ring-offset-1 z-10 bg-black text-white`}
        >
          {index + 1}
        </div>
        {!isLast && <div className="w-px flex-1 bg-slate-200 mt-1 mb-0" />}
      </div>

      {/* Step card */}
      <div
        className={`flex-1 mb-3 bg-white border border-slate-200 rounded-xl overflow-hidden border-l-[3px] ${toolBorderClass(step.toolName)}`}
      >
        {/* Header row — clickable to expand result */}
        <button
          onClick={() => setExpanded((v) => !v)}
          className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-slate-50/80 transition-colors group"
        >
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={`text-[11px] font-semibold px-2 py-0.5`}
            >
              {toolLabel(step.toolName)}
            </span>
            <span className="text-[11px] text-slate-500 truncate">{summariseArgs(step.toolName, step.arguments)}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-2">
            <span className="flex items-center gap-1 text-[10px] text-slate-400 font-mono">
              <Clock size={10} />
              {new Date(step.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
            <span className="text-slate-400 group-hover:text-slate-600 transition-colors">
              {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </span>
          </div>
        </button>

        {/* Expanded result */}
        {expanded && (
          <div className="border-t border-slate-100 bg-slate-50/60 px-3 py-2.5">
            <pre className="text-[10px] text-slate-600 font-mono whitespace-pre-wrap break-all leading-relaxed max-h-48 overflow-y-auto">
              {resultStr}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * ReasoningTrace — collapsible ordered list of agent tool-call steps.
 * Used in both the exception judgment card and the Q&A panel.
 */
export const ReasoningTrace: React.FC<ReasoningTraceProps> = ({
  trace,
  hitStepBudget = false,
  className = "",
}) => {
  const [collapsed, setCollapsed] = useState(false);

  if (!trace || trace.length === 0) return null;

  return (
    <div className={`rounded-xl border border-slate-200 bg-slate-50/40 overflow-hidden ${className}`}>
      {/* Toggle header */}
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-slate-100/60 transition-colors"
        aria-expanded={!collapsed}
      >
        <div className="flex items-center gap-2">
          <CheckCircle2 size={14} className="text-indigo-500 shrink-0" />
          <span className="text-xs font-semibold text-slate-700">Agent Reasoning Trace</span>
          <span className="text-[10px] font-medium text-slate-500 bg-slate-200 px-2 py-0.5 rounded-full">
            {trace.length} step{trace.length !== 1 ? "s" : ""}
          </span>
          {hitStepBudget && (
            <span className="text-[10px] font-semibold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full ring-1 ring-amber-200">
              Budget reached
            </span>
          )}
        </div>
        <span className="text-slate-400">
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>

      {/* Steps list */}
      {!collapsed && (
        <div className="px-4 pt-3 pb-1">
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
