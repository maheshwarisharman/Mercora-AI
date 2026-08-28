import levenshtein from "fast-levenshtein";
import type { NormalizedEvent } from "../shared/types";

const MATCH_SCORE_THRESHOLD = 50;
const COD_EXACT_MATCH_TOLERANCE = 1;
const COD_SUBSET_SUM_TOLERANCE = 5;
const COD_BATCH_MIN_AGE_DAYS = 5;
const COD_BATCH_MAX_AGE_DAYS = 20;

export type BankCreditCandidateSource = "razorpay" | "courier" | string;

export interface BankCreditDateWindow {
  minDays: number;
  maxDays: number;
  /** The expected lag used to rank candidates inside the allowed window. */
  idealDays?: number;
}

export interface BankCreditDisambiguationConfig {
  /** Rupees. Used for exact/near-exact amount scoring and candidate filtering. */
  amountToleranceRupees?: number;
  /** Minimum score required before a deterministic assignment is accepted. */
  minimumConfidence?: number;
  /** Minimum gap between the first and second ranked candidates. */
  minimumMargin?: number;
  sourceDateWindows?: Record<string, BankCreditDateWindow>;
  /** Add or override narration patterns without changing scorer logic. */
  sourceKeywords?: Record<string, string[]>;
}

export interface BankCreditCandidate {
  id: string;
  batch_reference: string;
  source: BankCreditCandidateSource;
  amount: number;
  date: string;
  event: NormalizedEvent;
  keywords: string[];
}

export interface BankCreditScoreBreakdown {
  amount: number;
  date: number;
  narration: number;
  reference: number;
  total: number;
  amount_difference: number;
  date_difference_days: number | null;
  matched_keywords: string[];
}

export interface RankedBankCreditCandidate {
  candidate_id: string;
  batch_reference: string;
  source: BankCreditCandidateSource;
  amount: number;
  date: string;
  score: number;
  signals: BankCreditScoreBreakdown;
  event: NormalizedEvent;
}

export type BankCreditResolutionStatus = "deterministic" | "ambiguous" | "no_candidates" | "llm_resolved" | "combined_batches" | "insufficient_evidence";

export interface BankCreditResolution {
  bank_credit: NormalizedEvent;
  status: BankCreditResolutionStatus;
  chosen_candidate_id: string | null;
  confidence: number;
  margin: number | null;
  candidates: RankedBankCreditCandidate[];
  resolution_method: "deterministic" | "llm" | "none";
  combined_candidate_ids?: string[];
  reasoning?: string;
}

/**
 * Built-in patterns are deliberately data, not branching logic. A new
 * courier can add patterns through `sourceKeywords` without editing the
 * scorer. Candidate courier names are also added automatically at runtime.
 */
export const BANK_CREDIT_SOURCE_KEYWORDS: Record<string, string[]> = {
  razorpay: ["razorpay", "rzp", "razor pay"],
  amazon: ["amazon", "amazon pay", "amazon marketplace", "amzn"],
  courier: ["delhivery", "delivery", "dlvry", "cod", "remittance", "shiprocket", "ecom express", "xpressbees", "bluedart", "shadowfax"],
};

const DEFAULT_BANK_CREDIT_DATE_WINDOWS: Record<string, BankCreditDateWindow> = {
  razorpay: { minDays: 2, maxDays: 3, idealDays: 2 },
  amazon: { minDays: 0, maxDays: 14, idealDays: 3 },
  courier: { minDays: 5, maxDays: 20, idealDays: 7 },
};

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
    remittances?: NormalizedEvent[];
    bank?: NormalizedEvent;
  };
}

export interface MatchResult {
  matches: ReconciledChain[];
  unmatched_sales: NormalizedEvent[];
  unmatched_payments: NormalizedEvent[];
  unmatched_settlements: NormalizedEvent[];
  unmatched_bank: NormalizedEvent[];
  bank_credit_resolutions: BankCreditResolution[];
}

export interface MatchMissionOptions {
  bankCreditAssignments?: Record<string, string>;
  bankCreditCombinedAssignments?: Record<string, string[]>;
  bankCreditDisambiguation?: BankCreditDisambiguationConfig;
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

function isBankCreditEvent(event: NormalizedEvent): boolean {
  const direction = String(event.metadata?.direction || "").toLowerCase();
  if (direction === "debit" || direction === "dr") return false;
  return event.event_type === "BANK_TRANSACTION" || event.event_type === "BANK_CREDIT" ||
    getCanonicalEventType(event) === "BANK_CREDIT";
}

function getBankNarration(event: NormalizedEvent): string {
  return [
    event.external_ref,
    event.counterparty,
    event.metadata?.description,
    event.metadata?.narration,
    event.metadata?.remarks,
  ]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => String(value))
    .join(" ")
    .toLowerCase();
}

