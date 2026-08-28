import type { ExtractedRecord, NormalizedEvent } from "../../shared/types";
import { parseDateToIso } from "../../shared/types";
import {
  amazonLineDate,
  amazonOrderRef,
  amazonValue,
  classifyAmazonLine,
  isAmazonReturnClawback,
  isAmazonSummaryRow,
  parseAmazonAmount,
  type AmazonLineClassification,
} from "../amazon";
import type { NormalizationContext, SourceNormalizerAdapter, ValidationResult } from "../types";

type AmazonGroup = {
  settlementId: string;
  records: ExtractedRecord[];
  summary?: ExtractedRecord;
};

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function safeRef(value: string): string | null {
  return value.trim() || null;
}

/**
 * Normalizes Amazon Flat File V2 into a batch SETTLEMENT, one SALE per order,
 * and one line-level event per report row. The line-level events retain the
 * original code and every raw field so an agent can reason over unfamiliar
 * deductions without losing the source context.
 */
export class AmazonAdapter implements SourceNormalizerAdapter {
  readonly detectedSource = "amazon_settlement";
  readonly requiredFields = ["settlement-id", "amount / total-amount", "amount-type / amount-description"];
  readonly priority = 3;

  validate(records: ExtractedRecord[]): ValidationResult {
    const recordIssues = records.flatMap((record) => {
      const raw = record.raw_json;
      const missingFields: string[] = [];
      if (!amazonValue(raw, "settlement-id")) missingFields.push("settlement-id");
      if (!amazonValue(raw, "amount") && !amazonValue(raw, "total-amount")) missingFields.push("amount / total-amount");
      // A summary row is valid without an amount-type. Detail rows need at
      // least one code; unknown codes are valid and intentionally preserved.
      if (!isAmazonSummaryRow(raw) && !amazonValue(raw, "amount-type") && !amazonValue(raw, "amount-description")) {
        missingFields.push("amount-type / amount-description");
      }
      return missingFields.length > 0 ? [{ recordId: record.id, missingFields }] : [];
    });
    return { valid: recordIssues.length === 0, recordIssues: recordIssues.length ? recordIssues : undefined };
  }

