import React, { useState, useEffect, useRef } from "react";
import { useAuth } from "../context/AuthContext";
import {
  UploadCloud,
  AlertCircle,
  ArrowRight,
  RefreshCw,
  Filter,
  FileSpreadsheet,
} from "lucide-react";

interface FinanceMission {
  id: string;
  merchant_id: string;
  period_start: string;
  period_end: string;
  sources: string[] | string;
  objective?: string | null;
  status: "created" | "ingesting" | "reconciling" | "needs_review" | "closed";
  created_at: string;
}

interface SourceDoc {
  id: string;
  file_path: string;
  original_filename: string;
  detected_source:
    | "shopify_orders"
    | "razorpay_settlement"
    | "bank_statement"
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
  metadata?: any;
  created_at: string;
}

export const FinanceMissionView: React.FC = () => {
  const { fetchWithAuth } = useAuth();

  // Active Mission State
  const [activeMission, setActiveMission] = useState<FinanceMission | null>(null);
  const [documents, setDocuments] = useState<SourceDoc[]>([]);
  const [events, setEvents] = useState<NormalizedEvent[]>([]);

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

  // Step 3: Pipeline Processing State
  const [processingPipeline, setProcessingPipeline] = useState(false);
  const [processLogs, setProcessLogs] = useState<string[]>([]);
  const [processError, setProcessError] = useState<string | null>(null);

  // Step 4: Table Filters
  const [filterEventType, setFilterEventType] = useState<string>("ALL");
  const [filterSourceSystem, setFilterSourceSystem] = useState<string>("ALL");
  const [searchTerm, setSearchTerm] = useState("");

  // Load existing documents & events if mission active
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
      setDocuments([]);
      setEvents([]);
      setProcessLogs([]);
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
      addLog(`Starting ingestion pipeline for Mission ${activeMission.id.slice(0, 8)}...`);

      // 3A. Sequential Extraction for each classified document
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
      addLog(`Normalizing records (linking Shopify orders, Razorpay settlements & Bank transactions)...`);
      const normRes = await fetchWithAuth(
        `/api/finance/missions/${activeMission.id}/normalize`,
        { method: "POST" }
      );

      const normData = await normRes.json();
      if (!normRes.ok) {
        throw new Error(normData.message || "Failed during normalization step");
      }

      const summary = normData.data;
      addLog(`✓ Normalization complete! Created ${summary.events_created} normalized events.`);
      if (summary.by_type) {
        Object.entries(summary.by_type).forEach(([type, count]) => {
          addLog(`   • ${type}: ${count}`);
        });
      }

      // 3C. Refresh mission events
      await loadMissionData(activeMission.id);
      addLog(`🎉 Pipeline finished successfully. Ready for matching in Batch 3.`);
    } catch (err: any) {
      setProcessError(err.message || "Pipeline execution failed");
      addLog(`❌ Error: ${err.message}`);
    } finally {
      setProcessingPipeline(false);
    }
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
      return matchRef || matchParty || matchType;
    }
    return true;
  });

  // Summary Metrics
  const totalVolume = events.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
  const salesCount = events.filter((e) => e.event_type === "SALE").length;
  const paymentsCount = events.filter((e) => e.event_type === "PAYMENT").length;
  const bankCount = events.filter((e) => e.event_type === "BANK_TRANSACTION").length;

  return (
    <div className="finance-container">
      {/* Top Banner Header */}
      <div className="finance-header-card">
        <div className="finance-header-main">
          <div className="finance-badge">
            <span className="pulse-dot-emerald" />
            <span>Finance Agent • Batch 2 Pipeline</span>
          </div>
          <h1 className="finance-title">Mission Close & Financial Event Engine</h1>
          <p className="finance-subtitle">
            Deterministic CSV Ingestion, Semantic Understanding, Raw Extraction & Multi-Source Canonical Normalization
          </p>
        </div>

        {activeMission && (
          <div className="active-mission-pill">
            <div className="mission-pill-left">
              <span className="pill-label">Active Mission</span>
              <code className="pill-id">{activeMission.id.slice(0, 8)}...</code>
            </div>
            <span className={`status-tag ${activeMission.status}`}>
              {activeMission.status.toUpperCase()}
            </span>
            <button
              onClick={() => setActiveMission(null)}
              className="btn-text-sm"
              title="Create or select another mission"
            >
              New Mission
            </button>
          </div>
        )}
      </div>

      {/* STEP 1: Mission Creation */}
      {!activeMission ? (
        <section className="finance-step-card">
          <div className="step-badge-row">
            <span className="step-num">Step 1</span>
            <h2 className="step-heading">Initialize Financial Mission</h2>
          </div>
          <p className="step-description">
            Specify the financial close period and source systems to reconcile (Shopify, Razorpay, Bank statement).
          </p>

          {missionError && (
            <div className="alert alert-error">
              <AlertCircle size={18} />
              <span>{missionError}</span>
            </div>
          )}

          <form onSubmit={handleCreateMission} className="mission-form">
            <div className="grid-2col-dense">
              <div className="form-group">
                <label>Period Start Date</label>
                <input
                  type="date"
                  value={periodStart}
                  onChange={(e) => setPeriodStart(e.target.value)}
                  required
                />
              </div>

              <div className="form-group">
                <label>Period End Date</label>
                <input
                  type="date"
                  value={periodEnd}
                  onChange={(e) => setPeriodEnd(e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="form-group">
              <label>Reconciliation Sources</label>
              <div className="sources-checkbox-row">
                {[
                  { id: "shopify", label: "Shopify Orders (Sales & Refunds)" },
                  { id: "razorpay", label: "Razorpay Gateway (Payments & Fees)" },
                  { id: "bank", label: "HDFC Bank Statement (Settlement Credits)" },
                ].map((src) => (
                  <label key={src.id} className="source-checkbox-label">
                    <input
                      type="checkbox"
                      checked={selectedSources.includes(src.id)}
                      onChange={() => toggleSource(src.id)}
                    />
                    <span>{src.label}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="form-group">
              <label>Mission Objective (Optional)</label>
              <input
                type="text"
                placeholder="e.g. Close August Books & verify Razorpay payout variance"
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
              />
            </div>

            <button type="submit" className="btn-primary" disabled={creatingMission}>
              {creatingMission ? (
                <div className="spinner-sm" />
              ) : (
                <>
                  <span>Create Finance Mission</span>
                  <ArrowRight size={16} />
                </>
              )}
            </button>
          </form>
        </section>
      ) : (
        <>
          {/* STEP 2: Document Upload & Classification */}
          <section className="finance-step-card">
            <div className="step-badge-row">
              <span className="step-num">Step 2</span>
              <h2 className="step-heading">Source Documents & Heuristic Understanding</h2>
            </div>
            <p className="step-description">
              Upload source CSVs (<code>shopify_orders.csv</code>, <code>razorpay_transactions.csv</code>, <code>bank_statement.csv</code>).
              The system inspects filename & header signatures to automatically classify each document.
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
                accept=".csv"
                style={{ display: "none" }}
                onChange={(e) => handleFileUpload(e.target.files)}
              />
              <UploadCloud size={36} className="dropzone-icon" />
              <div className="dropzone-text">
                <strong>Click or drop CSV files here to upload</strong>
                <span>Supports multiple CSV files simultaneously</span>
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
              <h2 className="step-heading">Extract & Normalize Financial Events</h2>
            </div>
            <p className="step-description">
              Parses raw tabular rows into <code>finance.extracted_records</code> and transforms them into canonical <code>finance.normalized_events</code> (SALES, PAYMENTS, FEES, SETTLEMENTS, BANK_TRANSACTIONS).
            </p>

            <div className="pipeline-action-row">
              <button
                onClick={handleExtractAndNormalize}
                disabled={processingPipeline || documents.length === 0}
                className="btn-accent-glow"
              >
                {processingPipeline ? (
                  <>
                    <div className="spinner-sm" />
                    <span>Executing Pipeline Stages...</span>
                  </>
                ) : (
                  <>
                    <RefreshCw size={18} />
                    <span>Extract & Normalize All Documents</span>
                  </>
                )}
              </button>
              <span className="btn-helper-text">
                {documents.length} document(s) ready for processing
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
                  <span className="terminal-title">Pipeline Execution Log</span>
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

          {/* STEP 4: Normalized Events Table */}
          <section className="finance-step-card">
            <div className="step-badge-row">
              <span className="step-num">Step 4</span>
              <h2 className="step-heading">Normalized Financial Events</h2>
            </div>
            <p className="step-description">
              Canonical financial events stored in <code>finance.normalized_events</code>. Cross-source soft links to <code>core.orders</code> and <code>core.payments</code> are marked below.
            </p>

            {/* Quick Metrics Bar */}
            <div className="metrics-strip">
              <div className="metric-cell">
                <span className="metric-label">Total Events</span>
                <span className="metric-value">{events.length}</span>
              </div>
              <div className="metric-cell">
                <span className="metric-label">Sales (Shopify)</span>
                <span className="metric-value text-emerald">{salesCount}</span>
              </div>
              <div className="metric-cell">
                <span className="metric-label">Payments (Razorpay)</span>
                <span className="metric-value text-indigo">{paymentsCount}</span>
              </div>
              <div className="metric-cell">
                <span className="metric-label">Bank Entries</span>
                <span className="metric-value text-amber">{bankCount}</span>
              </div>
              <div className="metric-cell">
                <span className="metric-label">Gross Processed</span>
                <span className="metric-value">₹{totalVolume.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
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
                  <option value="BANK_TRANSACTION">BANK_TRANSACTION</option>
                  <option value="REFUND">REFUND</option>
                </select>

                <select
                  value={filterSourceSystem}
                  onChange={(e) => setFilterSourceSystem(e.target.value)}
                  className="filter-select"
                >
                  <option value="ALL">All Sources</option>
                  <option value="shopify">Shopify</option>
                  <option value="razorpay">Razorpay</option>
                  <option value="bank">Bank</option>
                </select>
              </div>

              <input
                type="text"
                placeholder="Search reference, counterparty..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="search-input"
              />
            </div>

            {/* Events Data Table */}
            <div className="table-responsive">
              <table className="events-table">
                <thead>
                  <tr>
                    <th>Event Type</th>
                    <th>Source</th>
                    <th>External Ref</th>
                    <th>Amount (INR)</th>
                    <th>Event Date</th>
                    <th>Counterparty</th>
                    <th title="Cross-source link to core.orders / core.payments / core.customers">Linked?</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEvents.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="table-empty">
                        {events.length === 0
                          ? "No normalized events yet. Complete Step 3 above to extract and normalize."
                          : "No events match the selected filters."}
                      </td>
                    </tr>
                  ) : (
                    filteredEvents.map((evt) => {
                      const isLinked = !!(evt.order_id || evt.payment_id || evt.customer_id);
                      return (
                        <tr key={evt.id}>
                          <td>
                            <span className={`event-badge ${evt.event_type}`}>
                              {evt.event_type}
                            </span>
                          </td>
                          <td>
                            <span className="source-tag">{evt.source_system}</span>
                          </td>
                          <td>
                            <code className="ref-code">{evt.external_ref || "—"}</code>
                          </td>
                          <td className="amount-cell">
                            ₹{Number(evt.amount).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                          </td>
                          <td>{evt.event_date}</td>
                          <td className="counterparty-cell">{evt.counterparty || "—"}</td>
                          <td className="linked-cell">
                            {isLinked ? (
                              <span className="link-check" title="Linked to core orders/payments">
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
          </section>
        </>
      )}
    </div>
  );
};
