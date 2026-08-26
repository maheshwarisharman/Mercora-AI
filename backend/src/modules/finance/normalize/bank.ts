import { parseDateToIso, type NormalizedEvent } from "../shared/types";

/**
 * Columns used by bank_statement CSV exports.
 *
 * The *_amount and reference_number aliases are retained because older
 * synthetic fixtures used those names. Real bank exports use the *_inr and
 * reference_no columns below.
 */
export interface BankStatementRow {
  transaction_date?: string;
  value_date?: string;
  description?: string;
  reference_no?: string;
  debit_inr?: string | number;
  credit_inr?: string | number;
  balance_inr?: string | number;
  // Backward-compatible aliases.
  credit_amount?: string | number;
  debit_amount?: string | number;
  reference_number?: string;
  date?: string;
  txn_date?: string;
  created_at?: string;
}

function firstNonEmptyValue(raw: BankStatementRow, keys: Array<keyof BankStatementRow>): string {
  for (const key of keys) {
    const value = raw[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function parseAmount(value: string): number {
  const parsed = Number(value.replace(/[,₹\s]/g, ""));
  return Number.isFinite(parsed) ? Math.abs(parsed) : 0;
}

/**
 * Pure mapping function for Bank Statement CSV row.
 * Produces a single BANK_TRANSACTION event.
 */
export function mapBankTransaction(
  raw: BankStatementRow,
  merchantId: string,
  missionId: string,
  extractedRecordId: string
): NormalizedEvent[] {
  const creditRaw = firstNonEmptyValue(raw, ["credit_inr", "credit_amount"]);
  const debitRaw = firstNonEmptyValue(raw, ["debit_inr", "debit_amount"]);

  const isCredit = creditRaw !== "" && parseAmount(creditRaw) > 0;
  const rawAmount = isCredit ? creditRaw : debitRaw;
  const parsedAmount = parseAmount(rawAmount);

  const transactionDate = parseDateToIso(raw.transaction_date || raw.date || raw.txn_date || raw.created_at);
  const description = String(raw.description || "Bank Transaction").trim();
  const referenceNumber = firstNonEmptyValue(raw, ["reference_no", "reference_number"]) || null;

  return [
    {
      mission_id: missionId,
      merchant_id: merchantId,
      extracted_record_id: extractedRecordId,
      event_type: "BANK_TRANSACTION",
      source_system: "bank",
      external_ref: referenceNumber || null,
      amount: parsedAmount,
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
