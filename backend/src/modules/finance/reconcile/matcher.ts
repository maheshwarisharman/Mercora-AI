import levenshtein from "fast-levenshtein";
import type { NormalizedEvent } from "../shared/types";

export interface LinkSignalBreakdown {
  id_signal: number;
  amount_signal: number;
  date_signal: number;
  reference_signal: number;
  total: number;
}

export interface ReconciledChain {
  order_ref: string;
  event_ids: string[];
  match_type: "exact_id" | "amount_date_window" | "fuzzy_reference" | "settlement_chain";
  confidence: number;
  status: "auto_matched" | "proposed";
  signals: {
    sale_to_payment?: LinkSignalBreakdown;
    payment_to_settlement?: LinkSignalBreakdown;
    settlement_to_bank?: LinkSignalBreakdown;
  };
  events: {
    sale?: NormalizedEvent;
    payment?: NormalizedEvent;
    fee?: NormalizedEvent;
    settlement?: NormalizedEvent;
    bank?: NormalizedEvent;
  };
}

export interface MatchResult {
  matches: ReconciledChain[];
  unmatched_sales: NormalizedEvent[];
  unmatched_payments: NormalizedEvent[];
  unmatched_settlements: NormalizedEvent[];
  unmatched_bank: NormalizedEvent[];
}

/**
 * Calculates string similarity ratio between 0.0 and 1.0 using Levenshtein distance
 * and substring containment checks.
 */
