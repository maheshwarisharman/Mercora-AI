import { getServiceSupabase } from "../../db/supabase";
import type { ToolDefinition } from "../../llm/types";

type BreakdownEvent = {
  id?: string;
  event_type?: string | null;
  source_system?: string | null;
  amount?: number | string | null;
  metadata?: Record<string, any> | null;
};

type BreakdownMatch = {
  event_ids?: string[] | null;
  status?: string | null;
};

export interface SourceFinancialBreakdown {
  sale_order_count: number;
  gross_sales_inr: number;
  matched_sale_order_count: number;
  matched_sales_inr: number;
  unmatched_sale_order_count: number;
  unmatched_sales_inr: number;
  settlement_count: number;
  settlement_value_inr: number;
  fee_count: number;
  fee_value_inr: number;
  refund_count: number;
  refund_value_inr: number;
  bank_credit_count: number;
  bank_credit_value_inr: number;
}

const EMPTY_BREAKDOWN: SourceFinancialBreakdown = {
  sale_order_count: 0,
  gross_sales_inr: 0,
  matched_sale_order_count: 0,
  matched_sales_inr: 0,
  unmatched_sale_order_count: 0,
  unmatched_sales_inr: 0,
  settlement_count: 0,
  settlement_value_inr: 0,
  fee_count: 0,
  fee_value_inr: 0,
  refund_count: 0,
  refund_value_inr: 0,
  bank_credit_count: 0,
  bank_credit_value_inr: 0,
};

function canonicalType(event: BreakdownEvent): string {
  return String(event.metadata?.canonical_event_type || event.event_type || "").toUpperCase();
}

function canonicalSource(event: BreakdownEvent): string {
  return String(event.metadata?.canonical_source_system || event.source_system || "unknown").toLowerCase();
}

function amountOf(event: BreakdownEvent): number {
  const amount = Number(event.amount || 0);
  return Number.isFinite(amount) ? Math.abs(amount) : 0;
}

function roundMoney(value: number): number {
  return Number(value.toFixed(2));
}

function isActiveMatch(match: BreakdownMatch): boolean {
  return match.status !== "rejected";
}

/**
 * Pure roll-up used by the mission-scoped QA tool. SALE events are counted by
 * canonical source, while settlements, deductions, refunds, and bank credits
 * remain available as context for the answer.
 */
export function buildSourceFinancialBreakdown(
  events: BreakdownEvent[],
  matches: BreakdownMatch[]
): Record<string, SourceFinancialBreakdown> {
  const bySource: Record<string, SourceFinancialBreakdown> = {};
  const salesById = new Map<string, { source: string; amount: number }>();
  const matchedSaleIds = new Set<string>();

  const ensure = (source: string): SourceFinancialBreakdown => {
    if (!bySource[source]) bySource[source] = { ...EMPTY_BREAKDOWN };
    return bySource[source];
  };

  for (const event of events) {
    const source = canonicalSource(event);
    const type = canonicalType(event);
    const amount = amountOf(event);
    const rollup = ensure(source);

    if (type === "SALE") {
      rollup.sale_order_count += 1;
      rollup.gross_sales_inr += amount;
      if (event.id) salesById.set(String(event.id), { source, amount });
    } else if (type === "SETTLEMENT" || type === "AMAZON_SETTLEMENT") {
      rollup.settlement_count += 1;
      rollup.settlement_value_inr += amount;
    } else if (type === "FEE" || type === "COD_DEDUCTION") {
      rollup.fee_count += 1;
      rollup.fee_value_inr += amount;
    } else if (type === "REFUND" || type === "CHARGEBACK") {
      rollup.refund_count += 1;
      rollup.refund_value_inr += amount;
    } else if (type === "BANK_CREDIT" || type === "BANK_TRANSACTION") {
      rollup.bank_credit_count += 1;
      rollup.bank_credit_value_inr += amount;
    }
  }

  for (const match of matches) {
    if (!isActiveMatch(match)) continue;
    for (const eventId of match.event_ids || []) {
      if (salesById.has(String(eventId))) matchedSaleIds.add(String(eventId));
    }
  }

  for (const [eventId, sale] of salesById) {
    const rollup = ensure(sale.source);
    if (matchedSaleIds.has(eventId)) {
      rollup.matched_sale_order_count += 1;
      rollup.matched_sales_inr += sale.amount;
    } else {
      rollup.unmatched_sale_order_count += 1;
      rollup.unmatched_sales_inr += sale.amount;
    }
  }

  for (const rollup of Object.values(bySource)) {
    for (const key of Object.keys(rollup) as Array<keyof SourceFinancialBreakdown>) {
      rollup[key] = typeof rollup[key] === "number" && key.endsWith("_inr")
        ? roundMoney(rollup[key] as number)
        : rollup[key];
    }
  }

  return bySource;
}

export const compareSalesBySourceDefinition: ToolDefinition = {
  name: "compare_sales_by_source",
  description:
    "Returns a deterministic, mission-scoped financial breakdown grouped by canonical source. " +
    "Use this for questions comparing Amazon, Shopify, Razorpay, COD, or other ingested channels, " +
    "especially questions such as 'how much did we sell on Amazon versus Shopify?'. " +
    "Gross sales come only from SALE events; matched and unmatched sales are computed from active " +
    "finance.matches rows. The response also includes settlement, fee, refund, and bank-credit totals " +
    "when those records were ingested.",
  parameters: {
    type: "object",
    properties: {},
  },
};

export async function compareSalesBySource(
  _args: Record<string, unknown>,
  context: { merchantId?: string; missionId?: string }
): Promise<unknown> {
  if (!context.merchantId || !context.missionId) {
    return { error: "merchantId and missionId are required" };
  }

  const supabase = getServiceSupabase();
  const [{ data: events, error: eventsError }, { data: matches, error: matchesError }] = await Promise.all([
    supabase
      .schema("finance")
      .from("normalized_events")
      .select("id, event_type, source_system, amount, metadata")
      .eq("mission_id", context.missionId)
      .eq("merchant_id", context.merchantId),
    supabase
      .schema("finance")
      .from("matches")
      .select("event_ids, status")
      .eq("mission_id", context.missionId),
  ]);

  if (eventsError || matchesError) {
    return { error: eventsError?.message || matchesError?.message || "Unable to load mission financial data" };
  }

  const bySource = buildSourceFinancialBreakdown(
    (events || []) as BreakdownEvent[],
    (matches || []) as BreakdownMatch[],
  );
  const amazon = bySource.amazon || { ...EMPTY_BREAKDOWN };
  const shopify = bySource.shopify || { ...EMPTY_BREAKDOWN };

  return {
    mission_id: context.missionId,
    by_source: bySource,
    sales_comparison: {
      amazon_gross_sales_inr: amazon.gross_sales_inr,
      shopify_gross_sales_inr: shopify.gross_sales_inr,
      amazon_minus_shopify_inr: roundMoney(amazon.gross_sales_inr - shopify.gross_sales_inr),
      amazon_to_shopify_ratio: shopify.gross_sales_inr
        ? roundMoney(amazon.gross_sales_inr / shopify.gross_sales_inr)
        : null,
    },
    definition: "Gross sales are the sum of canonical SALE event amounts; settlement totals are separate net-payout context.",
  };
}
