import { describe, expect, test } from "bun:test";
import type { ExtractedRecord } from "../../shared/types";
import { GenericCodAdapter } from "./generic-cod.adapter";

function fakeSupabase() {
  const query = {
    select() { return query; },
    eq() { return query; },
    or() { return query; },
    async maybeSingle() { return { data: null }; },
  };
  return {
    schema() {
      return { from() { return query; } };
    },
  } as any;
}

function record(raw_json: Record<string, unknown>): ExtractedRecord {
  return {
    id: "record-1",
    source_document_id: "document-1",
    mission_id: "mission-1",
    merchant_id: "merchant-1",
    raw_json,
    extraction_method: "csv_parse",
    created_at: "2026-08-01T00:00:00.000Z",
  };
}

describe("GenericCodAdapter", () => {
  test("maps Shipmozo order, reference, and delivered-date columns", async () => {
    const adapter = new GenericCodAdapter();
    const input = record({
      "order id": "internal-shipment-id",
      "ref order id": "#HBM27395",
      "delivered date": "22 Jul 2026",
      courier: "Amazon ATS",
      cod_amount: "1,225.00",
    });

    expect(adapter.validate([input]).valid).toBe(true);
    const [event] = await adapter.normalize([input], {
      missionId: "mission-1",
      merchantId: "merchant-1",
      supabase: fakeSupabase(),
    });

    expect(event?.amount).toBe(1225);
    expect(event?.event_date).toBe("2026-07-22");
    expect(event?.metadata?.order_id).toBe("#HBM27395");
    expect(event?.order_ids).toEqual(["#HBM27395"]);
    expect(event?.external_ref).toBe("remit-#HBM27395");
  });
});