function getCandidateSource(event: NormalizedEvent): BankCreditCandidateSource | null {
  const canonicalSource = String(event.metadata?.canonical_source_system || event.source_system || "").toLowerCase();
  const canonicalType = getCanonicalEventType(event);
  if (canonicalSource === "amazon" && (canonicalType === "AMAZON_SETTLEMENT" || canonicalType === "SETTLEMENT" || event.event_type === "SETTLEMENT")) {
    return "amazon";
  }
  if (canonicalSource === "razorpay" && (canonicalType === "SETTLEMENT" || event.event_type === "SETTLEMENT")) {
    return "razorpay";
  }
  if (
    canonicalSource === "courier" ||
    canonicalSource === "cod" ||
    canonicalType === "COD_REMITTANCE" ||
    (canonicalType === "SETTLEMENT" && (event.source_system === "vendor" || event.metadata?.courier_partner))
  ) {
    return "courier";
  }
  return null;
}

function getCandidateKeywords(
  event: NormalizedEvent,
  source: BankCreditCandidateSource,
  config: BankCreditDisambiguationConfig
): string[] {
  const partnerKeys = source === "courier"
    ? [event.counterparty, event.metadata?.courier_partner, event.metadata?.courier_code]
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean)
    : [];
  const configured = [
    ...(config.sourceKeywords?.[source] || BANK_CREDIT_SOURCE_KEYWORDS[source] || []),
    ...partnerKeys.flatMap((key) => config.sourceKeywords?.[key] || []),
  ];
  const dynamic = source === "courier" ? partnerKeys : [];

  return Array.from(new Set([...configured, ...dynamic]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter((value) => value.length >= 2)));
}

function getCandidateBatchReference(event: NormalizedEvent): string {
  return getBatchRef(event) || String(event.metadata?.settlement_id || event.external_ref || event.id || "").trim();
}

export function buildBankCreditCandidates(
  events: NormalizedEvent[],
  config: BankCreditDisambiguationConfig = {}
): BankCreditCandidate[] {
  return events
    .map((event) => {
      const source = getCandidateSource(event);
      const id = String(event.id || "").trim();
      if (!source || !id) return null;
      return {
        id,
        batch_reference: getCandidateBatchReference(event),
        source,
        amount: Number(event.amount || 0),
        date: event.event_date,
        event,
        keywords: getCandidateKeywords(event, source, config),
      } satisfies BankCreditCandidate;
    })
    .filter((candidate): candidate is BankCreditCandidate => Boolean(candidate));
}

function getDateWindow(source: BankCreditCandidateSource, candidate: BankCreditCandidate, config: BankCreditDisambiguationConfig): BankCreditDateWindow {
  const partnerKeys = source === "courier"
    ? [candidate.event.metadata?.courier_partner, candidate.event.counterparty, candidate.event.metadata?.courier_code]
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean)
    : [];
  const configuredBySource = partnerKeys.map((key) => config.sourceDateWindows?.[key]).find(Boolean) || config.sourceDateWindows?.[source];
  const metadataWindow = candidate.event.metadata?.bank_credit_window_days;
  if (Array.isArray(metadataWindow) && metadataWindow.length >= 2) {
    return {
      minDays: Number(metadataWindow[0]),
      maxDays: Number(metadataWindow[1]),
      idealDays: Number(metadataWindow[2] ?? metadataWindow[0]),
    };
  }
  if (metadataWindow && typeof metadataWindow === "object") {
    const window = metadataWindow as Record<string, unknown>;
    return {
      minDays: Number(window.minDays ?? window.min_days ?? 0),
      maxDays: Number(window.maxDays ?? window.max_days ?? 365),
      idealDays: Number(window.idealDays ?? window.ideal_days ?? window.minDays ?? 0),
    };
  }
  return configuredBySource || DEFAULT_BANK_CREDIT_DATE_WINDOWS[source] || { minDays: 0, maxDays: 30, idealDays: 0 };
}

