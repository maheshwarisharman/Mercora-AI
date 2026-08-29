import React, { useState, useEffect, useRef } from "react";
import { useAuth } from "../context/AuthContext";
import {
  UploadCloud,
  AlertCircle,
  ArrowRight,
  RefreshCw,
  Filter,
  FileSpreadsheet,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Layers,
  ShieldAlert,
  Plus,
  Search,
  ArrowLeft,
  FileText,
  X,
  Send,
  MessageSquare,
  Bot,
  User,
} from "lucide-react";
import { ReasoningTrace, type AgentTraceStep } from "./ReasoningTrace";
import { MissionSummary } from "../pages/MissionSummary";

interface FinanceMission {
  id: string;
  merchant_id: string;
  period_start: string;
  period_end: string;
  sources: string[] | string;
  objective?: string | null;
  status: "created" | "ingesting" | "reconciling" | "needs_review" | "completed" | "closed";
  created_at: string;
}

interface SourceDoc {
  id: string;
  file_path: string;
  original_filename: string;
  detected_source:
    | "shopify_orders"
    | "razorpay_settlement"
    | "amazon_settlement"
    | "bank_statement"
    | "generic_cod"
    | "courier_settlement"
    | "vendor_invoice"
    | "support_export"
    | "unknown";
  detection_method: "filename_heuristic" | "gemini_classified" | "user_corrected";
  detection_confidence: number;
  uploaded_at: string;
  is_extracted?: boolean;
}

interface NormalizedEvent {
  id: string;
  mission_id: string;
  event_type: string;
  source_system: string;
  external_ref?: string | null;
  amount: number;
  currency: string;
  event_date: string;
  counterparty?: string | null;
  order_id?: string | null;
  payment_id?: string | null;
  customer_id?: string | null;
  batch_ref?: string | null;
  order_ids?: string[] | null;
  deduction_type?: string | null;
  metadata?: any;
  created_at: string;
}

interface ReconciledMatch {
  id: string;
  mission_id: string;
  event_ids: string[];
  match_type: "exact_id" | "amount_date_window" | "fuzzy_reference" | "settlement_chain";
  confidence: number;
  status: "auto_matched" | "proposed" | "confirmed" | "rejected";
  signals: Record<string, any>;
  created_at: string;
}

interface EvidenceItem {
  id: string;
  exception_id: string;
  source_type: "support_ticket" | "refund_record" | "manual_note" | "invoice" | "email" | "amazon_settlement";
  content: string;
  source_ref?: string | null;
  relevance_score?: number | null;
  found_by: string;
  created_at: string;
}

interface ExceptionJudgment {
  id: string;
  exception_id: string;
  classification: string;
  confidence: number;
  explanation: string;
  evidence_ids: string[];
  recommended_action?: string | null;
  generated_at: string;
}

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

const FRIENDLY_LABELS: Record<string, string> = {
  MISSING_BANK_CREDIT: "Bank payment not received yet",
  UNEXPLAINED_DIFFERENCE: "Amount doesn't match",
  AMAZON_UNKNOWN_DEDUCTION: "Unrecognized Amazon fee",
  AMAZON_RETURN_CLAWBACK: "Amazon deducted for a return",
  REQUIRES_HUMAN_REVIEW: "Needs Your Review",
  EXPLAINED: "Resolved",
};

function friendlyLabel(value: string): string {
  return FRIENDLY_LABELS[value.toUpperCase()] || value.replace(/_/g, " ");
}

function chainLegLabel(eventType: string): string {
  const labels: Record<string, string> = {
    SALE: "Sale",
    PAYMENT: "Payment",
    SETTLEMENT: "Settlement",
    BANK_TRANSACTION: "Bank Credit",
    FEE: "Fee",
  };
  return labels[eventType] || eventType.replace(/_/g, " ");
}

function evidenceSummary(ev: EvidenceItem): string {
  const rawContent = ev.content.trim();
  const amazonPrefix = "Verified Amazon settlement context:";
  const isAmazonContext = rawContent.startsWith(amazonPrefix);
  const jsonText = isAmazonContext ? rawContent.slice(amazonPrefix.length).trim() : rawContent;

  let parsed: Record<string, any> | null = null;
  try {
    const candidate = JSON.parse(jsonText);
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      parsed = candidate;
    }
  } catch {
    // Evidence from non-Amazon sources is already plain text.
  }

  if (!parsed) {
    return isAmazonContext ? "Amazon settlement evidence available" : rawContent;
  }

  if (!isAmazonContext && ev.source_type !== "amazon_settlement") {
    return "Verified supporting record available";
  }

  const metadata = parsed.metadata && typeof parsed.metadata === "object" ? parsed.metadata : {};
  const externalRef = String(parsed.external_ref || "");
  const settlementId = String(
    metadata.amazon_settlement_id ||
      parsed.batch_ref ||
      externalRef.split(":line-")[0] ||
      ""
  );
  const lineNumber = metadata.line_number || externalRef.match(/:line-(\d+)$/)?.[1];
  const orderRef = metadata.order_ref || parsed.order_ref || "";
  const amount = Number(parsed.amount);
  const amountText = Number.isFinite(amount)
    ? `₹${amount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`
    : "";
  const category = String(metadata.deduction_label || "settlement adjustment");
  const details = [amountText, category, orderRef ? `order ${orderRef}` : ""]
    .filter(Boolean)
    .join(" ");

  return `${settlementId ? `Amazon settlement ${settlementId}` : "Amazon settlement"}${
    lineNumber ? `, line ${lineNumber}` : ""
  }${details ? ` — ${details}` : ""}`;
}

interface MissionException {
  id: string;
  mission_id: string;
  normalized_event_ids: string[];
  exception_type:
    | "timing_difference"
    | "gateway_fee"
    | "refund"
    | "partial_refund"
    | "duplicate"
    | "missing_settlement"
    | "missing_bank_credit"
    | "ambiguous_bank_credit"
    | "unexplained_difference"
    | "amazon_unknown_deduction"
    | "amazon_return_clawback"
    | "amazon_fee_anomaly";
  expected_amount: number;
  actual_amount: number;
  difference: number;
  status: "open" | "investigating" | "explained" | "requires_human_review" | "resolved";
  created_at: string;
  evidence?: EvidenceItem[];
  exception_judgments?: ExceptionJudgment[];
}

