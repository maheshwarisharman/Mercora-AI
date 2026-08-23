# Mercora — AI-Native Merchant OS

## Product Definition

**Core thesis:** Mercora is a merchant-wide operating layer where a shared Merchant Brain powers four specialized operating loops: Growth, Customer/CRM, Finance, and Website/Commerce.

The agents are not separate products. They are specialized workers operating on the same business context.

> **The merchant should not have to connect the dots. Mercora connects them, explains what it found, executes only within policy, and remembers what happened.**

---

# 1. What the Product Actually Is

Mercora sits above the merchant's existing commerce stack.

It does **not** try to replace Shopify, Razorpay, Meta, WhatsApp/support tools, marketplaces, or accounting software.

Instead, it makes those systems behave like one business.

The merchant interacts with **missions**, not individual agents.

Examples:

- **Recover lost revenue** — identify high-intent abandoned customers, personalize recovery, trigger the right action, and measure recovered orders.
- **Find a growth opportunity** — detect a product/category/creative/competitor signal, propose a test, and produce the assets needed to run it.
- **Close this week's books** — reconcile Shopify orders, Razorpay settlements, bank credits, marketplace payouts and invoices, then explain every unresolved mismatch.
- **Fix the customer problem** — resolve a support issue and turn the conversation into durable customer/product intelligence.
- **Increase AOV** — identify complementary products from purchase history and surface the right upsell/cross-sell.

The agents are implementation detail.

**The mission is the product primitive.**

---

# 2. Target Customer

### Primary ICP

Indian D2C/ecommerce brands that have enough operational complexity that founders or small teams are already stitching together:

- Shopify
- Razorpay
- Meta Ads
- WhatsApp/support
- Marketplaces
- Bank statements
- Accounting/spreadsheets
- Product/catalog systems

The strongest signal is **cross-functional complexity**, not revenue alone.

A smaller merchant with five disconnected systems can have more pain than a larger merchant with a mature ERP.

### Key personas

| Persona | Pain | Why they care |
|---|---|---|
| Founder / Operator | Too many dashboards; acts as the integration layer | Wants one view of where money is being lost and what to do next |
| Growth Marketer | Creative fatigue, unstable ad performance, competitor research, constant testing | Needs a faster creative-to-experiment loop |
| Support Lead | Customer history scattered across systems | Needs context instantly and wants repeated issues converted into product insight |
| Finance / Ops | Payouts are net, orders are gross, refunds/fees create gaps | Needs a reliable close with evidence |

---

# 3. Product Architecture

```text
                         MERCORA
                            │
                    ┌───────▼────────┐
                    │   API Layer    │
                    └───────┬────────┘
                            │
              ┌─────────────▼─────────────┐
              │    MISSION ORCHESTRATOR   │
              │                           │
              │ Planning / Routing        │
              │ Policies / Permissions   │
              │ Agent execution           │
              └──────┬─────────┬──────────┘
                     │         │
        ┌────────────┘         └──────────────┐
        ▼                                     ▼
┌───────────────┐                     ┌────────────────┐
│ Merchant Brain│                     │ Event / Queue  │
│               │                     │                │
│ Customers     │                     │ Redis          │
│ Products      │                     │ BullMQ         │
│ Orders        │                     └────────────────┘
│ Payments      │
│ Campaigns     │
│ Support       │
│ Finance       │
│ Agent memory  │
└───────┬───────┘
        │
        ├──────────────────────────────────────┐
        │                                      │
        ▼                                      ▼
┌────────────────────┐                ┌─────────────────────┐
│ Specialist Agents  │                │ Python Executor     │
│                    │                │                     │
│ Growth             │                │ Finance Agent       │
│ CRM                │                │ Pandas              │
│ Commerce           │                │ PDF parsing         │
│ Finance            │                │ Fuzzy matching      │
└─────────┬──────────┘                │ Sandboxed code      │
          │                           └─────────────────────┘
          ▼
 ┌─────────────────────┐
 │ External Connectors │
 │                     │
 │ Razorpay            │
 │ Shopify             │
 │ Meta                │
 │ WhatsApp            │
 │ Marketplaces        │
 │ Email               │
 └─────────────────────┘
```

