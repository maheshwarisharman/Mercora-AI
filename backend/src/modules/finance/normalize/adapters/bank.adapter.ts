import type { ExtractedRecord, NormalizedEvent } from "../../shared/types";
import type { NormalizationContext, SourceNormalizerAdapter, ValidationResult } from "../types";
import { mapBankTransaction } from "../bank";

export class BankAdapter implements SourceNormalizerAdapter {
  readonly detectedSource = "bank_statement";
  readonly requiredFields: string[] = [];
  readonly priority = 4;

  validate(_records: ExtractedRecord[]): ValidationResult {
    return { valid: true };
  }

  async normalize(
    records: ExtractedRecord[],
    context: NormalizationContext
  ): Promise<NormalizedEvent[]> {
    const { missionId, merchantId } = context;
    const events: NormalizedEvent[] = [];

    for (const rec of records) {
      const mapped = mapBankTransaction(rec.raw_json, merchantId, missionId, rec.id);
      mapped.forEach((evt) => events.push(evt));
    }

    return events;
  }
}
