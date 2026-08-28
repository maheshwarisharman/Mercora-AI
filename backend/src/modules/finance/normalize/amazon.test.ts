import { describe, expect, test } from "bun:test";
import { classifyAmazonLine, isAmazonSummaryRow, looksLikeAmazonSettlementHeaders, parseAmazonAmount } from "./amazon";
import { parseCsvBufferToRecords } from "../extract/csv";

describe("Amazon Flat File V2 parsing", () => {
  test("recognises the real 24-column tab-delimited header and summary row", () => {
    const headers = [
      "settlement-id", "settlement-start-date", "settlement-end-date", "deposit-date", "total-amount", "currency",
      "transaction-type", "order-id", "merchant-order-id", "adjustment-id", "shipment-id", "marketplace-name",
      "amount-type", "amount-description", "amount", "fulfillment-id", "posted-date", "posted-date-time",
      "order-item-code", "merchant-order-item-id", "merchant-adjustment-item-id", "sku", "quantity-purchased", "promotion-id",
    ];
    expect(looksLikeAmazonSettlementHeaders(headers)).toBe(true);
    expect(isAmazonSummaryRow({ "settlement-id": "123", "total-amount": "889.00", currency: "INR" })).toBe(true);
    expect(parseAmazonAmount("(1,234.50)")).toBe(-1234.5);
  });

  test("preserves tab-delimited rows as exact raw extracted records", () => {
    const csv = "settlement-id\tamount-type\tamount-description\tamount\n123\tItemFees\tCommission\t-100.00\n";
    const [record] = parseCsvBufferToRecords({
      buffer: Buffer.from(csv),
      sourceDocumentId: "doc",
      missionId: "mission",
      merchantId: "merchant",
    });
    expect(record?.raw_json["amount-description"]).toBe("Commission");
    expect(record?.raw_json.amount).toBe("-100.00");
  });

  test("classifies statutory withholding separately from an unknown code", () => {
    const statutory = classifyAmazonLine({ "amount-type": "ItemFees", "amount-description": "ItemTCS" }, -10);
    const unknown = classifyAmazonLine({ "amount-type": "ItemFees", "amount-description": "NewMarketplaceCode" }, -12);
    expect(statutory.category).toBe("statutory_tax_withholding");
    expect(statutory.isStatutoryWithholding).toBe(true);
    expect(statutory.requiresAgent).toBe(false);
    expect(unknown.category).toBe("unrecognized_deduction");
    expect(unknown.requiresAgent).toBe(true);
  });
});
