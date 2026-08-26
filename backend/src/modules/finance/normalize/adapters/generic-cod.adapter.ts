import type { ExtractedRecord, NormalizedEvent, DeductionType } from "../../shared/types";
import { parseDateToIso } from "../../shared/types";
import type { NormalizationContext, SourceNormalizerAdapter, ValidationResult } from "../types";

export interface CodColumnConfig {
  orderIdKeys: string[];
  amountKeys: string[];
  batchRefKeys: string[];
  dateKeys: string[];
  statusKeys: string[];
  courierKeys: string[];
}

const DEFAULT_COD_COLUMN_CONFIG: CodColumnConfig = {
  orderIdKeys: ["order_id", "order_ref", "waybill", "awb", "order_number", "shipment_id"],
  amountKeys: ["cod_amount", "collected_amount", "remittance_amount", "amount", "net_amount", "cr_amount"],
  batchRefKeys: ["batch_ref", "remittance_id", "utr", "payout_id", "settlement_id", "batch_id", "remittance_ref"],
  dateKeys: ["remittance_date", "date", "delivery_date", "payment_date", "txn_date", "created_at"],
  statusKeys: ["status", "delivery_status", "shipment_status", "order_status"],
  courierKeys: ["courier", "courier_name", "partner", "carrier"],
};

/**
 * Adapter for Generic COD Settlement CSVs.
 * Supports configurable column aliases so specific couriers (Delhivery, Shiprocket, etc.)
 * can inherit or be instantiated with tailored column mappings.
 */
export class GenericCodAdapter implements SourceNormalizerAdapter {
  readonly detectedSource = "generic_cod";
  readonly requiredFields = ["order_id", "cod_amount"];
  readonly priority = 3;
  protected config: CodColumnConfig;

  constructor(config?: Partial<CodColumnConfig>) {
    this.config = { ...DEFAULT_COD_COLUMN_CONFIG, ...config };
  }

  protected getFirstValue(raw: Record<string, any>, keys: string[]): any {
    for (const k of keys) {
      if (raw[k] !== undefined && raw[k] !== null && String(raw[k]).trim() !== "") {
        return raw[k];
      }
      // Also test lowercase / stripped keys
      const lowerKey = k.toLowerCase().replace(/[^a-z0-9_]/g, "");
      for (const [rk, rv] of Object.entries(raw)) {
        if (rk.toLowerCase().replace(/[^a-z0-9_]/g, "") === lowerKey && rv !== undefined && rv !== null && String(rv).trim() !== "") {
          return rv;
        }
      }
    }
    return undefined;
  }

  validate(records: ExtractedRecord[]): ValidationResult {
    const missing: string[] = [];
    const recordIssues: Array<{ recordId: string; missingFields: string[] }> = [];

    for (const rec of records) {
      const raw = rec.raw_json;
      const orderVal = this.getFirstValue(raw, this.config.orderIdKeys);
      const amountVal = this.getFirstValue(raw, this.config.amountKeys);

      const missingForRec: string[] = [];
      if (!orderVal) missingForRec.push("order_id");
      if (!amountVal) missingForRec.push("cod_amount");

      if (missingForRec.length > 0) {
        recordIssues.push({ recordId: rec.id, missingFields: missingForRec });
      }
    }

    return {
      valid: recordIssues.length === 0,
      missingFields: missing,
      recordIssues: recordIssues.length > 0 ? recordIssues : undefined,
    };
  }

