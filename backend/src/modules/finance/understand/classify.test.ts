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
});
