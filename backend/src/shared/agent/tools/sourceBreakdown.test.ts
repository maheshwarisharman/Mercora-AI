import { describe, expect, test } from "bun:test";
import { buildSourceFinancialBreakdown } from "./sourceBreakdown";

describe("buildSourceFinancialBreakdown", () => {
  test("compares Amazon and Shopify sales without mixing settlement rows into sales", () => {
    const breakdown = buildSourceFinancialBreakdown(
      [
        { id: "shopify-sale-1", event_type: "SALE", source_system: "shopify", amount: 100 },
        { id: "shopify-sale-2", event_type: "SALE", source_system: "shopify", amount: 50 },
        { id: "amazon-sale-1", event_type: "SALE", source_system: "amazon", amount: 300 },
        { event_type: "SETTLEMENT", source_system: "vendor", amount: 250, metadata: { canonical_source_system: "amazon", canonical_event_type: "AMAZON_SETTLEMENT" } },
        { event_type: "FEE", source_system: "amazon", amount: -20 },
        { event_type: "BANK_TRANSACTION", source_system: "bank", amount: 250 },
      ],
      [
        { event_ids: ["shopify-sale-1", "amazon-sale-1"], status: "auto_matched" },
      ],
    );

    expect(breakdown.shopify).toMatchObject({
      sale_order_count: 2,
      gross_sales_inr: 150,
      matched_sale_order_count: 1,
      matched_sales_inr: 100,
      unmatched_sale_order_count: 1,
      unmatched_sales_inr: 50,
    });
    expect(breakdown.amazon).toMatchObject({
      sale_order_count: 1,
      gross_sales_inr: 300,
      matched_sale_order_count: 1,
      matched_sales_inr: 300,
      settlement_count: 1,
      settlement_value_inr: 250,
      fee_count: 1,
      fee_value_inr: 20,
    });
    expect(breakdown.bank.bank_credit_value_inr).toBe(250);
  });

  test("does not count rejected matches as matched sales", () => {
    const breakdown = buildSourceFinancialBreakdown(
      [{ id: "sale-1", event_type: "SALE", source_system: "amazon", amount: 125 }],
      [{ event_ids: ["sale-1"], status: "rejected" }],
    );

    expect(breakdown.amazon.matched_sale_order_count).toBe(0);
    expect(breakdown.amazon.unmatched_sales_inr).toBe(125);
  });
});