  async normalize(records: ExtractedRecord[], context: NormalizationContext): Promise<NormalizedEvent[]> {
    const { missionId, merchantId, supabase } = context;
    const groups = new Map<string, AmazonGroup>();
    for (const record of records) {
      const settlementId = amazonValue(record.raw_json, "settlement-id") || `amazon-${record.source_document_id}`;
      const group = groups.get(settlementId) || { settlementId, records: [] };
      if (isAmazonSummaryRow(record.raw_json)) group.summary = record;
      else group.records.push(record);
      groups.set(settlementId, group);
    }

    const events: NormalizedEvent[] = [];
    for (const group of groups.values()) {
      const allRows = group.records;
      const classifications = allRows.map((record) => ({
        record,
        amount: parseAmazonAmount(amazonValue(record.raw_json, "amount")),
        classification: classifyAmazonLine(record.raw_json, parseAmazonAmount(amazonValue(record.raw_json, "amount"))),
      }));
      const declaredTotal = group.summary
        ? parseAmazonAmount(amazonValue(group.summary.raw_json, "total-amount"))
        : 0;
      const detailTotal = roundMoney(classifications.reduce((sum, line) => sum + line.amount, 0));
      const settlementAmount = declaredTotal !== 0 ? declaredTotal : detailTotal;
      const currency = amazonValue(group.summary?.raw_json || allRows[0]?.raw_json || {}, "currency") || "INR";
      const settlementDate = parseDateToIso(
        amazonValue(group.summary?.raw_json || allRows[0]?.raw_json || {}, "deposit-date") ||
          amazonValue(group.summary?.raw_json || allRows[0]?.raw_json || {}, "settlement-end-date") ||
          (allRows.length ? amazonLineDate(allRows[allRows.length - 1].raw_json) : "")
      );
      const orderRefs = Array.from(new Set(allRows.map((line) => amazonOrderRef(line.raw_json)).filter(Boolean)));
      const resolvedOrderIds = new Map<string, string>();

      for (const orderRef of orderRefs) {
        const { data: matchedOrder } = await supabase
          .schema("core")
          .from("orders")
          .select("id")
          .eq("merchant_id", merchantId)
          .or(`external_ref.eq."${orderRef}",order_number.eq."${orderRef}"`)
          .maybeSingle();
        if (matchedOrder?.id) resolvedOrderIds.set(orderRef, matchedOrder.id);
      }

      const categoryCounts: Record<string, number> = {};
      for (const line of classifications) {
        categoryCounts[line.classification.category] = (categoryCounts[line.classification.category] || 0) + 1;
      }

      const settlementRecord = group.summary || allRows[0];
      if (settlementRecord) {
        events.push({
          mission_id: missionId,
          merchant_id: merchantId,
          extracted_record_id: settlementRecord.id,
          event_type: "AMAZON_SETTLEMENT",
          source_system: "amazon",
          external_ref: group.settlementId,
          amount: settlementAmount,
          currency,
          event_date: settlementDate,
          counterparty: amazonValue(settlementRecord.raw_json, "marketplace-name") || "Amazon Marketplace",
          batch_ref: group.settlementId,
          order_ids: orderRefs,
          metadata: {
            raw_source_row: group.summary?.raw_json || allRows[0]?.raw_json || {},
            amazon_settlement_id: group.settlementId,
            settlement_start_date: amazonValue(settlementRecord.raw_json, "settlement-start-date"),
            settlement_end_date: amazonValue(settlementRecord.raw_json, "settlement-end-date"),
            deposit_date: amazonValue(settlementRecord.raw_json, "deposit-date"),
            declared_total: declaredTotal,
            detail_total: detailTotal,
            line_count: allRows.length,
            deduction_category_counts: categoryCounts,
            amazon_report_type: "GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2",
            bank_credit_window_days: { minDays: 0, maxDays: 14, idealDays: 3 },
          },
        });
      }

      const byOrder = new Map<string, typeof classifications>();
      for (const line of classifications) {
        const orderRef = amazonOrderRef(line.record.raw_json);
        if (!orderRef) continue;
        const orderLines = byOrder.get(orderRef) || [];
        orderLines.push(line);
        byOrder.set(orderRef, orderLines);
      }

      for (const [orderRef, lines] of byOrder.entries()) {
        const grossCredits = lines.reduce((sum, line) => {
          // Principal is the canonical order value. If a report does not
          // include Principal, retain other positive order-level credits so
          // the order can still be reconciled and investigated.
          return sum + (line.amount > 0 && (line.classification.category === "sale_proceeds" || !line.classification.isDeduction) ? line.amount : 0);
        }, 0);
        if (grossCredits <= 0) continue;
        const representative = lines[0].record;
        const raw = representative.raw_json;
        events.push({
          mission_id: missionId,
          merchant_id: merchantId,
          extracted_record_id: representative.id,
          event_type: "SALE",
          source_system: "amazon",
          external_ref: orderRef,
          amount: roundMoney(grossCredits),
          currency,
          event_date: amazonLineDate(raw, settlementDate),
          counterparty: amazonValue(raw, "marketplace-name") || "Amazon Marketplace",
          order_id: resolvedOrderIds.get(orderRef) || null,
          batch_ref: group.settlementId,
          order_ids: [orderRef],
          metadata: {
            raw_source_row: raw,
            order_ref: orderRef,
            merchant_order_id: amazonValue(raw, "merchant-order-id"),
            amazon_order_id: amazonValue(raw, "order-id"),
            amazon_settlement_id: group.settlementId,
            gross_order_credits: roundMoney(grossCredits),
            line_item_count: lines.length,
          },
        });
      }

      classifications.forEach(({ record, amount, classification }, index) => {
        const raw = record.raw_json;
        const orderRef = amazonOrderRef(raw);
        const isRefund = isAmazonReturnClawback(raw);
        const eventType = isRefund ? "REFUND" : amount < 0 ? "FEE" : "ADJUSTMENT";
        const absAmount = Math.abs(amount);
        const orderLines = orderRef ? byOrder.get(orderRef) || [] : [];
        const grossOrderCredits = orderLines.reduce((sum, line) => sum + Math.max(0, line.amount), 0);
        const anomalyFlags: string[] = [];
        if (classification.category === "weight_handling_fee" && grossOrderCredits > 0 && absAmount > grossOrderCredits * 0.1) {
          anomalyFlags.push("weight_charge_over_10_percent_of_order");
        }
        if (classification.requiresAgent) anomalyFlags.push("agent_context_required");

        events.push({
          mission_id: missionId,
          merchant_id: merchantId,
          extracted_record_id: record.id,
          event_type: eventType,
          source_system: "amazon",
          external_ref: `${group.settlementId}:line-${index + 1}`,
          amount: roundMoney(absAmount),
          currency,
          event_date: amazonLineDate(raw, settlementDate),
          counterparty: amazonValue(raw, "marketplace-name") || "Amazon Marketplace",
          order_id: orderRef ? resolvedOrderIds.get(orderRef) || null : null,
          batch_ref: group.settlementId,
          order_ids: orderRef ? [orderRef] : [],
          deduction_type: classification.category,
          metadata: {
            raw_source_row: raw,
            amazon_settlement_id: group.settlementId,
            amazon_order_id: amazonValue(raw, "order-id"),
            merchant_order_id: amazonValue(raw, "merchant-order-id"),
            order_ref: orderRef,
            amount_type: amazonValue(raw, "amount-type"),
            amount_description: amazonValue(raw, "amount-description"),
            transaction_type: amazonValue(raw, "transaction-type"),
            sku: amazonValue(raw, "sku"),
            posted_date: amazonValue(raw, "posted-date"),
            signed_amount: amount,
            deduction_category: classification.category,
            deduction_label: classification.label,
            classification_reason: classification.reason,
            classification_confidence: classification.requiresAgent ? 0 : 96,
            classification_method: classification.requiresAgent ? "agent_required" : "deterministic_code_context",
            is_deduction: classification.isDeduction,
            is_statutory_withholding: classification.isStatutoryWithholding,
            is_return_clawback: isRefund,
            anomaly_flags: anomalyFlags,
            line_number: index + 1,
          },
        });
      });
    }

    return events;
  }
}
