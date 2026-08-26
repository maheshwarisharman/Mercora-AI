import levenshtein from "fast-levenshtein";
import type { NormalizedEvent } from "../shared/types";

const MATCH_SCORE_THRESHOLD = 50;
const COD_EXACT_MATCH_TOLERANCE = 1;
const COD_SUBSET_SUM_TOLERANCE = 5;
const COD_BATCH_MIN_AGE_DAYS = 5;
const COD_BATCH_MAX_AGE_DAYS = 20;

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
    sale_group_to_settlement?: LinkSignalBreakdown;
    remittance_to_bank?: LinkSignalBreakdown;
  };
  events: {
    sale?: NormalizedEvent;
    sales?: NormalizedEvent[];
    payment?: NormalizedEvent;
    fee?: NormalizedEvent;
    fees?: NormalizedEvent[];
    settlement?: NormalizedEvent;
    remittance?: NormalizedEvent;
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

function getCanonicalEventType(event: NormalizedEvent): string {
  return String(event.metadata?.canonical_event_type || event.event_type || "").trim();
}

function getBatchRef(event: NormalizedEvent): string {
  return String(event.batch_ref || event.metadata?.batch_ref || event.external_ref || "").trim();
}

function getEventDescription(event: NormalizedEvent): string {
  return String(event.counterparty || event.metadata?.description || "").trim();
}

function toPaise(amount: number): number {
  return Math.round(Number(amount || 0) * 100);
}

function sumEventAmounts(events: NormalizedEvent[]): number {
  return events.reduce((total, event) => total + Number(event.amount || 0), 0);
}

function amountsWithinTolerance(expectedAmount: number, actualAmount: number, toleranceRupees: number): boolean {
  return Math.abs(Number(expectedAmount || 0) - Number(actualAmount || 0)) <= toleranceRupees;
}

function normalizeLookupValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim().toLowerCase();
  return normalized ? normalized : null;
}

function normalizeStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => normalizeLookupValue(value))
    .filter((value): value is string => Boolean(value));
}

function getSaleLookupKeys(sale: NormalizedEvent): string[] {
  const keys = [
    normalizeLookupValue(sale.order_id),
    normalizeLookupValue(sale.external_ref),
    normalizeLookupValue(sale.metadata?.order_number),
  ].filter((value): value is string => Boolean(value));

  return Array.from(new Set(keys));
}

function buildSaleIndex(sales: NormalizedEvent[]): Map<string, NormalizedEvent[]> {
  const saleIndex = new Map<string, NormalizedEvent[]>();

  for (const sale of sales) {
    for (const key of getSaleLookupKeys(sale)) {
      const existing = saleIndex.get(key) || [];
      existing.push(sale);
      saleIndex.set(key, existing);
    }
  }

  return saleIndex;
}

function getLatestEventDate(events: NormalizedEvent[]): string | null {
  if (events.length === 0) return null;
  return events.reduce((latest, event) => {
    if (!latest) return event.event_date;
    return new Date(event.event_date).getTime() > new Date(latest).getTime() ? event.event_date : latest;
  }, "" as string);
}

function getOrderRefForSale(sale: NormalizedEvent): string {
  return sale.external_ref || String(sale.metadata?.order_number || sale.id || "");
}

function getRepresentativeOrderRef(sales: NormalizedEvent[], fallback: string): string {
  return sales.map(getOrderRefForSale).find(Boolean) || fallback;
}

function isSaleWithinWindowBeforeAnchor(
  sale: NormalizedEvent,
  anchorDate: string,
  minDays: number,
  maxDays: number
): boolean {
  const saleTime = new Date(sale.event_date).getTime();
  const anchorTime = new Date(anchorDate).getTime();
  if (!Number.isFinite(saleTime) || !Number.isFinite(anchorTime) || saleTime > anchorTime) {
    return false;
  }

  const diffDays = Math.floor((anchorTime - saleTime) / (1000 * 60 * 60 * 24));
  return diffDays >= minDays && diffDays <= maxDays;
}