### Non-negotiable design rules

1. Agents do not own business truth.
2. PostgreSQL owns canonical state.
3. Agents access external systems through tools.
4. Agents communicate through structured tasks/events, not uncontrolled agent-to-agent chat.
5. High-impact actions go through policy checks.
6. Every action produces an audit record.
7. Every meaningful action feeds its outcome back into Merchant Brain.

---

# 4. Merchant Brain

Merchant Brain is **not a chatbot**.

It is the shared business context graph and context compiler.

## Context captured

| Domain | Context |
|---|---|
| Merchant | Goals, policies, margins, brand voice, channels, approval rules |
| Customer | Identity, orders, LTV, complaints, preferences, consent |
| Product | SKU, price, margin, inventory, category, attributes |
| Orders | Items, discounts, shipping, status, refunds |
| Payments | Gateway, payment ID, amount, fees, settlements, refunds |
| Marketing | Campaigns, creatives, spend, CTR, CPC, CPA, ROAS |
| Support | Tickets, messages, issue type, sentiment, resolution |
| Finance | Payouts, bank credits, invoices, fees, adjustments |
| Website | Recommendations, placement, clicks, cart events |
| Agent actions | Agent, tool, reason, approval, result, outcome |

## Context compiler

Agents should never receive the entire merchant database.

Instead:

```text
Agent Request
     │
     ▼
Context Compiler
     │
     ├── Merchant context
     ├── Relevant customers
     ├── Relevant products
     ├── Orders
     ├── Payments
     ├── Campaigns
     ├── Support signals
     └── Finance signals
             │
             ▼
       Scoped Context
             │
             ▼
           Agent
```

Example:

```ts
contextCompiler.build({
  merchantId,
  objective: "find_growth_opportunities",
  entities: ["product:123"],
  timeRange: "30d"
});
```

The LLM interprets and reasons over the context.

**The LLM is not the database.**

---

# 5. Growth Agent

## Customer problem

Small D2C teams are trapped in an endless loop of:

- Meta performance volatility
- Creative fatigue
- Manual competitor research
- Constant UGC/content production
- Slow experimentation
- Disconnected product and marketing data

A generic AI marketer that answers questions is not enough.

Mercora should turn insight into an **experiment-ready action**.

## Capabilities

### 5.1 Performance Monitor

Ingest Meta campaign/ad-set/creative metrics.

Detect meaningful changes rather than alerting on every small fluctuation.

### 5.2 Opportunity Detector

Correlate:

- Product sales
- Product margins
- Inventory
- Customer segments
- Meta performance
- Support complaints
- Historical campaigns

Example:

> Product A has strong organic conversion and margin, but almost no creative coverage in paid acquisition.

That becomes an opportunity.

### 5.3 Competitor Intelligence

Track publicly available competitor signals where technically appropriate:

- Products
- Offers
- Positioning
- Landing pages
- Ad creative patterns
- Hooks
- Claims
- New launches

The system should summarize patterns rather than simply scrape raw pages.

### 5.4 Creative Agent

Turn opportunities into:

- Hooks
- UGC scripts
- Video concepts
- Static concepts
- Product angles
- Copy
- Creative briefs
- Variants

### 5.5 Experiment Planner

Create:

- Hypothesis
- Audience
- Creative variants
- Expected metric
- Success criteria
- Stop/scale conditions

### 5.6 Feedback Loop

When results arrive:

```text
Creative
   ↓
Experiment
   ↓
Performance
   ↓
Winning angle
   ↓
Merchant Brain
   ↓
Future creative generation
```

### Critical product gap

Generic AI creative generation is commoditizing.

Mercora's differentiation must be:

> **Creative intelligence grounded in the merchant's actual sales, product, customer and advertising data.**

---

# 6. Customer / CRM Agent

## Customer problem

Support teams waste time because answering a simple question often requires looking across:

- Customer history
- Orders
- Payments
- Products
- Shipping
- Previous conversations

The CRM Agent should therefore not just be "AI support."

Its actual job is:

