import { getServiceSupabase } from "../../../shared/db/supabase";

export type SummarySource = "shopify" | "cod" | "amazon";

export interface MissionAggregate {
  missionId: string;
  dateRange: { from: string; to: string };
  orderCounts: { total: number; bySource: Record<SummarySource, number> };
  salesBySource: Record<SummarySource, { orderCount: number; grossSales: number }>;
  totals: {
    grossSales: number;
    totalFees: number;
    totalRefunds: number;
    statutoryWithholding: number;
    netExpected: number;
    netReceived: number;
    variance: number;
  };
  matchHealth: {
    overallMatchRatePct: number;
    bySource: Record<SummarySource, { matchRatePct: number; unmatchedValue: number; unmatchedCount: number }>;
  };
  deductionsByCategory: Array<{ category: string; value: number; count: number }>;
  exceptions: {
    byType: Record<string, number>;
    byStatus: { open: number; resolved: number; requiresHumanReview: number };
    topOpen: Array<{ id: string; type: string; amount: number; ageDays: number }>;
  };
  cod: { remittanceCount: number; avgSettlementLagDays: number; rtoCount: number; rtoValue: number };
  amazon: { unmatchedOrderCount: number; unresolvedUnknownDeductions: number; resolvedUnknownDeductions: number };
  timeSeries: Array<{ bucket: string; matchedValue: number; unmatchedValue: number }>;
}

const SOURCES: SummarySource[] = ["shopify", "cod", "amazon"];

function numberValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sourceMap<T>(input: Record<string, T> | null | undefined, fallback: (source: SummarySource) => T): Record<SummarySource, T> {
  return SOURCES.reduce((result, source) => {
    result[source] = input?.[source] ?? fallback(source);
    return result;
  }, {} as Record<SummarySource, T>);
}

function normalizeAggregate(raw: any, missionId: string): MissionAggregate {
  const totals = raw?.totals || {};
  const rawMatchHealth = raw?.matchHealth || {};
  const rawOrderCounts = raw?.orderCounts || {};
  const rawBySource = rawMatchHealth.bySource || {};

  return {
    missionId: String(raw?.missionId || missionId),
    dateRange: {
      from: String(raw?.dateRange?.from || ""),
      to: String(raw?.dateRange?.to || ""),
    },
    orderCounts: {
      total: numberValue(rawOrderCounts.total),
      bySource: sourceMap(rawOrderCounts.bySource, () => 0),
    },
    salesBySource: sourceMap(raw?.salesBySource, (source) => ({
      orderCount: numberValue(raw?.salesBySource?.[source]?.orderCount),
      grossSales: numberValue(raw?.salesBySource?.[source]?.grossSales),
    })),
    totals: {
      grossSales: numberValue(totals.grossSales),
      totalFees: numberValue(totals.totalFees),
      totalRefunds: numberValue(totals.totalRefunds),
      statutoryWithholding: numberValue(totals.statutoryWithholding),
      netExpected: numberValue(totals.netExpected),
      netReceived: numberValue(totals.netReceived),
      variance: numberValue(totals.variance),
    },
    matchHealth: {
      overallMatchRatePct: numberValue(rawMatchHealth.overallMatchRatePct),
      bySource: sourceMap(rawBySource, (source) => {
        const item = rawBySource?.[source] || {};
        return {
          matchRatePct: numberValue(item.matchRatePct),
          unmatchedValue: numberValue(item.unmatchedValue),
          unmatchedCount: numberValue(item.unmatchedCount),
        };
      }),
    },
    deductionsByCategory: Array.isArray(raw?.deductionsByCategory)
      ? raw.deductionsByCategory.map((item: any) => ({
          category: String(item?.category || "unrecognized_deduction"),
          value: numberValue(item?.value),
          count: numberValue(item?.count),
        }))
      : [],
    exceptions: {
      byType: Object.fromEntries(Object.entries(raw?.exceptions?.byType || {}).map(([key, value]) => [key, numberValue(value)])),
      byStatus: {
        open: numberValue(raw?.exceptions?.byStatus?.open),
        resolved: numberValue(raw?.exceptions?.byStatus?.resolved),
        requiresHumanReview: numberValue(raw?.exceptions?.byStatus?.requiresHumanReview),
      },
      topOpen: Array.isArray(raw?.exceptions?.topOpen)
        ? raw.exceptions.topOpen.map((item: any) => ({
            id: String(item?.id || ""),
            type: String(item?.type || "unexplained_difference"),
            amount: numberValue(item?.amount),
            ageDays: numberValue(item?.ageDays),
          }))
        : [],
    },
    cod: {
      remittanceCount: numberValue(raw?.cod?.remittanceCount),
      avgSettlementLagDays: numberValue(raw?.cod?.avgSettlementLagDays),
      rtoCount: numberValue(raw?.cod?.rtoCount),
      rtoValue: numberValue(raw?.cod?.rtoValue),
    },
    amazon: {
      unmatchedOrderCount: numberValue(raw?.amazon?.unmatchedOrderCount),
      unresolvedUnknownDeductions: numberValue(raw?.amazon?.unresolvedUnknownDeductions),
      resolvedUnknownDeductions: numberValue(raw?.amazon?.resolvedUnknownDeductions),
    },
    timeSeries: Array.isArray(raw?.timeSeries)
      ? raw.timeSeries.map((item: any) => ({
          bucket: String(item?.bucket || ""),
          matchedValue: numberValue(item?.matchedValue),
          unmatchedValue: numberValue(item?.unmatchedValue),
        }))
      : [],
  };
}

/**
 * Stage 1: ask Postgres for the deterministic, typed reporting aggregate.
 * The RPC is intentionally the only data source used by the narrative stage.
 */
export async function buildMissionAggregate(missionId: string): Promise<MissionAggregate> {
  const supabase = getServiceSupabase();
  const { data, error } = await supabase
    .schema("finance")
    .rpc("build_mission_aggregate", { p_mission_id: missionId });

  if (error || !data) {
    throw new Error(`Failed to build mission aggregate: ${error?.message || "empty aggregate"}`);
  }

  return normalizeAggregate(data, missionId);
}
