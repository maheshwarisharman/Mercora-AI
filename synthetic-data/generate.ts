import fs from "fs";
import path from "path";

// Seeded pseudo-random number generator (Mulberry32) for deterministic output
function mulberry32(a: number) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(42891); // Fixed seed for repeatability

function randomBetween(min: number, max: number): number {
  return min + random() * (max - min);
}

function randomInt(min: number, max: number): number {
  return Math.floor(randomBetween(min, max + 1));
}

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(random() * arr.length)];
}

function randomAlphaNumeric(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(random() * chars.length));
  }
  return result;
}

const FIRST_NAMES = [
  "Aarav", "Aditi", "Ananya", "Dev", "Diya", "Ishaan", "Kavya", "Manish", "Neha",
  "Pooja", "Priya", "Rahul", "Riya", "Rohan", "Siddharth", "Tanvi", "Varun", "Vikram",
  "Arjun", "Kunal", "Meera", "Nikhil", "Sneha", "Tarun", "Aditya", "Simran", "Deepak"
];

const LAST_NAMES = [
  "Sharma", "Verma", "Gupta", "Patel", "Mehta", "Reddy", "Nair", "Kapoor",
  "Malhotra", "Joshi", "Bhatia", "Deshmukh", "Singhania", "Mukherjee", "Chatterjee", "Saxena"
];

const DOMAINS = ["gmail.com", "outlook.com", "yahoo.co.in", "icloud.com", "proton.me"];

export interface GroundTruthChain {
  chain_id: number;
  order_id: string;
  order_number: string;
  customer_name: string;
  customer_email: string;
  payment_id: string;
  settlement_id: string | null;
  order_date: string;
  payment_date: string;
  settlement_date: string | null;
  bank_date: string | null;
  gross_amount: number;
  fee_amount: number;
  tax_on_fee: number;
  net_amount: number;
  bank_credit_amount: number | null;
  order_status: "paid" | "refunded" | "partially_refunded";
  payment_status: "captured" | "refunded";
  refund_amount: number | null;
  bank_reference_number: string | null;
  anomaly_type: "timing_difference" | "missing_settlement" | "missing_bank_credit" | "duplicate" | "unexplained_difference" | null;
  anomaly_details?: {
    type: string;
    expected_amount?: number;
    actual_amount?: number;
    difference?: number;
    description: string;
  } | null;
}

