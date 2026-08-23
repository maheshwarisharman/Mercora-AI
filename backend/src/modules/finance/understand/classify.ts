import type { DetectedSource, DetectionMethod } from "../shared/types";

export interface ClassificationResult {
  detected_source: DetectedSource;
  detection_confidence: number;
  detection_method: DetectionMethod;
  is_suspicious?: boolean;
  notes?: string;
}

/**
 * Pure heuristic classifier based on filename and CSV header inspection.
 * Zero AI / LLM involvement in Batch 2.
 */
export function classifyDocumentHeuristic(
  filename: string,
  headers?: string[]
): ClassificationResult {
  const lowerName = filename.toLowerCase();
  const normalizedHeaders = headers?.map((h) => h.toLowerCase().trim().replace(/[^a-z0-9_]/g, "")) || [];

  // 1. Filename heuristic candidate
  let filenameCandidate: DetectedSource | null = null;
  if (lowerName.includes("shopify") || lowerName.includes("order")) {
    filenameCandidate = "shopify_orders";
  } else if (
    lowerName.includes("razorpay") ||
    lowerName.includes("settlement") ||
    lowerName.includes("payment")
  ) {
    filenameCandidate = "razorpay_settlement";
  } else if (
    lowerName.includes("bank") ||
    lowerName.includes("statement") ||
    lowerName.includes("hdfc") ||
    lowerName.includes("icici") ||
    lowerName.includes("sbi") ||
    lowerName.includes("axis")
  ) {
    filenameCandidate = "bank_statement";
  }

  // 2. Header inspection candidate
  let headerCandidate: DetectedSource | null = null;
  if (normalizedHeaders.length > 0) {
    const hasHeader = (h: string) => normalizedHeaders.some((item) => item.includes(h));

    if (hasHeader("order_id") && hasHeader("customer_email")) {
      headerCandidate = "shopify_orders";
    } else if (hasHeader("payment_id") && hasHeader("settlement_id")) {
      headerCandidate = "razorpay_settlement";
    } else if (
      hasHeader("transaction_date") &&
      (hasHeader("credit_amount") || hasHeader("debit_amount"))
    ) {
      headerCandidate = "bank_statement";
    }
  }

  // 3. Compute Confidence & Source
  if (filenameCandidate && headerCandidate) {
    if (filenameCandidate === headerCandidate) {
      return {
        detected_source: filenameCandidate,
        detection_confidence: 95,
        detection_method: "filename_heuristic",
        notes: "Filename and header signatures matched with high confidence",
      };
    } else {
      // Filename suggests one source, but headers prove another -> header wins with suspicious note
      return {
        detected_source: headerCandidate,
        detection_confidence: 70,
        detection_method: "filename_heuristic",
        is_suspicious: true,
        notes: `Filename '${filename}' suggested ${filenameCandidate}, but CSV header matched ${headerCandidate}`,
      };
    }
  }

  if (headerCandidate) {
    return {
      detected_source: headerCandidate,
      detection_confidence: 70,
      detection_method: "filename_heuristic",
      notes: "Detected from CSV header columns",
    };
  }

  if (filenameCandidate) {
    if (normalizedHeaders.length > 0) {
      // Filename had signal, but headers failed to match expected columns
      return {
        detected_source: filenameCandidate,
        detection_confidence: 40,
        detection_method: "filename_heuristic",
        is_suspicious: true,
        notes: "Filename matched known pattern but headers did not confirm standard columns",
      };
    } else {
      // Headers not provided
      return {
        detected_source: filenameCandidate,
        detection_confidence: 85,
        detection_method: "filename_heuristic",
        notes: "Detected based on filename patterns",
      };
    }
  }

  return {
    detected_source: "unknown",
    detection_confidence: 0,
    detection_method: "filename_heuristic",
    notes: "No matching filename or CSV header pattern identified",
  };
}
