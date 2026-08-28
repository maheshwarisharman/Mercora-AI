import { describe, expect, test } from "bun:test";
import { detectMissionExceptions } from "./detect";
import type { NormalizedEvent } from "../shared/types";

function event(overrides: Partial<NormalizedEvent>): NormalizedEvent {
  return {
    id: "event",
    mission_id: "mission",
    merchant_id: "merchant",
    extracted_record_id: "record",
    event_type: "FEE",
    source_system: "amazon",
    amount: 10,
    currency: "INR",
    event_date: "2026-08-02",
    metadata: { canonical_event_type: "FEE", canonical_source_system: "amazon", is_deduction: true },
    ...overrides,
  };
}

describe("Amazon exception detection", () => {
  test("excludes TCS/TDS and flags unknown codes", () => {
    const exceptions = detectMissionExceptions([
      event({ id: "tcs", metadata: { canonical_event_type: "FEE", canonical_source_system: "amazon", is_deduction: true, is_statutory_withholding: true, deduction_category: "statutory_tax_withholding" } }),
      event({ id: "new-code", metadata: { canonical_event_type: "FEE", canonical_source_system: "amazon", is_deduction: true, deduction_category: "unrecognized_deduction" } }),
    ]);
    expect(exceptions.some((exception) => exception.normalized_event_ids.includes("tcs"))).toBe(false);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]?.exception_type).toBe("amazon_unknown_deduction");
  });

  test("flags a long-lookback return clawback only when no Shopify return is present", () => {
    const clawback = event({
      id: "clawback",
      event_type: "REFUND",
      amount: 250,
      metadata: {
        canonical_event_type: "REFUND",
        canonical_source_system: "amazon",
        is_deduction: true,
        is_return_clawback: true,
        order_ref: "#MRC-24001",
        deduction_category: "return_processing_charge",
      },
    });
    expect(detectMissionExceptions([clawback]).map((exception) => exception.exception_type)).toContain("amazon_return_clawback");

    const knownReturn = event({
      id: "shopify-refund",
      event_type: "REFUND",
      source_system: "shopify",
      amount: 250,
      external_ref: "#MRC-24001",
      metadata: { canonical_event_type: "REFUND", canonical_source_system: "shopify", order_ref: "#MRC-24001" },
    });
    expect(detectMissionExceptions([clawback, knownReturn]).some((exception) => exception.exception_type === "amazon_return_clawback")).toBe(false);
  });
});