export function generateSyntheticDataset(orderCount = 40): {
  shopifyCsv: string;
  razorpayCsv: string;
  bankCsv: string;
  groundTruth: GroundTruthChain[];
} {
  const groundTruth: GroundTruthChain[] = [];

  const shopifyRows: string[][] = [
    ["order_id", "order_number", "customer_name", "customer_email", "order_date", "total_amount", "currency", "status", "refund_amount"]
  ];

  const razorpayRows: string[][] = [
    ["payment_id", "order_ref", "payment_date", "gross_amount", "fee_amount", "tax_on_fee", "net_amount", "settlement_id", "settlement_date", "status"]
  ];

  const bankRows: string[][] = [
    ["transaction_date", "description", "credit_amount", "debit_amount", "reference_number"]
  ];

  const baseDate = new Date("2026-08-01T00:00:00Z");

  for (let i = 1; i <= orderCount; i++) {
    const orderNumInt = 1000 + i;
    const orderId = `#SHF-${orderNumInt}`;
    const orderNumber = `${orderNumInt}`;

    const firstName = randomChoice(FIRST_NAMES);
    const lastName = randomChoice(LAST_NAMES);
    const customerName = `${firstName} ${lastName}`;
    const customerEmail = `${firstName.toLowerCase()}.${lastName.toLowerCase()}${randomInt(10, 99)}@${randomChoice(DOMAINS)}`;

    // Order Date: spanning 2026-08-01 to 2026-08-20
    const dayOffset = Math.floor((i - 1) * 0.45);
    const orderDateObj = new Date(baseDate.getTime() + dayOffset * 24 * 60 * 60 * 1000);
    const orderDateStr = orderDateObj.toISOString().split("T")[0];

    // Payment Date: same day or +1 day
    const paymentDateObj = new Date(orderDateObj.getTime() + (random() > 0.8 ? 1 : 0) * 24 * 60 * 60 * 1000);
    const paymentDateStr = paymentDateObj.toISOString().split("T")[0];

    // Settlement Date: 1-3 days after payment
    const settlementDateObj = new Date(paymentDateObj.getTime() + randomInt(1, 3) * 24 * 60 * 60 * 1000);
    const settlementDateStr = settlementDateObj.toISOString().split("T")[0];

    // Bank Date: standard 1-3 days after settlement
    let bankDateObj = new Date(settlementDateObj.getTime() + (random() > 0.7 ? 1 : 0) * 24 * 60 * 60 * 1000);

    // Amount generation (e.g. INR 499 to INR 14999)
    const grossAmount = Math.round(randomBetween(499, 14999) * 100) / 100;

    // Fee calculation: ~2% gateway fee + 18% GST on fee
    const feeAmount = Math.round(grossAmount * 0.02 * 100) / 100;
    const taxOnFee = Math.round(feeAmount * 0.18 * 100) / 100;
    const netAmount = Math.round((grossAmount - feeAmount - taxOnFee) * 100) / 100;

    // Payment IDs
    const paymentId = `pay_${randomAlphaNumeric(14)}`;
    let settlementId: string | null = `setl_${randomAlphaNumeric(14)}`;
    let finalSettlementDateStr: string | null = settlementDateStr;

    // Status: mostly paid, ~8% partially_refunded, ~5% refunded (avoid collision with anomaly indices)
    let orderStatus: "paid" | "refunded" | "partially_refunded" = "paid";
    let paymentStatus: "captured" | "refunded" = "captured";
    let refundAmount: number | null = null;

    if (i === 15) {
      orderStatus = "refunded";
      paymentStatus = "refunded";
      refundAmount = grossAmount;
    } else if (i === 9) {
      orderStatus = "partially_refunded";
      refundAmount = Math.round((grossAmount * 0.5) * 100) / 100;
    }

    // Bank Reference: blank on ~30% rows intentionally as per spec
    const hasBankRef = random() > 0.3;
    const bankRefNumber = hasBankRef ? `CMS${randomInt(10000000, 99999999)}` : null;

    // Alternate order reference between order_id and order_number to test both matches
    const orderRefUsed = i % 2 === 0 ? orderId : orderNumber;

    // ------------------------------------------------------------------------
    // SEEDED ANOMALIES (Batch 3 & 4)
    // ------------------------------------------------------------------------
    let anomalyType: GroundTruthChain["anomaly_type"] = null;
    let anomalyDetails: GroundTruthChain["anomaly_details"] = null;
    let bankCreditAmount: number | null = netAmount;
    let emitBankRow = true;
    let emitSettlementInRzp = true;

    if (i === 7) {
      // 1. Timing Outlier 1: Bank credit lands 12 days after settlement (>5 days)
      anomalyType = "timing_difference";
      bankDateObj = new Date(settlementDateObj.getTime() + 12 * 24 * 60 * 60 * 1000);
      anomalyDetails = {
        type: "timing_difference",
        description: "Bank credit lands 12 days after settlement instead of usual 1-5 day window"
      };
    } else if (i === 14) {
      // 2. Missing Settlement: Razorpay payment captured, but settlement row is omitted
      anomalyType = "missing_settlement";
      emitSettlementInRzp = false;
      settlementId = null;
      finalSettlementDateStr = null;
      emitBankRow = false;
      bankCreditAmount = null;
      anomalyDetails = {
        type: "missing_settlement",
        description: "Payment captured in Razorpay but settlement leg is omitted"
      };
    } else if (i === 21) {
      // 3. Missing Bank Credit: Settlement exists in Razorpay, but bank credit row is omitted
      anomalyType = "missing_bank_credit";
      emitBankRow = false;
      bankCreditAmount = null;
      anomalyDetails = {
        type: "missing_bank_credit",
        description: "Settlement exists in Razorpay but bank statement credit row is omitted"
      };
    } else if (i === 28) {
      // 4. Timing Outlier 2: Bank credit lands 14 days after settlement (>5 days)
      anomalyType = "timing_difference";
      bankDateObj = new Date(settlementDateObj.getTime() + 14 * 24 * 60 * 60 * 1000);
      anomalyDetails = {
        type: "timing_difference",
        description: "Bank credit lands 14 days after settlement instead of usual 1-5 day window"
      };
    } else if (i === 33) {
      // 5. Duplicate: Same Razorpay payment row appears twice
      anomalyType = "duplicate";
      anomalyDetails = {
        type: "duplicate",
        description: "Duplicate export row in Razorpay transactions CSV"
      };
    } else if (i === 38) {
      // 6. Small Unexplained Delta: Bank credit is off by ₹500 from expected net amount
      anomalyType = "unexplained_difference";
      bankCreditAmount = Math.round((netAmount - 500) * 100) / 100;
      anomalyDetails = {
        type: "unexplained_difference",
        expected_amount: netAmount,
        actual_amount: bankCreditAmount,
        difference: 500,
        description: "Bank credit is off by ₹500 from net settlement; to be resolved via synthetic evidence in Batch 4"
      };
    }

    const bankDateStr = emitBankRow ? bankDateObj.toISOString().split("T")[0] : null;

    // 1. Shopify Row
    shopifyRows.push([
      orderId,
      orderNumber,
      customerName,
      customerEmail,
      orderDateStr,
      grossAmount.toFixed(2),
      "INR",
      orderStatus,
      refundAmount ? refundAmount.toFixed(2) : ""
    ]);

    // 2. Razorpay Row
    const rzpRow = [
      paymentId,
      orderRefUsed,
      paymentDateStr,
      grossAmount.toFixed(2),
      feeAmount.toFixed(2),
      taxOnFee.toFixed(2),
      emitSettlementInRzp ? netAmount.toFixed(2) : "",
      settlementId || "",
      finalSettlementDateStr || "",
      paymentStatus
    ];
    razorpayRows.push(rzpRow);

    // If duplicate anomaly on row 33, push duplicate row to Razorpay CSV
    if (i === 33) {
      razorpayRows.push([...rzpRow]);
    }

    // 3. Bank Row (Credits net settlement amount or modified amount)
    if (emitBankRow && bankDateStr && bankCreditAmount !== null) {
      bankRows.push([
        bankDateStr,
        `NEFT RAZORPAY SETL ${settlementId || paymentId}`,
        bankCreditAmount.toFixed(2),
        "", // debit_amount
        bankRefNumber || ""
      ]);
    }

    // Ground Truth record
    groundTruth.push({
      chain_id: i,
      order_id: orderId,
      order_number: orderNumber,
      customer_name: customerName,
      customer_email: customerEmail,
      payment_id: paymentId,
      settlement_id: settlementId,
      order_date: orderDateStr,
      payment_date: paymentDateStr,
      settlement_date: finalSettlementDateStr,
      bank_date: bankDateStr,
      gross_amount: grossAmount,
      fee_amount: feeAmount,
      tax_on_fee: taxOnFee,
      net_amount: netAmount,
      bank_credit_amount: bankCreditAmount,
      order_status: orderStatus,
      payment_status: paymentStatus,
      refund_amount: refundAmount,
      bank_reference_number: bankRefNumber,
      anomaly_type: anomalyType,
      anomaly_details: anomalyDetails,
    });
  }

  // Convert 2D arrays to CSV strings
  const toCsv = (rows: string[][]) =>
    rows.map((row) => row.map((val) => `"${val.replace(/"/g, '""')}"`).join(",")).join("\n");

  return {
    shopifyCsv: toCsv(shopifyRows),
    razorpayCsv: toCsv(razorpayRows),
    bankCsv: toCsv(bankRows),
    groundTruth,
  };
}