> **Resolve. Remember. Feed the business.**

## Capabilities

### 6.1 Unified Ticket Context

Before replying, assemble:

```text
Customer
   +
Order
   +
Payment
   +
Product
   +
Previous conversations
   +
Policies
```

### 6.2 Resolution

The agent can:

- Draft responses
- Answer common questions
- Explain payment states
- Explain refund status
- Fetch order context
- Escalate uncertain cases

### 6.3 Issue Extraction

Convert conversations into structured data:

- Issue type
- Product feedback
- Feature request
- Defect
- Sentiment
- Purchase objection
- Refund reason

### 6.4 Knowledge Write-Back

Verified information is written into Merchant Brain.

Example:

```text
Product: XYZ Shoes
Issue: Size runs small
Evidence: 17 support conversations
Period: Last 14 days
Confidence: High
```

### 6.5 Cross-Agent Trigger

If complaints spike:

```text
CRM
 ↓
Complaint cluster
 ↓
Merchant Brain
 ↓
Website Agent
 ↓
Improve product explanation
 ↓
Growth Agent
 ↓
Create objection-handling creative
```

Support becomes a **real-time product research channel**.

---

# 7. Finance Agent

This should be one of Mercora's strongest technical differentiators.

## Customer problem

Ecommerce finance spans:

- Shopify gross orders
- Razorpay net settlements
- Bank credits
- Marketplace payouts
- Gateway fees
- Refunds
- Chargebacks
- Vendor invoices
- Manual adjustments
- Timing differences

Merchants end up doing manual spreadsheet reconciliation and investigating mismatches late.

Razorpay provides settlement IDs and reconciliation reporting, but the merchant's actual close still crosses multiple systems and often unstructured evidence.

## Finance Agent architecture

Do not build one reconciliation prompt.

Build a collaborative finance investigation pipeline.

```text
                 Finance Mission
                       │
          ┌────────────┴────────────┐
          ▼                         ▼
   Structured data           Unstructured data
   Shopify orders            PDF invoices
   Razorpay payouts          Bank statements
   Bank transactions         WhatsApp receipts
          │                         │
          │                  Vision / Parsing
          │                         │
          └──────────┬──────────────┘
                     ▼
                Normalization
                     │
                     ▼
              Code Interpreter
                     │
                ┌────┴────┐
                │         │
              Match    Exception
                │         │
                │         ▼
                │    Forensic Agent
                │         │
                │         ▼
                └───► Evidence
                          │
                          ▼
                Reconciliation Judge
                          │
                          ▼
                    Close Report
```

## 7.1 Vision / Parsing Agent

Input:

- Blurry PDF invoices
- Scanned invoices
- Bank statements
- WhatsApp vendor receipts
- Screenshots

Output:

Strict normalized JSON.

Example:

```json
{
  "vendor": "ABC Packaging",
  "invoice_number": "INV-992",
  "amount": 24500,
  "tax": 4410,
  "date": "2026-08-20",
  "currency": "INR"
}
```

## 7.2 Normalization Agent

Different sources use different schemas.

Convert everything into common financial events:

```text
ORDER
PAYMENT
PAYOUT
BANK_CREDIT
FEE
REFUND
INVOICE
ADJUSTMENT
CHARGEBACK
```

## 7.3 Code Interpreter Agent

Instead of hardcoding reconciliation joins, let the agent dynamically generate Python/pandas code.

Example:

```python
shopify = pd.read_csv("shopify.csv")
razorpay = pd.read_csv("razorpay.csv")
bank = pd.read_csv("bank.csv")

# fuzzy matching / amount / timestamp / IDs
matches = ...
```

The code runs in a sandbox.

### Critical rule

The Code Interpreter proposes matches.

It does **not** decide truth.

Every match needs:

- Source records
- Match criteria
- Confidence
- Difference
- Explanation

## 7.4 Forensic Investigator Agent

When matching fails:

```text
₹500 mismatch
      ↓
Search support emails
Search Slack
Search customer conversations
Search invoices
      ↓
Find:
"Manual ₹500 refund issued"
      ↓
Evidence
```

This is where the Finance Agent becomes genuinely intelligent.

