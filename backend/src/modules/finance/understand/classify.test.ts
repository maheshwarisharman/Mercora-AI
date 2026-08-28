import { describe, expect, test } from "bun:test";
import { classifyDocumentHeuristic } from "./classify";

describe("finance source classification", () => {
  test("recognizes shipment-level COD exports from filename and headers", () => {
    const result = classifyDocumentHeuristic("cod_remittances.csv", [
      "ref order id",
      "order id",
      "cod_amount",
      "delivered date",
      "batch_ref",
      "courier",
    ]);

    expect(result.detected_source).toBe("generic_cod");
    expect(result.detection_confidence).toBe(95);
    expect(result.is_suspicious).toBeUndefined();
  });

  test("recognizes Amazon Flat File V2 even when the download has a .txt extension", () => {
    const result = classifyDocumentHeuristic("amazon_settlement.txt", [
      "settlement-id",
      "settlement-start-date",
      "settlement-end-date",
      "deposit-date",
      "total-amount",
      "currency",
      "transaction-type",
      "order-id",
      "merchant-order-id",
      "amount-type",
      "amount-description",
      "amount",
      "posted-date",
      "posted-date-time",
    ]);
    expect(result.detected_source).toBe("amazon_settlement");
    expect(result.detection_confidence).toBe(95);
  });
});
