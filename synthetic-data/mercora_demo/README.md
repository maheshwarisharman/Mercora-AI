# Mercora reconciliation demo

Upload the four CSVs in this order: orders, PG gateway settlements, COD remittances, then bank transactions. The files are intentionally linked by Shopify-style order IDs, Razorpay settlement IDs, COD batch references, and bank UTR/narration text.

The demo contains clean online chains, one aggregate Shipmozo COD payout, and the anomalies listed in manifest.json. Keep the filenames unchanged so the source classifier selects the intended adapters.
