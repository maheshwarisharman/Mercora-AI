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
  settlement_id: string;
  order_date: string;
  payment_date: string;
  settlement_date: string;
  bank_date: string;
  gross_amount: number;
  fee_amount: number;
  tax_on_fee: number;
  net_amount: number;
  order_status: "paid" | "refunded" | "partially_refunded";
  payment_status: "captured" | "refunded";
  refund_amount: number | null;
  bank_reference_number: string | null;
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

    // Bank Date: same as settlement date or +1 day
    const bankDateObj = new Date(settlementDateObj.getTime() + (random() > 0.7 ? 1 : 0) * 24 * 60 * 60 * 1000);
    const bankDateStr = bankDateObj.toISOString().split("T")[0];

    // Amount generation (e.g. INR 499 to INR 14999)
    const grossAmount = Math.round(randomBetween(499, 14999) * 100) / 100;

    // Fee calculation: ~2% gateway fee + 18% GST on fee
    const feeAmount = Math.round(grossAmount * 0.02 * 100) / 100;
    const taxOnFee = Math.round(feeAmount * 0.18 * 100) / 100;
    const netAmount = Math.round((grossAmount - feeAmount - taxOnFee) * 100) / 100;

    // Payment IDs
    const paymentId = `pay_${randomAlphaNumeric(14)}`;
    const settlementId = `setl_${randomAlphaNumeric(14)}`;

    // Status: mostly paid, ~8% partially_refunded, ~5% refunded
    let orderStatus: "paid" | "refunded" | "partially_refunded" = "paid";
    let paymentStatus: "captured" | "refunded" = "captured";
    let refundAmount: number | null = null;

    if (i % 15 === 0) {
      orderStatus = "refunded";
      paymentStatus = "refunded";
      refundAmount = grossAmount;
    } else if (i % 9 === 0) {
      orderStatus = "partially_refunded";
      refundAmount = Math.round((grossAmount * 0.5) * 100) / 100;
    }

    // Bank Reference: blank on ~30% rows intentionally as per spec
    const hasBankRef = random() > 0.3;
    const bankRefNumber = hasBankRef ? `CMS${randomInt(10000000, 99999999)}` : null;

    // Alternate order reference between order_id and order_number to test both matches
    const orderRefUsed = i % 2 === 0 ? orderId : orderNumber;

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
    razorpayRows.push([
      paymentId,
      orderRefUsed,
      paymentDateStr,
      grossAmount.toFixed(2),
      feeAmount.toFixed(2),
      taxOnFee.toFixed(2),
      netAmount.toFixed(2),
      settlementId,
      settlementDateStr,
      paymentStatus
    ]);

    // 3. Bank Row (Credits the net settlement amount)
    bankRows.push([
      bankDateStr,
      `NEFT RAZORPAY SETL ${settlementId}`,
      netAmount.toFixed(2),
      "", // debit_amount
      bankRefNumber || ""
    ]);

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
      settlement_date: settlementDateStr,
      bank_date: bankDateStr,
      gross_amount: grossAmount,
      fee_amount: feeAmount,
      tax_on_fee: taxOnFee,
      net_amount: netAmount,
      order_status: orderStatus,
      payment_status: paymentStatus,
      refund_amount: refundAmount,
      bank_reference_number: bankRefNumber,
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

  console.log("Generating 40 synthetic linked order chains...");
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
  console.log(` - razorpay_transactions.csv (40 transactions)`);
  console.log(` - bank_statement.csv (40 settlements)`);
  console.log(` - ground_truth.json (40 linked chains)`);
}

// Run if executed directly
if (import.meta.main || process.argv[1]?.endsWith("generate.ts")) {
  main();
}
