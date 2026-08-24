import fs from "fs";
import path from "path";
import type { NormalizedEvent } from "../shared/types";

export interface CandidateEvidence {
  source_type: "support_ticket" | "refund_record";
  source_ref: string;
  customer_email?: string;
  order_ref?: string;
  amount?: number | null;
  date: string;
  title: string;
  content: string;
  relevance_score: number; // 0 - 100
}

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

/**
 * Loads synthetic evidence files from disk (/synthetic-data).
 */
function loadEvidenceFiles(): {
  tickets: RawSupportTicket[];
  refunds: RawRefundRecord[];
} {
  const syntheticDir = path.resolve(__dirname, "../../../../../synthetic-data");
  const ticketsPath = path.join(syntheticDir, "support_tickets.json");
  const refundsPath = path.join(syntheticDir, "refund_records.json");

  let tickets: RawSupportTicket[] = [];
  let refunds: RawRefundRecord[] = [];

  if (fs.existsSync(ticketsPath)) {
    try {
      tickets = JSON.parse(fs.readFileSync(ticketsPath, "utf-8"));
    } catch (e) {
      console.warn("Could not read support_tickets.json:", e);
    }
  }

  if (fs.existsSync(refundsPath)) {
    try {
      refunds = JSON.parse(fs.readFileSync(refundsPath, "utf-8"));
    } catch (e) {
      console.warn("Could not read refund_records.json:", e);
    }
  }

  return { tickets, refunds };
}

/**
 * Plain deterministic code for candidate evidence retrieval and ranking.
 * Evaluates candidate proximity to exception difference amount, date proximity,
 * and order/customer identifiers.
 */
export function retrieveCandidateEvidence(params: {
  difference: number;
  linkedEvents: NormalizedEvent[];
}): CandidateEvidence[] {
  const { difference, linkedEvents } = params;
  const { tickets, refunds } = loadEvidenceFiles();

  // Extract reference context from linked events
  const orderRefs = new Set<string>();
  const customerEmails = new Set<string>();
  const eventDates: string[] = [];

  for (const evt of linkedEvents) {
    if (evt.external_ref) orderRefs.add(evt.external_ref);
    if (evt.metadata?.order_ref) orderRefs.add(evt.metadata.order_ref);
    if (evt.metadata?.order_number) orderRefs.add(String(evt.metadata.order_number));
    if (evt.metadata?.customer_email) customerEmails.add(evt.metadata.customer_email);
    if (evt.counterparty && evt.counterparty.includes("@")) customerEmails.add(evt.counterparty);
    if (evt.event_date) eventDates.push(evt.event_date);
  }

  const baseDateStr = eventDates.length > 0 ? eventDates[0] : new Date().toISOString().split("T")[0];
  const baseTime = new Date(baseDateStr).getTime();

  const candidates: CandidateEvidence[] = [];

  // 1. Evaluate Support Tickets
  for (const ticket of tickets) {
    let score = 20; // baseline

    // Amount match
    if (ticket.related_amount !== null && Math.abs(ticket.related_amount - difference) <= 1.0) {
      score += 40;
    } else if (ticket.related_amount !== null && Math.abs(ticket.related_amount - difference) <= 50.0) {
      score += 20;
    }

    // Customer email match
    if (ticket.customer_email && customerEmails.has(ticket.customer_email)) {
      score += 30;
    }

    // Body contains order ref
    for (const ref of orderRefs) {
      if (ticket.body.includes(ref) || ticket.subject.includes(ref)) {
        score += 30;
        break;
      }
    }

    // Date proximity (within 14 days)
    const ticketTime = new Date(ticket.created_date).getTime();
    const daysDiff = Math.abs(ticketTime - baseTime) / (1000 * 60 * 60 * 24);
    if (daysDiff <= 3) {
      score += 15;
    } else if (daysDiff <= 7) {
      score += 10;
    } else if (daysDiff <= 14) {
      score += 5;
    }

    candidates.push({
      source_type: "support_ticket",
      source_ref: ticket.ticket_ref,
      customer_email: ticket.customer_email,
      amount: ticket.related_amount,
      date: ticket.created_date,
      title: ticket.subject,
      content: ticket.body,
      relevance_score: Math.min(100, score),
    });
  }

  // 2. Evaluate Refund Records
  for (const refund of refunds) {
    let score = 20; // baseline

    // Amount match
    if (Math.abs(refund.amount - difference) <= 1.0) {
      score += 40;
    } else if (Math.abs(refund.amount - difference) <= 50.0) {
      score += 20;
    }

    // Order ref match
    if (refund.order_ref && orderRefs.has(refund.order_ref)) {
      score += 35;
    }

    // Date proximity (within 14 days)
    const refundTime = new Date(refund.date).getTime();
    const daysDiff = Math.abs(refundTime - baseTime) / (1000 * 60 * 60 * 24);
    if (daysDiff <= 3) {
      score += 15;
    } else if (daysDiff <= 7) {
      score += 10;
    } else if (daysDiff <= 14) {
      score += 5;
    }

    candidates.push({
      source_type: "refund_record",
      source_ref: refund.refund_ref,
      order_ref: refund.order_ref,
      amount: refund.amount,
      date: refund.date,
      title: `Refund Record ${refund.refund_ref} for ${refund.order_ref}`,
      content: refund.reason,
      relevance_score: Math.min(100, score),
    });
  }

  // Sort descending by relevance score and pick top 5
  candidates.sort((a, b) => b.relevance_score - a.relevance_score);
  return candidates.slice(0, 5);
}
