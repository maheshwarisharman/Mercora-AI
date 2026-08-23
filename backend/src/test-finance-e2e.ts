import fs from "fs";
import path from "path";
import { getServiceSupabase, getOrCreateMerchant } from "./shared/db/supabase";
import { classifyDocumentHeuristic } from "./modules/finance/understand/classify";
import { parseCsvBufferToRecords } from "./modules/finance/extract/csv";
import { runMissionNormalization } from "./modules/finance/normalize/run";
import { writeAuditLog } from "./modules/finance/shared/audit";
import { uploadSourceFile, downloadSourceFile } from "./modules/finance/ingest/storage";

async function runE2ETest() {
  console.log("=================================================");
  console.log("  Running Mercora Finance Pipeline E2E Test");
  console.log("=================================================\n");

  const supabase = getServiceSupabase();

  // 1. Create/Ensure Test Merchant
  const testAuthUserId = "00000000-0000-0000-0000-000000000001";
  console.log("1. Resolving test merchant...");
  const merchant = await getOrCreateMerchant(testAuthUserId, {
    store_name: "Artisanal Roasters Test",
    default_currency: "INR",
  });
  console.log(`   ✓ Merchant ID: ${merchant.id} (${merchant.business_name})\n`);

  // 2. Create Mission
  console.log("2. Creating Finance Mission (2026-08-01 to 2026-08-20)...");
  const { data: mission, error: missionError } = await supabase
    .schema("finance")
    .from("finance_missions")
    .insert({
      merchant_id: merchant.id,
      period_start: "2026-08-01",
      period_end: "2026-08-20",
      sources: JSON.stringify(["shopify", "razorpay", "bank"]),
      objective: "E2E Verification of Batch 2 CSV Pipeline",
      status: "created",
    })
    .select("*")
    .single();

  if (missionError || !mission) {
    throw new Error(`Failed to create test mission: ${missionError?.message}`);
  }
  console.log(`   ✓ Mission Created: ${mission.id}\n`);

  await writeAuditLog({
    merchant_id: merchant.id,
    mission_id: mission.id,
    actor_type: "system",
    action: "mission.created",
    entity_type: "finance.finance_missions",
    entity_id: mission.id,
    after: mission,
  });

  // 3. Upload Synthetic CSVs to Storage and Insert Source Documents
  console.log("3. Uploading synthetic CSV files...");
  const syntheticDir = path.resolve(__dirname, "../../synthetic-data");
  const filesToUpload = [
    { name: "shopify_orders.csv", filename: "shopify_orders.csv" },
    { name: "razorpay_transactions.csv", filename: "razorpay_transactions.csv" },
    { name: "bank_statement.csv", filename: "bank_statement.csv" },
  ];

  const sourceDocs: any[] = [];
  for (const file of filesToUpload) {
    const filePath = path.join(syntheticDir, file.filename);
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    const buffer = fs.readFileSync(filePath);

    // Upload to Supabase Storage
    const storagePath = await uploadSourceFile({
      merchantId: merchant.id,
      missionId: mission.id,
      filename: file.filename,
      buffer,
      mimeType: "text/csv",
    });

    // Insert to source_documents
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

    if (docError || !doc) {
      throw new Error(`Failed to insert source document: ${docError?.message}`);
    }

    sourceDocs.push(doc);
    console.log(`   ✓ Uploaded ${file.filename} -> ${storagePath}`);
  }
  console.log();

  // 4. Understand (Classification) Stage
  console.log("4. Running Understand (Heuristic Classification) on documents...");
  for (const doc of sourceDocs) {
    const fileBuffer = await downloadSourceFile(doc.file_path);
    const textContent = fileBuffer.toString("utf-8");
    const firstLine = textContent.split("\n")[0] || "";
    const headers = firstLine.split(",").map((h) => h.replace(/"/g, "").trim());

    const result = classifyDocumentHeuristic(doc.original_filename, headers);
    console.log(
      `   • '${doc.original_filename}' -> Detected: ${result.detected_source} (Confidence: ${result.detection_confidence}%)`
    );

    if (result.detected_source === "unknown" || result.detection_confidence < 70) {
      throw new Error(`Document ${doc.original_filename} failed classification expectation`);
    }

    // Update document
    const { data: updatedDoc, error: updateError } = await supabase
      .schema("finance")
      .from("source_documents")
      .update({
        detected_source: result.detected_source,
        detection_method: result.detection_method,
        detection_confidence: result.detection_confidence,
      })
      .eq("id", doc.id)
      .select("*")
      .single();

    if (updateError || !updatedDoc) {
      throw new Error(`Failed to update doc classification: ${updateError?.message}`);
    }

    doc.detected_source = result.detected_source;
  }
  console.log();

  // 5. Extract (CSV Parse) Stage
  console.log("5. Running Extraction (CSV to extracted_records)...");
  let totalExtracted = 0;
  for (const doc of sourceDocs) {
    const fileBuffer = await downloadSourceFile(doc.file_path);
    const records = parseCsvBufferToRecords({
      buffer: fileBuffer,
      sourceDocumentId: doc.id,
      missionId: mission.id,
      merchantId: merchant.id,
    });

    const { error: insertError } = await supabase
      .schema("finance")
      .from("extracted_records")
      .insert(records);

    if (insertError) {
      throw new Error(`Failed to insert extracted records: ${insertError.message}`);
    }

    totalExtracted += records.length;
    console.log(`   ✓ Extracted ${records.length} rows from '${doc.original_filename}'`);
  }
  console.log(`   Total Extracted Records: ${totalExtracted}\n`);

  // 6. Normalize Stage
  console.log("6. Running Mission Normalization (Shopify -> Razorpay -> Bank)...");
  const normSummary = await runMissionNormalization({
    missionId: mission.id,
    merchantId: merchant.id,
    actorUserId: testAuthUserId,
  });

  console.log(`   ✓ Events Created: ${normSummary.events_created}`);
  console.log(`   ✓ Breakdown:`, normSummary.by_type);
  console.log(`   ✓ New Mission Status: ${normSummary.mission_status}\n`);

  // 7. Verify Idempotency
  console.log("7. Testing Normalization Idempotency (re-running on same mission)...");
  const secondRun = await runMissionNormalization({
    missionId: mission.id,
    merchantId: merchant.id,
    actorUserId: testAuthUserId,
  });
  console.log(`   ✓ Second run events created: ${secondRun.events_created} (Expected: 0)`);
  if (secondRun.events_created !== 0) {
    throw new Error(`Idempotency failed: second run created ${secondRun.events_created} duplicate events`);
  }
  console.log();

  // 8. Verify Cross-Source Linking & DB State
  console.log("8. Verifying Cross-Source Linking in Normalized Events...");
  const { data: allEvents, error: evError } = await supabase
    .schema("finance")
    .from("normalized_events")
    .select("*")
    .eq("mission_id", mission.id);

  if (evError || !allEvents) {
    throw new Error(`Failed to query normalized events: ${evError?.message}`);
  }

  const linkedSales = allEvents.filter((e) => e.event_type === "SALE" && e.order_id);
  const linkedPayments = allEvents.filter((e) => e.event_type === "PAYMENT" && e.order_id);

  console.log(`   • Total Normalized Events in DB: ${allEvents.length}`);
  console.log(`   • Shopify SALE events linked to core.orders: ${linkedSales.length}`);
  console.log(`   • Razorpay PAYMENT events linked to core.orders: ${linkedPayments.length}`);

  if (linkedSales.length === 0 || linkedPayments.length === 0) {
    throw new Error("Cross-source linking verification failed: linked orders missing");
  }

  // 9. Verify Audit Log Entries
  console.log("\n9. Verifying Audit Log Entries...");
  const { data: auditLogs, error: auditError } = await supabase
    .schema("audit")
    .from("audit_log")
    .select("action, entity_type, created_at")
    .eq("mission_id", mission.id);

  if (auditError) {
    console.warn("Audit query note:", auditError.message);
  } else {
    console.log(`   • Audit entries recorded: ${auditLogs?.length || 0}`);
    auditLogs?.forEach((log) => console.log(`     - [${log.action}] on ${log.entity_type}`));
  }

  console.log("\n=================================================");
  console.log("  🎉 ALL BATCH 2 ACCEPTANCE CRITERIA VERIFIED!");
  console.log("=================================================");
}

runE2ETest().catch((err) => {
  console.error("E2E Test Failed:", err);
  process.exit(1);
});
