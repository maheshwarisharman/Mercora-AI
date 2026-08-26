import type { ExtractedRecord, NormalizedEvent } from "../../shared/types";
import type { NormalizationContext, SourceNormalizerAdapter, ValidationResult } from "../types";
import { mapBankTransaction, type BankStatementRow } from "../bank";

export class BankAdapter implements SourceNormalizerAdapter {
  readonly detectedSource = "bank_statement";
  readonly requiredFields = ["transaction_date", "description", "credit_inr/debit_inr"];
  readonly priority = 4;

  validate(records: ExtractedRecord[]): ValidationResult {
    const recordIssues = records.flatMap((record) => {
      const raw = record.raw_json as BankStatementRow;
      const missingFields: string[] = [];
      if (!raw.transaction_date) missingFields.push("transaction_date");
      if (!raw.description) missingFields.push("description");
      if (
        String(raw.credit_inr ?? raw.credit_amount ?? "").trim() === "" &&
        String(raw.debit_inr ?? raw.debit_amount ?? "").trim() === ""
      ) {
        missingFields.push("credit_inr/debit_inr");
      }
      return missingFields.length > 0 ? [{ recordId: record.id, missingFields }] : [];
    });

    return {
      valid: recordIssues.length === 0,
      ...(recordIssues.length > 0 ? { recordIssues } : {}),
    };
  }

  async normalize(
    records: ExtractedRecord[],
    context: NormalizationContext
  ): Promise<NormalizedEvent[]> {
    const { missionId, merchantId } = context;
    const events: NormalizedEvent[] = [];

    for (const rec of records) {
      const mapped = mapBankTransaction(rec.raw_json as BankStatementRow, merchantId, missionId, rec.id);
      mapped.forEach((evt) => events.push(evt));
    }

    return events;
  }
}
