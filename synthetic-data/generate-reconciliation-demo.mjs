import fs from "node:fs/promises";
import path from "node:path";
import { Workbook } from "@oai/artifact-tool";

const outputDir = path.resolve("synthetic-data/mercora_demo");
const round2 = (value) => Math.round(value * 100) / 100;
const iso = (date) => date.toISOString().slice(0, 10);
const addDays = (date, days) => new Date(date.getTime() + days * 86_400_000);
const csvCell = (value) => {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
};
const toCsv = (headers, rows) => [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";

const names = [
  ["Aarav Mehta", "aarav.mehta@example.com"],
  ["Diya Nair", "diya.nair@example.com"],
  ["Kabir Shah", "kabir.shah@example.com"],
  ["Meera Iyer", "meera.iyer@example.com"],
  ["Rohan Kapoor", "rohan.kapoor@example.com"],
  ["Ananya Rao", "ananya.rao@example.com"],
  ["Vikram Joshi", "vikram.joshi@example.com"],
  ["Kavya Menon", "kavya.menon@example.com"],
  ["Nikhil Bhat", "nikhil.bhat@example.com"],
  ["Pooja Sethi", "pooja.sethi@example.com"],
  ["Rahul Desai", "rahul.desai@example.com"],
  ["Sneha Pillai", "sneha.pillai@example.com"],
  ["Aditya Verma", "aditya.verma@example.com"],
  ["Ishita Malhotra", "ishita.malhotra@example.com"],
  ["Varun Patel", "varun.patel@example.com"],
  ["Tara Singh", "tara.singh@example.com"],
  ["Arjun Khanna", "arjun.khanna@example.com"],
  ["Neha Kulkarni", "neha.kulkarni@example.com"],
  ["Siddharth Jain", "siddharth.jain@example.com"],
  ["Riya Thomas", "riya.thomas@example.com"],
  ["Manish Gupta", "manish.gupta@example.com"],
  ["Aditi Bose", "aditi.bose@example.com"],
  ["Kunal Reddy", "kunal.reddy@example.com"],
  ["Priya Chawla", "priya.chawla@example.com"],
];
const amounts = [1299, 2499, 1799, 3299, 2199, 1499, 2799, 3899, 999, 4599, 1899, 2699, 1599, 4999, 2299, 1199, 2999, 3499, 1399, 4199, 1699, 2399, 3199, 1299];
const baseDate = new Date("2026-08-01T00:00:00Z");
const onlineCount = 16;
const orderHeaders = ["order_id", "order_number", "customer_name", "customer_email", "order_date", "total_amount", "currency", "status", "refund_amount"];
const pgHeaders = ["payment_id", "order_ref", "payment_date", "gross_amount", "fee_amount", "tax_on_fee", "net_amount", "settlement_id", "settlement_date", "status"];
const codHeaders = ["ref order id", "order id", "order Date", "product name", "courier", "awb number", "invoice amount", "cod_amount", "delivered date", "delivered time", "batch_ref", "status"];
const bankHeaders = ["transaction_date", "value_date", "description", "reference_no", "debit_inr", "credit_inr", "balance_inr"];

const orders = [];
const pg = [];
const cod = [];
const bankCredits = [];
const groundTruth = [];

for (let i = 0; i < amounts.length; i += 1) {
  const n = i + 1;
  const orderId = `#MRC-${24000 + n}`;
  const orderNumber = `MRC-${24000 + n}`;
  const orderDate = addDays(baseDate, Math.floor(i / 2));
  const gross = amounts[i];
  const paymentMethod = n <= onlineCount ? "prepaid" : "cod";
  const status = n === 6 ? "partially_refunded" : "paid";
  const refundAmount = n === 6 ? 199 : "";
  const [customerName, customerEmail] = names[i];

  orders.push([orderId, orderNumber, customerName, customerEmail, iso(orderDate), gross.toFixed(2), "INR", status, refundAmount === "" ? "" : refundAmount.toFixed(2)]);

  if (paymentMethod === "prepaid") {
    const paymentDate = addDays(orderDate, n % 4 === 0 ? 1 : 0);
    const fee = round2(gross * 0.02);
    const tax = round2(fee * 0.18);
    const net = round2(gross - fee - tax);
    const paymentId = `pay_mrc_${String(n).padStart(3, "0")}`;
    const settlementId = `setl_mrc_${String(n).padStart(3, "0")}`;
    const isMissingSettlement = n === 9;
    const settlementDate = addDays(paymentDate, 2);
    const pgRow = [paymentId, orderId, iso(paymentDate), gross.toFixed(2), fee.toFixed(2), tax.toFixed(2), isMissingSettlement ? "" : net.toFixed(2), isMissingSettlement ? "" : settlementId, isMissingSettlement ? "" : iso(settlementDate), "captured"];
    pg.push(pgRow);
    if (n === 7) {
      // Duplicate only the payment export row. Leaving the settlement fields
      // blank keeps the duplicate anomaly isolated to the payment leg so the
      // real settlement chain remains deterministically matchable.
      const duplicatePaymentRow = [...pgRow];
      duplicatePaymentRow[6] = "";
      duplicatePaymentRow[7] = "";
      duplicatePaymentRow[8] = "";
      pg.push(duplicatePaymentRow);
    }

    const isMissingBank = n === 13;
    if (!isMissingSettlement && !isMissingBank) {
      const bankDate = addDays(settlementDate, n === 5 ? 8 : 1);
      const bankAmount = n === 15 ? round2(net - 10) : net;
      bankCredits.push({
        date: bankDate,
        description: `NEFT RAZORPAY SETTLEMENT ${settlementId}`,
        reference: `UTR-RZP-${String(n).padStart(3, "0")}`,
        credit: bankAmount,
        anomaly: n === 5 ? "timing_difference" : n === 15 ? "unexplained_difference" : null,
      });
    }

    groundTruth.push({
      order_id: orderId,
      payment_id: paymentId,
      channel: "PG",
      gross_amount: gross,
      fee_amount: fee,
      tax_on_fee: tax,
      expected_net: net,
      anomaly: isMissingSettlement ? "missing_settlement" : n === 13 ? "missing_bank_credit" : n === 5 ? "timing_difference" : n === 15 ? "unexplained_difference" : n === 7 ? "duplicate_payment_export" : null,
      note: isMissingSettlement ? "Payment exists but settlement leg is intentionally blank." : n === 13 ? "Settlement exists but no matching bank credit is intentionally present." : n === 5 ? "Bank credit is 8 days after settlement; expected timing window is 1-5 days." : n === 15 ? "Bank credit is ₹10 below the settlement net amount." : n === 7 ? "The same payment row is intentionally exported twice.": "Clean online settlement chain.",
    });
  } else {
    const deliveredDate = addDays(orderDate, 3 + (n % 3));
    cod.push([orderId, `SHM-${800000 + n}`, iso(orderDate), `Demo Product ${String.fromCharCode(64 + ((n - onlineCount - 1) % 8) + 1)}`, "Shipmozo", `AWB-MRC-${900000 + n}`, gross.toFixed(2), gross.toFixed(2), iso(deliveredDate), "11:20", "COD-BATCH-MRC-0823", "Delivered"]);
    groundTruth.push({
      order_id: orderId,
      channel: "COD",
      cod_amount: gross,
      batch_ref: "COD-BATCH-MRC-0823",
      anomaly: null,
      note: "Clean COD remittance row; eight rows aggregate into one courier bank credit.",
    });
  }
}

const codTotal = cod.reduce((sum, row) => sum + Number(row[7]), 0);
const latestCodDelivery = new Date(Math.max(...cod.map((row) => new Date(row[8] + "T00:00:00Z").getTime())));
bankCredits.push({
  date: addDays(latestCodDelivery, 7),
  description: "NEFT SHIPMOZO COD REMITTANCE COD-BATCH-MRC-0823",
  reference: "UTR-COD-MRC-0823",
  credit: codTotal,
  anomaly: null,
});
bankCredits.push({
  date: new Date("2026-12-01T00:00:00Z"),
  description: "UPI CUSTOMER REFUND REVERSAL - NON-SETTLEMENT CREDIT",
  reference: "UTR-UNRELATED-01",
  credit: 750,
  anomaly: "unmatched_bank_credit",
});

bankCredits.sort((a, b) => a.date - b.date);
const debits = [
  { date: new Date("2026-08-06T00:00:00Z"), description: "IMPS SUPPLIER PAYMENT - PACKAGING", reference: "DBT-MRC-001", debit: 18500 },
  { date: new Date("2026-08-18T00:00:00Z"), description: "UPI OFFICE EXPENSE", reference: "DBT-MRC-002", debit: 4200 },
];
const ledger = [...bankCredits.map((entry) => ({ ...entry, debit: 0 })), ...debits].sort((a, b) => a.date - b.date || a.reference.localeCompare(b.reference));
let balance = 500000;
const bankRows = ledger.map((entry) => {
  balance = round2(balance + (entry.credit || 0) - (entry.debit || 0));
  return [iso(entry.date), iso(entry.date), entry.description, entry.reference, entry.debit ? entry.debit.toFixed(2) : "", entry.credit ? entry.credit.toFixed(2) : "", balance.toFixed(2)];
});

const files = {
  "orders.csv": toCsv(orderHeaders, orders),
  "pg_gateway_settlements.csv": toCsv(pgHeaders, pg),
  "cod_remittances.csv": toCsv(codHeaders, cod),
  "bank_transactions.csv": toCsv(bankHeaders, bankRows),
};
const manifest = {
  name: "Mercora reconciliation demo",
  generated_at: "2026-08-28T00:00:00Z",
  upload_order: ["orders.csv", "pg_gateway_settlements.csv", "cod_remittances.csv", "bank_transactions.csv"],
  counts: { orders: orders.length, pg_rows: pg.length, cod_rows: cod.length, bank_rows: bankRows.length, bank_credits: bankCredits.length },
  totals: { order_value: round2(amounts.reduce((sum, amount) => sum + amount, 0)), cod_remittance: round2(codTotal), pg_gross: round2(groundTruth.filter((item) => item.channel === "PG").reduce((sum, item) => sum + item.gross_amount, 0)) },
  expected_demo_result: { clean_pg_chains: 14, clean_cod_aggregate_chains: 1, intentional_open_exceptions: ["duplicate", "timing_difference", "missing_settlement", "missing_bank_credit", "unexplained_difference", "ambiguous_bank_credit"] },
  anomaly_legend: {
    duplicate_payment_export: "PG row 7 is duplicated exactly.",
    timing_difference: "PG order MRC-24005 has a bank credit eight days after settlement.",
    missing_settlement: "PG order MRC-24009 has a captured payment but no settlement_id/net_amount.",
    missing_bank_credit: "PG order MRC-24013 has a settlement but no bank credit.",
    unexplained_difference: "PG order MRC-24015 bank credit is ₹10 below expected net.",
    unmatched_bank_credit: "₹750 bank credit has no source settlement and should remain an exception.",
  },
};

await fs.mkdir(outputDir, { recursive: true });
for (const [filename, content] of Object.entries(files)) {
  await fs.writeFile(path.join(outputDir, filename), content, "utf8");
  // Parse every deliverable through the spreadsheet runtime so quoting and
  // row/column shape are validated using the supported CSV reader.
  const workbook = await Workbook.fromCSV(content, { sheetName: filename.replace(".csv", "") });
  const check = await workbook.inspect({ kind: "table", tableMaxRows: 2, tableMaxCols: 12, maxChars: 1200 });
  if (!check?.ndjson) throw new Error(`Could not inspect generated ${filename}`);
}
await fs.writeFile(path.join(outputDir, "ground_truth.json"), JSON.stringify(groundTruth, null, 2) + "\n", "utf8");
await fs.writeFile(path.join(outputDir, "README.md"), `# Mercora reconciliation demo\n\nUpload the four CSVs in this order: orders, PG gateway settlements, COD remittances, then bank transactions. The files are intentionally linked by Shopify-style order IDs, Razorpay settlement IDs, COD batch references, and bank UTR/narration text.\n\nThe demo contains clean online chains, one aggregate Shipmozo COD payout, and the anomalies listed in manifest.json. Keep the filenames unchanged so the source classifier selects the intended adapters.\n`, "utf8");
await fs.writeFile(path.join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

console.log(JSON.stringify({ outputDir, files: Object.keys(files), counts: manifest.counts, totals: manifest.totals }, null, 2));
