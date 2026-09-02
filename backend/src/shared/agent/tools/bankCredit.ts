import { getServiceSupabase } from "../../db/supabase";
import type { ToolDefinition } from "../../llm/types";
import type { NormalizedEvent } from "../../../modules/finance/shared/types";
import {
  buildBankCreditCandidates,
  rankBankCreditCandidates,
  type BankCreditDisambiguationConfig,
} from "../../../modules/finance/reconcile/matcher";

export interface BankCreditToolContext {
  merchantId?: string;
  missionId?: string;
}

const bankCreditFields = "id, event_type, source_system, external_ref, amount, currency, event_date, counterparty, metadata, batch_ref";

export const getBankCreditDefinition: ToolDefinition = {
  name: "get_bank_credit",
  description:
    "Fetches real bank credit transactions from the current finance mission, including exact narration, amount, date, and normalized event ID. " +
    "Can be queried by event UUID, UTR / reference, settlement ID (e.g. 'AMZ-DEMO-2026-08-001'), narration keyword, or amount.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "The normalized BANK_TRANSACTION or BANK_CREDIT event UUID (optional if reference or query is provided)." },
      reference: { type: "string", description: "UTR, settlement ID, or reference number (e.g. 'UTR-AMZ-DEMO-001', 'AMZ-DEMO-2026-08-001')." },
      query: { type: "string", description: "Narration, counterparty, or description keyword to search in bank statement." },
      amount: { type: "number", description: "Bank credit amount in INR." },
    },
  },
};

export const listCandidateBatchesDefinition: ToolDefinition = {
  name: "list_candidate_batches",
  description:
    "Lists only currently-unmatched Razorpay settlement and courier COD remittance events in the current mission. " +
    "Candidates are filtered by the requested date range and amount tolerance around the specified bank credit; they are real database rows, never invented.",
  parameters: {
    type: "object",
    properties: {
      bank_credit_id: { type: "string", description: "The bank credit being disambiguated." },
      date_range: {
        type: "object",
        properties: {
          from: { type: "string", description: "Earliest candidate date, YYYY-MM-DD." },
          to: { type: "string", description: "Latest candidate date, YYYY-MM-DD." },
        },
        required: ["from", "to"],
      },
      amount_tolerance: { type: "number", description: "Maximum amount difference in INR." },
    },
    required: ["bank_credit_id", "date_range", "amount_tolerance"],
  },
};

export const getNarrationHistoryDefinition: ToolDefinition = {
  name: "get_narration_history",
  description:
    "Returns a few previously confirmed bank narration examples for a source such as razorpay or courier. " +
    "Use this as pattern precedent only; it cannot create a candidate that is absent from list_candidate_batches.",
  parameters: {
    type: "object",
    properties: {
      source: { type: "string", description: "Source to inspect, for example 'razorpay' or 'courier'." },
    },
    required: ["source"],
  },
};

function scoped(ctx: BankCreditToolContext): { merchantId: string; missionId: string } | { error: string } {
  if (!ctx.merchantId || !ctx.missionId) return { error: "merchantId and missionId are required" };
  return { merchantId: ctx.merchantId, missionId: ctx.missionId };
}

function canonicalType(event: any): string {
  return String(event.metadata?.canonical_event_type || event.event_type || "");
}

function isBankCredit(event: any): boolean {
  const direction = String(event.metadata?.direction || "").toLowerCase();
  if (direction === "debit" || direction === "dr") return false;
  return event.event_type === "BANK_TRANSACTION" || event.event_type === "BANK_CREDIT" || canonicalType(event) === "BANK_CREDIT";
}

function isBatch(event: any): boolean {
  const type = canonicalType(event);
  const source = String(event.metadata?.canonical_source_system || event.source_system || "").toLowerCase();
  return (type === "SETTLEMENT" && (source === "razorpay" || source === "courier")) || type === "COD_REMITTANCE";
}

function publicEvent(event: any): Record<string, unknown> {
  return {
    id: event.id,
    event_type: event.event_type,
    canonical_event_type: canonicalType(event),
    source_system: event.source_system,
    canonical_source_system: event.metadata?.canonical_source_system || event.source_system,
    batch_reference: event.batch_ref || event.metadata?.batch_ref || event.external_ref,
    external_ref: event.external_ref,
    amount: Number(event.amount),
    currency: event.currency,
    event_date: event.event_date,
    counterparty: event.counterparty,
    metadata: event.metadata,
  };
}

export async function getBankCredit(args: Record<string, unknown>, ctx: BankCreditToolContext): Promise<unknown> {
  const scope = scoped(ctx);
  if ("error" in scope) return scope;

  const id = String(args.id || "").trim();
  const ref = String(args.reference || args.query || args.narration || "").trim();
  const amount = args.amount !== undefined && args.amount !== null ? Number(args.amount) : null;

  const supabase = getServiceSupabase();
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

  if (isUuid) {
    const { data, error } = await supabase
      .schema("finance")
      .from("normalized_events")
      .select(bankCreditFields)
      .eq("id", id)
      .eq("mission_id", scope.missionId)
      .eq("merchant_id", scope.merchantId)
      .maybeSingle();
    if (error || !data) return { error: error?.message || "Bank credit not found" };
    if (!isBankCredit(data)) return { error: "The requested event is not a bank credit" };
    return { bank_credit: publicEvent(data) };
  }

  // Search by reference / query / amount
  const searchKey = ref || id;
  const { data: allBankEvents, error } = await supabase
    .schema("finance")
    .from("normalized_events")
    .select(bankCreditFields)
    .eq("mission_id", scope.missionId)
    .eq("merchant_id", scope.merchantId);

  if (error) return { error: error.message };

  const bankCredits = (allBankEvents || []).filter(isBankCredit);
  let matches = bankCredits;

  if (searchKey) {
    const lowerKey = searchKey.toLowerCase();
    matches = matches.filter((e) => {
      const narration = [e.external_ref, e.counterparty, e.metadata?.description, e.metadata?.narration, e.metadata?.remarks]
        .filter(Boolean).join(" ").toLowerCase();
      return (
        narration.includes(lowerKey) ||
        String(e.external_ref || "").toLowerCase().includes(lowerKey) ||
        String(e.counterparty || "").toLowerCase().includes(lowerKey) ||
        String(e.batch_ref || "").toLowerCase().includes(lowerKey)
      );
    });
  }

  if (amount !== null && !isNaN(amount)) {
    matches = matches.filter((e) => Math.abs(Number(e.amount) - amount) <= 1.0);
  }

  if (matches.length === 0) {
    return { error: `No bank credit matching criteria found for reference "${searchKey || amount}".` };
  }

  return {
    bank_credit: publicEvent(matches[0]),
    all_matching_credits: matches.map(publicEvent),
    count: matches.length,
  };
}


