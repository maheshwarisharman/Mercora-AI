import type { NormalizedEvent } from "../shared/types";

/**
 * Pure mapping function for Bank Statement CSV row.
 * Produces a single BANK_TRANSACTION event.
 */
export function mapBankTransaction(
  raw: Record<string, any>,
  merchantId: string,
  missionId: string,
  extractedRecordId: string
): NormalizedEvent[] {
  const creditRaw = raw.credit_amount !== undefined && raw.credit_amount !== null ? String(raw.credit_amount).trim() : "";
  const debitRaw = raw.debit_amount !== undefined && raw.debit_amount !== null ? String(raw.debit_amount).trim() : "";

  const isCredit = creditRaw !== "" && !isNaN(parseFloat(creditRaw)) && parseFloat(creditRaw) > 0;
  const rawAmount = isCredit ? creditRaw : debitRaw;
  const parsedAmount = Math.abs(parseFloat(rawAmount || "0"));

  const transactionDate = String(raw.transaction_date || "").trim();
  const description = String(raw.description || "Bank Transaction").trim();
  const referenceNumber = raw.reference_number ? String(raw.reference_number).trim() : null;

  return [
    {
      mission_id: missionId,
      merchant_id: merchantId,
      extracted_record_id: extractedRecordId,
      event_type: "BANK_TRANSACTION",
      source_system: "bank",
      external_ref: referenceNumber || null,
      amount: isNaN(parsedAmount) ? 0 : parsedAmount,
      currency: "INR",
      event_date: transactionDate,
      counterparty: description,
      metadata: {
        raw_source_row: raw,
        direction: isCredit ? "credit" : "debit",
        description,
      },
    },
  ];
}