function getSignedDateDifferenceDays(sourceDate: string, bankDate: string): number | null {
  const sourceTime = new Date(sourceDate).getTime();
  const bankTime = new Date(bankDate).getTime();
  if (!Number.isFinite(sourceTime) || !Number.isFinite(bankTime)) return null;
  return Math.floor((bankTime - sourceTime) / (1000 * 60 * 60 * 24));
}

function scoreAmountProximity(bankAmount: number, candidateAmount: number, tolerance: number): number {
  const difference = Math.abs(bankAmount - candidateAmount);
  const larger = Math.max(Math.abs(bankAmount), Math.abs(candidateAmount), 1);
  if (difference <= tolerance) return 45;
  if (difference <= larger * 0.005) return 35;
  if (difference <= larger * 0.02) return 22;
  if (difference <= larger * 0.05) return 8;
  return 0;
}

function scoreDateProximity(
  bankDate: string,
  candidate: BankCreditCandidate,
  config: BankCreditDisambiguationConfig
): { score: number; difference: number | null } {
  const difference = getSignedDateDifferenceDays(candidate.date, bankDate);
  if (difference === null || difference < 0) return { score: 0, difference };
  const window = getDateWindow(candidate.source, candidate, config);
  if (difference >= window.minDays && difference <= window.maxDays) {
    const ideal = window.idealDays ?? window.minDays;
    const spread = Math.max(window.maxDays - window.minDays, 1);
    return { score: Math.max(18, 30 - Math.round((Math.abs(difference - ideal) / spread) * 12)), difference };
  }
  // A nearby date is useful evidence but is deliberately weaker than an
  // in-window date; this keeps the scorer useful for timing anomalies.
  if (difference <= window.maxDays + 7) {
    return { score: Math.max(4, 16 - (difference > window.maxDays ? difference - window.maxDays : window.minDays - difference) * 2), difference };
  }
  return { score: 0, difference };
}

export function scoreBankCreditCandidate(params: {
  bankCredit: NormalizedEvent;
  candidate: BankCreditCandidate | NormalizedEvent;
  config?: BankCreditDisambiguationConfig;
}): RankedBankCreditCandidate {
  const config = params.config || {};
  const candidate = "keywords" in params.candidate
    ? params.candidate
    : (() => {
        const source = getCandidateSource(params.candidate) || "unknown";
        return {
          id: String(params.candidate.id || ""),
          batch_reference: getCandidateBatchReference(params.candidate),
          source,
          amount: Number(params.candidate.amount || 0),
          date: params.candidate.event_date,
          event: params.candidate,
          keywords: getCandidateKeywords(params.candidate, source, config),
        } satisfies BankCreditCandidate;
      })();

  const tolerance = config.amountToleranceRupees ?? 1;
  const bankAmount = Number(params.bankCredit.amount || 0);
  const narration = getBankNarration(params.bankCredit);
  const matchedKeywords = candidate.keywords.filter((keyword) => narration.includes(keyword));
  const reference = candidate.batch_reference && narration.includes(candidate.batch_reference.toLowerCase()) ? 25 : 0;
  const narrationScore = reference > 0 ? 25 : matchedKeywords.length > 0 ? 25 : 0;
  const dateScore = scoreDateProximity(params.bankCredit.event_date, candidate, config);
  const amountScore = scoreAmountProximity(bankAmount, candidate.amount, tolerance);
  const signals: BankCreditScoreBreakdown = {
    amount: amountScore,
    date: dateScore.score,
    narration: narrationScore,
    reference,
    total: Math.min(100, amountScore + dateScore.score + narrationScore),
    amount_difference: Math.round(Math.abs(bankAmount - candidate.amount) * 100) / 100,
    date_difference_days: dateScore.difference,
    matched_keywords: matchedKeywords,
  };

  return {
    candidate_id: candidate.id,
    batch_reference: candidate.batch_reference,
    source: candidate.source,
    amount: candidate.amount,
    date: candidate.date,
    score: signals.total,
    signals,
    event: candidate.event,
  };
}

export function rankBankCreditCandidates(
  bankCredit: NormalizedEvent,
  candidates: BankCreditCandidate[] | NormalizedEvent[],
  config: BankCreditDisambiguationConfig = {}
): RankedBankCreditCandidate[] {
  return candidates
    .map((candidate) => scoreBankCreditCandidate({ bankCredit, candidate, config }))
    .sort((left, right) => right.score - left.score || left.candidate_id.localeCompare(right.candidate_id));
}