## 7.5 Reconciliation Judge

Classify:

- Matched
- Matched with adjustment
- Timing difference
- Duplicate
- Missing
- Unexplained

## 7.6 Close Agent

Produces:

```text
47 records processed

42 automatically matched
3 timing differences
1 duplicate
1 unexplained

Unexplained exposure: ₹500

Likely cause:
Manual customer refund

Evidence:
Support conversation #2841
Order #44
Customer: XXXXX

Confidence: 96%
```

### Finance UX principle

**Exception-first.**

The merchant should not inspect 50 rows.

They should see:

> **47 records processed. 42 matched. 5 need attention.**

---

# 8. Website Agent

Do **not** build a generic website builder.

That is a separate product.

The Website Agent should focus on:

1. Autonomous merchandising
2. Personalized recommendations
3. Agentic commerce

## 8.1 Personalized Merchandising

Use:

- Previous purchases
- Current cart
- Customer lifecycle
- Product affinity
- Margin
- Inventory
- Campaign context

to recommend products.

Example:

> Customer bought running shoes three months ago → recommend socks + running insoles rather than generic "best sellers."

## 8.2 Dynamic Bundles

Generate merchant-approved bundles based on:

- Co-purchase patterns
- Margin
- Inventory
- Current campaigns
- Customer profile

## 8.3 On-Site Selling Agent

A lightweight conversational shopping interface can:

- Understand product requirements
- Compare products
- Recommend products
- Answer product questions
- Add products to cart

All using Merchant Brain.

## 8.4 Agentic Commerce

Expose a structured merchant commerce interface that another AI agent can consume.

For example:

```text
Search products
      ↓
Get product details
      ↓
Check availability
      ↓
Recommend
      ↓
Create cart
      ↓
Checkout
```

Do not attempt to recreate an entire universal commerce protocol in the hackathon.

Build a small interoperable **Merchant Commerce Agent / MCP-style interface**.

---

# 9. Core Interaction Model

The merchant interacts with **missions**, not agents.

| Merchant asks | Mercora does |
|---|---|
| "Why did sales fall?" | Merchant Brain compiles evidence; Growth diagnoses; CRM adds complaint trends; Finance checks settlement anomalies. |
| "Find growth opportunities." | Growth scans sales, product, Meta and competitor signals and creates ranked opportunities. |
| "Close yesterday." | Finance ingests data, reconciles, investigates exceptions and produces a close report. |
| "Why are customers complaining about X?" | CRM clusters tickets; Merchant Brain links complaints to product/order data; Website/Growth can act. |
| "Increase AOV." | Website identifies bundles/recommendations; Growth can create supporting campaigns. |

The agent graph remains mostly invisible.

The merchant sees the outcome.

---

# 10. Cross-Agent Workflows

## Workflow A — Lost Revenue Recovery

```text
Growth detects opportunity
        ↓
Merchant Brain gathers context
        ↓
CRM scores affected customers
        ↓
Website chooses offer/bundle
        ↓
Growth creates supporting creative
        ↓
Recovery action
        ↓
Conversion
        ↓
Merchant Brain records outcome
```

## Workflow B — Finance Investigation

```text
Files/data arrive
       ↓
Vision / Parsing
       ↓
Normalization
       ↓
Code Interpreter
       ↓
Matches + Exceptions
       ↓
Forensic Investigator
       ↓
Evidence
       ↓
Reconciliation Judge
       ↓
Close Report
```

## Workflow C — Customer Complaint → Revenue Action

```text
Support complaints spike
       ↓
CRM clusters issue
       ↓
Merchant Brain links product/order data
       ↓
Website improves product explanation
       ↓
Growth creates objection-handling creative
       ↓
Conversion/support metrics improve
```

These workflows make the platform feel like one product.

---

# 11. Actual Product UI

## Home

Business pulse:

- Revenue
- Cash settled
- Growth opportunities
- Customer issues
- Finance exceptions
- Active missions

The key section:

> **What needs attention?**

This makes Mercora proactive rather than a pull-based chatbot.

## Missions

Each mission shows:

