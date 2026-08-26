import type { NormalizedEvent } from "../shared/types";
import { computeLinkScore, getDateDiffDays, type BankCreditResolution } from "../reconcile/matcher";

export interface DetectedException {
  exception_type:
    | "timing_difference"
    | "gateway_fee"
    | "refund"
    | "partial_refund"
    | "duplicate"
    | "missing_settlement"
    | "missing_bank_credit"
    | "ambiguous_bank_credit"
    | "unexplained_difference";
  normalized_event_ids: string[];
  expected_amount: number;
  actual_amount: number;
  difference: number;
  status: "open" | "investigating" | "explained" | "requires_human_review" | "resolved";
}

/**
 * Deterministic Exception Detection Engine.
 * Scans normalized events and chain candidate links to identify gaps, timing delays,
 * duplicates, and unexplained variances.
 */
export function detectMissionExceptions(events: NormalizedEvent[], options: {
  bankCreditResolutions?: BankCreditResolution[];
  matchedBankEventIds?: Set<string>;
} = {}): DetectedException[] {
  const exceptions: DetectedException[] = [];

  // Disambiguation is intentionally represented as its own exception. A
  // low-confidence bank assignment must not be converted into a guessed
  // missing-bank or unexplained-difference exception by the legacy chain walk.
  for (const resolution of options.bankCreditResolutions || []) {
    const bankId = resolution.bank_credit.id;
    if (!bankId || options.matchedBankEventIds?.has(bankId)) continue;
    if (!["ambiguous", "no_candidates", "combined_batches", "insufficient_evidence"].includes(resolution.status)) continue;

    const candidateIds = resolution.candidates.map((candidate) => candidate.candidate_id).filter(Boolean);
    exceptions.push({
      exception_type: "ambiguous_bank_credit",
      normalized_event_ids: [bankId, ...candidateIds].slice(0, 21),
      expected_amount: resolution.candidates[0]?.amount ?? Number(resolution.bank_credit.amount),
      actual_amount: Number(resolution.bank_credit.amount),
      difference: resolution.candidates[0]
        ? Math.round((Number(resolution.candidates[0].amount) - Number(resolution.bank_credit.amount)) * 100) / 100
        : 0,
      status: "open",
    });
  }

  const canonicalType = (event: NormalizedEvent): string => String(event.metadata?.canonical_event_type || event.event_type);
  const sales = events.filter((e) => canonicalType(e) === "SALE");
  const payments = events.filter((e) => canonicalType(e) === "PAYMENT");
  const fees = events.filter((e) => canonicalType(e) === "FEE");
  const settlements = events.filter((e) => canonicalType(e) === "SETTLEMENT");
  const bankTxns = events.filter((e) => {
    const direction = String(e.metadata?.direction || "").toLowerCase();
    return direction !== "debit" && direction !== "dr" &&
      (e.event_type === "BANK_TRANSACTION" || e.event_type === "BANK_CREDIT" || e.metadata?.canonical_event_type === "BANK_CREDIT");
  });

  // Fee lookup map
  const feeByPaymentKey = new Map<string, NormalizedEvent>();
  for (const fee of fees) {
    if (fee.payment_id) feeByPaymentKey.set(fee.payment_id, fee);
    if (fee.metadata?.parent_payment_id) feeByPaymentKey.set(fee.metadata.parent_payment_id, fee);
    if (fee.external_ref) feeByPaymentKey.set(fee.external_ref, fee);
  }

  // --------------------------------------------------------------------------
  // 1. DUPLICATE DETECTION
  // --------------------------------------------------------------------------
  const seenEventSignatures = new Map<string, NormalizedEvent>();
  const processedDuplicates = new Set<string>();

  for (const evt of events) {
    if (!evt.external_ref || !evt.id) continue;
    // Primary transaction events only to avoid triplicating gateway fee/settlement sub-events
    if (evt.event_type !== "PAYMENT" && evt.event_type !== "SALE" && evt.event_type !== "BANK_TRANSACTION") {
      continue;
    }
    const signature = `${evt.source_system}|${evt.external_ref}|${Number(evt.amount).toFixed(2)}|${evt.event_date}`;

    if (seenEventSignatures.has(signature)) {
      const priorEvt = seenEventSignatures.get(signature)!;
      if (!priorEvt.id) continue;

      const dupKey = [priorEvt.id, evt.id].sort().join(":");

      if (!processedDuplicates.has(dupKey)) {
        processedDuplicates.add(dupKey);
        exceptions.push({
          exception_type: "duplicate",
          normalized_event_ids: [priorEvt.id, evt.id],
          expected_amount: Number(priorEvt.amount),
          actual_amount: Number(priorEvt.amount) + Number(evt.amount),
          difference: Number(evt.amount),
          status: "open",
        });
      }
    } else {
      seenEventSignatures.set(signature, evt);
    }
  }

  // --------------------------------------------------------------------------
  // 2. CHAIN WALKING & EXCEPTION CLASSIFICATION
  // --------------------------------------------------------------------------
  const matchedPaymentIds = new Set<string>();
  const matchedSettlementIds = new Set<string>();
  const matchedBankIds = new Set<string>();
  const assignedBankByCandidate = new Map<string, NormalizedEvent>();
  for (const resolution of options.bankCreditResolutions || []) {
    if (resolution.chosen_candidate_id && ["deterministic", "llm_resolved"].includes(resolution.status)) {
      assignedBankByCandidate.set(resolution.chosen_candidate_id, resolution.bank_credit);
    }
  }

  for (const sale of sales) {
    const saleId = sale.id || "";
    if (!saleId) continue;

    // A. Match Sale to Payment
    let bestPayment: NormalizedEvent | null = null;
    let bestPaymentScore = 0;

    for (const payment of payments) {
      const paymentId = payment.id || "";
      if (paymentId && matchedPaymentIds.has(paymentId)) continue;

      const hasDirectIdLink = !!(
        (sale.order_id && payment.order_id && sale.order_id === payment.order_id) ||
        (sale.external_ref && payment.metadata?.order_ref === sale.external_ref) ||
        (sale.metadata?.order_number && String(payment.metadata?.order_ref) === String(sale.metadata.order_number))
      );

      const score = computeLinkScore({
        hasDirectIdLink,
        expectedAmount: Number(sale.amount),
        actualAmount: Number(payment.amount),
        date1: sale.event_date,
        date2: payment.event_date,
        refString1: sale.external_ref || sale.metadata?.order_number,
        refString2: payment.metadata?.order_ref || payment.external_ref,
      });

      if (score.total > bestPaymentScore) {
        bestPaymentScore = score.total;
        bestPayment = payment;
      }
    }

    if (!bestPayment || bestPaymentScore < 50 || !bestPayment.id) {
      continue;
    }

    matchedPaymentIds.add(bestPayment.id);
    const paymentFee = feeByPaymentKey.get(bestPayment.id) || (bestPayment.external_ref ? feeByPaymentKey.get(bestPayment.external_ref) : undefined);
    const expectedNetAmount = paymentFee ? Number(bestPayment.amount) - Number(paymentFee.amount) : Number(bestPayment.amount);

    // B. Match Payment to Settlement
    let bestSettlement: NormalizedEvent | null = null;
    let bestSettlementScore = 0;

    for (const settlement of settlements) {
      const settlementId = settlement.id || "";
      if (settlementId && matchedSettlementIds.has(settlementId)) continue;

      const hasDirectIdLink = !!(
        (settlement.metadata?.payment_id && settlement.metadata.payment_id === bestPayment.external_ref) ||
        (bestPayment.metadata?.settlement_id && settlement.external_ref === bestPayment.metadata.settlement_id) ||
        (bestPayment.order_id && settlement.order_id && bestPayment.order_id === settlement.order_id)
      );

      const score = computeLinkScore({
        hasDirectIdLink,
        expectedAmount: expectedNetAmount,
        actualAmount: Number(settlement.amount),
        date1: bestPayment.event_date,
        date2: settlement.event_date,
        refString1: bestPayment.external_ref,
        refString2: settlement.metadata?.payment_id || settlement.external_ref,
      });

      if (score.total > bestSettlementScore) {
        bestSettlementScore = score.total;
        bestSettlement = settlement;
      }
    }

    // Condition 1: Missing Settlement
    if (!bestSettlement || bestSettlementScore < 50 || !bestSettlement.id) {
      const chainIds = [saleId, bestPayment.id];
      if (paymentFee?.id) chainIds.push(paymentFee.id);

      exceptions.push({
        exception_type: "missing_settlement",
        normalized_event_ids: chainIds,
        expected_amount: Number(bestPayment.amount),
        actual_amount: 0,
        difference: Number(bestPayment.amount),
        status: "open",
      });
      continue;
    }

    matchedSettlementIds.add(bestSettlement.id);

    // C. Match Settlement to Bank Transaction
    let bestBank: NormalizedEvent | null = null;
    let bestBankScore = 0;

    const assignedBank = bestSettlement.id ? assignedBankByCandidate.get(bestSettlement.id) : undefined;
    if (assignedBank) {
      bestBank = assignedBank;
      bestBankScore = computeLinkScore({
        hasDirectIdLink: false,
        expectedAmount: Number(bestSettlement.amount),
        actualAmount: Number(assignedBank.amount),
        date1: bestSettlement.event_date,
        date2: assignedBank.event_date,
        refString1: bestSettlement.external_ref,
        refString2: assignedBank.external_ref || assignedBank.counterparty,
      }).total;
    }

    for (const bank of assignedBank ? [] : bankTxns) {
      const bankId = bank.id || "";
      if (bankId && matchedBankIds.has(bankId)) continue;

      if (bestSettlement.id && (options.bankCreditResolutions || []).some((resolution) =>
        resolution.candidates.some((candidate) => candidate.candidate_id === bestSettlement!.id)
      )) continue;

      const bankDesc = String(bank.counterparty || bank.metadata?.description || "");
      const settlementRef = bestSettlement.external_ref || "";

      const hasDirectIdLink = !!(
        (bank.metadata?.settlement_id && bank.metadata.settlement_id === settlementRef) ||
        (settlementRef && bankDesc.includes(settlementRef))
      );

      const score = computeLinkScore({
        hasDirectIdLink,
        expectedAmount: Number(bestSettlement.amount),
        actualAmount: Number(bank.amount),
        date1: bestSettlement.event_date,
        date2: bank.event_date,
        refString1: settlementRef,
        refString2: bankDesc,
      });

      if (score.total > bestBankScore) {
        bestBankScore = score.total;
        bestBank = bank;
      }
    }

    // Condition 2: Missing Bank Credit
    if (!bestBank || bestBankScore < 50 || !bestBank.id) {
      const isAmbiguousCandidate = Boolean(bestSettlement.id && (options.bankCreditResolutions || []).some((resolution) =>
        ["ambiguous", "combined_batches", "insufficient_evidence"].includes(resolution.status) &&
        resolution.candidates.some((candidate) => candidate.candidate_id === bestSettlement!.id)
      ));
      if (isAmbiguousCandidate) continue;
      const chainIds = [saleId, bestPayment.id, bestSettlement.id];
      if (paymentFee?.id) chainIds.push(paymentFee.id);

      exceptions.push({
        exception_type: "missing_bank_credit",
        normalized_event_ids: chainIds,
        expected_amount: Number(bestSettlement.amount),
        actual_amount: 0,
        difference: Number(bestSettlement.amount),
        status: "open",
      });
      continue;
    }

    matchedBankIds.add(bestBank.id);

    const fullChainIds = [saleId, bestPayment.id, bestSettlement.id, bestBank.id];
    if (paymentFee?.id && !fullChainIds.includes(paymentFee.id)) {
      fullChainIds.push(paymentFee.id);
    }

    // Condition 3: Timing Difference (Bank credit date - settlement date > 5 days)
    const dateLagDays = getDateDiffDays(bestSettlement.event_date, bestBank.event_date);
    if (dateLagDays > 5) {
      exceptions.push({
        exception_type: "timing_difference",
        normalized_event_ids: fullChainIds,
        expected_amount: Number(bestSettlement.amount),
        actual_amount: Number(bestBank.amount),
        difference: 0,
        status: "open",
      });
    }

    // Condition 4: Unexplained Difference (abs(expected - actual) > ₹1)
    const amountDelta = Math.abs(Number(bestSettlement.amount) - Number(bestBank.amount));
    if (amountDelta > 1.0) {
      exceptions.push({
        exception_type: "unexplained_difference",
        normalized_event_ids: fullChainIds,
        expected_amount: Number(bestSettlement.amount),
        actual_amount: Number(bestBank.amount),
        difference: Math.round((Number(bestSettlement.amount) - Number(bestBank.amount)) * 100) / 100,
        status: "open",
      });
    }
  }

  return exceptions;
}