/** Public plural alias for callers that treat this as the candidate scorer. */
export function scoreBankCreditCandidates(
  bankCredit: NormalizedEvent,
  candidates: BankCreditCandidate[] | NormalizedEvent[],
  config: BankCreditDisambiguationConfig = {}
): RankedBankCreditCandidate[] {
  return rankBankCreditCandidates(bankCredit, candidates, config);
}

export function resolveBankCreditDeterministically(params: {
  bankCredit: NormalizedEvent;
  candidates: BankCreditCandidate[] | NormalizedEvent[];
  config?: BankCreditDisambiguationConfig;
}): BankCreditResolution {
  const config = params.config || {};
  // Rows with a zero score are only present because they were supplied as
  // possible candidates. They are not evidence and must not turn an
  // unrelated bank credit into an ambiguous assignment or suppress a real
  // missing-bank-credit exception.
  const ranked = rankBankCreditCandidates(params.bankCredit, params.candidates, config)
    .filter((candidate) => candidate.score > 0);
  const top = ranked[0];
  const second = ranked[1];
  const minimumConfidence = config.minimumConfidence ?? 70;
  const minimumMargin = config.minimumMargin ?? 15;
  const margin = top ? top.score - (second?.score ?? 0) : null;
  const deterministic = Boolean(top && top.score >= minimumConfidence && (second === undefined || (margin ?? 0) >= minimumMargin));

  const status: BankCreditResolutionStatus = !top
    ? "no_candidates"
    : deterministic ? "deterministic" : "ambiguous";
  const resolution: BankCreditResolution = {
    bank_credit: params.bankCredit,
    status,
    chosen_candidate_id: deterministic ? top.candidate_id : null,
    confidence: top?.score || 0,
    margin,
    candidates: ranked,
    resolution_method: deterministic ? "deterministic" : "none",
  };

  return resolution;
}

function findCourierCombinedCandidateIds(params: {
  bankCredit: NormalizedEvent;
  candidates: BankCreditCandidate[];
  config: BankCreditDisambiguationConfig;
}): string[] {
  const { bankCredit, candidates, config } = params;
  const narration = getBankNarration(bankCredit);
  const courierKeywords = BANK_CREDIT_SOURCE_KEYWORDS.courier || [];
  const genericCourierSignals = ["cod", "remittance", "logistics", "courier", "transport"];
  const getPartnerKeywords = (candidate: BankCreditCandidate): string[] => {
    const values = [
      candidate.event.counterparty,
      candidate.event.metadata?.courier_partner,
      candidate.event.metadata?.courier_code,
    ]
      .map((value) => String(value || "").trim().toLowerCase())
      .filter((value) => value.length >= 3);
    return Array.from(new Set([
      ...values,
      ...values.flatMap((value) => value.split(/\s+/).filter((token) => token.length >= 4)),
    ]));
  };
  const courierCandidates = candidates.filter((candidate) => candidate.source === "courier");
  const matchedPartnerKeywords = Array.from(new Set(
    courierCandidates
      .flatMap(getPartnerKeywords)
      .filter((keyword) => narration.includes(keyword))
  ));
  const matchedSpecificSourceKeyword = courierKeywords
    .filter((keyword) => !genericCourierSignals.includes(keyword))
    .some((keyword) => narration.includes(keyword));
  if (matchedSpecificSourceKeyword && matchedPartnerKeywords.length === 0) return [];

  const hasCourierSignal = courierKeywords.some((keyword) => narration.includes(keyword)) ||
    genericCourierSignals.some((keyword) => narration.includes(keyword));
  if (!hasCourierSignal) return [];

  const eligible = candidates.filter((candidate) => {
    if (candidate.source !== "courier") return false;
    if (matchedPartnerKeywords.length > 0 && !matchedPartnerKeywords.some((keyword) => getPartnerKeywords(candidate).includes(keyword))) {
      return false;
    }
    const dateDifference = getSignedDateDifferenceDays(candidate.date, bankCredit.event_date);
    if (dateDifference === null) return false;
    const window = getDateWindow("courier", candidate, config);
    return dateDifference >= window.minDays && dateDifference <= window.maxDays;
  });
  if (eligible.length < 2) return [];

  const subsetIndexes = findSubsetSumMatch(
    Number(bankCredit.amount),
    eligible.map((candidate) => candidate.event),
    config.amountToleranceRupees ?? 1
  );
  if (!subsetIndexes || subsetIndexes.length < 2) return [];

  return subsetIndexes.map((index) => eligible[index].id);
}

