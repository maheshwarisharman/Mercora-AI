import { describe, expect, test, mock } from "bun:test";
import { getTransactionChainDefinition } from "./transactionChain";
import { getAmazonDeductionContextDefinition } from "./amazonDeductionContext";
import { getBankCreditDefinition } from "./bankCredit";

describe("Finance QA & Investigation Tools Definitions", () => {
  test("getTransactionChainDefinition accepts order_ref and describes settlement/batch lookup", () => {
    expect(getTransactionChainDefinition.name).toBe("get_transaction_chain");
    expect(getTransactionChainDefinition.description).toContain("settlement ID");
    const params = getTransactionChainDefinition.parameters as Record<string, any>;
    expect(params.properties).toHaveProperty("order_ref");
  });

  test("getAmazonDeductionContextDefinition accepts settlement_id, order_ref, or exception_id", () => {
    expect(getAmazonDeductionContextDefinition.name).toBe("get_amazon_deduction_context");
    const params = getAmazonDeductionContextDefinition.parameters as Record<string, any>;
    expect(params.properties).toHaveProperty("settlement_id");
    expect(params.properties).toHaveProperty("order_ref");
    expect(params.properties).toHaveProperty("exception_id");
  });

  test("getBankCreditDefinition allows searching by reference, query, or amount", () => {
    expect(getBankCreditDefinition.name).toBe("get_bank_credit");
    const params = getBankCreditDefinition.parameters as Record<string, any>;
    expect(params.properties).toHaveProperty("reference");
    expect(params.properties).toHaveProperty("query");
    expect(params.properties).toHaveProperty("amount");
  });
});
