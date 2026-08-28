# Mercora reconciliation demo

Upload the five source files in this order: orders, PG gateway settlements, Amazon Flat File V2 settlement, COD remittances, then bank transactions. The files are intentionally linked by Shopify-style order IDs, Razorpay settlement IDs, Amazon merchant-order IDs / settlement IDs, COD batch references, and bank UTR/narration text.

The demo contains clean online chains, one Amazon batch with line-level fees and TCS/TDS, an unfamiliar Amazon fee code, a delayed return clawback, one aggregate Shipmozo COD payout, and the anomalies listed in manifest.json. Keep the filenames unchanged so the source classifier selects the intended adapters.
