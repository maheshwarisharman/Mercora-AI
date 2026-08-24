import fs from "fs";
import path from "path";

export interface SupportTicket {
  ticket_ref: string;
  customer_email: string;
  created_date: string;
  subject: string;
  body: string;
  related_amount: number | null;
}

export interface RefundRecord {
  refund_ref: string;
  order_ref: string;
  amount: number;
  date: string;
  reason: string;
}

export const SUPPORT_TICKETS: SupportTicket[] = [
  {
    ticket_ref: "TICK-8842",
    customer_email: "siddharth.mehta71@proton.me",
    created_date: "2026-08-18",
    subject: "Package arrived with damaged outer box - manual compensation adjustment",
    body: "Customer Siddharth Mehta reported that Order #SHF-1038 arrived with dented outer packaging. Support supervisor approved an immediate ₹500 concession/manual goodwill adjustment, processed directly via payment gateway settlement deduction.",
    related_amount: 500.0
  },
  {
    ticket_ref: "TICK-1029",
    customer_email: "priya.sharma92@gmail.com",
    created_date: "2026-08-04",
    subject: "Inquiry about delivery estimate",
    body: "Customer inquired regarding expected delivery date for order #SHF-1004. Provided BlueDart tracking number and estimated delivery within 48 hours.",
    related_amount: null
  },
  {
    ticket_ref: "TICK-3391",
    customer_email: "rahul.gupta44@outlook.com",
    created_date: "2026-08-12",
    subject: "Discount coupon query on bulk order",
    body: "Customer requested a bulk purchase coupon code for artisanal roast beans. Provided seasonal promotional coupon for ₹150 off on next purchase.",
    related_amount: 150.0
  },
  {
    ticket_ref: "TICK-7201",
    customer_email: "ananya.patel55@yahoo.co.in",
    created_date: "2026-08-15",
    subject: "Address update request before shipment",
    body: "Customer requested change of apartment number on order #SHF-1030 prior to warehouse dispatch. Warehouse manifest successfully updated.",
    related_amount: null
  }
];

export const REFUND_RECORDS: RefundRecord[] = [
  {
    refund_ref: "RF-5502",
    order_ref: "#SHF-1038",
    amount: 500.0,
    date: "2026-08-19",
    reason: "Manual goodwill adjustment of ₹500 for Order #SHF-1038 damaged packaging as documented in support ticket TICK-8842."
  },
  {
    refund_ref: "RF-1092",
    order_ref: "#SHF-1009",
    amount: 2400.0,
    date: "2026-08-07",
    reason: "Standard customer return for unwanted secondary item."
  },
  {
    refund_ref: "RF-8821",
    order_ref: "#SHF-1015",
    amount: 899.0,
    date: "2026-08-10",
    reason: "Full cancellation before fulfillment."
  }
];

export function seedEvidenceFiles() {
  const outputDir = path.resolve(__dirname);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const ticketsPath = path.join(outputDir, "support_tickets.json");
  const refundsPath = path.join(outputDir, "refund_records.json");

  fs.writeFileSync(ticketsPath, JSON.stringify(SUPPORT_TICKETS, null, 2), "utf-8");
  fs.writeFileSync(refundsPath, JSON.stringify(REFUND_RECORDS, null, 2), "utf-8");

  console.log("✅ Synthetic evidence files seeded successfully:");
  console.log(` - ${ticketsPath} (${SUPPORT_TICKETS.length} tickets)`);
  console.log(` - ${refundsPath} (${REFUND_RECORDS.length} records)`);
}

if (import.meta.main || process.argv[1]?.endsWith("seed-evidence.ts")) {
  seedEvidenceFiles();
}