function collectSalesForOrderRefs(params: {
  orderRefs: string[];
  saleIndex: Map<string, NormalizedEvent[]>;
  matchedSaleIds: Set<string>;
}): { sales: NormalizedEvent[]; resolvedOrderRefs: Set<string> } {
  const { orderRefs, saleIndex, matchedSaleIds } = params;
  const collected: NormalizedEvent[] = [];
  const seenSaleIds = new Set<string>();
  const resolvedOrderRefs = new Set<string>();

  for (const orderRef of orderRefs) {
    const normalizedRef = normalizeLookupValue(orderRef);
    if (!normalizedRef) continue;

    const salesForRef = saleIndex.get(normalizedRef) || [];
    if (salesForRef.length > 0) {
      resolvedOrderRefs.add(normalizedRef);
    }

    for (const sale of salesForRef) {
      const saleId = sale.id || `${sale.external_ref || ""}:${sale.event_date}:${sale.amount}`;
      if (matchedSaleIds.has(sale.id || "") || seenSaleIds.has(saleId)) continue;
      seenSaleIds.add(saleId);
      collected.push(sale);
    }
  }

  return { sales: collected, resolvedOrderRefs };
}

function buildCodDeductionIndex(deductions: NormalizedEvent[]): Map<string, NormalizedEvent[]> {
  const deductionIndex = new Map<string, NormalizedEvent[]>();

  for (const deduction of deductions) {
    const batchRef = getBatchRef(deduction);
    if (!batchRef) continue;

    const existing = deductionIndex.get(batchRef) || [];
    existing.push(deduction);
    deductionIndex.set(batchRef, existing);
  }

  return deductionIndex;
}

function findBestDirectBankMatch(params: {
  remittance: NormalizedEvent;
  bankTxns: NormalizedEvent[];
  matchedBankIds: Set<string>;
}): { bank: NormalizedEvent; score: LinkSignalBreakdown } | null {
  const { remittance, bankTxns, matchedBankIds } = params;
  const batchRef = getBatchRef(remittance);
  const referenceKeys = Array.from(
    new Set([normalizeLookupValue(batchRef), normalizeLookupValue(remittance.external_ref)].filter((value): value is string => Boolean(value)))
  );

  if (referenceKeys.length === 0) return null;

  let bestBank: NormalizedEvent | null = null;
  let bestScore: LinkSignalBreakdown = { id_signal: 0, amount_signal: 0, date_signal: 0, reference_signal: 0, total: 0 };

  for (const bank of bankTxns) {
    const bankId = bank.id || "";
    if (bankId && matchedBankIds.has(bankId)) continue;

    const bankRef = normalizeLookupValue(bank.external_ref);
    const bankDesc = normalizeLookupValue(getEventDescription(bank)) || "";
    const hasDirectIdLink = referenceKeys.some((referenceKey) => bankRef === referenceKey || bankDesc.includes(referenceKey));
    if (!hasDirectIdLink) continue;

    const score = computeLinkScore({
      hasDirectIdLink,
      expectedAmount: Number(remittance.amount),
      actualAmount: Number(bank.amount),
      date1: remittance.event_date,
      date2: bank.event_date,
      refString1: batchRef || remittance.external_ref,
      refString2: bank.external_ref || getEventDescription(bank),
    });

    if (score.total > bestScore.total) {
      bestScore = score;
      bestBank = bank;
    }
  }

  return bestBank ? { bank: bestBank, score: bestScore } : null;
}

export function findSubsetSumMatch(
  targetAmount: number,
  candidates: Array<Pick<NormalizedEvent, "amount">>,
  toleranceRupees = 0
): number[] | null {
  const targetPaise = toPaise(targetAmount);
  const tolerancePaise = toPaise(toleranceRupees);
  const maxTargetPaise = targetPaise + tolerancePaise;
  const normalizedCandidates = candidates
    .map((candidate, index) => ({ index, paise: toPaise(Number(candidate.amount || 0)) }))
    .filter((candidate) => candidate.paise > 0 && candidate.paise <= maxTargetPaise);

  const reachable = new Set<number>([0]);
  const parents = new Map<number, { prevSum: number; candidateIndex: number }>();

  for (const candidate of normalizedCandidates) {
    const currentSums = Array.from(reachable);
    const nextSums: number[] = [];

    for (const sum of currentSums) {
      const nextSum = sum + candidate.paise;
      if (nextSum > maxTargetPaise || reachable.has(nextSum) || parents.has(nextSum)) {
        continue;
      }

      parents.set(nextSum, { prevSum: sum, candidateIndex: candidate.index });
      nextSums.push(nextSum);
    }

    for (const nextSum of nextSums) {
      reachable.add(nextSum);
    }
  }

  let bestSum: number | null = null;
  for (let offset = 0; offset <= tolerancePaise; offset += 1) {
    const lower = targetPaise - offset;
    const upper = targetPaise + offset;

    if (lower >= 0 && reachable.has(lower)) {
      bestSum = lower;
      break;
    }

    if (offset > 0 && reachable.has(upper)) {
      bestSum = upper;
      break;
    }
  }

  if (bestSum === null) return null;

  const matchedCandidateIndexes: number[] = [];
  let currentSum = bestSum;
  while (currentSum > 0) {
    const parent = parents.get(currentSum);
    if (!parent) return null;
    matchedCandidateIndexes.push(parent.candidateIndex);
    currentSum = parent.prevSum;
  }

  return matchedCandidateIndexes.reverse();
}

