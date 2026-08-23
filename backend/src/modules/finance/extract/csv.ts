import Papa from "papaparse";
import type { ExtractedRecord } from "../shared/types";

/**
 * Parses raw CSV buffer into finance.extracted_records format.
 * Preserves raw_json untouched with exact CSV header keys.
 */
export function parseCsvBufferToRecords(params: {
  buffer: Buffer;
  sourceDocumentId: string;
  missionId: string;
  merchantId: string;
}): Omit<ExtractedRecord, "id" | "created_at">[] {
  const textContent = params.buffer.toString("utf-8");

  const parseResult = Papa.parse<Record<string, any>>(textContent, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.trim(),
  });

  if (parseResult.errors && parseResult.errors.length > 0) {
    console.warn(`[CSV Parse Warning] Encountered issues in CSV:`, parseResult.errors);
  }

  const rows = parseResult.data.filter((row) => Object.keys(row).length > 0);

  return rows.map((row) => ({
    source_document_id: params.sourceDocumentId,
    mission_id: params.missionId,
    merchant_id: params.merchantId,
    raw_json: row,
    extraction_method: "csv_parse",
    extraction_confidence: 100,
  }));
}