  async normalize(
    records: ExtractedRecord[],
    context: NormalizationContext
  ): Promise<NormalizedEvent[]> {
    const { missionId, merchantId, supabase } = context;
    const events: NormalizedEvent[] = [];

    // Group constituent order refs by batch for many-to-one batch_ref mapping
    const batchToOrdersMap = new Map<string, string[]>();
    for (const rec of records) {
      const raw = rec.raw_json;
      const orderRef = String(this.getFirstValue(raw, this.config.orderIdKeys) || "").trim();
      const batchRef = String(this.getFirstValue(raw, this.config.batchRefKeys) || "").trim();
      if (batchRef && orderRef) {
        const list = batchToOrdersMap.get(batchRef) || [];
        if (!list.includes(orderRef)) {
          list.push(orderRef);
        }
        batchToOrdersMap.set(batchRef, list);
      }
    }

    for (const rec of records) {
      const raw = rec.raw_json;
      const orderRef = String(this.getFirstValue(raw, this.config.orderIdKeys) || "").trim();
      const codAmountRaw = this.getFirstValue(raw, this.config.amountKeys);
      const codAmount = parseFloat(String(codAmountRaw || "0"));
      const batchRef = String(this.getFirstValue(raw, this.config.batchRefKeys) || "").trim() || null;
      const rawDate = this.getFirstValue(raw, this.config.dateKeys);
      const eventDate = parseDateToIso(rawDate);
      const status = String(this.getFirstValue(raw, this.config.statusKeys) || "").toLowerCase().trim();
      const courierName = String(this.getFirstValue(raw, this.config.courierKeys) || "Courier Partner").trim();

      let resolvedOrderId: string | null = null;

      // 1. Resolve core.orders linkage if order exists in core
      if (orderRef) {
        const { data: matchedOrder } = await supabase
          .schema("core")
          .from("orders")
          .select("id")
          .eq("merchant_id", merchantId)
          .or(`external_ref.eq."${orderRef}",order_number.eq."${orderRef}"`)
          .maybeSingle();

        if (matchedOrder) {
          resolvedOrderId = matchedOrder.id;
        }
      }

      const constituentOrderIds = batchRef ? batchToOrdersMap.get(batchRef) || [orderRef] : [orderRef];

      // 2. Emit COD_REMITTANCE event
      events.push({
        mission_id: missionId,
        merchant_id: merchantId,
        extracted_record_id: rec.id,
        event_type: "COD_REMITTANCE",
        source_system: "courier",
        external_ref: batchRef || (orderRef ? `remit-${orderRef}` : null),
        amount: isNaN(codAmount) ? 0 : codAmount,
        currency: "INR",
        event_date: eventDate,
        counterparty: courierName,
        order_id: resolvedOrderId,
        batch_ref: batchRef,
        order_ids: constituentOrderIds.filter(Boolean),
        metadata: {
          raw_source_row: raw,
          order_id: orderRef,
          batch_ref: batchRef,
          courier_partner: courierName,
          constituent_order_count: constituentOrderIds.length,
          status: raw.status || raw.delivery_status,
        },
      });

      // 3. Emit COD_COLLECTION event if reported separately
      const collectedAmountRaw = raw.doorstep_collected_amount || raw.collected_cash || raw.cod_collected;
      if (collectedAmountRaw !== undefined && collectedAmountRaw !== null && collectedAmountRaw !== "") {
        const collectedAmt = parseFloat(String(collectedAmountRaw || "0"));
        if (!isNaN(collectedAmt) && collectedAmt > 0) {
          events.push({
            mission_id: missionId,
            merchant_id: merchantId,
            extracted_record_id: rec.id,
            event_type: "COD_COLLECTION",
            source_system: "courier",
            external_ref: orderRef ? `collect-${orderRef}` : null,
            amount: collectedAmt,
            currency: "INR",
            event_date: eventDate,
            counterparty: courierName,
            order_id: resolvedOrderId,
            order_ids: [orderRef].filter(Boolean),
            metadata: {
              raw_source_row: raw,
              order_id: orderRef,
              courier_partner: courierName,
            },
          });
        }
      }

      // 4. Emit RTO_EVENT if shipment was returned/refused
      const isRto = status.includes("rto") || status.includes("return") || status.includes("refused") || status.includes("undelivered");
      if (isRto) {
        events.push({
          mission_id: missionId,
          merchant_id: merchantId,
          extracted_record_id: rec.id,
          event_type: "RTO_EVENT",
          source_system: "courier",
          external_ref: orderRef ? `rto-${orderRef}` : null,
          amount: isNaN(codAmount) ? 0 : codAmount,
          currency: "INR",
          event_date: eventDate,
          counterparty: courierName,
          order_id: resolvedOrderId,
          order_ids: [orderRef].filter(Boolean),
          metadata: {
            raw_source_row: raw,
            order_id: orderRef,
            rto_status: status,
            courier_partner: courierName,
          },
        });
      }

      // 5. Emit COD_DEDUCTION events for deduction columns present in the file
      const deductionMappings: Array<{ keys: string[]; type: DeductionType }> = [
        { keys: ["handling_fee", "cod_fee", "processing_fee"], type: "HANDLING_FEE" },
        { keys: ["rto_charge", "rto_clawback", "rto_fee"], type: "RTO_CLAWBACK" },
        { keys: ["weight_charge", "weight_adj", "weight_discrepancy"], type: "WEIGHT_ADJ" },
        { keys: ["shortpay", "short_payment", "penalty"], type: "SHORTPAY" },
        { keys: ["freight_charge", "shipping_fee", "delivery_charge", "freight"], type: "FREIGHT_CHARGE" },
        { keys: ["other_deduction", "deduction_amount", "deduction"], type: "OTHER" },
      ];

      for (const mapping of deductionMappings) {
        const val = this.getFirstValue(raw, mapping.keys);
        if (val !== undefined && val !== null && String(val).trim() !== "") {
          const parsedDeduction = parseFloat(String(val));
          if (!isNaN(parsedDeduction) && parsedDeduction > 0) {
            events.push({
              mission_id: missionId,
              merchant_id: merchantId,
              extracted_record_id: rec.id,
              event_type: "COD_DEDUCTION",
              source_system: "courier",
              external_ref: orderRef ? `${orderRef}-${mapping.type.toLowerCase()}` : (batchRef ? `${batchRef}-${mapping.type.toLowerCase()}` : null),
              amount: parsedDeduction,
              currency: "INR",
              event_date: eventDate,
              counterparty: courierName,
              order_id: resolvedOrderId,
              batch_ref: batchRef,
              order_ids: [orderRef].filter(Boolean),
              deduction_type: mapping.type,
              metadata: {
                raw_source_row: raw,
                order_id: orderRef,
                batch_ref: batchRef,
                deduction_type: mapping.type,
                courier_partner: courierName,
              },
            });
          }
        }
      }
    }

    return events;
  }
}