export const FinanceMissionView: React.FC = () => {
  const { fetchWithAuth } = useAuth();

  // Missions List State (SaaS Table)
  const [missions, setMissions] = useState<FinanceMission[]>([]);
  const [loadingMissions, setLoadingMissions] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [missionSearchTerm, setMissionSearchTerm] = useState("");
  const [missionStatusFilter, setMissionStatusFilter] = useState("ALL");

  // Active Mission State
  const [activeMission, setActiveMission] = useState<FinanceMission | null>(null);
  const [showSummary, setShowSummary] = useState(false);
  const [documents, setDocuments] = useState<SourceDoc[]>([]);
  const [events, setEvents] = useState<NormalizedEvent[]>([]);
  const [matches, setMatches] = useState<ReconciledMatch[]>([]);
  const [exceptions, setExceptions] = useState<MissionException[]>([]);

  // Step 1: Mission Form State
  const [periodStart, setPeriodStart] = useState("2026-08-01");
  const [periodEnd, setPeriodEnd] = useState("2026-08-20");
  const [selectedSources, setSelectedSources] = useState<string[]>([
    "shopify",
    "razorpay",
    "bank",
  ]);
  const [objective, setObjective] = useState(
    "Reconcile Shopify sales against Razorpay settlements and HDFC bank credits"
  );
  const [creatingMission, setCreatingMission] = useState(false);
  const [missionError, setMissionError] = useState<string | null>(null);

  // Step 2: Upload & Classify State
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Step 3: Pipeline Extract & Normalize State
  const [processingPipeline, setProcessingPipeline] = useState(false);
  const [processLogs, setProcessLogs] = useState<string[]>([]);
  const [processError, setProcessError] = useState<string | null>(null);

  // Step 4: Reconcile State
  const [reconciling, setReconciling] = useState(false);
  const [reconcileLogs, setReconcileLogs] = useState<string[]>([]);
  const [reconcileError, setReconcileError] = useState<string | null>(null);

  // Step 5: Table Filters & UI State
  const [filterEventType, setFilterEventType] = useState<string>("ALL");
  const [filterSourceSystem, setFilterSourceSystem] = useState<string>("ALL");
  const [searchTerm, setSearchTerm] = useState("");

  // Exception Expansion & Investigation State
  const [expandedExceptionId, setExpandedExceptionId] = useState<string | null>(null);
  const [explainingExceptionId, setExplainingExceptionId] = useState<string | null>(null);
  const [selectedSignalsMatch, setSelectedSignalsMatch] = useState<ReconciledMatch | null>(null);
  const [exceptionTraces, setExceptionTraces] = useState<Record<string, AgentTraceStep[]>>({});
  const [exceptionBudgetHit, setExceptionBudgetHit] = useState<Record<string, boolean>>({});
  const exceptionRowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});

  // Settlement Q&A State
  const [qaMessages, setQaMessages] = useState<QAMessage[]>([]);
  const [qaInput, setQaInput] = useState("");
  const [qaConversationHistory, setQaConversationHistory] = useState<AgentMessage[]>([]);
  const [qaSending, setQaSending] = useState(false);
  const [qaError, setQaError] = useState<string | null>(null);
  const [highlightedExceptionId, setHighlightedExceptionId] = useState<string | null>(null);
  const qaBottomRef = useRef<HTMLDivElement | null>(null);

  // Fetch all missions from backend
  const fetchMissions = async () => {
    setLoadingMissions(true);
    try {
      const res = await fetchWithAuth("/api/finance/missions");
      if (res.ok) {
        const data = await res.json();
        setMissions(data.data || []);
      }
    } catch (err) {
      console.error("Error fetching missions list:", err);
    } finally {
      setLoadingMissions(false);
    }
  };

  useEffect(() => {
    fetchMissions();
  }, []);

  const openMission = (mission: FinanceMission) => {
    setActiveMission(mission);
    setShowSummary(mission.status === "needs_review" || mission.status === "completed" || mission.status === "closed");
  };

  // Helper to parse sources
  const parseSources = (sources: string[] | string | undefined | null): string[] => {
    if (!sources) return [];
    if (Array.isArray(sources)) return sources;
    try {
      const parsed = JSON.parse(sources);
      return Array.isArray(parsed) ? parsed : [String(sources)];
    } catch {
      return [String(sources)];
    }
  };

  // Load existing documents, events, matches & exceptions
  const loadMissionData = async (missionId: string) => {
    try {
      // 1. Fetch documents
      const docsRes = await fetchWithAuth(`/api/finance/missions/${missionId}/documents`);
      if (docsRes.ok) {
        const docsData = await docsRes.json();
        setDocuments(docsData.data || []);
      }

      // 2. Fetch normalized events
      const eventsRes = await fetchWithAuth(`/api/finance/missions/${missionId}/events`);
      if (eventsRes.ok) {
        const eventsData = await eventsRes.json();
        setEvents(eventsData.data || []);
      }

      // 3. Fetch Matches
      const matchesRes = await fetchWithAuth(`/api/finance/missions/${missionId}/matches`);
      if (matchesRes.ok) {
        const matchesData = await matchesRes.json();
        setMatches(matchesData.data || []);
      }

      // 4. Fetch Exceptions
      const exceptionsRes = await fetchWithAuth(`/api/finance/missions/${missionId}/exceptions`);
      if (exceptionsRes.ok) {
        const exceptionsData = await exceptionsRes.json();
        setExceptions(exceptionsData.data || []);
      }
    } catch (err) {
      console.error("Error loading mission details:", err);
    }
  };

  useEffect(() => {
    if (activeMission?.id) {
      loadMissionData(activeMission.id);
    }
  }, [activeMission?.id]);

  // Toggle Source Checkbox
  const toggleSource = (src: string) => {
    setSelectedSources((prev) =>
      prev.includes(src) ? prev.filter((s) => s !== src) : [...prev, src]
    );
  };

  // 1. Create Mission Handler
  const handleCreateMission = async (e: React.FormEvent) => {
    e.preventDefault();
    setMissionError(null);
    setCreatingMission(true);

    try {
      const res = await fetchWithAuth("/api/finance/missions", {
        method: "POST",
        body: JSON.stringify({
          period_start: periodStart,
          period_end: periodEnd,
          sources: selectedSources,
          objective: objective.trim() || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || "Failed to create mission");
      }

      setActiveMission(data.data);
      setShowSummary(false);
      setShowCreateModal(false);
      setDocuments([]);
      setEvents([]);
      setMatches([]);
      setExceptions([]);
      setProcessLogs([]);
      setReconcileLogs([]);
      fetchMissions();
    } catch (err: any) {
      setMissionError(err.message || "Failed to create finance mission");
    } finally {
      setCreatingMission(false);
    }
  };

  // 2. Upload and Auto-Classify Handler
  const handleFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0 || !activeMission) return;
    setUploading(true);
    setUploadError(null);

    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
      formData.append("files", files[i]);
    }

    try {
      const uploadRes = await fetchWithAuth(
        `/api/finance/missions/${activeMission.id}/documents`,
        {
          method: "POST",
          headers: {}, // let browser set boundary for multipart
          body: formData,
        }
      );

      const uploadData = await uploadRes.json();
      if (!uploadRes.ok) {
        throw new Error(uploadData.message || "Failed to upload document(s)");
      }

      const uploadedList: SourceDoc[] = Array.isArray(uploadData.data)
        ? uploadData.data
        : [uploadData.data];

      // Auto-classify each uploaded document immediately
      const classifiedDocs: SourceDoc[] = [];
      for (const doc of uploadedList) {
        const classifyRes = await fetchWithAuth(
          `/api/finance/missions/${activeMission.id}/documents/${doc.id}/classify`,
          { method: "POST" }
        );

        if (classifyRes.ok) {
          const classifyData = await classifyRes.json();
          classifiedDocs.push(classifyData.data);
        } else {
          classifiedDocs.push(doc);
        }
      }

      setDocuments((prev) => {
        const existingIds = new Set(classifiedDocs.map((d) => d.id));
        return [...prev.filter((d) => !existingIds.has(d.id)), ...classifiedDocs];
      });
    } catch (err: any) {
      setUploadError(err.message || "Error uploading or classifying documents");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // 2b. Manual Override Source Handler
  const handleOverrideSource = async (docId: string, newSource: string) => {
    if (!activeMission) return;
    try {
      const res = await fetchWithAuth(
        `/api/finance/missions/${activeMission.id}/documents/${docId}`,
        {
          method: "PATCH",
          body: JSON.stringify({ detected_source: newSource }),
        }
      );

      if (res.ok) {
        const data = await res.json();
        setDocuments((prev) =>
          prev.map((doc) => (doc.id === docId ? data.data : doc))
        );
      }
    } catch (err) {
      console.error("Error overriding document source:", err);
    }
  };

  // 3. Extract & Normalize Pipeline Trigger
  const handleExtractAndNormalize = async () => {
    if (!activeMission || documents.length === 0) return;

    setProcessingPipeline(true);
    setProcessError(null);
    setProcessLogs([]);

    const addLog = (msg: string) => {
      setProcessLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
    };

    try {
      addLog(`Starting extraction pipeline for Mission ${activeMission.id.slice(0, 8)}...`);

      // 3A. Extraction for each classified document
      for (const doc of documents) {
        if (doc.detected_source === "unknown") {
          addLog(`⚠️ Skipping '${doc.original_filename}' (source is unknown).`);
          continue;
        }

        addLog(`Extracting '${doc.original_filename}' as ${doc.detected_source}...`);
        const extRes = await fetchWithAuth(
          `/api/finance/missions/${activeMission.id}/documents/${doc.id}/extract`,
          { method: "POST" }
        );

        const extData = await extRes.json();
        if (!extRes.ok) {
          throw new Error(`Failed to extract ${doc.original_filename}: ${extData.message}`);
        }

        addLog(`✓ Extracted ${extData.count} records from '${doc.original_filename}'.`);
      }

      // 3B. Trigger Normalization
      addLog(`Normalizing canonical events (linking Shopify orders, COD remittances, payment-gateway settlements & bank transactions)...`);
      const normRes = await fetchWithAuth(
        `/api/finance/missions/${activeMission.id}/normalize`,
        { method: "POST" }
      );

      const normData = await normRes.json();
      if (!normRes.ok) {
        throw new Error(normData.message || "Failed during normalization step");
      }

      const summary = normData.data;
      addLog(`✓ Normalization complete! Created ${summary.events_created} canonical events.`);
      if (summary.by_type) {
        Object.entries(summary.by_type).forEach(([type, count]) => {
          addLog(`   • ${type}: ${count}`);
        });
      }

      setActiveMission((prev) => (prev ? { ...prev, status: "reconciling" } : null));
      await loadMissionData(activeMission.id);
      addLog(`🎉 Pipeline ready for deterministic reconciliation.`);
    } catch (err: any) {
      setProcessError(err.message || "Pipeline execution failed");
      addLog(`❌ Error: ${err.message}`);
    } finally {
      setProcessingPipeline(false);
    }
  };

  // 4. Reconcile Trigger
  const handleReconcile = async () => {
    if (!activeMission) return;

    setReconciling(true);
    setReconcileError(null);
    setReconcileLogs([]);

    const addLog = (msg: string) => {
      setReconcileLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
    };

    try {
      addLog(`Running multi-source reconciliation scoring engine (online and COD settlement paths)...`);
      const res = await fetchWithAuth(`/api/finance/missions/${activeMission.id}/reconcile`, {
        method: "POST",
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || "Reconciliation failed");
      }

      const summary = data.data;
      addLog(`✓ Matching complete! Created ${summary.matches_created} matched chains.`);
      addLog(`✓ Exception detection complete! Detected ${summary.exceptions_created} exceptions.`);

      if (summary.by_type) {
        Object.entries(summary.by_type).forEach(([type, count]) => {
          addLog(`   • Exception [${type}]: ${count}`);
        });
      }

      setActiveMission((prev) => (prev ? { ...prev, status: "needs_review" } : null));
      setShowSummary(true);
      await loadMissionData(activeMission.id);
      addLog(`🎉 Mission status updated to 'needs_review'. Ready for exception investigation.`);
    } catch (err: any) {
      setReconcileError(err.message || "Reconciliation execution failed");
      addLog(`❌ Error: ${err.message}`);
    } finally {
      setReconciling(false);
    }
  };

  // 5. "Explain this difference" Handler (Agent loop investigation)
  const handleExplainDifference = async (exceptionId: string) => {
    if (!activeMission) return;

    setExplainingExceptionId(exceptionId);
    try {
      const res = await fetchWithAuth(`/api/finance/exceptions/${exceptionId}/explain`, {
        method: "POST",
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || "Failed to explain exception");
      }

      // Store the agent trace for this exception
      if (data.data?.trace) {
        setExceptionTraces((prev) => ({ ...prev, [exceptionId]: data.data.trace }));
      }
      if (data.data?.hitStepBudget !== undefined) {
        setExceptionBudgetHit((prev) => ({ ...prev, [exceptionId]: data.data.hitStepBudget }));
      }

      await loadMissionData(activeMission.id);
      setExpandedExceptionId(exceptionId);
    } catch (err: any) {
      alert(`Error generating explanation: ${err.message}`);
    } finally {
      setExplainingExceptionId(null);
    }
  };

  // 6. Settlement Q&A Handler
  const handleAskQuestion = async () => {
    if (!activeMission || !qaInput.trim() || qaSending) return;

    const question = qaInput.trim();
    setQaInput("");
    setQaError(null);
    setQaSending(true);

    setQaMessages((prev) => [...prev, { role: "user", content: question }]);
    setQaMessages((prev) => [...prev, { role: "assistant", content: "", isLoading: true }]);

    try {
      const res = await fetchWithAuth(`/api/finance/missions/${activeMission.id}/ask`, {
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

  // Scroll to + highlight a cited exception row
  const scrollToException = (exceptionId: string) => {
    setHighlightedExceptionId(exceptionId);
    setExpandedExceptionId(exceptionId);
    exceptionRowRefs.current[exceptionId]?.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => setHighlightedExceptionId(null), 2500);
  };

  // Filtered Events calculation
  const filteredEvents = events.filter((evt) => {
    if (filterEventType !== "ALL" && evt.event_type !== filterEventType) return false;
    if (filterSourceSystem !== "ALL" && evt.source_system !== filterSourceSystem) return false;
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      const matchRef = evt.external_ref?.toLowerCase().includes(term);
      const matchParty = evt.counterparty?.toLowerCase().includes(term);
      const matchType = evt.event_type?.toLowerCase().includes(term);
      const matchDeduction = String(evt.metadata?.amount_description || evt.metadata?.deduction_label || "").toLowerCase().includes(term);
      return matchRef || matchParty || matchType || matchDeduction;
    }
    return true;
  });

  // Event lookup map for expanding exceptions
  const eventMap = new Map<string, NormalizedEvent>();
  events.forEach((e) => eventMap.set(e.id, e));

  // Summary Metrics
  const totalVolume = events.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
  const autoMatchedCount = matches.filter((m) => m.status === "auto_matched").length;
  const proposedCount = matches.filter((m) => m.status === "proposed").length;
  const amazonLineEvents = events.filter((event) => event.source_system === "amazon" && event.metadata?.amount_description);
  const amazonStatutoryCount = amazonLineEvents.filter((event) => event.metadata?.is_statutory_withholding).length;
  const amazonAgentCount = amazonLineEvents.filter((event) => event.metadata?.classification_method === "agent_required").length;
  const amazonCategoryCounts = amazonLineEvents.reduce<Record<string, number>>((counts, event) => {
    const category = String(event.metadata?.deduction_label || event.deduction_type || "Unclassified");
    counts[category] = (counts[category] || 0) + 1;
    return counts;
  }, {});

  // Filtered Missions for SaaS Table
  const filteredMissions = missions.filter((m) => {
    if (missionStatusFilter !== "ALL" && m.status !== missionStatusFilter) return false;
    if (missionSearchTerm) {
      const term = missionSearchTerm.toLowerCase();
      const idMatch = m.id.toLowerCase().includes(term);
      const objMatch = m.objective?.toLowerCase().includes(term);
      const startMatch = m.period_start.includes(term);
      const endMatch = m.period_end.includes(term);
      return idMatch || objMatch || startMatch || endMatch;
    }
    return true;
  });

  if (activeMission && showSummary) {
    return (
      <MissionSummary
        mission={activeMission}
        onBack={() => setShowSummary(false)}
        onOpenException={(exceptionId) => {
          setShowSummary(false);
          window.setTimeout(() => scrollToException(exceptionId), 0);
        }}
      />
    );
  }

  return (
    <div className="w-full space-y-6">
      {/* SaaS Dashboard Header */}
      <div className="bg-white border border-slate-200/80 rounded-2xl p-6 sm:p-8 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-6 transition-all">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2">
            {activeMission && (
              <span className="text-xs font-mono font-medium text-slate-500">
                / Mission #{activeMission.id.slice(0, 8)}
              </span>
            )}
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">
            {activeMission ? `Mission #${activeMission.id.slice(0, 8)}` : "Finance Missions"}
          </h1>
          <p className="text-sm text-slate-500 mt-1.5 max-w-3xl leading-relaxed">
            {activeMission
              ? activeMission.objective || "Reconcile multi-channel sales against settlement payouts and bank credits."
              : "Manage and execute multi-source financial reconciliation missions across Shopify, Razorpay, and Bank statements."}
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          {activeMission ? (
            <>
              {(activeMission.status === "needs_review" || activeMission.status === "completed" || activeMission.status === "closed") && (
                <button
                  onClick={() => setShowSummary(true)}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-slate-700 bg-white hover:bg-slate-50 transition-colors border border-slate-300 shadow-2xs cursor-pointer"
                >
                  <ShieldAlert size={16} />
                  <span>View summary</span>
                </button>
              )}
              <button
                onClick={() => { setActiveMission(null); setShowSummary(false); }}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 transition-colors border border-slate-200 shadow-2xs cursor-pointer"
              >
                <ArrowLeft size={16} />
                <span>All Missions Table</span>
              </button>
            </>
          ) : null}

          <button
            onClick={() => setShowCreateModal(true)}
            className="btn-primary"
          >
            <Plus size={17} className="stroke-[2.5]" />
            <span >New Mission</span>
          </button>
        </div>
      </div>

      {/* VIEW 1: ALL MISSIONS SAAS TABLE (when no active mission) */}
      {!activeMission ? (
        <div className="bg-white border border-slate-200/80 rounded-2xl shadow-xs overflow-hidden w-full">
          {/* Table Toolbar */}
          <div className="p-4 sm:p-5 border-b border-slate-200/80 bg-slate-50/60 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 flex-1 max-w-2xl">
              {/* Search Bar */}
              <div className="relative flex-1 min-w-[280px]">
                <Search size={17} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                <input
                  type="text"
                  placeholder="Search missions by ID, goal, or date range..."
                  value={missionSearchTerm}
                  onChange={(e) => setMissionSearchTerm(e.target.value)}
                  className="w-full pl-10 pr-4 py-2.5 text-sm bg-white border border-slate-200 rounded-xl text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-2xs transition-all"
                />
              </div>

              {/* Filter Dropdown */}
              <div className="flex items-center gap-2 shrink-0">
                <Filter size={15} className="text-slate-400 shrink-0" />
                <select
                  value={missionStatusFilter}
                  onChange={(e) => setMissionStatusFilter(e.target.value)}
                  className="px-3.5 py-2.5 text-sm bg-white border border-slate-200 rounded-xl text-slate-700 font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-2xs transition-all cursor-pointer"
                >
                  <option value="ALL">All Status</option>
                  <option value="created">Created</option>
                  <option value="ingesting">Ingesting</option>
                  <option value="reconciling">Reconciling</option>
                  <option value="needs_review">Needs Review</option>
                  <option value="closed">Closed</option>
                </select>
              </div>
            </div>

            <div className="text-xs font-semibold text-slate-500 shrink-0">
              Showing <span className="text-slate-900 font-bold">{filteredMissions.length}</span> of <span className="text-slate-900 font-bold">{missions.length}</span> missions
            </div>
          </div>

          {/* Full Width Table */}
          <div className="overflow-x-auto w-full">
            <table className="w-full text-left text-sm border-collapse">
              <thead>
                <tr className="border-b border-slate-200/80 bg-slate-50/80 text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                  <th className="py-4 px-6 min-w-[160px]">Mission ID</th>
                  <th className="py-4 px-6 min-w-[280px]">Goal</th>
                  <th className="py-4 px-6 min-w-[220px]">Date Period</th>
                  <th className="py-4 px-6 min-w-[240px]">Recon Sources</th>
                  <th className="py-4 px-6 min-w-[160px]">Status</th>
                  <th className="py-4 px-6 min-w-[140px]">Created</th>
                  <th className="py-4 px-6 min-w-[110px] text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {loadingMissions ? (
                  <tr>
                    <td colSpan={6} className="py-16 text-center text-slate-400">
                      <div className="inline-flex items-center gap-3 px-4 py-2 rounded-xl bg-slate-50 border border-slate-200/70">
                        <div className="w-4 h-4 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
                        <span className="text-sm font-medium text-slate-600">Loading finance missions...</span>
                      </div>
                    </td>
                  </tr>
                ) : filteredMissions.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-20 text-center text-slate-400">
                      <FileText size={40} className="mx-auto mb-3 text-slate-300 stroke-[1.5]" />
                      <p className="font-bold text-slate-800 text-base">No finance missions found</p>
                      <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">Create your first mission to initialize automated reconciliation across Shopify, Razorpay & Bank data.</p>
                      <button
                        onClick={() => setShowCreateModal(true)}
                        className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 transition-all shadow-xs cursor-pointer"
                      >
                        <Plus size={15} />
                        <span>Create Mission</span>
                      </button>
                    </td>
                  </tr>
                ) : (
                  filteredMissions.map((m) => {
                    const srcs = parseSources(m.sources);
                    return (
                      <tr
                        key={m.id}
                        onClick={() => openMission(m)}
                        className="hover:bg-slate-50/80 transition-colors cursor-pointer group"
                      >
                        {/* Mission ID & Goal */}
                        <td className="py-4.5 px-6 whitespace-nowrap">
                          <div className="inline-flex items-center gap-3">
                            <span className="font-mono font-bold text-xs text-slate-800 px-2.5 py-1 rounded-md shrink-0">
                              #{m.id.slice(0, 8)}
                            </span>
                          </div>
                        </td>

                        {/* Mission Goal */}
                        <td className="py-4.5 px-6 text-xs font-medium text-slate-700 whitespace-nowrap ">
                          <div className="inline-flex items-center gap-2 px-3 py-1 font-mono text-[12px]">
                          <span className="text-sm font-medium text-slate-800 truncate max-w-[300px]" title={m.objective || "Financial Reconciliation"}>
                            {m.objective || "Financial Reconciliation"}
                          </span>
                          </div>
                        </td>

                        {/* Period */}
                        <td className="py-4.5 px-6 text-xs font-medium text-slate-700 whitespace-nowrap">
                          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-lg bg-slate-50 border border-slate-200/70 font-mono text-[12px]">
                            <span>{m.period_start}</span>
                            <span className="text-slate-400 font-bold">→</span>
                            <span>{m.period_end}</span>
                          </div>
                        </td>

                        {/* Sources */}
                        <td className="py-4.5 px-6">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {srcs.map((s) => (
                              <span
                                key={s}
                                className="text-xs font-medium px-2.5 py-1 rounded-md bg-slate-100 text-slate-700 border border-slate-200/80 capitalize"
                              >
                                {s}
                              </span>
                            ))}
                          </div>
                        </td>

                        {/* Status */}
                        <td className="py-4.5 px-6 whitespace-nowrap">
                          <span
                            className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold border capitalize ${
                              m.status === "closed" || m.status === "completed"
                                ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                : m.status === "needs_review"
                                ? "bg-amber-50 text-amber-700 border-amber-200"
                                : m.status === "reconciling"
                                ? "bg-indigo-50 text-indigo-700 border-indigo-200"
                                : m.status === "ingesting"
                                ? "bg-blue-50 text-blue-700 border-blue-200"
                                : "bg-slate-100 text-slate-700 border-slate-200"
                            }`}
                          >
                            <span
                              className={`w-2 h-2 rounded-full ${
                                m.status === "closed" || m.status === "completed"
                                  ? "bg-emerald-500"
                                  : m.status === "needs_review"
                                  ? "bg-amber-500 animate-pulse"
                                  : m.status === "reconciling"
                                  ? "bg-indigo-500 animate-pulse"
                                  : m.status === "ingesting"
                                  ? "bg-blue-500 animate-pulse"
                                  : "bg-slate-400"
                              }`}
                            />
                            <span>{m.status.replace("_", " ")}</span>
                          </span>
                        </td>

                        {/* Created Date */}
                        <td className="py-4.5 px-6 text-xs font-medium text-slate-500 whitespace-nowrap">
                          {new Date(m.created_at).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                        </td>

                        {/* Action Button */}
                        <td className="py-4.5 px-6 text-right whitespace-nowrap">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              openMission(m);
                            }}
                            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200/80 group-hover:border-indigo-300 transition-all shadow-2xs cursor-pointer"
                          >
                            <span>Open</span>
                            <ArrowRight size={13} className="group-hover:translate-x-0.5 transition-transform" />
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <>
          {/* STEP 2: Document Upload & Classification */}
          <section className="finance-step-card">
            <div className="step-badge-row">
              <span className="step-num">Step 2</span>
              <h2 className="step-heading">Source Documents & Heuristic Understanding</h2>
            </div>
            <p className="step-description">
              Upload your Shopify orders, Razorpay transactions, Amazon settlement, courier COD, and bank statement files.
              We’ll recognize each file automatically and organize it so you can compare sales, payouts, fees, returns, and bank deposits.
            </p>

            {uploadError && (
              <div className="alert alert-error">
                <AlertCircle size={18} />
                <span>{uploadError}</span>
              </div>
            )}

            {/* Dropzone */}
            <div
              className={`dropzone ${uploading ? "uploading" : ""}`}
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                type="file"
                ref={fileInputRef}
                multiple
                accept=".csv,.txt"
                style={{ display: "none" }}
                onChange={(e) => handleFileUpload(e.target.files)}
              />
              <UploadCloud size={36} className="dropzone-icon" />
              <div className="dropzone-text">
                <strong>Click or drop CSV / TXT files here to upload</strong>
                <span>Supports Shopify, Razorpay, Amazon Flat File V2, COD Courier, and Bank exports</span>
              </div>
              {uploading && (
                <div className="dropzone-loading">
                  <div className="spinner-sm" />
                  <span>Uploading to Supabase Storage and classifying...</span>
                </div>
              )}
            </div>

            {/* Uploaded Documents List */}
            {documents.length > 0 && (
              <div className="documents-list">
                <h4 className="docs-list-title">Uploaded Source Documents ({documents.length})</h4>
                <div className="docs-grid">
                  {documents.map((doc) => (
                    <div key={doc.id} className="doc-card">
                      <div className="doc-card-top">
                        <FileSpreadsheet size={20} className="text-indigo" />
                        <span className="doc-filename truncate">{doc.original_filename}</span>
                      </div>

                      <div className="doc-meta-row">
                        <span className={`badge-source ${doc.detected_source}`}>
                          {doc.detected_source.replace("_", " ")}
                        </span>
                        <span className="confidence-pill">
                          {doc.detection_confidence}% confidence
                        </span>
                      </div>

                      {/* Manual Override Dropdown */}
                      <div className="doc-override-row">
                        <span className="override-label">Override:</span>
                        <select
                          value={doc.detected_source}
                          onChange={(e) => handleOverrideSource(doc.id, e.target.value)}
                          className="select-sm"
                        >
                          <option value="shopify_orders">Shopify Orders</option>
                          <option value="razorpay_settlement">Razorpay Settlement</option>
                          <option value="amazon_settlement">Amazon Flat File V2</option>
                          <option value="generic_cod">Generic COD Remittance</option>
                          <option value="courier_settlement">Courier Settlement</option>
                          <option value="bank_statement">Bank Statement</option>
                          <option value="unknown">Unknown</option>
                        </select>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* STEP 3: Extraction & Normalization Action */}
          <section className="finance-step-card">
            <div className="step-badge-row">
              <span className="step-num">Step 3</span>
              <h2 className="step-heading">Extract & Normalize Canonical Events</h2>
            </div>
            <p className="step-description">
              We turn your uploaded files into one easy-to-follow view of sales, payments, payouts, fees, refunds, and other money movements.
              Amazon settlement lines stay separate so every fee and deduction can be checked.
            </p>

            <div className="pipeline-action-row">
              <button
                onClick={handleExtractAndNormalize}
                disabled={processingPipeline || documents.length === 0}
                className="btn-primary"
              >
                {processingPipeline ? (
                  <>
                    <div className="spinner-sm" />
                    <span>Processing Files...</span>
                  </>
                ) : (
                  <>
                    <RefreshCw size={18} />
                    <span>Process Uploaded Files</span>
                  </>
                )}
              </button>
              <span className="btn-helper-text">
                {documents.length} files processed • {events.length} transactions found
              </span>
            </div>

            {processError && (
              <div className="alert alert-error mt-4">
                <AlertCircle size={18} />
                <span>{processError}</span>
              </div>
            )}

            {/* Realtime Process Log Stream */}
            {processLogs.length > 0 && (
              <div className="process-logs-terminal">
                <div className="terminal-header">
                  <span className="terminal-dot red" />
                  <span className="terminal-dot yellow" />
                  <span className="terminal-dot green" />
                  <span className="terminal-title">Extraction & Normalization Log</span>
                </div>
                <div className="terminal-body">
                  {processLogs.map((log, idx) => (
                    <div key={idx} className="terminal-line">
                      {log}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* STEP 4: Reconciliation & Exception Detection */}
          <section className="finance-step-card">
            <div className="step-badge-row">
              <span className="step-num">Step 4</span>
              <h2 className="step-heading">Reconciliation & Exception Detection</h2>
            </div>
            <p className="step-description">
              We compare each sale with its payment, marketplace or courier payout, and bank deposit.
              Anything that doesn’t line up—such as a missing payout, return, fee, or amount difference—is flagged for you to review.
            </p>

            <div className="pipeline-action-row">
              <button
                onClick={handleReconcile}
                disabled={reconciling || events.length === 0}
                className="btn-primary"
              >
                {reconciling ? (
                  <>
                    <div className="spinner-sm" />
                    <span>Matching Transactions...</span>
                  </>
                ) : (
                  <>
                    <Layers size={18} />
                    <span>Match Transactions</span>
                  </>
                )}
              </button>
              <span className="btn-helper-text">
                {matches.length} chain(s) matched ({autoMatchedCount} auto-matched, {proposedCount} proposed) • {exceptions.length} exception(s) detected
              </span>
            </div>

            {reconcileError && (
              <div className="alert alert-error mt-4">
                <AlertCircle size={18} />
                <span>{reconcileError}</span>
              </div>
            )}

            {/* Realtime Reconcile Log Stream */}
            {reconcileLogs.length > 0 && (
              <div className="process-logs-terminal">
                <div className="terminal-header">
                  <span className="terminal-dot red" />
                  <span className="terminal-dot yellow" />
                  <span className="terminal-dot green" />
                  <span className="terminal-title">Reconciliation Execution Log</span>
                </div>
                <div className="terminal-body">
                  {reconcileLogs.map((log, idx) => (
                    <div key={idx} className="terminal-line">
                      {log}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {amazonLineEvents.length > 0 && (
              <section className="amazon-reconciliation-panel" aria-labelledby="amazon-reconciliation-heading">
                <div className="amazon-panel-heading">
                  <div>
                    <div className="amazon-kicker">Amazon Fee Breakdown</div>
                    <h3 id="amazon-reconciliation-heading">Every deduction line, accounted for</h3>
                    <p>Known fees are classified deterministically. New codes and return clawbacks are queued for agent investigation.</p>
                  </div>
                  <div className="amazon-panel-count">{amazonLineEvents.length} line items</div>
                </div>
                <div className="amazon-summary-grid">
                  <div><strong>{amazonStatutoryCount}</strong><span>statutory withholdings excluded from anomalies</span></div>
                  <div><strong>{amazonAgentCount}</strong><span>need a closer look</span></div>
                  <div><strong>{Object.keys(amazonCategoryCounts).length}</strong><span>fee types found</span></div>
                </div>
                <div className="amazon-line-table-wrap">
                  <table className="amazon-line-table">
                    <thead><tr><th>Code</th><th>Category</th><th>Order</th><th>Amount</th><th>Decision</th></tr></thead>
                    <tbody>
                      {amazonLineEvents.map((event) => {
                        const linkedException = exceptions.find((exception) => exception.normalized_event_ids.includes(event.id));
                        const requiresAgent = event.metadata?.classification_method === "agent_required";
                        const feeCode = event.metadata?.amount_description || event.metadata?.amount_type || "Adjustment";
                        const feeCategory = event.metadata?.deduction_label || event.deduction_type || "Unclassified";
                        return (
                          <tr key={event.id}>
                            <td>
                              <strong>{feeCategory}</strong>
                              <small className="block text-slate-500">{feeCode}</small>
                            </td>
                            <td>{feeCategory}</td>
                            <td>{event.metadata?.order_ref || "Settlement-level"}</td>
                            <td className="amazon-amount">₹{Number(event.amount).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td>
                            <td>
                              {event.metadata?.is_statutory_withholding ? <span className="amazon-decision expected">Expected statutory</span> :
                                requiresAgent && linkedException ? <button className="amazon-decision review" onClick={() => scrollToException(linkedException.id)}>Investigate with agent</button> :
                                requiresAgent ? <span className="amazon-decision review">Agent review queued</span> :
                                <span className="amazon-decision classified">Classified</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {/* 4A. MATCHES TABLE */}
            {matches.length > 0 && (
              <div className="mt-6">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="docs-list-title">Reconciled Chains ({matches.length})</h4>
                  <div className="flex gap-2">
                    <span className="font-bold text-sm">
                      ✓ {autoMatchedCount} Auto-Matched (≥85%)
                    </span>
                    {proposedCount > 0 && (
                      <span className="match-status-badge proposed">
                        ⚠ {proposedCount} Proposed (50–84%)
                      </span>
                    )}
                  </div>
                </div>

                <div className="w-full overflow-x-auto rounded-xl border border-slate-200/80 bg-white shadow-xs">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-200/80 bg-slate-50/80 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                        <th className="px-4 py-3">Order Ref</th>
                        <th className="px-4 py-3">Match Type</th>
                        <th className="px-4 py-3">Confidence</th>
                        <th className="px-4 py-3">Status</th>
                        <th className="px-4 py-3">Chain Legs</th>
                        <th className="px-4 py-3">Signals Breakdown</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {matches.map((m) => {
                        const linkedEvts = (m.event_ids || [])
                          .map((id) => eventMap.get(id))
                          .filter(Boolean) as NormalizedEvent[];

                        const saleEvt = linkedEvts.find((e) => e.event_type === "SALE");
                        const orderRef = saleEvt?.external_ref || saleEvt?.metadata?.order_number || m.id.slice(0, 8);

                        return (
                          <tr key={m.id} className="hover:bg-slate-50/60 transition-colors">
                            <td className="px-4 py-3">
                              <code className="ref-code">{orderRef}</code>
                            </td>
                            <td className="px-4 py-3">
                              <span className="match-type-tag">{m.match_type.match("exact_id") ? "Exact" : "Best-effort match"}</span>
                            </td>
                            <td className="px-4 py-3 font-semibold text-slate-700">
                              <span>
                                {m.confidence}%
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              <span className="capitalize text-slate-600 font-medium">
                                {m.status.replace(/_/g, " ")}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex gap-1">
                                {linkedEvts.map((e) => (
                                  <span key={e.id} className={`event-badge ${e.event_type}`}>
                                    {chainLegLabel(e.event_type)}
                                  </span>
                                ))}
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <button
                                onClick={() =>
                                  setSelectedSignalsMatch(
                                    selectedSignalsMatch?.id === m.id ? null : m
                                  )
                                }
                                className="btn-text-sm"
                              >
                                {selectedSignalsMatch?.id === m.id ? "Hide Match Details" : "View Match Details"}
                              </button>
                              {selectedSignalsMatch?.id === m.id && (
                                <div className="mt-2 p-2 bg-slate-100 rounded text-xs font-mono">
                                  <pre>{JSON.stringify(m.signals, null, 2)}</pre>
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* 4B. EXCEPTIONS TABLE */}
            {exceptions.length > 0 && (
              <div className="mt-8">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <ShieldAlert size={20} className="text-amber" />
                    <h4 className="docs-list-title">Detected Exceptions & Discrepancies ({exceptions.length})</h4>
                  </div>
                </div>

                <div className="w-full overflow-x-auto rounded-xl border border-slate-200/80 bg-white shadow-xs">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-200/80 bg-slate-50/80 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                        <th className="px-4 py-3">Exception Type</th>
                        <th className="px-4 py-3">Expected Net</th>
                        <th className="px-4 py-3">Actual Amount</th>
                        <th className="px-4 py-3">Discrepancy</th>
                        <th className="px-4 py-3">Status</th>
                        <th className="px-4 py-3">Investigation & Explanation</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {exceptions.map((ex) => {
                        const isExpanded = expandedExceptionId === ex.id;
                        const isExplaining = explainingExceptionId === ex.id;
                        const latestJudgment = ex.exception_judgments?.[0];
                        const evidenceList = ex.evidence || [];
                        const exTrace = exceptionTraces[ex.id];
                        const hitBudget = exceptionBudgetHit[ex.id];
                        const isHumanReview = latestJudgment?.classification === "REQUIRES_HUMAN_REVIEW";
                        const isHighlighted = highlightedExceptionId === ex.id;

                        return (
                          <React.Fragment key={ex.id}>
                            <tr
                              ref={(el) => { exceptionRowRefs.current[ex.id] = el; }}
                              style={isHighlighted ? { outline: "2px solid #6366f1", outlineOffset: "-2px", background: "#eef2ff" } : {}}
                              className="hover:bg-slate-50/60 transition-colors"
                            >
                              <td className="px-4 py-3">
                                <span className={`exception-badge ${ex.exception_type}`}>
                                  {friendlyLabel(ex.exception_type)}
                                </span>
                              </td>
                              <td className="px-4 py-3 font-semibold text-slate-900 font-mono">
                                ₹{Number(ex.expected_amount).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                              </td>
                              <td className="px-4 py-3 font-semibold text-slate-900 font-mono">
                                ₹{Number(ex.actual_amount).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                              </td>
                              <td className="px-4 py-3 font-bold text-rose-600 font-mono">
                                ₹{Number(ex.difference).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                              </td>
                              <td className="px-4 py-3">
                                <span className={`status-badge-sm ${ex.status}`}>
                                  {friendlyLabel(ex.status)}
                                </span>
                              </td>
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-2">
                                <button
                                  onClick={() => handleExplainDifference(ex.id)}
                                  disabled={isExplaining}
                                  title="Chains plain retrieval, LLM investigation, and LLM judgment"
                                  className="btn-primary"
                                >
                                  {isExplaining ? (
                                    <>
                                      <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-900" />
                                      <span>Investigating...</span>
                                    </>
                                  ) : (
                                    <>
                                      <span>Explain difference</span>
                                    </>
                                  )}
                                </button>

                                  <button
                                    onClick={() => setExpandedExceptionId(isExpanded ? null : ex.id)}
                                    className="h-9 px-3 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-medium rounded-lg transition-colors flex items-center gap-1.5"
                                  >
                                    <span>{isExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</span>
                                    <span>{isExpanded ? "Hide Details" : "View Order Details"}</span>
                                  </button>
                                </div>
                              </td>
                            </tr>

                            {/* EXPANDED ROW: Linked Events and/or Rich Judgment Card */}
                            {isExpanded && (
                              <tr>
                                <td colSpan={6} className="p-0 bg-slate-50/50">
                                  <div className="p-4 bg-slate-50 border-y border-slate-200">
                                    {/* Linked Events Subtable */}
                                    <div className="mb-4">
                                      <h5 className="inline-events-title">
                                        {ex.exception_type === "ambiguous_bank_credit" ? "Candidate Events" : "Linked Chain Events"} ({ex.normalized_event_ids?.length || 0})
                                      </h5>
                                      <div className="w-full overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-xs">
                                        <table className="w-full text-left border-collapse text-xs">
                                          <thead>
                                            <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                                              <th className="px-3 py-2">Event Type</th>
                                              <th className="px-3 py-2">Source</th>
                                              <th className="px-3 py-2">Ref</th>
                                              <th className="px-3 py-2">Amount</th>
                                              <th className="px-3 py-2">Date</th>
                                              <th className="px-3 py-2">Counterparty</th>
                                            </tr>
                                          </thead>
                                          <tbody className="divide-y divide-slate-100">
                                            {(ex.normalized_event_ids || []).map((id) => {
                                              const evt = eventMap.get(id);
                                              if (!evt) return null;
                                              return (
                                                <tr key={evt.id} className="hover:bg-slate-50/60 transition-colors">
                                                  <td className="px-3 py-2">
                                                    <span className={`event-badge ${evt.event_type}`}>
                                                      {evt.event_type}
                                                    </span>
                                                  </td>
                                                  <td className="px-3 py-2 capitalize font-medium text-slate-700">{evt.source_system}</td>
                                                  <td className="px-3 py-2">
                                                    <code className="ref-code">{evt.external_ref || "—"}</code>
                                                  </td>
                                                  <td className="px-3 py-2 font-semibold text-slate-900 font-mono">
                                                    ₹{Number(evt.amount).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                                                  </td>
                                                  <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{evt.event_date}</td>
                                                  <td className="px-3 py-2 text-slate-700">{evt.counterparty || "—"}</td>
                                                </tr>
                                              );
                                            })}
                                          </tbody>
                                        </table>
                                      </div>
                                    </div>

                                    {/* Budget Reached / Human Review Banner */}
                                    {(hitBudget || isHumanReview) && (
                                      <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4 text-amber-800">
                                        <ShieldAlert size={18} className="shrink-0 mt-0.5" />
                                        <div>
                                          <strong className="text-sm font-semibold">
                                            {isHumanReview ? "Escalated for Human Review" : "Investigation Budget Reached"}
                                          </strong>
                                          <p className="text-xs mt-0.5 text-amber-700">
                                            {isHumanReview
                                              ? "The agent determined evidence was insufficient to classify this exception confidently. A human analyst should review it."
                                              : "The agent exhausted its 6-step investigation budget. The best available answer was committed, but confidence may be lower than usual."}
                                          </p>
                                        </div>
                                      </div>
                                    )}

                                    {/* Agent Reasoning Trace */}
                                    {exTrace && exTrace.length > 0 && (
                                      <ReasoningTrace
                                        trace={exTrace}
                                        hitStepBudget={hitBudget}
                                        className="mb-4"
                                      />
                                    )}

                                    {/* RICH JUDGMENT EXPLANATION CARD (Killer Feature UI) */}
                                    {latestJudgment && (
                                      <div className="judgment-card">
                                        <div className="judgment-header">
                                          <div className="judgment-title-row">
                                            <span className={"font-bold"}>
                                              {friendlyLabel(latestJudgment.classification)}
                                            </span>
                                            <span className="text-xs font-medium text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">
                                              {latestJudgment.confidence}% confidence
                                            </span>
                                          </div>
                                        </div>

                                        <div className="judgment-body">
                                          {/* Explanation Text */}
                                          <div className="judgment-explanation-text">
                                            <strong>Financial Explanation:</strong> {latestJudgment.explanation}
                                          </div>

                                          {/* Cited Evidence List */}
                                          {evidenceList.length > 0 && (
                                            <div className="judgment-evidence-section">
                                              <div className="evidence-section-title">
                                                Cited Verified Evidence ({evidenceList.length})
                                              </div>
                                              <div className="evidence-items-grid">
                                                {evidenceList.map((ev) => (
                                                  <div key={ev.id} className="evidence-item-card">
                                                    <div className="evidence-item-top">
                                                      <span className="evidence-source-tag">
                                                        {ev.source_type.replace(/_/g, " ")}
                                                      </span>
                                                      <span className="evidence-ref-tag">{ev.source_ref}</span>
                                                    </div>
                                                    <div className="evidence-snippet">{evidenceSummary(ev)}</div>
                                                  </div>
                                                ))}
                                              </div>
                                            </div>
                                          )}

                                          {/* Recommended Action */}
                                          {latestJudgment.recommended_action && (
                                            <div className="judgment-action-box">
                                              <CheckCircle2 size={18} />
                                              <div>
                                                <strong>Recommended Action:</strong> {latestJudgment.recommended_action}
                                              </div>
                                            </div>
                                          )}
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* SETTLEMENT Q&A PANEL */}
            {exceptions.length > 0 && (
              <div className="mt-8 rounded-2xl border border-indigo-100 bg-gradient-to-br from-indigo-50/40 to-slate-50 overflow-hidden shadow-sm">
                {/* Panel header */}
                <div className="px-5 pt-5 pb-4 border-b border-indigo-100">
                  <div className="flex items-center gap-2.5 mb-1">
                    <div className="w-8 h-8 rounded-xl bg-indigo-600 flex items-center justify-center shadow-sm">
                      <Bot size={16} className="text-white" />
                    </div>
                    <div>
                      <h4 className="text-sm font-bold text-slate-800">Settlement Q&amp;A</h4>
                      <p className="text-xs text-slate-500">
                        Ask anything about this mission — the agent uses its tools to answer and shows its reasoning.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Message list */}
                <div className="px-5 py-4 space-y-4 max-h-[480px] overflow-y-auto">
                  {qaMessages.length === 0 && (
                    <div className="py-8 text-center">
                      <div className="w-12 h-12 rounded-2xl bg-indigo-100 flex items-center justify-center mx-auto mb-3">
                        <MessageSquare size={22} className="text-indigo-400" />
                      </div>
                      <p className="text-sm font-semibold text-slate-600 mb-1">Ask about this mission</p>
                      <p className="text-xs text-slate-400 max-w-xs mx-auto">
                        Try: "What needs my attention?", "How much is unresolved?", or "Why did Razorpay settle less than expected?"
                      </p>
                    </div>
                  )}

                  {qaMessages.map((msg, i) => (
                    <div key={i} className={`flex gap-3 ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}>
                      {/* Avatar */}
                      <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
                        msg.role === "user"
                          ? "bg-slate-800 text-white"
                          : "bg-indigo-600 text-white"
                      }`}>
                        {msg.role === "user" ? <User size={13} /> : <Bot size={13} />}
                      </div>

                      {/* Bubble */}
                      <div className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm shadow-sm ${
                        msg.role === "user"
                          ? "bg-slate-800 text-white rounded-tr-sm"
                          : "bg-white border border-slate-200 text-slate-800 rounded-tl-sm"
                      }`}>
                        {msg.isLoading ? (
                          <div className="flex items-center gap-1.5 py-1">
                            {[0, 1, 2].map((d) => (
                              <div
                                key={d}
                                className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce"
                                style={{ animationDelay: `${d * 0.15}s` }}
                              />
                            ))}
                          </div>
                        ) : (
                          <>
                            {/* Out-of-scope banner */}
                            {msg.couldNotAnswer && (
                              <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-2">
                                <AlertCircle size={13} className="shrink-0" />
                                <span>Out of scope — I can only answer questions about this mission's reconciliation data.</span>
                              </div>
                            )}

                            <p className="leading-relaxed whitespace-pre-wrap">{msg.content}</p>

                            {/* Cited exception chips */}
                            {msg.citedExceptionIds && msg.citedExceptionIds.length > 0 && (
                              <div className="flex flex-wrap items-center gap-1.5 mt-2.5 pt-2.5 border-t border-slate-100">
                                <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Exceptions:</span>
                                {msg.citedExceptionIds.map((id) => (
                                  <button
                                    key={id}
                                    onClick={() => scrollToException(id)}
                                    className="text-[11px] font-mono font-semibold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 rounded-full px-2.5 py-0.5 transition-colors cursor-pointer"
                                    title="Click to scroll to this exception"
                                  >
                                    #{id.slice(0, 8)}
                                  </button>
                                ))}
                              </div>
                            )}

                            {/* Cited evidence chips */}
                            {msg.citedEvidenceIds && msg.citedEvidenceIds.length > 0 && (
                              <div className="flex flex-wrap items-center gap-1.5 mt-2 pt-2 border-t border-slate-100">
                                <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Evidence:</span>
                                {msg.citedEvidenceIds.map((ref) => (
                                  <span key={ref} className="text-[11px] font-mono font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2.5 py-0.5">
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
                              <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-2">
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
                    <div className="flex items-center gap-2 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">
                      <AlertCircle size={14} className="shrink-0" />
                      <span>{qaError}</span>
                    </div>
                  )}

                  <div ref={qaBottomRef} />
                </div>

                {/* Input row */}
                <div className="px-5 pb-5 pt-3 border-t border-indigo-100 flex gap-2">
                  <input
                    type="text"
                    id="qa-question-input"
                    value={qaInput}
                    onChange={(e) => setQaInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleAskQuestion(); } }}
                    placeholder="Ask about this mission's reconciliation..."
                    disabled={qaSending}
                    className="flex-1 text-sm bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent disabled:opacity-60 transition-all"
                  />
                  <button
                    onClick={handleAskQuestion}
                    disabled={qaSending || !qaInput.trim()}
                    id="qa-send-button"
                    aria-label="Send question"
                    className="w-10 h-10 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white flex items-center justify-center transition-colors shadow-sm shrink-0"
                  >
                    {qaSending ? (
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <Send size={16} />
                    )}
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* STEP 5: Normalized Canonical Events Table — hidden once reconcile results are shown */}
          {matches.length === 0 && <section className="finance-step-card">
            <div className="step-badge-row">
              <span className="step-num">Step 5</span>
              <h2 className="step-heading">Canonical Financial Events Explorer</h2>
            </div>
            <p className="step-description">
              Raw data normalized into canonical financial events in <code>finance.normalized_events</code>.
            </p>

            {/* Quick Metrics Bar */}
            <div className="metrics-strip">
              <div className="metric-cell">
                <span className="metric-label">Total Events</span>
                <span className="metric-value">{events.length}</span>
              </div>
              <div className="metric-cell">
                <span className="metric-label">Sales (Shopify)</span>
                <span className="metric-value text-emerald">
                  {events.filter((e) => e.event_type === "SALE").length}
                </span>
              </div>
              <div className="metric-cell">
                <span className="metric-label">Payments (Razorpay)</span>
                <span className="metric-value text-indigo">
                  {events.filter((e) => e.event_type === "PAYMENT").length}
                </span>
              </div>
              <div className="metric-cell">
                <span className="metric-label">COD Remittances</span>
                <span className="metric-value text-blue-600">
                  {events.filter((e) => e.event_type === "COD_REMITTANCE").length}
                </span>
              </div>
              <div className="metric-cell">
                <span className="metric-label">Bank Entries</span>
                <span className="metric-value text-amber">
                  {events.filter((e) => e.event_type === "BANK_TRANSACTION").length}
                </span>
              </div>
              <div className="metric-cell">
                <span className="metric-label">Gross Processed</span>
                <span className="metric-value">
                  ₹{totalVolume.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                </span>
              </div>
            </div>

            {/* Filters Bar */}
            <div className="table-controls">
              <div className="filter-group">
                <Filter size={16} className="text-muted" />
                <select
                  value={filterEventType}
                  onChange={(e) => setFilterEventType(e.target.value)}
                  className="filter-select"
                >
                  <option value="ALL">All Event Types</option>
                  <option value="SALE">SALE</option>
                  <option value="PAYMENT">PAYMENT</option>
                  <option value="FEE">FEE</option>
                  <option value="SETTLEMENT">SETTLEMENT</option>
                  <option value="AMAZON_SETTLEMENT">AMAZON_SETTLEMENT</option>
                  <option value="BANK_TRANSACTION">BANK_TRANSACTION</option>
                  <option value="REFUND">REFUND</option>
                  <option value="COD_REMITTANCE">COD_REMITTANCE</option>
                  <option value="COD_DEDUCTION">COD_DEDUCTION</option>
                  <option value="COD_COLLECTION">COD_COLLECTION</option>
                  <option value="RTO_EVENT">RTO_EVENT</option>
                </select>

                <select
                  value={filterSourceSystem}
                  onChange={(e) => setFilterSourceSystem(e.target.value)}
                  className="filter-select"
                >
                  <option value="ALL">All Sources</option>
                  <option value="shopify">Shopify</option>
                  <option value="razorpay">Razorpay</option>
                  <option value="amazon">Amazon Marketplace</option>
                  <option value="courier">Courier / COD</option>
                  <option value="bank">Bank</option>
                </select>
              </div>

              <input
                type="text"
                placeholder="Search reference, counterparty, batch..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="search-input"
              />
            </div>

            {/* Events Data Table */}
            <div className="w-full overflow-x-auto rounded-xl border border-slate-200/80 bg-white shadow-xs">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200/80 bg-slate-50/80 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    <th className="px-4 py-3">Event Type</th>
                    <th className="px-4 py-3">Source</th>
                    <th className="px-4 py-3">External / Batch Ref</th>
                    <th className="px-4 py-3">Amount (INR)</th>
                    <th className="px-4 py-3">Event Date</th>
                    <th className="px-4 py-3">Counterparty</th>
                    <th className="px-4 py-3 text-center" title="Cross-source link to core.orders / core.payments / core.customers">Linked?</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredEvents.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-12 text-center text-sm text-slate-400">
                        {events.length === 0
                          ? "No normalized events yet. Complete Step 3 above to extract and normalize."
                          : "No events match the selected filters."}
                      </td>
                    </tr>
                  ) : (
                    filteredEvents.map((evt) => {
                      const isLinked = !!(evt.order_id || evt.payment_id || evt.customer_id);
                      return (
                        <tr key={evt.id} className="hover:bg-slate-50/60 transition-colors">
                          <td className="px-4 py-3">
                            <div className="flex flex-col gap-1 items-start">
                              <span className={`event-badge ${evt.event_type}`}>
                                {evt.event_type}
                              </span>
                              {evt.deduction_type && (
                                <span className="deduction-pill">
                                  {evt.deduction_type}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 font-medium text-slate-700 capitalize">
                            <span className="source-tag">{evt.source_system}</span>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <code className="ref-code">{evt.external_ref || "—"}</code>
                              {evt.batch_ref && evt.batch_ref !== evt.external_ref && (
                                <span className="batch-pill" title={`Batch: ${evt.batch_ref}`}>
                                  📦 {evt.batch_ref}
                                </span>
                              )}
                              {evt.order_ids && evt.order_ids.length > 1 && (
                                <span className="batch-pill" title={`Orders: ${evt.order_ids.join(", ")}`}>
                                  {evt.order_ids.length} orders
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 font-semibold text-slate-900 font-mono">
                            ₹{Number(evt.amount).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                          </td>
                          <td className="px-4 py-3 text-slate-600 whitespace-nowrap">{evt.event_date}</td>
                          <td className="px-4 py-3 text-slate-700 max-w-[220px] truncate" title={evt.counterparty || ""}>
                            {evt.counterparty || "—"}
                          </td>
                          <td className="px-4 py-3 text-center">
                            {isLinked ? (
                              <span className="link-check inline-flex items-center justify-center" title="Linked to core orders/payments">
                                ✓
                              </span>
                            ) : (
                              <span className="link-dash">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>}
        </>
      )}

      {/* CREATE MISSION MODAL */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-fadeIn">
          <div className="bg-white rounded-xl shadow-xl max-w-lg w-full p-6 relative">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800 mb-4">
              <div>
                <h3 className="text-lg font-bold text-slate-900">Initialize Financial Mission</h3>
                <p className="text-xs text-slate-500 mt-0.5">Specify date range and sources to reconcile</p>
              </div>
              <button
                onClick={() => setShowCreateModal(false)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X size={18} />
              </button>
            </div>

            {missionError && (
              <div className="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-xs flex items-center gap-2">
                <AlertCircle size={16} />
                <span>{missionError}</span>
              </div>
            )}

            <form onSubmit={handleCreateMission} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">Period Start</label>
                  <input
                    type="date"
                    value={periodStart}
                    onChange={(e) => setPeriodStart(e.target.value)}
                    required
                    className="w-full px-3 py-1.5 text-sm bg-white border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Period End</label>
                  <input
                    type="date"
                    value={periodEnd}
                    onChange={(e) => setPeriodEnd(e.target.value)}
                    required
                    className="w-full px-3 py-1.5 text-sm bg-white border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">Reconciliation Sources</label>
                <div className="space-y-3">
                  {[
                    { id: "shopify", label: "Shopify Orders (Sales & Refunds)" },
                    { id: "razorpay", label: "Razorpay Gateway (Payments & Fees)" },
                    { id: "amazon", label: "Amazon Marketplace (Flat File V2 fees, returns & taxes)" },
                    { id: "generic_cod", label: "COD Courier Settlements (Delhivery, Shiprocket, Generic COD)" },
                    { id: "bank", label: "HDFC Bank Statement (Settlement Credits)" },
                  ].map((src) => (
                    <label key={src.id} className="flex items-center gap-2.5 text-xs text-slate-700 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={selectedSources.includes(src.id)}
                        onChange={() => toggleSource(src.id)}
                        className="rounded border-slate-300 text-slate-900 focus:ring-slate-900"
                      />
                      <span>{src.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Mission Goal / Objective</label>
                <input
                  type="text"
                  placeholder="e.g. Reconcile August sales against Razorpay payouts"
                  value={objective}
                  onChange={(e) => setObjective(e.target.value)}
                  className="w-full px-3 py-1.5 text-sm bg-white border border-slate-200  rounded-lg text-slate-900  placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-200 mt-4">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-3.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creatingMission}
                  className="px-4 py-1.5 text-xs font-medium text-white bg-slate-900 dark:bg-slate-100 dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-white rounded-lg shadow-sm flex items-center gap-1.5 disabled:opacity-50 transition-all"
                >
                  {creatingMission ? (
                    <div className="w-3.5 h-3.5 border-2 border-white dark:border-slate-900 border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <>
                      <span>Create Mission</span>
                      <ArrowRight size={14} />
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
