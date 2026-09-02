import { getServiceSupabase } from "../../../shared/db/supabase";
import type { ToolDefinition } from "../../llm/types";

// `.or()` takes a raw PostgREST filter expression, so values containing
// delimiters must be quoted and escaped before being interpolated.
function postgrestFilterValue(value: string): string {
  if (!/[,()"\\]/.test(value) && value === value.trim()) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export const getTransactionChainDefinition: ToolDefinition = {
  name: "get_transaction_chain",
  description:
    "Retrieves the full financial event chain and breakdown for a given order reference, settlement ID (e.g. 'AMZ-DEMO-2026-08-001', 'setl_mrc_001'), batch reference (e.g. 'COD-BATCH-MRC-0823'), payment ID, or bank UTR. " +
    "Returns every normalized event associated with that entity — including SALE (Shopify/Amazon), PAYMENT, FEE / deductions, SETTLEMENT / remittance payout, and BANK_TRANSACTION credit — " +
    "along with matched links, deduction breakdown, and variance summary. " +
    "Call this FIRST when asked about a specific settlement, order, batch, bank deposit difference, or transaction lifecycle.",
  parameters: {
    type: "object",
    properties: {
      order_ref: {
        type: "string",
        description:
          "The order reference, settlement ID, batch reference, payment ID, or UTR (e.g. 'AMZ-DEMO-2026-08-001', 'SHF-1038', '#MRC-24025', 'setl_mrc_001', 'COD-BATCH-MRC-0823').",
      },
    },
    required: ["order_ref"],
  },
};

export async function getTransactionChain(
  args: Record<string, unknown>,
  context?: { merchantId?: string; missionId?: string },
): Promise<unknown> {
  const orderRef = String(
    args.order_ref ||
    args.orderRef ||
    args.ref ||
    args.reference ||
    args.settlement_id ||
    args.settlementId ||
    args.batch_ref ||
    args.batchRef ||
    args.query ||
    ""
  ).trim();
  if (!orderRef) return { error: "order_ref is required" };

  const supabase = getServiceSupabase();
  const orderRefFilterValue = postgrestFilterValue(orderRef);
  const orderRefSearchValue = postgrestFilterValue(`%${orderRef}%`);

  const filterClauses = [
    `external_ref.ilike.${orderRefSearchValue}`,
    `batch_ref.ilike.${orderRefSearchValue}`,
    `counterparty.ilike.${orderRefSearchValue}`,
    `metadata->>order_ref.eq.${orderRefFilterValue}`,
    `metadata->>order_number.eq.${orderRefFilterValue}`,
    `metadata->>merchant_order_id.eq.${orderRefFilterValue}`,
    `metadata->>amazon_order_id.eq.${orderRefFilterValue}`,
    `metadata->>amazon_settlement_id.eq.${orderRefFilterValue}`,
    `metadata->>settlement_id.eq.${orderRefFilterValue}`,
    `metadata->>payment_id.eq.${orderRefFilterValue}`,
    `metadata->>parent_payment_id.eq.${orderRefFilterValue}`,
    `metadata->>description.ilike.${orderRefSearchValue}`,
    `metadata->>narration.ilike.${orderRefSearchValue}`,
    `metadata->>remarks.ilike.${orderRefSearchValue}`,
    `metadata->>raw_description.ilike.${orderRefSearchValue}`,
  ];

  // 1. Initial search
  let eventQuery = supabase
    .schema("finance")
    .from("normalized_events")
    .select("*");
  if (context?.missionId) eventQuery = eventQuery.eq("mission_id", context.missionId);
  if (context?.merchantId) eventQuery = eventQuery.eq("merchant_id", context.merchantId);

  const { data: initialEvents, error: evErr } = await eventQuery
    .or(filterClauses.join(","))
    .order("event_date", { ascending: true });

  if (evErr) return { error: evErr.message };

  const eventMap = new Map<string, any>();
  for (const e of initialEvents || []) {
    if (e.id) eventMap.set(String(e.id), e);
  }

  // 2. Discover related batches / settlements / orders / payments to pull full sibling context
  const batchRefs = new Set<string>();
  const settlementIds = new Set<string>();
  const orderRefs = new Set<string>();

  for (const e of initialEvents || []) {
    if (e.batch_ref) batchRefs.add(String(e.batch_ref));
    if (e.metadata?.amazon_settlement_id) settlementIds.add(String(e.metadata.amazon_settlement_id));
    if (e.metadata?.settlement_id) settlementIds.add(String(e.metadata.settlement_id));
    if (e.metadata?.order_ref) orderRefs.add(String(e.metadata.order_ref));
    if (e.metadata?.order_number) orderRefs.add(String(e.metadata.order_number));
    if (e.metadata?.merchant_order_id) orderRefs.add(String(e.metadata.merchant_order_id));
    if (e.metadata?.amazon_order_id) orderRefs.add(String(e.metadata.amazon_order_id));
  }

  // If we matched a settlement batch or order, fetch all sibling events for complete chain
  const expansionConditions: string[] = [];
  for (const b of batchRefs) {
    const val = postgrestFilterValue(b);
    const searchVal = postgrestFilterValue(`%${b}%`);
    expansionConditions.push(
      `batch_ref.eq.${val}`,
      `metadata->>amazon_settlement_id.eq.${val}`,
      `metadata->>settlement_id.eq.${val}`,
      `metadata->>description.ilike.${searchVal}`,
      `metadata->>narration.ilike.${searchVal}`
    );
  }
  for (const s of settlementIds) {
    const val = postgrestFilterValue(s);
    const searchVal = postgrestFilterValue(`%${s}%`);
    expansionConditions.push(
      `batch_ref.eq.${val}`,
      `metadata->>amazon_settlement_id.eq.${val}`,
      `metadata->>settlement_id.eq.${val}`,
      `metadata->>description.ilike.${searchVal}`,
      `metadata->>narration.ilike.${searchVal}`
    );
  }

  if (expansionConditions.length > 0 && context?.missionId) {
    const { data: siblingEvents } = await supabase
      .schema("finance")
      .from("normalized_events")
      .select("*")
      .eq("mission_id", context.missionId)
      .or(expansionConditions.slice(0, 30).join(","));

    for (const e of siblingEvents || []) {
      if (e.id) eventMap.set(String(e.id), e);
    }
  }

  const events = Array.from(eventMap.values()).sort((a, b) =>
    String(a.event_date || "").localeCompare(String(b.event_date || ""))
  );

  // 3. Find any matches row that contains these event IDs
  const eventIds = events.map((e: any) => e.id).filter(Boolean);
  let matchRow: any = null;
  if (eventIds.length > 0) {
    const { data: matches } = await supabase
      .schema("finance")
      .from("matches")
      .select("*")
      .overlaps("event_ids", eventIds)
      .order("confidence", { ascending: false })
      .limit(1);
    matchRow = matches?.[0] || null;
  }

  // 4. Compute financial breakdown summary for fast, clear reasoning
  const settlements = events.filter((e) =>
    e.event_type === "AMAZON_SETTLEMENT" ||
    e.event_type === "SETTLEMENT" ||
    e.metadata?.canonical_event_type === "AMAZON_SETTLEMENT" ||
    e.metadata?.canonical_event_type === "SETTLEMENT"
  );
  const bankCredits = events.filter((e) => {
    const dir = String(e.metadata?.direction || "").toLowerCase();
    return dir !== "debit" && dir !== "dr" &&
      (e.event_type === "BANK_TRANSACTION" || e.event_type === "BANK_CREDIT" || e.metadata?.canonical_event_type === "BANK_CREDIT");
  });
  const sales = events.filter((e) =>
    e.event_type === "SALE" || e.metadata?.canonical_event_type === "SALE"
  );
  const deductions = events.filter((e) =>
    e.event_type === "FEE" || e.metadata?.is_deduction === true || e.deduction_type
  );
  const refunds = events.filter((e) =>
    e.event_type === "REFUND" || e.metadata?.canonical_event_type === "REFUND" || e.metadata?.is_return_clawback === true
  );

  const settlementAmount = settlements.length > 0 ? Number(settlements[0].amount) : null;
  const bankCreditAmount = bankCredits.length > 0 ? Number(bankCredits[0].amount) : null;
  const variance = (settlementAmount !== null && bankCreditAmount !== null)
    ? Math.round((bankCreditAmount - settlementAmount) * 100) / 100
    : null;

  const deductionList = deductions.map((d) => ({
    event_id: d.id,
    external_ref: d.external_ref,
    order_ref: d.order_id || d.metadata?.order_ref || d.metadata?.order_number,
    code: d.metadata?.amount_description || d.metadata?.amount_type || d.deduction_type || "Fee",
    category: d.metadata?.deduction_category || d.deduction_type || "fee",
    label: d.metadata?.deduction_label || d.metadata?.amount_description || "Deduction",
    amount: Number(d.amount),
    is_statutory: Boolean(d.metadata?.is_statutory_withholding),
  }));

  const unrecognizedDeductions = deductionList.filter(
    (d) => d.category === "unrecognized_deduction" || d.category === "other marketplace deduction" ||
      d.code === "SellerAccountHealthFee" || d.code === "CrossBorderServiceFee" || d.code === "NewMarketplaceCode"
  );

  return {
    order_ref: orderRef,
    chain_summary: {
      total_events_found: events.length,
      settlement_report_amount: settlementAmount,
      bank_credit_amount: bankCreditAmount,
      variance_inr: variance,
      gross_sales_inr: Math.round(sales.reduce((sum, s) => sum + Number(s.amount || 0), 0) * 100) / 100,
      deductions_total_inr: Math.round(deductions.reduce((sum, d) => sum + Number(d.amount || 0), 0) * 100) / 100,
      refunds_total_inr: Math.round(refunds.reduce((sum, r) => sum + Number(r.amount || 0), 0) * 100) / 100,
      deduction_items: deductionList,
      unrecognized_deduction_items: unrecognizedDeductions,
    },
    chain: events.map((e: any) => ({
      id: e.id,
      event_type: e.metadata?.canonical_event_type || e.event_type,
      source_system: e.metadata?.canonical_source_system || e.source_system,
      external_ref: e.external_ref,
      amount: Number(e.amount),
      currency: e.currency,
      event_date: e.event_date,
      counterparty: e.counterparty,
      batch_ref: e.batch_ref || e.metadata?.batch_ref || e.metadata?.amazon_settlement_id,
      metadata: e.metadata,
    })),
    match: matchRow
      ? {
          id: matchRow.id,
          match_type: matchRow.match_type,
          confidence: matchRow.confidence,
          status: matchRow.status,
          signals: matchRow.signals,
        }
      : null,
  };
}