- Objective
- Expected impact
- Current agent
- Current step
- Actions taken
- Evidence
- Outcome

## Growth

- Opportunities
- Meta performance
- Competitor intelligence
- Creative workspace
- Experiments

## Customers

- Unified customer profile
- Orders
- Payments
- Support history
- Feedback
- Next best action

## Finance

- Reconciliation status
- Match confidence
- Evidence
- Exceptions
- Monetary exposure
- Close summary

## Website

- Recommendations
- Bundles
- Conversion experiments
- Personalized merchandising
- Agentic-commerce status

## Context

Searchable Merchant Brain:

> "Show me everything known about Product X."

## Activity

Every:

- Agent action
- Tool call
- Policy decision
- Approval
- Result

---

# 12. Deliberate Non-Goals

Mercora should **not** become:

### A complete accounting ERP

Finance reconciles and explains.

It does not replace Tally, Zoho Books or QuickBooks.

### A full ad manager

Growth plans, creates and analyzes experiments.

Meta remains the execution system where appropriate.

### A complete helpdesk replacement

CRM handles automation and context while existing channels remain channels.

### A website builder

Website Agent optimizes commerce behavior.

It does not build arbitrary websites.

### A generic autonomous employee

Every action has:

- Scope
- Evidence
- Permission
- Policy

### A universal checkout protocol

Mercora exposes a small interoperable commerce interface rather than rebuilding UCP.

### A memory dump

Only verified, attributable facts become durable business context.

---

# 13. Exact Buildathon MVP

## P0 — Merchant Brain

Build:

- Shopify catalog/orders
- Razorpay payment/settlement data
- Synthetic support events
- Synthetic marketing events
- Finance records
- Normalized event model
- Searchable context

## P0 — Growth

Build:

- Meta-style metrics ingestion
- Opportunity detection
- Competitor snapshot input
- Creative generation
- Experiment object

## P0 — CRM

Build:

- Unified customer/ticket view
- AI response drafting
- Issue classification
- Feedback extraction
- Context write-back

## P0 — Finance

Build:

- 50+ messy synthetic records
- PDF/image parsing
- Schema normalization
- Sandbox pandas matching
- Forensic search
- Exception report

## P0 — Website

Build:

- Personalized recommendation engine
- Simple storefront widget
- Merchant configuration
- Agent-accessible product/offer endpoint

## P0 — Orchestration

Build:

- Mission engine
- Agent routing
- Agent task state
- Tool execution
- Action audit
- Outcome recording

## P1

Do later:

- Real WhatsApp sends
- Full marketplace integrations
- Robust A/B testing
- Production accounting exports
- Large-scale external connectors

---

# 14. Product Success Criteria

| Area | Metric |
|---|---|
| Growth | Time from opportunity detection to experiment-ready plan/creative |
| CRM | Resolution time and percentage of tickets resolved with complete context |
| Finance | Automatic match rate and percentage of exceptions explained with evidence |
| Website | AOV lift, recommendation acceptance and conversion |
| Platform | Cross-agent missions completed without human orchestration |
| Reliability | Agent action success rate and human override rate |

---

# 15. Final Product Shape

Mercora is:

> **An AI operating layer for D2C merchants, with four operational loops sharing one business brain.**

The architecture is:

```text
                     MERCORA
                        │
                ┌───────▼────────┐
                │ Merchant Brain │
                └───────┬────────┘
                        │
                 Mission Engine
                        │
          ┌─────────────┼─────────────┐
          ▼             ▼             ▼
       Growth          CRM         Finance
          │             │             │
          └─────────────┼─────────────┘
                        ▼
                    Commerce
                        │
                        ▼
                     ACTION
                        │
                        ▼
                    OUTCOME
                        │
                        └──────► Merchant Brain
```

The key product principle is:

> **The merchant should not have to connect the dots.**

Customer complaints can influence Growth creatives.

Finance anomalies can influence CRM responses.

Customer history can influence Website recommendations.

Successful campaigns can influence merchandising.

Website behavior can influence Growth.

Everything flows back into Merchant Brain.

The agents are not the product.

**The connected business operating loop is the product.**
