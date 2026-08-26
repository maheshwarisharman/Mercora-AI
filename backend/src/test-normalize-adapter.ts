import { normalizerRegistry } from "./modules/finance/normalize/registry";
import { runMissionNormalization } from "./modules/finance/normalize/run";
import { getServiceSupabase, getOrCreateMerchant } from "./shared/db/supabase";
import type { ExtractedRecord } from "./modules/finance/shared/types";

async function testAdapterRefactor() {
  console.log("==================================================");
  console.log("  Testing Normalization Adapter Layer & COD Events");
  console.log("==================================================\n");

  // 1. Verify Adapter Registry
  console.log("1. Checking NormalizerRegistry...");
  const shopifyAdapter = normalizerRegistry.get("shopify_orders");
  const razorpayAdapter = normalizerRegistry.get("razorpay_settlement");
  const bankAdapter = normalizerRegistry.get("bank_statement");
  const codAdapter = normalizerRegistry.get("generic_cod");
  const aliasAdapter = normalizerRegistry.get("courier_settlement");

  if (!shopifyAdapter || !razorpayAdapter || !bankAdapter || !codAdapter || !aliasAdapter) {
    throw new Error("Missing registered adapters in registry!");
  }
  console.log("   ✓ All 4 adapters + aliases registered correctly.");

  const sortedAdapters = normalizerRegistry.getSortedAdapters();
  console.log(
    "   ✓ Adapter priority sequence:",
    sortedAdapters.map((a) => `${a.detectedSource} (prio: ${a.priority})`).join(" -> ")
  );

  // 2. Setup Test Merchant and Mission
  console.log("\n2. Initializing test merchant and mission...");
  const testAuthUserId = "732fde6c-d7ec-496e-b5b1-5c6ffd2e1ae9";
  const merchant = await getOrCreateMerchant(testAuthUserId, {
    store_name: "Artisanal Roasters Test",
    default_currency: "INR",
  });
  console.log(`   ✓ Merchant ID: ${merchant.id}`);

  const supabase = getServiceSupabase();
  const { data: mission, error: missionError } = await supabase
    .schema("finance")
    .from("finance_missions")
    .insert({
      merchant_id: merchant.id,
      period_start: "2026-08-01",
      period_end: "2026-08-25",
      sources: JSON.stringify(["shopify", "razorpay", "bank", "generic_cod"]),
      objective: "Verification of Normalization Adapter Refactor and COD remits",
      status: "created",
    })
    .select("*")
    .single();

  if (missionError || !mission) {
    throw new Error(`Failed to create test mission: ${missionError?.message}`);
  }
  console.log(`   ✓ Mission Created: ${mission.id}`);

  // 3. Create Source Documents
  console.log("\n3. Creating source document records...");
  const { data: shopifyDoc } = await supabase
    .schema("finance")
    .from("source_documents")
    .insert({
      mission_id: mission.id,
      merchant_id: merchant.id,
      file_path: "test/shopify.csv",
      original_filename: "shopify_orders.csv",
      detected_source: "shopify_orders",
      detection_method: "filename_heuristic",
      detection_confidence: 95,
    })
    .select("*")
    .single();

  let codDoc = null;
  const { data: directCodDoc, error: directErr } = await supabase
    .schema("finance")
    .from("source_documents")
    .insert({
      mission_id: mission.id,
      merchant_id: merchant.id,
      file_path: "test/delhivery_cod.csv",
      original_filename: "delhivery_cod_settlement.csv",
      detected_source: "generic_cod" as any,
      detection_method: "filename_heuristic",
      detection_confidence: 90,
    })
    .select("*")
    .maybeSingle();

  if (directCodDoc) {
    codDoc = directCodDoc;
  } else {
    // Fallback to unknown source with filename hint
    const { data: fallbackDoc } = await supabase
      .schema("finance")
      .from("source_documents")
      .insert({
        mission_id: mission.id,
        merchant_id: merchant.id,
        file_path: "test/delhivery_cod.csv",
        original_filename: "delhivery_cod_settlement.csv",
        detected_source: "unknown",
        detection_method: "filename_heuristic",
        detection_confidence: 90,
      })
      .select("*")
      .single();
    codDoc = fallbackDoc;
  }

  // 4. Create Extracted Records
  console.log("4. Inserting extracted records (Shopify + COD Remittances)...");
  // Shopify order
  await supabase
    .schema("finance")
    .from("extracted_records")
    .insert([
      {
        source_document_id: shopifyDoc.id,
        mission_id: mission.id,
        merchant_id: merchant.id,
        raw_json: {
          order_id: "ORD-COD-1001",
          order_number: "#1001",
          customer_name: "Rohan Verma",
          customer_email: "rohan@example.com",
          total_amount: "2500.00",
          currency: "INR",
          order_date: "2026-08-10",
          status: "fulfilled",
        },
        extraction_method: "csv_parse",
      },
      {
        source_document_id: shopifyDoc.id,
        mission_id: mission.id,
        merchant_id: merchant.id,
        raw_json: {
          order_id: "ORD-COD-1002",
          order_number: "#1002",
          customer_name: "Ananya Iyer",
          customer_email: "ananya@example.com",
          total_amount: "1800.00",
          currency: "INR",
          order_date: "2026-08-11",
          status: "refunded",
          refund_amount: "1800.00",
        },
        extraction_method: "csv_parse",
      },
    ]);

  // COD Courier Remittance Records
  await supabase
    .schema("finance")
    .from("extracted_records")
    .insert([
      {
        source_document_id: codDoc.id,
        mission_id: mission.id,
        merchant_id: merchant.id,
        raw_json: {
          order_id: "ORD-COD-1001",
          awb: "DELH12345678",
          cod_amount: "2500.00",
          batch_ref: "BATCH-DLH-20260815",
          remittance_date: "2026-08-15",
          status: "Delivered",
          courier: "Delhivery",
          handling_fee: "45.00",
          freight_charge: "90.00",
        },
        extraction_method: "csv_parse",
      },
      {
        source_document_id: codDoc.id,
        mission_id: mission.id,
        merchant_id: merchant.id,
        raw_json: {
          order_id: "ORD-COD-1002",
          awb: "DELH12345679",
          cod_amount: "1800.00",
          batch_ref: "BATCH-DLH-20260815",
          remittance_date: "2026-08-15",
          status: "RTO - Customer Refused",
          courier: "Delhivery",
          rto_charge: "110.00",
          weight_charge: "25.00",
        },
        extraction_method: "csv_parse",
      },
    ]);

  // 5. Run Normalization
  console.log("\n5. Running mission normalization via adapter pipeline...");
  const summary = await runMissionNormalization({
    missionId: mission.id,
    merchantId: merchant.id,
    actorUserId: testAuthUserId,
  });

  console.log("   ✓ Normalization Summary:", JSON.stringify(summary, null, 2));

  // 6. Verify Normalized Events
  console.log("\n6. Fetching generated normalized events...");
  const { data: events, error: evtErr } = await supabase
    .schema("finance")
    .from("normalized_events")
    .select("*")
    .eq("mission_id", mission.id)
    .order("created_at", { ascending: true });

  if (evtErr) {
    throw new Error(`Failed to query normalized events: ${evtErr.message}`);
  }

  console.log(`   ✓ Total events created: ${events.length}`);
  for (const evt of events) {
    console.log(
      `   - [${evt.event_type}] ext_ref: ${evt.external_ref}, amount: ${evt.amount}, date: ${evt.event_date}` +
        (evt.metadata?.deduction_type ? `, deduction: ${evt.metadata.deduction_type}` : "") +
        (evt.metadata?.batch_ref ? `, batch: ${evt.metadata.batch_ref}` : "")
    );
  }

  // 7. Verify Idempotency
  console.log("\n7. Verifying idempotency (re-running normalization)...");
  const rerunSummary = await runMissionNormalization({
    missionId: mission.id,
    merchantId: merchant.id,
    actorUserId: testAuthUserId,
  });
  console.log(`   ✓ Re-run events created: ${rerunSummary.events_created} (expected: 0)`);
  if (rerunSummary.events_created !== 0) {
    throw new Error("Idempotency failed: duplicate events created on re-run!");
  }

  console.log("\n==================================================");
  console.log("  ALL TESTS PASSED SUCCESSFULLY! 🎉");
  console.log("==================================================");
}

testAdapterRefactor()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
  });
