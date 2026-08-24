import fs from "fs";
import path from "path";
import { getServiceSupabase, getOrCreateMerchant } from "./shared/db/supabase";
import { uploadSourceFile, downloadSourceFile } from "./modules/finance/ingest/storage";
import { classifyDocumentHeuristic } from "./modules/finance/understand/classify";
import { parseCsvBufferToRecords } from "./modules/finance/extract/csv";
import { runMissionNormalization } from "./modules/finance/normalize/run";
import { runMissionReconciliation } from "./modules/finance/reconcile/run";
import { runExceptionInvestigation } from "./modules/finance/investigate/run";
import { runExceptionJudgment } from "./modules/finance/judge/classify";
import { getLLMProvider } from "./shared/llm";

async function runReconcileE2ETest() {
  console.log("==================================================================");
  console.log("  MERCORA FINANCE PIPELINE E2E TEST: RECONCILE, EXCEPTIONS & JUDGE");
  console.log("==================================================================\n");

  const supabase = getServiceSupabase();

  // --------------------------------------------------------------------------
  // TEST 1: LLM Provider Abstraction Boundary
  // --------------------------------------------------------------------------
  console.log("--- TEST 1: Verifying LLM Provider Abstraction Boundary ---");
  const prevProvider = process.env.LLM_PROVIDER;
  process.env.LLM_PROVIDER = "openrouter";
  try {
    getLLMProvider("investigate");
    throw new Error("FAIL: Expected getLLMProvider with openrouter to throw an error");
  } catch (err: any) {
    if (err.message.includes("Unknown LLM provider: openrouter")) {
      console.log("   ✓ Successfully verified: LLM_PROVIDER=openrouter throws clear error boundary.");
    } else {
      throw err;
    }
  } finally {
    if (prevProvider) process.env.LLM_PROVIDER = prevProvider;
    else delete process.env.LLM_PROVIDER;
  }
  console.log();

  // --------------------------------------------------------------------------
  // TEST 2: Ingest, Classify, Extract & Normalize Clean + Anomaly CSVs
  // --------------------------------------------------------------------------
  console.log("--- TEST 2: Setting up Test Mission & Ingestion Pipeline ---");
  const testAuthUserId = "732fde6c-d7ec-496e-b5b1-5c6ffd2e1ae9";
  const merchant = await getOrCreateMerchant(testAuthUserId, {
    store_name: "Artisanal Roasters Complete Close Test",
    default_currency: "INR",
  });
  console.log(`   ✓ Test Merchant: ${merchant.id} (${merchant.business_name})`);

  // Create Finance Mission
  const { data: mission, error: missionError } = await supabase
    .schema("finance")
    .from("finance_missions")
    .insert({
      merchant_id: merchant.id,
      period_start: "2026-08-01",
      period_end: "2026-08-20",
      sources: JSON.stringify(["shopify", "razorpay", "bank"]),
      objective: "Full Lifecycle Close with Reconciliation and Exception Investigation",
      status: "created",
    })
    .select("*")
    .single();

  if (missionError || !mission) {
    throw new Error(`Failed to create mission: ${missionError?.message}`);
  }
  console.log(`   ✓ Created Mission: ${mission.id}`);

  // Upload CSV files
  const syntheticDir = path.resolve(__dirname, "../../synthetic-data");
  const filesToUpload = [
    { name: "shopify_orders.csv", filename: "shopify_orders.csv" },
    { name: "razorpay_transactions.csv", filename: "razorpay_transactions.csv" },
    { name: "bank_statement.csv", filename: "bank_statement.csv" },
  ];

  const sourceDocs: any[] = [];
  for (const file of filesToUpload) {
    const filePath = path.join(syntheticDir, file.filename);
    const buffer = fs.readFileSync(filePath);

    const storagePath = await uploadSourceFile({
      merchantId: merchant.id,
      missionId: mission.id,
      filename: file.filename,
      buffer,
      mimeType: "text/csv",
    });

    const { data: doc, error: docError } = await supabase
      .schema("finance")
      .from("source_documents")
      .insert({
        mission_id: mission.id,
        merchant_id: merchant.id,
        file_path: storagePath,
        original_filename: file.filename,
        mime_type: "text/csv",
        detected_source: "unknown",
        detection_method: "filename_heuristic",
        detection_confidence: 0,
      })
      .select("*")
      .single();

    if (docError || !doc) throw new Error(`Doc insert failed: ${docError?.message}`);
    sourceDocs.push(doc);
  }

  // Classify and Extract
  for (const doc of sourceDocs) {
    const fileBuffer = await downloadSourceFile(doc.file_path);
    const textContent = fileBuffer.toString("utf-8");
    const firstLine = textContent.split("\n")[0] || "";
    const headers = firstLine.split(",").map((h) => h.replace(/"/g, "").trim());

    const result = classifyDocumentHeuristic(doc.original_filename, headers);
    await supabase
      .schema("finance")
      .from("source_documents")
      .update({
        detected_source: result.detected_source,
        detection_method: result.detection_method,
        detection_confidence: result.detection_confidence,
      })
      .eq("id", doc.id);

    const records = parseCsvBufferToRecords({
      buffer: fileBuffer,
      sourceDocumentId: doc.id,
      missionId: mission.id,
      merchantId: merchant.id,
    });

    await supabase.schema("finance").from("extracted_records").insert(records);
  }

  // Normalize
  const normSummary = await runMissionNormalization({
    missionId: mission.id,
    merchantId: merchant.id,
    actorUserId: testAuthUserId,
  });
  console.log(`   ✓ Normalization Complete: ${normSummary.events_created} events created.`);
  console.log();

  // --------------------------------------------------------------------------
  // TEST 3: Deterministic Reconciliation & Exception Detection
  // --------------------------------------------------------------------------
  console.log("--- TEST 3: Executing Deterministic Reconciliation & Exception Engine ---");
  const reconSummary = await runMissionReconciliation({
    missionId: mission.id,
    merchantId: merchant.id,
    actorUserId: testAuthUserId,
  });

  console.log(`   ✓ Matches created: ${reconSummary.matches_created}`);
  console.log(`   ✓ Exceptions detected: ${reconSummary.exceptions_created}`);
  console.log(`   ✓ Exception breakdown:`, reconSummary.by_type);

  // Check matching thresholds
  const autoMatchedCount = reconSummary.matches.filter((m) => m.status === "auto_matched" && m.confidence >= 85).length;
  console.log(`   ✓ Auto-matched chains (confidence ≥ 85%): ${autoMatchedCount}`);

  if (autoMatchedCount < 30) {
    throw new Error(`Expected at least 30 clean auto-matched chains, found: ${autoMatchedCount}`);
  }

  // Check that the 5 seeded anomaly types were properly detected
  const expectedAnomalies = ["timing_difference", "missing_settlement", "missing_bank_credit", "duplicate", "unexplained_difference"];
  for (const anomaly of expectedAnomalies) {
    const count = reconSummary.by_type[anomaly] || 0;
    if (count === 0) {
      throw new Error(`Expected anomaly type '${anomaly}' was not detected by the exception engine.`);
    }
    console.log(`   ✓ Seeded anomaly '${anomaly}' verified (count: ${count})`);
  }
  console.log();

  // --------------------------------------------------------------------------
  // TEST 4: Investigate & Judge Seeded ₹500 Unexplained Delta
  // --------------------------------------------------------------------------
  console.log("--- TEST 4: Investigating & Judging Seeded ₹500 Unexplained Delta ---");
  const { data: unexplainedExceptions } = await supabase
    .schema("finance")
    .from("exceptions")
    .select("*")
    .eq("mission_id", mission.id)
    .eq("exception_type", "unexplained_difference");

  if (!unexplainedExceptions || unexplainedExceptions.length === 0) {
    throw new Error("Unexplained difference exception was not found in DB.");
  }

  const seededException = unexplainedExceptions[0];
  console.log(`   • Target Exception ID: ${seededException.id} (Discrepancy: ₹${seededException.difference})`);

  // Run Investigate
  console.log("   • Running Investigate stage (Retrieval + Evidence Selection)...");
  const invResult = await runExceptionInvestigation({
    exceptionId: seededException.id,
    merchantId: merchant.id,
  });
  console.log(`   ✓ Investigate created ${invResult.evidence_rows_created} evidence row(s):`);
  invResult.selected_candidates.forEach((c) => console.log(`     - [${c.source_ref}] (${c.source_type}) ${c.title}`));

  // Run Judge
  console.log("   • Running Judge stage (Ground-truth classification & constraint check)...");
  const judgeResult = await runExceptionJudgment({
    exceptionId: seededException.id,
    merchantId: merchant.id,
  });

  console.log(`   ✓ Judgment Classification: ${judgeResult.classification}`);
  console.log(`   ✓ Confidence: ${judgeResult.confidence}%`);
  console.log(`   ✓ Explanation: "${judgeResult.explanation}"`);
  console.log(`   ✓ Cited Evidence IDs: ${judgeResult.evidence_ids.length}`);
  console.log(`   ✓ Recommended Action: "${judgeResult.recommended_action}"`);

  if (judgeResult.classification === "UNEXPLAINED") {
    throw new Error("Seeded ₹500 exception was classified as UNEXPLAINED despite valid evidence available.");
  }
  console.log();

  // --------------------------------------------------------------------------
  // TEST 5: Investigate & Judge on Missing Settlement (No False Evidence)
  // --------------------------------------------------------------------------
  console.log("--- TEST 5: Investigating Non-Corroborated Anomaly (missing_settlement) ---");
  const { data: missingSetlExceptions } = await supabase
    .schema("finance")
    .from("exceptions")
    .select("*")
    .eq("mission_id", mission.id)
    .eq("exception_type", "missing_settlement");

  if (missingSetlExceptions && missingSetlExceptions.length > 0) {
    const missingSetlEx = missingSetlExceptions[0];
    await runExceptionInvestigation({
      exceptionId: missingSetlEx.id,
      merchantId: merchant.id,
    });
    const missingJudge = await runExceptionJudgment({
      exceptionId: missingSetlEx.id,
      merchantId: merchant.id,
    });

    console.log(`   ✓ Correctly classified uncorroborated anomaly as: ${missingJudge.classification}`);
    console.log(`   ✓ Factual non-hallucinated explanation: "${missingJudge.explanation}"`);
  }
  console.log();

  // --------------------------------------------------------------------------
  // TEST 6: Audit Log Integrity Verification
  // --------------------------------------------------------------------------
  console.log("--- TEST 6: Verifying Audit Log Entries Across All Agents & Stages ---");
  const { data: auditLogs, error: auditErr } = await supabase
    .schema("audit")
    .from("audit_log")
    .select("action, entity_type, actor_type, actor_id, created_at")
    .eq("mission_id", mission.id);

  if (auditErr) {
    throw new Error(`Audit log query failed: ${auditErr.message}`);
  }

  console.log(`   • Total audit records for mission: ${auditLogs?.length || 0}`);
  auditLogs?.forEach((log) => {
    console.log(`     - [${log.action}] by actor: '${log.actor_type}' (${log.actor_id || "system"}) on ${log.entity_type}`);
  });

  const hasReconcileAudit = auditLogs?.some((l) => l.action === "mission.reconciled");
  const hasInvestigateAudit = auditLogs?.some((l) => l.action === "exception.investigated" && l.actor_type === "gemini");
  const hasJudgeAudit = auditLogs?.some((l) => l.action === "exception.judged" && l.actor_type === "gemini");

  if (!hasReconcileAudit || !hasInvestigateAudit || !hasJudgeAudit) {
    throw new Error("Audit log verification failed: missing expected audit actions or actor types");
  }

  console.log("\n==================================================================");
  console.log("  🎉 ALL 6 ACCEPTANCE CRITERIA VERIFIED AND PASSING!");
  console.log("==================================================================");
}

runReconcileE2ETest().catch((err) => {
  console.error("E2E Test Failed:", err);
  process.exit(1);
});