export function resolveBankCreditCandidates(params: {
  bankCredits: NormalizedEvent[];
  candidates: NormalizedEvent[];
  config?: BankCreditDisambiguationConfig;
}): BankCreditResolution[] {
  const candidateRecords = buildBankCreditCandidates(params.candidates, params.config);
  const available = new Set(candidateRecords.map((candidate) => candidate.id));
  const resolutions = params.bankCredits
    .filter(isBankCreditEvent)
    .map((bankCredit) => resolveBankCreditDeterministically({
      bankCredit,
      candidates: candidateRecords.filter((candidate) => available.has(candidate.id)),
      config: params.config,
    }))
    .sort((left, right) => right.confidence - left.confidence);

  // Enforce one bank credit per source batch. Single-candidate deterministic
  // decisions take precedence; then an exact aggregate courier payout may
  // claim a group of COD rows as one combined candidate.
  const claimed = new Set<string>();
  for (const resolution of resolutions) {
    if (resolution.status !== "deterministic" || !resolution.chosen_candidate_id) continue;
    if (claimed.has(resolution.chosen_candidate_id)) {
      resolution.status = "ambiguous";
      resolution.chosen_candidate_id = null;
      resolution.resolution_method = "none";
      resolution.reasoning = "Candidate was already claimed by a stronger bank-credit assignment.";
      continue;
    }
    claimed.add(resolution.chosen_candidate_id);
  }

  const combinedProposals = resolutions
    .filter((resolution) => resolution.status === "ambiguous")
    .map((resolution) => {
      const candidateIds = findCourierCombinedCandidateIds({
        bankCredit: resolution.bank_credit,
        candidates: candidateRecords,
        config: params.config || {},
      });
      const candidateAmount = candidateIds.reduce((sum, candidateId) => {
        const candidate = candidateRecords.find((item) => item.id === candidateId);
        return sum + Number(candidate?.amount || 0);
      }, 0);
      const coverage = candidateAmount > 0 ? Number(resolution.bank_credit.amount || 0) / candidateAmount : 0;
      return { resolution, candidateIds, coverage };
    })
    .filter((proposal) => proposal.candidateIds.length >= 2)
    .sort((left, right) => right.coverage - left.coverage || right.candidateIds.length - left.candidateIds.length);

  for (const proposal of combinedProposals) {
    if (proposal.candidateIds.some((candidateId) => claimed.has(candidateId))) continue;

    proposal.resolution.status = "combined_batches";
    proposal.resolution.chosen_candidate_id = null;
    proposal.resolution.combined_candidate_ids = proposal.candidateIds;
    proposal.resolution.confidence = Math.min(100, 80 + Math.round(proposal.coverage * 20));
    proposal.resolution.margin = 20;
    proposal.resolution.resolution_method = "deterministic";
    proposal.resolution.reasoning = "The bank credit exactly matches a date-compatible group of courier remittance rows.";
    proposal.candidateIds.forEach((candidateId) => claimed.add(candidateId));
  }

  return resolutions.sort((left, right) => String(left.bank_credit.id).localeCompare(String(right.bank_credit.id)));
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

function getMarketplaceSaleWindow(remittance: NormalizedEvent): { minDays: number; maxDays: number } {
  return remittance.source_system === "amazon" || remittance.metadata?.canonical_source_system === "amazon"
    ? { minDays: 0, maxDays: 90 }
    : { minDays: COD_BATCH_MIN_AGE_DAYS, maxDays: COD_BATCH_MAX_AGE_DAYS };
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

function getRemittanceOrderRefs(remittance: NormalizedEvent): string[] {
  const orderIds = Array.isArray(remittance.order_ids) ? remittance.order_ids : [];
  return normalizeStringArray([
    ...orderIds,
    remittance.metadata?.order_id,
  ]);
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
export function matchMissionEvents(events: NormalizedEvent[], options: MatchMissionOptions = {}): MatchResult {
  const sales = events.filter((event) => getCanonicalEventType(event) === "SALE");
  const payments = events.filter((event) => event.event_type === "PAYMENT" && getCanonicalEventType(event) === "PAYMENT");
  const fees = events.filter((event) => event.event_type === "FEE" && getCanonicalEventType(event) === "FEE");
  const settlements = events.filter((event) => event.event_type === "SETTLEMENT" && getCanonicalEventType(event) === "SETTLEMENT");
  const codRemittances = events.filter((event) => getCanonicalEventType(event) === "COD_REMITTANCE");
  const amazonSettlements = events.filter((event) => getCanonicalEventType(event) === "AMAZON_SETTLEMENT");
  const marketplaceRemittances = [...codRemittances, ...amazonSettlements];
  const codDeductions = events.filter((event) => getCanonicalEventType(event) === "COD_DEDUCTION");
  const amazonDeductions = events.filter((event) => event.source_system === "amazon" && event.metadata?.is_deduction === true);
  const bankTxns = events.filter(isBankCreditEvent);

  const bankCreditResolutions = resolveBankCreditCandidates({
    bankCredits: bankTxns,
    candidates: [...settlements, ...marketplaceRemittances],
    config: options.bankCreditDisambiguation,
  });
  const resolutionByBankId = new Map(
    bankCreditResolutions.map((resolution) => [String(resolution.bank_credit.id || ""), resolution])
  );
  const bankByCandidateId = new Map<string, NormalizedEvent>();
  for (const resolution of bankCreditResolutions) {
    if (resolution.chosen_candidate_id && (resolution.status === "deterministic" || resolution.status === "llm_resolved")) {
      bankByCandidateId.set(resolution.chosen_candidate_id, resolution.bank_credit);
    }
    if (resolution.status === "combined_batches") {
      for (const candidateId of resolution.combined_candidate_ids || []) {
        bankByCandidateId.set(candidateId, resolution.bank_credit);
      }
    }
  }
  // LLM assignments are supplied as bank-credit ID -> candidate event ID. The
  // caller validates these IDs against the exact ranked list before invoking
  // the matcher; this map only applies already-validated assignments.
  for (const [bankId, candidateId] of Object.entries(options.bankCreditAssignments || {})) {
    const bank = bankTxns.find((event) => event.id === bankId);
    const candidate = [...settlements, ...marketplaceRemittances].find((event) => event.id === candidateId);
    if (!bank || !candidate) continue;
    const existingBank = bankByCandidateId.get(candidateId);
    if (existingBank && existingBank.id !== bankId) continue;
    bankByCandidateId.set(candidateId, bank);
    const resolution = resolutionByBankId.get(bankId);
    if (resolution) {
      resolution.status = "llm_resolved";
      resolution.chosen_candidate_id = candidateId;
      resolution.resolution_method = "llm";
    }
  }

  // LLM combined-batch assignments are validated by the caller against the
  // exact ranked candidate list before they reach the matcher. Every member
  // of a combined group points to the same bank credit for aggregate matching.
  for (const [bankId, candidateIds] of Object.entries(options.bankCreditCombinedAssignments || {})) {
    const bank = bankTxns.find((event) => event.id === bankId);
    if (!bank || candidateIds.length < 2) continue;

    const validCandidateIds = candidateIds.filter((candidateId) =>
      [...settlements, ...marketplaceRemittances].some((event) => event.id === candidateId)
    );
    if (validCandidateIds.length !== candidateIds.length) continue;
    if (validCandidateIds.some((candidateId) => {
      const existingBank = bankByCandidateId.get(candidateId);
      return existingBank && existingBank.id !== bankId;
    })) continue;

    for (const candidateId of validCandidateIds) {
      bankByCandidateId.set(candidateId, bank);
    }
    const resolution = resolutionByBankId.get(bankId);
    if (resolution) {
      resolution.status = "combined_batches";
      resolution.chosen_candidate_id = null;
      resolution.combined_candidate_ids = validCandidateIds;
      resolution.resolution_method = "llm";
    }
  }
  const resolutionByCandidateId = new Map<string, BankCreditResolution>();
  for (const resolution of bankCreditResolutions) {
    if (resolution.candidates.length > 0) {
      for (const candidate of resolution.candidates) {
        resolutionByCandidateId.set(candidate.candidate_id, resolution);
      }
    }
  }

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

    // 3. Find the assigned BANK_TRANSACTION link for this Settlement. A
    // candidate present in the disambiguation plan must not fall back to the
    // old greedy reference matcher when its ranked list is ambiguous.
    let bestBank: NormalizedEvent | null = null;
    let bestBankScore: LinkSignalBreakdown = { id_signal: 0, amount_signal: 0, date_signal: 0, reference_signal: 0, total: 0 };

    const assignedBank = bestSettlement.id ? bankByCandidateId.get(bestSettlement.id) : undefined;
    if (assignedBank) {
      const bankDesc = String(assignedBank.counterparty || assignedBank.metadata?.description || "");
      const settlementRef = bestSettlement.external_ref || "";
      bestBank = assignedBank;
      bestBankScore = computeLinkScore({
        hasDirectIdLink: Boolean(settlementRef && bankDesc.toLowerCase().includes(settlementRef.toLowerCase())),
        expectedAmount: Number(bestSettlement.amount),
        actualAmount: Number(assignedBank.amount),
        date1: bestSettlement.event_date,
        date2: assignedBank.event_date,
        refString1: settlementRef,
        refString2: bankDesc,
      });
    }

    for (const bank of assignedBank ? [] : bankTxns) {
      const bankId = bank.id || "";
      if (bankId && matchedBankIds.has(bankId)) continue;

      if (bestSettlement.id && resolutionByCandidateId.has(bestSettlement.id)) continue;

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
  const codDeductionsByBatch = buildCodDeductionIndex([...codDeductions, ...amazonDeductions]);

  // Aggregate bank credits (for example, a courier payout covering many
  // delivered orders) must be matched as one bank -> remittance group. The
  // single-remittance loop below is kept for sources that provide real batch
  // references, but must not split an already-resolved combined assignment.
  const protectedCombinedCandidateIds = new Set<string>();
  const courierGroups = bankCreditResolutions.flatMap((resolution) => {
    const candidateIds = resolution.combined_candidate_ids || [];
    if (resolution.status !== "combined_batches" || candidateIds.length < 2) return [];
    candidateIds.forEach((candidateId) => protectedCombinedCandidateIds.add(candidateId));

    const bank = resolution.bank_credit;
    const remittances = candidateIds
      .map((candidateId) => codRemittances.find((remittance) => remittance.id === candidateId))
      .filter((remittance): remittance is NormalizedEvent => Boolean(remittance));
    return bank.id && remittances.length >= 2 ? [{ bank, remittances, resolution }] : [];
  });

  for (const group of courierGroups) {
    const bankId = group.bank.id || "";
    if (!bankId || matchedBankIds.has(bankId)) continue;

    const remittances = group.remittances.filter((remittance) =>
      !remittance.id || !matchedSettlementIds.has(remittance.id)
    );
    if (remittances.length < 2) continue;

    const remittanceTotal = sumEventAmounts(remittances);
    if (!amountsWithinTolerance(remittanceTotal, Number(group.bank.amount), COD_SUBSET_SUM_TOLERANCE)) {
      continue;
    }

    const deductions = remittances.flatMap((remittance) => codDeductionsByBatch.get(getBatchRef(remittance)) || []);
    const deductionTotal = sumEventAmounts(deductions);
    const directOrderRefs = Array.from(new Set(remittances.flatMap(getRemittanceOrderRefs)));

    let matchedSalesForBatch: NormalizedEvent[] | null = null;
    let saleGroupScore: LinkSignalBreakdown | null = null;

    if (directOrderRefs.length > 0) {
      const directMatch = collectSalesForOrderRefs({
        orderRefs: directOrderRefs,
        saleIndex,
        matchedSaleIds,
      });
      if (directMatch.resolvedOrderRefs.size === new Set(directOrderRefs.map((ref) => normalizeLookupValue(ref))).size && directMatch.sales.length > 0) {
        const directNetAmount = sumEventAmounts(directMatch.sales) - deductionTotal;
        if (amountsWithinTolerance(directNetAmount, Number(group.bank.amount), COD_SUBSET_SUM_TOLERANCE)) {
          matchedSalesForBatch = directMatch.sales;
          saleGroupScore = computeLinkScore({
            hasDirectIdLink: true,
            expectedAmount: directNetAmount,
            actualAmount: Number(group.bank.amount),
            date1: getLatestEventDate(directMatch.sales),
            date2: group.bank.event_date,
            refString1: directOrderRefs.join(","),
            refString2: group.bank.external_ref || getEventDescription(group.bank),
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
          group.bank.event_date,
          COD_BATCH_MIN_AGE_DAYS,
          COD_BATCH_MAX_AGE_DAYS
        );
      });
      const subsetIndexes = findSubsetSumMatch(
        Number(group.bank.amount) + deductionTotal,
        candidateSales,
        COD_SUBSET_SUM_TOLERANCE
      );
      if (subsetIndexes && subsetIndexes.length > 0) {
        matchedSalesForBatch = subsetIndexes.map((index) => candidateSales[index]);
        saleGroupScore = computeLinkScore({
          hasDirectIdLink: false,
          expectedAmount: sumEventAmounts(matchedSalesForBatch) - deductionTotal,
          actualAmount: Number(group.bank.amount),
          date1: getLatestEventDate(matchedSalesForBatch),
          date2: group.bank.event_date,
          refString1: matchedSalesForBatch.map(getOrderRefForSale).join(","),
          refString2: group.bank.external_ref || getEventDescription(group.bank),
        });
      }
    }

    if (!matchedSalesForBatch || !saleGroupScore) continue;

    const remittanceToBankScore = computeLinkScore({
      hasDirectIdLink: false,
      expectedAmount: remittanceTotal,
      actualAmount: Number(group.bank.amount),
      date1: getLatestEventDate(remittances),
      date2: group.bank.event_date,
      refString1: remittances.map(getBatchRef).filter(Boolean).join(","),
      refString2: group.bank.external_ref || getEventDescription(group.bank),
    });
    remittanceToBankScore.total = Math.max(remittanceToBankScore.total, group.resolution.confidence);

    for (const matchedSale of matchedSalesForBatch) {
      if (matchedSale.id) matchedSaleIds.add(matchedSale.id);
    }
    for (const remittance of remittances) {
      if (remittance.id) matchedSettlementIds.add(remittance.id);
    }
    matchedBankIds.add(bankId);

    const chainEventIds = [
      ...matchedSalesForBatch.map((sale) => sale.id || "").filter(Boolean),
      ...remittances.map((remittance) => remittance.id || "").filter(Boolean),
      ...deductions.map((deduction) => deduction.id || "").filter(Boolean),
      bankId,
    ];
    const chainConfidence = Math.min(saleGroupScore.total, remittanceToBankScore.total);

    matches.push({
      order_ref: getRepresentativeOrderRef(matchedSalesForBatch, group.bank.external_ref || bankId),
      event_ids: Array.from(new Set(chainEventIds)),
      match_type: "settlement_chain",
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
        settlement: remittances[0],
        remittance: remittances[0],
        remittances,
        bank: group.bank,
      },
    });
  }

  for (const remittance of marketplaceRemittances) {
    const remittanceId = remittance.id || "";
    if (remittanceId && matchedSettlementIds.has(remittanceId)) continue;
    if (remittanceId && protectedCombinedCandidateIds.has(remittanceId)) continue;

    const batchRef = getBatchRef(remittance);
    if (!batchRef) continue;

    const assignedBank = remittance.id ? bankByCandidateId.get(remittance.id) : undefined;
    const bankMatch = assignedBank
      ? {
          bank: assignedBank,
          score: computeLinkScore({
            hasDirectIdLink: Boolean(getBatchRef(remittance) && getBankNarration(assignedBank).includes(getBatchRef(remittance).toLowerCase())),
            expectedAmount: Number(remittance.amount),
            actualAmount: Number(assignedBank.amount),
            date1: remittance.event_date,
            date2: assignedBank.event_date,
            refString1: batchRef,
            refString2: assignedBank.external_ref || getEventDescription(assignedBank),
          }),
        }
      : remittance.id && resolutionByCandidateId.has(remittance.id)
      ? null
      : findBestDirectBankMatch({ remittance, bankTxns, matchedBankIds });

    if (!bankMatch?.bank.id) {
      continue;
    }

    const deductions = codDeductionsByBatch.get(batchRef) || [];
    const deductionTotal = sumEventAmounts(deductions);
    const directOrderRefs = getRemittanceOrderRefs(remittance);

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
        const window = getMarketplaceSaleWindow(remittance);
        return isSaleWithinWindowBeforeAnchor(
          sale,
          remittance.event_date,
          window.minDays,
          window.maxDays
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
  const unmatchedSettlements = [...settlements, ...marketplaceRemittances].filter((settlement) => !settlement.id || !matchedSettlementIds.has(settlement.id));
  const unmatchedBank = bankTxns.filter((b) => b.id && !matchedBankIds.has(b.id));

  return {
    matches,
    unmatched_sales: unmatchedSales,
    unmatched_payments: unmatchedPayments,
    unmatched_settlements: unmatchedSettlements,
    unmatched_bank: unmatchedBank,
    bank_credit_resolutions: bankCreditResolutions,
  };
}
