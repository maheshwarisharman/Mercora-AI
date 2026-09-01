import type { DetectedSource, DetectionMethod } from "../shared/types";
import { looksLikeShopifyOrderHeaders } from "../normalize/shopify";
import { looksLikeAmazonSettlementHeaders, looksLikeAmazonOrderHeaders } from "../normalize/amazon";

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
  // Compare header signatures independent of separators/casing. This allows
  // both transaction_date and transaction date to match transactiondate.
  const normalizedHeaders = headers?.map((h) => h.toLowerCase().trim().replace(/[^a-z0-9]/g, "")) || [];

  // 1. Filename heuristic candidate
  // IMPORTANT: More-specific vendor checks must come before generic ones.
  // e.g. "amazon_orders.csv" must not be caught by the bare lowerName.includes("order") shopify branch.
  let filenameCandidate: DetectedSource | null = null;
  if (
    lowerName.includes("cod") ||
    lowerName.includes("remittance") ||
    lowerName.includes("delhivery") ||
    lowerName.includes("shiprocket") ||
    lowerName.includes("shipmozo") ||
    lowerName.includes("ecom")
  ) {
    filenameCandidate = "generic_cod";
  } else if (
    lowerName.includes("amazon") &&
    (lowerName.includes("order") || lowerName.includes("business_report") || lowerName.includes("business-report"))
  ) {
    // Amazon orders file — must be checked before generic "order" → shopify fallback
    filenameCandidate = "amazon_orders";
  } else if (lowerName.includes("amazon") || lowerName.includes("mtr")) {
    filenameCandidate = "amazon_settlement";
  } else if (lowerName.includes("shopify") || lowerName.includes("order")) {
    // Generic "order" only reaches here after amazon-specific checks have passed
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

    if (looksLikeAmazonSettlementHeaders(headers || [])) {
      headerCandidate = "amazon_settlement";
    } else if (
      looksLikeAmazonOrderHeaders(headers || []) &&
      (filenameCandidate === "amazon_orders" || hasHeader("amazon") || hasHeader("asin") || hasHeader("merchantorderid"))
    ) {
      headerCandidate = "amazon_orders";
    } else if (
      looksLikeShopifyOrderHeaders(headers || []) ||
      (hasHeader("orderid") && hasHeader("customeremail") && filenameCandidate !== "amazon_orders")
    ) {
      headerCandidate = "shopify_orders";
    } else if (looksLikeAmazonOrderHeaders(headers || [])) {
      headerCandidate = "amazon_orders";
    } else if (
      hasHeader("codamount") &&
      (hasHeader("reforderid") || hasHeader("orderid") || hasHeader("awb")) &&
      (hasHeader("delivereddate") || hasHeader("deliverydate") || hasHeader("batchref") || hasHeader("courier"))
    ) {
      headerCandidate = "generic_cod";
    } else if (hasHeader("paymentid") && hasHeader("settlementid")) {
      headerCandidate = "razorpay_settlement";
    } else if (
      hasHeader("transactiondate") &&
      (
        hasHeader("creditinr") ||
        hasHeader("debitinr") ||
        hasHeader("creditamount") ||
        hasHeader("debitamount")
      )
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