export async function listCandidateBatches(args: Record<string, unknown>, ctx: BankCreditToolContext): Promise<unknown> {
  const scope = scoped(ctx);
  if ("error" in scope) return scope;
  const bankCreditId = String(args.bank_credit_id || "");
  const dateRange = (args.date_range || {}) as Record<string, unknown>;
  const from = String(dateRange.from || "");
  const to = String(dateRange.to || "");
  const tolerance = Number(args.amount_tolerance);
  if (!bankCreditId || !from || !to || !Number.isFinite(tolerance) || tolerance < 0) {
    return { error: "bank_credit_id, date_range.from, date_range.to and non-negative amount_tolerance are required" };
  }

  const supabase = getServiceSupabase();
  const { data: bank, error: bankError } = await supabase
    .schema("finance")
    .from("normalized_events")
    .select(bankCreditFields)
    .eq("id", bankCreditId)
    .eq("mission_id", scope.missionId)
    .eq("merchant_id", scope.merchantId)
    .maybeSingle();
  if (bankError || !bank || !isBankCredit(bank)) return { error: bankError?.message || "Bank credit not found" };

  const { data: matches, error: matchesError } = await supabase
    .schema("finance")
    .from("matches")
    .select("event_ids")
    .eq("mission_id", scope.missionId);
  if (matchesError) return { error: matchesError.message };
  const matchedIds = new Set((matches || []).flatMap((row: any) => row.event_ids || []).map(String));

  const { data: events, error: eventsError } = await supabase
    .schema("finance")
    .from("normalized_events")
    .select("*")
    .eq("mission_id", scope.missionId)
    .eq("merchant_id", scope.merchantId)
    .gte("event_date", from)
    .lte("event_date", to);
  if (eventsError) return { error: eventsError.message };

  const candidates = (events || [])
    .filter((event: any) => isBatch(event) && event.id !== bankCreditId && !matchedIds.has(String(event.id)))
    .filter((event: any) => Math.abs(Number(event.amount) - Number(bank.amount)) <= tolerance);
  const ranked = rankBankCreditCandidates(bank as NormalizedEvent, buildBankCreditCandidates(candidates as NormalizedEvent[]), {
    amountToleranceRupees: tolerance,
  } satisfies BankCreditDisambiguationConfig);

  return {
    bank_credit_id: bankCreditId,
    candidates: ranked.map((candidate) => ({
      candidate_id: candidate.candidate_id,
      batch_reference: candidate.batch_reference,
      source: candidate.source,
      amount: candidate.amount,
      date: candidate.date,
      score: candidate.score,
      signals: candidate.signals,
    })),
  };
}

export async function getNarrationHistory(args: Record<string, unknown>, ctx: BankCreditToolContext): Promise<unknown> {
  const scope = scoped(ctx);
  if ("error" in scope) return scope;
  const source = String(args.source || "").toLowerCase().trim();
  if (!source) return { error: "source is required" };

  const supabase = getServiceSupabase();
  const [{ data: matches, error: matchesError }, { data: events, error: eventsError }] = await Promise.all([
    supabase.schema("finance").from("matches").select("event_ids, status").eq("mission_id", scope.missionId),
    supabase.schema("finance").from("normalized_events").select("*").eq("mission_id", scope.missionId).eq("merchant_id", scope.merchantId),
  ]);
  if (matchesError || eventsError) return { error: matchesError?.message || eventsError?.message };

  const eventById = new Map((events || []).map((event: any) => [String(event.id), event]));
  const examples: Array<Record<string, unknown>> = [];
  for (const match of matches || []) {
    if (match.status !== "confirmed" && match.status !== "auto_matched") continue;
    const chain = (match.event_ids || []).map((id: string) => eventById.get(String(id))).filter(Boolean) as any[];
    const bank = chain.find(isBankCredit);
    const batch = chain.find((event) => isBatch(event) && String(event.metadata?.canonical_source_system || event.source_system).toLowerCase() === source);
    if (!bank || !batch) continue;
    examples.push({
      source,
      narration: [bank.external_ref, bank.counterparty, bank.metadata?.description, bank.metadata?.narration].filter(Boolean).join(" "),
      batch_reference: batch.batch_ref || batch.metadata?.batch_ref || batch.external_ref,
      amount: Number(bank.amount),
      bank_date: bank.event_date,
    });
    if (examples.length >= 5) break;
  }
  return { source, examples };
}

export function createBankCreditToolImplementations(ctx: BankCreditToolContext): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
  return {
    get_bank_credit: (args) => getBankCredit(args, ctx),
    list_candidate_batches: (args) => listCandidateBatches(args, ctx),
    get_narration_history: (args) => getNarrationHistory(args, ctx),
  };
}
