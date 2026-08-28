import { describe, expect, test } from "bun:test";
import type { ExtractedRecord } from "../../shared/types";
import { AmazonAdapter } from "./amazon.adapter";

function fakeSupabase() {
  const query = {
    select() { return query; },
    eq() { return query; },
    or() { return query; },
    async maybeSingle() { return { data: null }; },
  };
  return { schema() { return { from() { return query; } }; } } as any;
}

function record(id: string, raw_json: Record<string, unknown>): ExtractedRecord {
  return {
    id,
    source_document_id: "document-1",
    mission_id: "mission-1",
    merchant_id: "merchant-1",
    raw_json,
    extraction_method: "csv_parse",
    created_at: "2026-08-01T00:00:00.000Z",
  };
}

describe("AmazonAdapter", () => {
  test("emits one settlement, one order sale, and every line item", async () => {
    const rows = [
      record("summary", { "settlement-id": "amz-set-1", "settlement-start-date": "2026-08-01", "settlement-end-date": "2026-08-14", "deposit-date": "2026-08-16", "total-amount": "889.00", currency: "INR" }),
      record("principal", { "settlement-id": "amz-set-1", "transaction-type": "Order", "order-id": "111-2222222-3333333", "merchant-order-id": "#MRC-24001", "amount-type": "ItemPrice", "amount-description": "Principal", amount: "1000.00", "posted-date": "2026-08-02" }),
      record("commission", { "settlement-id": "amz-set-1", "transaction-type": "Order", "order-id": "111-2222222-3333333", "merchant-order-id": "#MRC-24001", "amount-type": "ItemFees", "amount-description": "Commission", amount: "-100.00", "posted-date": "2026-08-02" }),
      record("tcs", { "settlement-id": "amz-set-1", "transaction-type": "Order", "order-id": "111-2222222-3333333", "merchant-order-id": "#MRC-24001", "amount-type": "ItemFees", "amount-description": "ItemTCS", amount: "-10.00", "posted-date": "2026-08-02" }),
      record("tds", { "settlement-id": "amz-set-1", "transaction-type": "Order", "order-id": "111-2222222-3333333", "merchant-order-id": "#MRC-24001", "amount-type": "ItemFees", "amount-description": "ItemTDS", amount: "-1.00", "posted-date": "2026-08-02" }),
      record("unknown", { "settlement-id": "amz-set-1", "transaction-type": "Order", "order-id": "111-2222222-3333333", "merchant-order-id": "#MRC-24001", "amount-type": "ItemFees", "amount-description": "NewMarketplaceCode", amount: "-0.00", "posted-date": "2026-08-02" }),
    ];
    const events = await new AmazonAdapter().normalize(rows, { missionId: "mission-1", merchantId: "merchant-1", supabase: fakeSupabase() });
    expect(events.filter((event) => event.event_type === "AMAZON_SETTLEMENT")).toHaveLength(1);
    expect(events.filter((event) => event.event_type === "SALE")).toHaveLength(1);
    expect(events.filter((event) => event.metadata?.amount_description)).toHaveLength(5);
    expect(events.find((event) => event.metadata?.amount_description === "ItemTCS")?.metadata?.is_statutory_withholding).toBe(true);
    expect(events.find((event) => event.metadata?.amount_description === "Commission")?.deduction_type).toBe("referral_fee");
    expect(events.find((event) => event.event_type === "AMAZON_SETTLEMENT")?.amount).toBe(889);
  });
});
