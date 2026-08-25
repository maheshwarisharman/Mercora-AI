import fs from "fs";
import path from "path";
import type { ToolDefinition } from "../../llm/types";

export const searchEvidenceDefinition: ToolDefinition = {
  name: "search_evidence",
  description:
    "Searches support tickets and refund records for evidence that could explain a reconciliation discrepancy. " +
    "Returns at most 5 results ranked by relevance to the provided filters. " +
    "Use the 'query' field to describe what you're looking for (e.g. 'goodwill concession packaging damage order SHF-1038'). " +
    "Use optional filters to narrow by amount range, date range, or customer email. " +
    "Call this when you have enough context from get_exception_details or get_transaction_chain " +
    "to know what kind of evidence to look for — not blindly at the start. " +
    "The returned source_refs (e.g. TICK-8842, RF-5502) are what you may cite in your final answer; " +
    "only cite refs that actually appeared in a result from this tool during this investigation.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Free-text description of what you're looking for. Include order refs, " +
          "reason keywords, or counterparty names if available.",
      },
      filters: {
        type: "object",
        description: "Optional filters to narrow the search.",
        properties: {
          amount_min: { type: "number", description: "Minimum related amount (inclusive)." },
          amount_max: { type: "number", description: "Maximum related amount (inclusive)." },
          date_from: {
            type: "string",
            description: "Earliest date to consider (YYYY-MM-DD).",
          },
          date_to: {
            type: "string",
            description: "Latest date to consider (YYYY-MM-DD).",
          },
          customer_email: {
            type: "string",
            description: "Filter by customer email if known from linked events.",
          },
        },
      },
    },
    required: ["query"],
  },
};

// ──────────────────────────────────────────────────────────────────────────────
// Raw data types matching the synthetic-data JSON files
// ──────────────────────────────────────────────────────────────────────────────

interface RawSupportTicket {
  ticket_ref: string;
  customer_email: string;
  created_date: string;
  subject: string;
  body: string;
  related_amount: number | null;
}

interface RawRefundRecord {
  refund_ref: string;
  order_ref: string;
  amount: number;
  date: string;
  reason: string;
}

function loadEvidenceFiles(): { tickets: RawSupportTicket[]; refunds: RawRefundRecord[] } {
  const syntheticDir = path.resolve(__dirname, "../../../../../../synthetic-data");
  const ticketsPath = path.join(syntheticDir, "support_tickets.json");
  const refundsPath = path.join(syntheticDir, "refund_records.json");

  let tickets: RawSupportTicket[] = [];
  let refunds: RawRefundRecord[] = [];

  if (fs.existsSync(ticketsPath)) {
    try {
      tickets = JSON.parse(fs.readFileSync(ticketsPath, "utf-8"));
    } catch (e) {
      console.warn("[searchEvidence] Could not read support_tickets.json:", e);
    }
  }

  if (fs.existsSync(refundsPath)) {
    try {
      refunds = JSON.parse(fs.readFileSync(refundsPath, "utf-8"));
    } catch (e) {
      console.warn("[searchEvidence] Could not read refund_records.json:", e);
    }
  }

  return { tickets, refunds };
}

export interface EvidenceResult {
  source_type: "support_ticket" | "refund_record";
  source_ref: string;
  date: string;
  amount: number | null;
  title: string;
  content: string;
  relevance_score: number;
}

export async function searchEvidence(args: Record<string, unknown>): Promise<unknown> {
  const query = String(args.query || "").toLowerCase();
  const filters = (args.filters || {}) as {
    amount_min?: number;
    amount_max?: number;
    date_from?: string;
    date_to?: string;
    customer_email?: string;
  };

  const { tickets, refunds } = loadEvidenceFiles();
  const results: EvidenceResult[] = [];

  const queryTokens = query.split(/\s+/).filter((t) => t.length > 2);
  const dateFrom = filters.date_from ? new Date(filters.date_from).getTime() : null;
  const dateTo = filters.date_to ? new Date(filters.date_to).getTime() : null;

  // ── Score support tickets ──────────────────────────────────────────────────
  for (const ticket of tickets) {
    let score = 10;

    // Amount filter — hard exclude if outside range
    if (filters.amount_min !== undefined && ticket.related_amount !== null) {
      if (ticket.related_amount < filters.amount_min) continue;
    }
    if (filters.amount_max !== undefined && ticket.related_amount !== null) {
      if (ticket.related_amount > filters.amount_max) continue;
    }

    // Date filter — hard exclude
    const ticketTime = new Date(ticket.created_date).getTime();
    if (dateFrom && ticketTime < dateFrom) continue;
    if (dateTo && ticketTime > dateTo) continue;

    // Customer email match
    if (filters.customer_email && ticket.customer_email) {
      if (ticket.customer_email.toLowerCase() === filters.customer_email.toLowerCase()) {
        score += 35;
      }
    }

    // Amount proximity scoring
    if (filters.amount_min !== undefined && filters.amount_max !== undefined && ticket.related_amount !== null) {
      const midpoint = (filters.amount_min + filters.amount_max) / 2;
      const diff = Math.abs(ticket.related_amount - midpoint);
      if (diff <= 1) score += 40;
      else if (diff <= 50) score += 20;
    }

    // Query token matching against body + subject
    const haystack = `${ticket.subject} ${ticket.body}`.toLowerCase();
    let tokenHits = 0;
    for (const token of queryTokens) {
      if (haystack.includes(token)) tokenHits++;
    }
    score += Math.min(40, tokenHits * 12);

    if (score > 10) {
      results.push({
        source_type: "support_ticket",
        source_ref: ticket.ticket_ref,
        date: ticket.created_date,
        amount: ticket.related_amount,
        title: ticket.subject,
        content: ticket.body,
        relevance_score: Math.min(100, score),
      });
    }
  }

  // ── Score refund records ───────────────────────────────────────────────────
  for (const refund of refunds) {
    let score = 10;

    // Amount filter — hard exclude
    if (filters.amount_min !== undefined && refund.amount < filters.amount_min) continue;
    if (filters.amount_max !== undefined && refund.amount > filters.amount_max) continue;

    // Date filter — hard exclude
    const refundTime = new Date(refund.date).getTime();
    if (dateFrom && refundTime < dateFrom) continue;
    if (dateTo && refundTime > dateTo) continue;

    // Amount proximity scoring
    if (filters.amount_min !== undefined && filters.amount_max !== undefined) {
      const midpoint = (filters.amount_min + filters.amount_max) / 2;
      const diff = Math.abs(refund.amount - midpoint);
      if (diff <= 1) score += 40;
      else if (diff <= 50) score += 20;
    }

    // Query token matching
    const haystack = `${refund.refund_ref} ${refund.order_ref} ${refund.reason}`.toLowerCase();
    let tokenHits = 0;
    for (const token of queryTokens) {
      if (haystack.includes(token)) tokenHits++;
    }
    score += Math.min(40, tokenHits * 12);

    if (score > 10) {
      results.push({
        source_type: "refund_record",
        source_ref: refund.refund_ref,
        date: refund.date,
        amount: refund.amount,
        title: `Refund ${refund.refund_ref} for order ${refund.order_ref}`,
        content: refund.reason,
        relevance_score: Math.min(100, score),
      });
    }
  }

  // Sort descending by relevance, cap at 5
  results.sort((a, b) => b.relevance_score - a.relevance_score);
  const top5 = results.slice(0, 5);

  return {
    query,
    filters,
    count: top5.length,
    results: top5,
  };
}
