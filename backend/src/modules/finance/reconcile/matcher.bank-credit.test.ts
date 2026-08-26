import { describe, expect, test } from "bun:test";
import {
  rankBankCreditCandidates,
  resolveBankCreditDeterministically,
  resolveBankCreditCandidates,
} from "./matcher";
import { runBankCreditFallback } from "./disambiguate";
import type { NormalizedEvent } from "../shared/types";

function event(overrides: Partial<NormalizedEvent>): NormalizedEvent {
  return {
    id: "event-id",
    mission_id: "mission-id",
    merchant_id: "merchant-id",
    extracted_record_id: "record-id",
    event_type: "SETTLEMENT",
    source_system: "razorpay",
    amount: 1000,
    currency: "INR",
    event_date: "2026-08-01",
    metadata: {},
    ...overrides,
  };
}

describe("bank credit disambiguation scorer", () => {
  test("ranks exact amount, expected date, and narration evidence highest", () => {
    const bank = event({
      id: "bank-1",
      event_type: "BANK_TRANSACTION",
      source_system: "bank",
      amount: 1000,
      event_date: "2026-08-03",
      external_ref: "NEFT RAZORPAY SETL setl-good",
      counterparty: "Razorpay settlement",
    });
    const good = event({ id: "setl-good", external_ref: "setl-good", amount: 1000, event_date: "2026-08-01" });
    const weak = event({ id: "setl-weak", external_ref: "setl-weak", amount: 1000, event_date: "2026-08-08" });

    const ranked = rankBankCreditCandidates(bank, [good, weak]);
    expect(ranked[0]?.candidate_id).toBe("setl-good");
    expect(ranked[0]?.signals.amount).toBe(45);
    expect(ranked[0]?.signals.matched_keywords).toContain("razorpay");
  });

  test("allows a new courier's patterns and date window through config", () => {
    const bank = event({
      id: "bank-2",
      event_type: "BANK_CREDIT",
      source_system: "bank",
      amount: 500,
      event_date: "2026-08-11",
      counterparty: "ACME logistics remittance",
    });
    const candidate = event({
      id: "acme-1",
      event_type: "COD_REMITTANCE",
      source_system: "courier",
      amount: 500,
      event_date: "2026-08-01",
      counterparty: "ACME Logistics",
      metadata: { courier_partner: "ACME Logistics" },
    });

    const resolution = resolveBankCreditDeterministically({
      bankCredit: bank,
      candidates: [candidate],
      config: {
        sourceKeywords: { courier: ["acme logistics"] },
        sourceDateWindows: { courier: { minDays: 7, maxDays: 12, idealDays: 10 } },
      },
    });
    expect(resolution.status).toBe("deterministic");
    expect(resolution.chosen_candidate_id).toBe("acme-1");
  });

  test("leaves a close tie ambiguous and prevents duplicate claims", () => {
    const bank = event({
      id: "bank-3",
      event_type: "BANK_TRANSACTION",
      source_system: "bank",
      amount: 1000,
      event_date: "2026-08-03",
      counterparty: "NEFT credit",
    });
    const first = event({ id: "setl-1", external_ref: "setl-1", amount: 1000, event_date: "2026-08-01" });
    const second = event({ id: "setl-2", external_ref: "setl-2", amount: 1000, event_date: "2026-08-01" });
    expect(resolveBankCreditDeterministically({ bankCredit: bank, candidates: [first, second] }).status).toBe("ambiguous");

    const secondBank = { ...bank, id: "bank-4" };
    const resolutions = resolveBankCreditCandidates({ bankCredits: [bank, secondBank], candidates: [first] });
    expect(resolutions.filter((item) => item.status === "deterministic")).toHaveLength(1);
    expect(resolutions.filter((item) => item.status === "ambiguous")).toHaveLength(1);
  });

  test("rejects an LLM candidate ID that is absent from the exact ranked list", async () => {
    const bank = event({ id: "bank-guard", event_type: "BANK_TRANSACTION", source_system: "bank" });
    const candidate = event({ id: "real-candidate", external_ref: "real-candidate" });
    const resolution = resolveBankCreditDeterministically({ bankCredit: bank, candidates: [candidate] });
    const fakeProvider = {
      name: "fake",
      runAgentStep: async () => ({ message: { role: "assistant", content: "done" }, requestsToolCalls: false }),
      generateStructured: async () => ({
        data: {
          decision: "chosen_candidate",
          chosen_candidate_id: "invented-candidate",
          combined_candidate_ids: [],
          reasoning: "invented",
        },
        rawResponse: {},
        model: "fake",
        provider: "fake",
      }),
    } as any;

    const result = await runBankCreditFallback({
      resolution,
      merchantId: "merchant-id",
      missionId: "mission-id",
      llmProvider: fakeProvider,
    });
    expect(result.resolution.status).toBe("insufficient_evidence");
    expect(result.resolution.chosen_candidate_id).toBeNull();
  });
});