export function calculateFuzzySimilarity(str1: string, str2: string): number {
  if (!str1 || !str2) return 0;
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();

  if (s1 === s2) return 1.0;
  if (s2.includes(s1) || s1.includes(s2)) return 1.0;

  // Check token containment
  const tokens1 = s1.split(/[\s_\-/#,.]+/).filter((t) => t.length >= 3);
  const tokens2 = s2.split(/[\s_\-/#,.]+/).filter((t) => t.length >= 3);

  for (const t1 of tokens1) {
    if (tokens2.includes(t1) || s2.includes(t1)) return 1.0;
  }

  const maxLen = Math.max(s1.length, s2.length);
  if (maxLen === 0) return 1.0;
  const distance = levenshtein.get(s1, s2);
  return Math.max(0, 1 - distance / maxLen);
}

/**
 * Helper to compute absolute calendar day difference between two ISO date strings.
 */
export function getDateDiffDays(date1?: string | null, date2?: string | null): number {
  if (!date1 || !date2) return 0;
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  const diffMs = Math.abs(d1.getTime() - d2.getTime());
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Pure scoring function for a single link between two normalized events.
 */
export function computeLinkScore(params: {
  hasDirectIdLink: boolean;
  expectedAmount: number;
  actualAmount: number;
  date1?: string | null;
  date2?: string | null;
  refString1?: string | null;
  refString2?: string | null;
}): LinkSignalBreakdown {
  const { hasDirectIdLink, expectedAmount, actualAmount, date1, date2, refString1, refString2 } = params;

  // 1. ID Signal
  const id_signal = hasDirectIdLink ? 100 : 0;

  // 2. Amount Signal
  const amountDiff = Math.abs(expectedAmount - actualAmount);
  const largerAmount = Math.max(Math.abs(expectedAmount), Math.abs(actualAmount), 1);
  let amount_signal = 0;
  if (amountDiff <= 1.0) {
    amount_signal = 30;
  } else if (amountDiff <= 0.01 * largerAmount) {
    amount_signal = 20;
  } else if (amountDiff <= 0.05 * largerAmount) {
    amount_signal = 10;
  }

  // 3. Date Signal
  const dateDiffDays = getDateDiffDays(date1, date2);
  let date_signal = 0;
  if (dateDiffDays === 0) {
    date_signal = 25;
  } else if (dateDiffDays >= 1 && dateDiffDays <= 3) {
    date_signal = 20;
  } else if (dateDiffDays >= 4 && dateDiffDays <= 7) {
    date_signal = 12;
  } else if (dateDiffDays >= 8 && dateDiffDays <= 14) {
    date_signal = 5;
  }

  // 4. Reference Signal
  let reference_signal = 0;
  if (refString1 && refString2) {
    const similarity = calculateFuzzySimilarity(refString1, refString2);
    if (similarity >= 0.9) {
      reference_signal = 20;
    } else if (similarity >= 0.7) {
      reference_signal = 10;
    }
  }

  const rawTotal = id_signal + amount_signal + date_signal + reference_signal;
  const total = Math.min(100, rawTotal);

  return {
    id_signal,
    amount_signal,
    date_signal,
    reference_signal,
    total,
  };
}

/**
 * Pure matcher function: operates on in-memory array of normalized events for a mission.
 * Chains: SALE -> PAYMENT -> SETTLEMENT -> BANK_TRANSACTION.
 */
export function matchMissionEvents(events: NormalizedEvent[]): MatchResult {
  const sales = events.filter((e) => e.event_type === "SALE");
  const payments = events.filter((e) => e.event_type === "PAYMENT");
  const fees = events.filter((e) => e.event_type === "FEE");
  const settlements = events.filter((e) => e.event_type === "SETTLEMENT");
  const bankTxns = events.filter((e) => e.event_type === "BANK_TRANSACTION");

  const matchedPaymentIds = new Set<string>();
  const matchedSettlementIds = new Set<string>();
  const matchedBankIds = new Set<string>();

  const matches: ReconciledChain[] = [];
  const unmatchedSales: NormalizedEvent[] = [];

  // Group fees by payment id or external_ref for lookup
  const feeByPaymentKey = new Map<string, NormalizedEvent>();
  for (const fee of fees) {
    if (fee.payment_id) feeByPaymentKey.set(fee.payment_id, fee);
    if (fee.metadata?.parent_payment_id) feeByPaymentKey.set(fee.metadata.parent_payment_id, fee);
    if (fee.external_ref) feeByPaymentKey.set(fee.external_ref, fee);
  }

  // Iterate over each SALE event
  for (const sale of sales) {
    const saleId = sale.id || "";
    const orderRef = sale.external_ref || sale.metadata?.order_number || saleId;

    // 1. Find Best PAYMENT Link
    let bestPayment: NormalizedEvent | null = null;
    let bestPaymentScore: LinkSignalBreakdown = { id_signal: 0, amount_signal: 0, date_signal: 0, reference_signal: 0, total: 0 };

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

      if (score.total > bestPaymentScore.total) {
        bestPaymentScore = score;
        bestPayment = payment;
      }
    }

    if (!bestPayment || bestPaymentScore.total < 50 || !bestPayment.id) {
      unmatchedSales.push(sale);
      continue;
    }

    matchedPaymentIds.add(bestPayment.id);

    // 2. Find Best SETTLEMENT Link for this Payment
    let bestSettlement: NormalizedEvent | null = null;
    let bestSettlementScore: LinkSignalBreakdown = { id_signal: 0, amount_signal: 0, date_signal: 0, reference_signal: 0, total: 0 };

    const paymentKey = bestPayment.external_ref;
    const paymentFee = feeByPaymentKey.get(bestPayment.id) || (paymentKey ? feeByPaymentKey.get(paymentKey) : undefined);
    const expectedNetAmount = paymentFee ? Number(bestPayment.amount) - Number(paymentFee.amount) : Number(bestPayment.amount);

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

      if (score.total > bestSettlementScore.total) {
        bestSettlementScore = score;
        bestSettlement = settlement;
      }
    }

    if (!bestSettlement || bestSettlementScore.total < 50 || !bestSettlement.id) {
      continue;
    }

    matchedSettlementIds.add(bestSettlement.id);

    // 3. Find Best BANK_TRANSACTION Link for this Settlement
    let bestBank: NormalizedEvent | null = null;
    let bestBankScore: LinkSignalBreakdown = { id_signal: 0, amount_signal: 0, date_signal: 0, reference_signal: 0, total: 0 };

    for (const bank of bankTxns) {
      const bankId = bank.id || "";
      if (bankId && matchedBankIds.has(bankId)) continue;

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

      if (score.total > bestBankScore.total) {
        bestBankScore = score;
        bestBank = bank;
      }
    }

    if (!bestBank || bestBankScore.total < 50 || !bestBank.id) {
      continue;
    }

    matchedBankIds.add(bestBank.id);

    // Compute chain confidence as MINIMUM confidence across all links
    const linkConfidences = [bestPaymentScore.total, bestSettlementScore.total, bestBankScore.total];
    const chainConfidence = Math.min(...linkConfidences);

    // Determine match_type
    const allExactId =
      bestPaymentScore.id_signal === 100 &&
      bestSettlementScore.id_signal === 100 &&
      bestBankScore.id_signal === 100;

    let matchType: ReconciledChain["match_type"] = "exact_id";
    if (!allExactId) {
      if (bestBankScore.reference_signal >= 10 && bestBankScore.id_signal < 100) {
        matchType = "fuzzy_reference";
      } else if (bestBankScore.amount_signal > 0 && bestBankScore.date_signal > 0) {
        matchType = "amount_date_window";
      } else {
        matchType = "settlement_chain";
      }
    }

    const chainEventIds: string[] = [saleId, bestPayment.id, bestSettlement.id, bestBank.id].filter(Boolean);
    if (paymentFee?.id && !chainEventIds.includes(paymentFee.id)) {
      chainEventIds.push(paymentFee.id);
    }

    matches.push({
      order_ref: orderRef,
      event_ids: chainEventIds,
      match_type: matchType,
      confidence: chainConfidence,
      status: chainConfidence >= 85 ? "auto_matched" : "proposed",
      signals: {
        sale_to_payment: bestPaymentScore,
        payment_to_settlement: bestSettlementScore,
        settlement_to_bank: bestBankScore,
      },
      events: {
        sale,
        payment: bestPayment,
        fee: paymentFee,
        settlement: bestSettlement,
        bank: bestBank,
      },
    });
  }

  const unmatchedPayments = payments.filter((p) => p.id && !matchedPaymentIds.has(p.id));
  const unmatchedSettlements = settlements.filter((s) => s.id && !matchedSettlementIds.has(s.id));
  const unmatchedBank = bankTxns.filter((b) => b.id && !matchedBankIds.has(b.id));

  return {
    matches,
    unmatched_sales: unmatchedSales,
    unmatched_payments: unmatchedPayments,
    unmatched_settlements: unmatchedSettlements,
    unmatched_bank: unmatchedBank,
  };
}
