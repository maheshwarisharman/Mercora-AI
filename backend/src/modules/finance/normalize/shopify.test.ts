import { describe, expect, test } from "bun:test";
import { ShopifyAdapter } from "../normalize/adapters/shopify.adapter";
import {
  looksLikeShopifyOrderHeaders,
  mapShopifyOrder,
  normalizeShopifyOrderRow,
} from "./shopify";

describe("Shopify normalization", () => {
  const nativeShopifyRow = {
    Name: "#HBM27393",
    Email: "customer@example.com",
    "Financial Status": "pending",
    Currency: "INR",
    Total: "4,140.00",
    "Created at": "2026-07-20 23:17:13 +0530",
    "Refunded Amount": "0.00",
    "Billing Name": "Shivani Chouguley",
    "Lineitem quantity": "15",
    "Lineitem name": "1 Pound Baseboard Round",
  };

  test("resolves native Shopify headers without relying on column order", () => {
    expect(normalizeShopifyOrderRow(nativeShopifyRow)).toMatchObject({
      orderId: "#HBM27393",
      orderNumber: "#HBM27393",
      customerEmail: "customer@example.com",
      customerName: "Shivani Chouguley",
      totalAmount: 4140,
      refundAmount: 0,
      orderDate: "2026-07-20",
      status: "pending",
      currency: "INR",
    });

    const events = mapShopifyOrder(nativeShopifyRow, "merchant", "mission", "record");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: "SALE",
      external_ref: "#HBM27393",
      amount: 4140,
      event_date: "2026-07-20",
      counterparty: "Shivani Chouguley",
    });
  });

  test("also supports canonical keys and refund amounts", () => {
    const events = mapShopifyOrder(
      {
        order_id: "order-1",
        order_number: "1001",
        customer_email: "buyer@example.com",
        customer_name: "Buyer",
        total_amount: "1,200.50",
        refund_amount: "200.50",
        order_date: "2026/08/01",
        status: "partially_refunded",
        currency: "usd",
      },
      "merchant",
      "mission",
      "record"
    );

    expect(events.map((event) => [event.event_type, event.amount])).toEqual([
      ["SALE", 1200.5],
      ["REFUND", 200.5],
    ]);
    expect(events[0].currency).toBe("USD");
    expect(events[1].external_ref).toBe("order-1-refund");
  });

  test("recognizes native Shopify headers even when the filename is unhelpful", () => {
    expect(
      looksLikeShopifyOrderHeaders([
        "Name",
        "Email",
        "Financial Status",
        "Currency",
        "Total",
        "Created at",
        "Lineitem quantity",
      ])
    ).toBe(true);
  });

  test("collapses line-item rows into one order event", async () => {
    let upsertCount = 0;
    const supabase = {
      schema: () => ({
        from: () => ({
          upsert: () => ({
            select: () => ({
              single: async () => ({
                data: { id: `entity-${++upsertCount}` },
                error: null,
              }),
            }),
          }),
        }),
      }),
    } as any;

    const events = await new ShopifyAdapter().normalize(
      [
        { id: "summary", raw_json: nativeShopifyRow } as any,
        {
          id: "line-item",
          raw_json: {
            Name: "#HBM27393",
            "Lineitem quantity": "2",
            "Lineitem name": "Another item",
            "Lineitem price": "50.00",
          },
        } as any,
      ],
      { missionId: "mission", merchantId: "merchant", supabase }
    );

    expect(events).toHaveLength(1);
    expect(events[0].amount).toBe(4140);
    expect(events[0].metadata?.source_record_ids).toEqual(["summary", "line-item"]);
  });
});
