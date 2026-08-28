import Papa from "papaparse";
import type { ExtractedRecord } from "../shared/types";

/** Amazon Flat File V2 is tab-delimited despite often being downloaded with a
 * .csv/.txt extension. Detect tabs before handing the file to Papa Parse. */
export function detectCsvDelimiter(text: string): "\t" | "," | ";" {
  const firstNonEmptyLine = text.split(/\r?\n/).find((line) => line.trim().length > 0) || "";
  if (firstNonEmptyLine.includes("\t")) return "\t";
  if (firstNonEmptyLine.includes(";")) return ";";
  return ",";
}

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
    delimiter: detectCsvDelimiter(textContent),
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