/**
 * Pure matcher function: operates on in-memory array of normalized events for a mission.
 * Chains standard online flows first, then resolves COD batch remittances as SALE[] -> COD_REMITTANCE -> BANK_TRANSACTION.
 */
export function matchMissionEvents(events: NormalizedEvent[]): MatchResult {
  const sales = events.filter((event) => getCanonicalEventType(event) === "SALE");
  const payments = events.filter((event) => event.event_type === "PAYMENT" && getCanonicalEventType(event) === "PAYMENT");
  const fees = events.filter((event) => event.event_type === "FEE" && getCanonicalEventType(event) === "FEE");
  const settlements = events.filter((event) => event.event_type === "SETTLEMENT" && getCanonicalEventType(event) === "SETTLEMENT");
  const codRemittances = events.filter((event) => getCanonicalEventType(event) === "COD_REMITTANCE");
  const codDeductions = events.filter((event) => getCanonicalEventType(event) === "COD_DEDUCTION");
  const bankTxns = events.filter((e) => e.event_type === "BANK_TRANSACTION");

  const matchedSaleIds = new Set<string>();
  const matchedPaymentIds = new Set<string>();
  const matchedSettlementIds = new Set<string>();
  const matchedBankIds = new Set<string>();

  const matches: ReconciledChain[] = [];

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

    if (!bestPayment || bestPaymentScore.total < MATCH_SCORE_THRESHOLD || !bestPayment.id) {
      continue;
    }

    if (saleId) matchedSaleIds.add(saleId);
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

    if (!bestSettlement || bestSettlementScore.total < MATCH_SCORE_THRESHOLD || !bestSettlement.id) {
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

    if (!bestBank || bestBankScore.total < MATCH_SCORE_THRESHOLD || !bestBank.id) {
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

  const saleIndex = buildSaleIndex(sales);
  const codDeductionsByBatch = buildCodDeductionIndex(codDeductions);

  for (const remittance of codRemittances) {
    const remittanceId = remittance.id || "";
    if (remittanceId && matchedSettlementIds.has(remittanceId)) continue;

    const batchRef = getBatchRef(remittance);
    if (!batchRef) continue;

    const bankMatch = findBestDirectBankMatch({
      remittance,
      bankTxns,
      matchedBankIds,
    });

    if (!bankMatch?.bank.id) {
      continue;
    }

    const deductions = codDeductionsByBatch.get(batchRef) || [];
    const deductionTotal = sumEventAmounts(deductions);
    const directOrderRefs = normalizeStringArray(remittance.order_ids || remittance.metadata?.order_ids);

    let matchedSalesForBatch: NormalizedEvent[] | null = null;
    let saleGroupScore: LinkSignalBreakdown | null = null;

    if (directOrderRefs.length > 0) {
      const directMatch = collectSalesForOrderRefs({
        orderRefs: directOrderRefs,
        saleIndex,
        matchedSaleIds,
      });

      if (directMatch.resolvedOrderRefs.size === new Set(directOrderRefs).size && directMatch.sales.length > 0) {
        const directNetAmount = sumEventAmounts(directMatch.sales) - deductionTotal;
        if (amountsWithinTolerance(directNetAmount, Number(bankMatch.bank.amount), COD_EXACT_MATCH_TOLERANCE)) {
          matchedSalesForBatch = directMatch.sales;
          saleGroupScore = computeLinkScore({
            hasDirectIdLink: true,
            expectedAmount: directNetAmount,
            actualAmount: Number(remittance.amount),
            date1: getLatestEventDate(directMatch.sales),
            date2: remittance.event_date,
            refString1: directOrderRefs.join(","),
            refString2: batchRef,
          });
        }
      }
    }

    if (!matchedSalesForBatch) {
      const candidateSales = sales.filter((sale) => {
        const saleId = sale.id || "";
        if (saleId && matchedSaleIds.has(saleId)) return false;
        return isSaleWithinWindowBeforeAnchor(
          sale,
          remittance.event_date,
          COD_BATCH_MIN_AGE_DAYS,
          COD_BATCH_MAX_AGE_DAYS
        );
      });

      const subsetIndexes = findSubsetSumMatch(
        Number(bankMatch.bank.amount) + deductionTotal,
        candidateSales,
        COD_SUBSET_SUM_TOLERANCE
      );

      if (!subsetIndexes || subsetIndexes.length === 0) {
        continue;
      }

      matchedSalesForBatch = subsetIndexes.map((index) => candidateSales[index]);
      saleGroupScore = computeLinkScore({
        hasDirectIdLink: false,
        expectedAmount: sumEventAmounts(matchedSalesForBatch) - deductionTotal,
        actualAmount: Number(remittance.amount),
        date1: getLatestEventDate(matchedSalesForBatch),
        date2: remittance.event_date,
        refString1: matchedSalesForBatch.map(getOrderRefForSale).join(","),
        refString2: batchRef,
      });
    }

    if (!matchedSalesForBatch || !saleGroupScore) {
      continue;
    }

    const remittanceToBankScore = computeLinkScore({
      hasDirectIdLink: true,
      expectedAmount: Number(remittance.amount),
      actualAmount: Number(bankMatch.bank.amount),
      date1: remittance.event_date,
      date2: bankMatch.bank.event_date,
      refString1: batchRef,
      refString2: bankMatch.bank.external_ref || getEventDescription(bankMatch.bank),
    });

    const matchedSalesNetAmount = sumEventAmounts(matchedSalesForBatch) - deductionTotal;
    if (!amountsWithinTolerance(matchedSalesNetAmount, Number(bankMatch.bank.amount), COD_SUBSET_SUM_TOLERANCE)) {
      continue;
    }

    for (const matchedSale of matchedSalesForBatch) {
      if (matchedSale.id) matchedSaleIds.add(matchedSale.id);
    }
    if (remittanceId) matchedSettlementIds.add(remittanceId);
    matchedBankIds.add(bankMatch.bank.id);

    const linkConfidences = [saleGroupScore.total, remittanceToBankScore.total];
    const chainConfidence = Math.min(...linkConfidences);
    const chainEventIds = [
      ...matchedSalesForBatch.map((sale) => sale.id || "").filter(Boolean),
      remittance.id || "",
      bankMatch.bank.id,
      ...deductions.map((deduction) => deduction.id || "").filter(Boolean),
    ];

    matches.push({
      order_ref: getRepresentativeOrderRef(matchedSalesForBatch, batchRef),
      event_ids: Array.from(new Set(chainEventIds)),
      match_type: directOrderRefs.length > 0 && saleGroupScore.id_signal === 100 ? "settlement_chain" : "amount_date_window",
      confidence: chainConfidence,
      status: chainConfidence >= 85 ? "auto_matched" : "proposed",
      signals: {
        sale_group_to_settlement: saleGroupScore,
        remittance_to_bank: remittanceToBankScore,
        settlement_to_bank: remittanceToBankScore,
      },
      events: {
        sale: matchedSalesForBatch[0],
        sales: matchedSalesForBatch,
        fee: deductions[0],
        fees: deductions,
        settlement: remittance,
        remittance,
        bank: bankMatch.bank,
      },
    });
  }

  const unmatchedSales = sales.filter((sale) => !sale.id || !matchedSaleIds.has(sale.id));
  const unmatchedPayments = payments.filter((p) => p.id && !matchedPaymentIds.has(p.id));
  const unmatchedSettlements = [...settlements, ...codRemittances].filter((settlement) => !settlement.id || !matchedSettlementIds.has(settlement.id));
  const unmatchedBank = bankTxns.filter((b) => b.id && !matchedBankIds.has(b.id));

  return {
    matches,
    unmatched_sales: unmatchedSales,
    unmatched_payments: unmatchedPayments,
    unmatched_settlements: unmatchedSettlements,
    unmatched_bank: unmatchedBank,
  };
}