// Standalone execution script
export function main() {
  const outputDir = path.resolve(__dirname);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log("Generating 40 synthetic linked order chains with 5 seeded anomalies...");
  const dataset = generateSyntheticDataset(40);

  fs.writeFileSync(path.join(outputDir, "shopify_orders.csv"), dataset.shopifyCsv, "utf-8");
  fs.writeFileSync(path.join(outputDir, "razorpay_transactions.csv"), dataset.razorpayCsv, "utf-8");
  fs.writeFileSync(path.join(outputDir, "bank_statement.csv"), dataset.bankCsv, "utf-8");
  fs.writeFileSync(
    path.join(outputDir, "ground_truth.json"),
    JSON.stringify(dataset.groundTruth, null, 2),
    "utf-8"
  );

  console.log(`✅ Generated synthetic dataset in: ${outputDir}`);
  console.log(` - shopify_orders.csv (40 orders)`);
  console.log(` - razorpay_transactions.csv (${dataset.groundTruth.length + 1} rows with duplicate)`);
  console.log(` - bank_statement.csv (38 settlements)`);
  console.log(` - ground_truth.json (40 chains documented with anomalies)`);
}

// Run if executed directly
if (import.meta.main || process.argv[1]?.endsWith("generate.ts")) {
  main();
}
