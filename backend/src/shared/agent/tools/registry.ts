import type { ToolDefinition } from "../../llm/types";
import { getTransactionChainDefinition, getTransactionChain } from "./transactionChain";
import { getExceptionDetailsDefinition, getExceptionDetails } from "./exceptionDetails";
import { searchEvidenceDefinition, searchEvidence } from "./searchEvidence";
import { getMissionSummaryDefinition, getMissionSummary } from "./missionSummary";
import { listOpenExceptionsDefinition, listOpenExceptions } from "./listOpenExceptions";
import { requestHumanReviewDefinition, requestHumanReview } from "./requestHumanReview";
import { getAmazonDeductionContextDefinition, getAmazonDeductionContext } from "./amazonDeductionContext";
import {
  getBankCreditDefinition,
  listCandidateBatchesDefinition,
  getNarrationHistoryDefinition,
  createBankCreditToolImplementations,
  getBankCredit,
  listCandidateBatches,
  getNarrationHistory,
} from "./bankCredit";

export type ToolContext = {
  merchantId?: string;
  missionId?: string;
};

/**
 * All tool definitions for the finance agent, shared by both exception investigation and Q&A.
 */
export const financeToolDefinitions: ToolDefinition[] = [
  getTransactionChainDefinition,
  getExceptionDetailsDefinition,
  searchEvidenceDefinition,
  getMissionSummaryDefinition,
  listOpenExceptionsDefinition,
  requestHumanReviewDefinition,
  getBankCreditDefinition,
  listCandidateBatchesDefinition,
  getNarrationHistoryDefinition,
  getAmazonDeductionContextDefinition,
];

/**
 * Creates the tool implementations map with context injected (merchantId, missionId).
 * These are passed to runAgentLoop as toolImplementations.
 */
export function createFinanceToolImplementations(
  ctx: ToolContext
): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
  return {
    get_transaction_chain: (args) => getTransactionChain(args),
    get_exception_details: (args) => getExceptionDetails(args),
    search_evidence: (args) => searchEvidence(args),
    get_mission_summary: (args) => getMissionSummary(args),
    list_open_exceptions: (args) => listOpenExceptions(args),
    request_human_review: (args) => requestHumanReview(args, ctx),
    get_amazon_deduction_context: (args) => getAmazonDeductionContext(args),
    ...createBankCreditToolImplementations(ctx),
  };
}

// Re-export individual implementations for direct use if needed
export {
  getTransactionChain,
  getExceptionDetails,
  searchEvidence,
  getMissionSummary,
  listOpenExceptions,
  requestHumanReview,
  getBankCredit,
  listCandidateBatches,
  getNarrationHistory,
  getAmazonDeductionContext,
};

export type { EvidenceResult } from "./searchEvidence";
