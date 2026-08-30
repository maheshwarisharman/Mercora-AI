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
    "Retrieves the full financial event chain for a given order reference. " +
    "Returns every normalized event associated with that order — including SALE (Shopify), " +
    "PAYMENT (Razorpay capture), SETTLEMENT (Razorpay payout), and BANK_TRANSACTION (HDFC credit) — " +
    "along with any finance.matches row that links them and its confidence score. " +
    "Call this when you need to verify whether an expected settlement amount reached the bank, " +
    "to trace a missing leg in the payment chain, or to understand the exact amounts and dates " +
    "at each stage of a specific order's lifecycle.",
  parameters: {
    type: "object",
    properties: {
      order_ref: {
        type: "string",
        description:
          "The external order reference (e.g. 'SHF-1038', 'rzp_pay_XYZ123', order number). " +
          "Try variants from the exception's linked events if the first attempt returns nothing.",
      },
    },
    required: ["order_ref"],
  },
};

export async function getTransactionChain(args: Record<string, unknown>): Promise<unknown> {
  const orderRef = String(args.order_ref || "");
  if (!orderRef) return { error: "order_ref is required" };

  const supabase = getServiceSupabase();
  const orderRefFilterValue = postgrestFilterValue(orderRef);
  const orderRefSearchValue = postgrestFilterValue(`%${orderRef}%`);

  // Find normalized events matching the order ref in external_ref or metadata
  const { data: events, error: evErr } = await supabase
    .schema("finance")
    .from("normalized_events")
    .select("*")
    .or(
      // Use ->> here: -> returns jsonb, causing PostgreSQL to parse values
      // such as "#MRC-24015" as JSON and fail with invalid input syntax.
      `external_ref.ilike.${orderRefSearchValue},metadata->>order_ref.eq.${orderRefFilterValue},metadata->>order_number.eq.${orderRefFilterValue}`
    )
    .order("event_date", { ascending: true });

  if (evErr) return { error: evErr.message };

  // Find any matches row that contains these event IDs
  const eventIds = (events || []).map((e: any) => e.id).filter(Boolean);
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

  return {
    order_ref: orderRef,
    chain: (events || []).map((e: any) => ({
      id: e.id,
      event_type: e.event_type,
      source_system: e.source_system,
      external_ref: e.external_ref,
      amount: Number(e.amount),
      currency: e.currency,
      event_date: e.event_date,
      counterparty: e.counterparty,
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
