# Wallet System Design — Mobile Money (MTN / Airtel UG) ⇄ USDT

Status: draft v1 · Scope: deposits and withdrawals for the prediction market app

## 1. Goal

- **Deposit:** a customer pays UGX from MTN MoMo or Airtel Money. Their in-app
  wallet is credited with the equivalent **USDT**.
- **Withdraw:** the customer picks a USDT amount, chooses MTN or Airtel, and
  enters a phone number. The USDT is converted to UGX and sent to that number.
- **Trade:** USDT balances fund prediction-market positions. Positions are
  locked while a market is open and paid out when it resolves.

## 2. The key design decision: where does the USDT actually live?

| Option | How it works | Verdict |
|---|---|---|
| A. On-chain wallet per user | Every deposit buys real USDT and sends it to a per-user blockchain address | ❌ Gas fee on every deposit, key management for thousands of users, slow, and UGX amounts are tiny |
| **B. Ledger-denominated USDT (recommended)** | User balances are **USDT entries in your own database ledger**. The company holds a real USDT **treasury reserve** (exchange/OTC/custodian) sized to cover the total of all user balances, and rebalances in batches | ✅ Instant, cheap, simple. This is how Binance, Yellow Card and most exchanges hold customer balances |
| C. Pure UGX | Keep balances in UGX and just display a USD estimate | ✅ Simplest, but users carry UGX inflation/FX risk and you lose the "dollar wallet" pitch |

**This design uses Option B.** The customer never touches a blockchain. "USDT"
is the unit of account in your ledger, backed 1:1 by a real reserve that you
reconcile every day.

## 3. Architecture

```
 ┌───────────── Mobile / Web app ─────────────┐
 │  Deposit screen   Withdraw screen   Markets │
 └──────┬──────────────────┬──────────────┬────┘
        │ HTTPS (JWT)      │              │
 ┌──────▼──────────────────▼──────────────▼─────────────────────────────┐
 │                         API service                                   │
 │  ┌────────────┐  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐ │
 │  │ Deposit    │  │ Withdrawal  │  │ Quote / FX   │  │ Market       │ │
 │  │ service    │  │ service     │  │ engine       │  │ engine       │ │
 │  └─────┬──────┘  └──────┬──────┘  └──────┬───────┘  └──────┬───────┘ │
 │        └────────────────┴───────┬────────┴─────────────────┘         │
 │                         ┌───────▼────────┐                            │
 │                         │ LEDGER (double │  ← single source of truth  │
 │                         │ entry, Postgres)│                           │
 │                         └───────┬────────┘                            │
 │  ┌──────────────┐  ┌───────────┴──────┐  ┌──────────────────────┐    │
 │  │ Webhook      │  │ Job queue        │  │ Risk / limits / KYC  │    │
 │  │ receiver     │  │ (retries, recon) │  │                      │    │
 │  └──────▲───────┘  └────────┬─────────┘  └──────────────────────┘    │
 └─────────┼───────────────────┼────────────────────────────────────────┘
           │ callbacks         │ API calls
 ┌─────────┴───────────────────▼─────────┐      ┌──────────────────────────┐
 │ MarzPay (aggregator)                  │      │ Treasury (ops, batched)  │
 │  /collect-money  /send-money          │      │  UGX float ⇄ USDT via     │
 │  /phone-verification  /balance        │      │  OTC desk / Yellow Card / │
 └───────┬────────────────────┬──────────┘      │  exchange; custody wallet│
         │                    │                 └──────────────────────────┘
   MTN MoMo UG           Airtel Money UG
```

**Why use an aggregator (MarzPay) instead of connecting to MTN and Airtel
directly?** You get one integration instead of two. The network is detected
automatically from the phone number. Sandbox, phone/KYC lookup and webhooks
come built in. MTN's MoMo API and Airtel's Open API are both possible later,
when volume makes the lower fees worth the extra work. Put a
`PaymentProvider` interface in front of MarzPay so you can switch providers
without rewriting the wallet.

## 4. Money rules (never break these)

1. **Integers only.** UGX is stored as whole shillings (`BIGINT`). USDT is
   stored in **micro-units** (`BIGINT`, 1 USDT = 1,000,000). Never use floats.
2. **Double-entry ledger.** Every movement is a transaction with ≥2 entries
   whose sum per currency is **zero**. Balances are derived from entries and
   never edited directly.
3. **Idempotency everywhere.** Every external call has a unique `reference`
   (UUID v4). Every webhook is handled at most once.
4. **Reserve before you pay out.** Funds are held *before* calling
   `/send-money`. They are released only when the payout is confirmed failed.
5. **"Unknown" is not "failed".** If a provider call times out, the
   transaction stays `pending` until the provider confirms a final status.
6. **Never trust the client.** Amounts, rates and phone numbers are validated
   on the server, and rates come from a server-side quote.

## 5. Data model (PostgreSQL)

```sql
-- Who
CREATE TABLE users (
  id            UUID PRIMARY KEY,
  phone_e164    TEXT UNIQUE NOT NULL,          -- +2567XXXXXXXX
  full_name     TEXT,
  kyc_level     SMALLINT NOT NULL DEFAULT 0,   -- 0 none, 1 phone-verified, 2 ID-verified
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ledger accounts: user wallets AND company accounts
CREATE TABLE accounts (
  id        UUID PRIMARY KEY,
  owner_id  UUID REFERENCES users(id),         -- NULL for system accounts
  kind      TEXT NOT NULL,   -- user_available | user_locked | market_escrow |
                             -- provider_clearing_ugx | treasury_usdt | fx_pool |
                             -- fee_revenue | withdrawal_pending
  currency  TEXT NOT NULL CHECK (currency IN ('UGX','USDT')),
  UNIQUE (owner_id, kind, currency)
);

CREATE TABLE ledger_transactions (
  id          UUID PRIMARY KEY,
  type        TEXT NOT NULL,   -- deposit | withdrawal | withdrawal_reversal | bet_lock | payout | fee
  external_ref TEXT UNIQUE,    -- idempotency key (deposit/withdrawal id)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id             BIGSERIAL PRIMARY KEY,
  transaction_id UUID NOT NULL REFERENCES ledger_transactions(id),
  account_id     UUID NOT NULL REFERENCES accounts(id),
  amount         BIGINT NOT NULL,              -- +credit / -debit, minor units
  currency       TEXT NOT NULL
);
-- Invariant (enforced in code + nightly check): per transaction & currency, SUM(amount) = 0

-- Cached balance for fast reads, updated in the SAME db transaction as entries
CREATE TABLE account_balances (
  account_id UUID PRIMARY KEY REFERENCES accounts(id),
  balance    BIGINT NOT NULL DEFAULT 0,
  version    BIGINT NOT NULL DEFAULT 0
);

-- FX quotes (locked rate for ~60s)
CREATE TABLE quotes (
  id           UUID PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users(id),
  side         TEXT NOT NULL CHECK (side IN ('buy_usdt','sell_usdt')),
  ugx_amount   BIGINT NOT NULL,
  usdt_micros  BIGINT NOT NULL,
  rate_ugx_per_usdt NUMERIC(18,6) NOT NULL,     -- customer rate incl. spread (for display/audit)
  mid_rate     NUMERIC(18,6) NOT NULL,
  fee_ugx      BIGINT NOT NULL DEFAULT 0,
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ
);

CREATE TABLE deposits (
  id              UUID PRIMARY KEY,             -- also sent to MarzPay as `reference`
  user_id         UUID NOT NULL REFERENCES users(id),
  quote_id        UUID REFERENCES quotes(id),
  network         TEXT NOT NULL CHECK (network IN ('MTN','AIRTEL')),
  phone_e164      TEXT NOT NULL,
  ugx_amount      BIGINT NOT NULL,
  usdt_micros     BIGINT,                       -- set when credited
  status          TEXT NOT NULL,                -- initiated | pending | completed | failed | expired
  provider_txn_id TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

CREATE TABLE withdrawals (
  id              UUID PRIMARY KEY,             -- MarzPay `reference`
  user_id         UUID NOT NULL REFERENCES users(id),
  quote_id        UUID NOT NULL REFERENCES quotes(id),
  network         TEXT NOT NULL CHECK (network IN ('MTN','AIRTEL')),
  phone_e164      TEXT NOT NULL,
  usdt_micros     BIGINT NOT NULL,
  ugx_amount      BIGINT NOT NULL,              -- what the recipient gets
  status          TEXT NOT NULL,                -- requested | held | review | sending | completed | failed | reversed
  provider_txn_id TEXT,
  failure_reason  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payout_numbers (                   -- verified withdrawal destinations
  user_id      UUID REFERENCES users(id),
  phone_e164   TEXT NOT NULL,
  network      TEXT NOT NULL,
  registered_name TEXT,                         -- from phone verification
  verified_at  TIMESTAMPTZ,
  usable_after TIMESTAMPTZ NOT NULL,            -- cooldown for newly-added numbers
  PRIMARY KEY (user_id, phone_e164)
);

CREATE TABLE webhook_events (                   -- raw inbox, dedupe
  id          BIGSERIAL PRIMARY KEY,
  provider    TEXT NOT NULL,
  reference   TEXT NOT NULL,
  final_status TEXT NOT NULL,
  payload     JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  UNIQUE (provider, reference, final_status)
);
```

User accounts must never go below 0. System accounts such as clearing and FX
may go negative. Enforce this in the posting function, which locks the
balance rows with `SELECT … FOR UPDATE` before writing entries.

## 6. FX / quote engine

```
mid_rate      = live USDT/UGX price (e.g. from your OTC desk / exchange API, cached 30s)
buy_rate      = mid_rate × (1 + spread)     ← customer buys USDT (deposit)
sell_rate     = mid_rate × (1 − spread)     ← customer sells USDT (withdrawal)
```

Worked example (illustrative numbers, mid = 3,700 UGX/USDT, spread = 1.5%):

| | Deposit 50,000 UGX | Withdraw 10 USDT |
|---|---|---|
| Customer rate | 3,755.5 UGX per USDT | 3,644.5 UGX per USDT |
| Result | 50,000 / 3,755.5 = **13.313806 USDT** (round **down**) | 10 × 3,644.5 = 36,445 → **36,445 UGX** (round **down**) minus payout fee |
| Your margin | spread ≈ 739 UGX | spread ≈ 555 UGX |

- Always round **in the platform's favour** (floor) so rounding never creates
  money out of nothing.
- A quote is **locked for 60s** and used **once** (`used_at`). Deposits are
  credited at the quote's rate if the webhook arrives before
  `expires_at + grace`. Otherwise they are re-priced at the current rate (state
  this in the terms).
- Add circuit breakers: refuse new quotes if the price feed is stale (>2 min)
  or moved >3% in 5 minutes.
- Price in the provider's fees (MarzPay collection and payout charges) either
  inside the spread or as a visible `fee_ugx`.

## 7. Deposit flow (mobile money → USDT)

```
User            App/API                 MarzPay            MTN/Airtel          Ledger
 │ enter 50,000   │                        │                    │                 │
 │──────────────▶ │ POST /quotes (buy)     │                    │                 │
 │ ◀── 13.31 USDT │                        │                    │                 │
 │ confirm + phone│                        │                    │                 │
 │──────────────▶ │ create deposit(id=UUID, status=initiated)   │                 │
 │                │ POST /collect-money {amount, phone, reference=id, callback}   │
 │                │──────────────────────▶ │ push USSD prompt ─▶│                 │
 │ ◀─ "Approve on your phone (enter PIN)"  │                    │                 │
 │ enters PIN on handset ────────────────────────────────────▶ │                 │
 │                │ ◀── webhook collection.completed ───────── │                 │
 │                │ dedupe → verify via GET /collect-money/{uuid}                 │
 │                │ post ledger txn (one DB transaction) ────────────────────────▶│
 │ ◀─ push notif "13.31 USDT added"         │                    │                 │
```

Deposit ledger transaction (`type=deposit`, `external_ref=deposit.id`):

| Account | UGX | USDT |
|---|---|---|
| provider_clearing_ugx (money now sitting at MarzPay) | +50,000 | |
| fx_pool | −50,000 | +… |
| fx_pool | | −13,313,806 |
| user_available (customer) | | +13,313,806 |

Each currency nets to zero. `fx_pool` collects your UGX↔USDT position, and
Treasury flattens it later (section 10).

**Failure handling:** if the user doesn't approve (`collection.failed` or
`cancelled`), or nothing arrives within ~10 min, mark the deposit
`failed`/`expired` and post no ledger entries. A late "completed" webhook
on an expired deposit is still credited (the money really moved), at the
current rate.

## 8. Withdrawal flow (USDT → mobile money)

```
User             API                       Ledger                MarzPay
 │ 10 USDT, MTN,   │                          │                     │
 │ +256772…        │                          │                     │
 │───────────────▶ │ validate phone, limits, payout_numbers cooldown │
 │                 │ POST /quotes (sell) → 36,445 UGX                │
 │ confirm (+PIN/OTP)                         │                     │
 │───────────────▶ │ DB txn: create withdrawal(status=held)         │
 │                 │   move 10 USDT user_available → withdrawal_pending ▶
 │                 │ risk check ── flagged? → status=review (manual) │
 │                 │ enqueue job "send"                             │
 │                 │ job: GET /balance (UGX float ok?)              │
 │                 │ POST /send-money {amount: 36445, phone, reference=withdrawal.id}
 │                 │──────────────────────────────────────────────▶ │
 │                 │ ◀── webhook success / failure ─────────────── │
 │                 │ completed → finalize ledger │ failed → reverse (refund user)
 │ ◀─ "36,445 UGX sent to 0772…"              │                     │
```

Step 1, hold (`type=withdrawal_hold`):

| Account | USDT |
|---|---|
| user_available | −10,000,000 |
| withdrawal_pending | +10,000,000 |

Step 2a, completed (`type=withdrawal`):

| Account | UGX | USDT |
|---|---|---|
| withdrawal_pending | | −10,000,000 |
| fx_pool | | +10,000,000 |
| fx_pool | +36,445 + fee | |
| provider_clearing_ugx | −36,445 − fee | |

Step 2b, failed (`type=withdrawal_reversal`): the reverse of step 1, so the
user gets the 10 USDT back.

**Timeouts:** if `/send-money` times out or returns a 5xx, *do not* reverse.
Leave the withdrawal in `sending` and poll `GET /send-money/{reference}` with
backoff. Reverse only on a confirmed `failed`. Because the `reference` is
reused, a retry can never pay out twice: MarzPay answers
`DUPLICATE_REFERENCE`.

## 9. Phone numbers (Uganda)

```js
// Normalise anything the user types → +256XXXXXXXXX
function normaliseUgPhone(input) {
  let d = input.replace(/\D/g, '');
  if (d.startsWith('256')) d = d.slice(3);
  else if (d.startsWith('0')) d = d.slice(1);
  if (!/^7\d{8}$/.test(d)) throw new Error('Enter a valid Ugandan mobile number');
  return '+256' + d;
}

// Network hint for the UI. MarzPay auto-detects anyway; confirm prefixes with your provider.
const PREFIXES = { MTN: ['76', '77', '78', '79'], AIRTEL: ['70', '74', '75'] };
function detectNetwork(e164) {
  const p = e164.slice(4, 6);
  return Object.keys(PREFIXES).find(n => PREFIXES[n].includes(p)) ?? null;
}
```

- If the network the user picked doesn't match the detected one, show
  "This looks like an Airtel number — switch?" before submitting.
- Call **`POST /phone-verification/verify`** to get the registered name, and
  show "Send to JOHN DOE?" as a confirmation step. This prevents typo payouts.
- **Payout number policy (anti-fraud):** the first payout number is the one
  the user deposited from (already proven theirs). A *new* number is name-matched
  against KYC and gets a 24-hour cooldown (`usable_after`) before first use.
  This blocks the common attack where a stolen account is drained to the
  attacker's phone.

## 10. Treasury & reconciliation (the part most teams forget)

Your **liabilities** are the sum of all user USDT balances. Your **assets**
are UGX at MarzPay plus USDT in your reserve. Every day:

1. **Exposure:** `fx_pool` shows net USDT sold minus bought. When customers
   deposit more than they withdraw, you are "short USDT": buy USDT with the
   extra UGX (OTC desk / Yellow Card / exchange) and move it to the
   custody wallet. When withdrawals exceed deposits, sell USDT for UGX and top
   up the MarzPay float.
2. **Float alert:** if MarzPay UGX balance < next 24h expected payouts × 1.5,
   page the ops team. Withdrawals queue (stay `held`) rather than fail.
3. **Three-way reconciliation:** (a) your ledger vs (b) MarzPay
   `GET /transactions` vs (c) custody wallet balance. Every deposit/withdrawal
   must match on `reference`, amount and status. Investigate any break the
   same day.
4. **Proof of solvency check:** `treasury_usdt + (marzpay_ugx / mid_rate) ≥
   Σ user balances`. Alert if it ever fails.

## 11. Prediction-market integration

- Placing a bet moves USDT `user_available → user_locked` (and on match into
  `market_escrow`). Withdrawals can only use `user_available`.
- On resolution, the market engine posts one transaction that moves escrow
  to winners' `user_available`, with your fee to `fee_revenue`.
- **Deposit hold for trading vs withdrawing:** allow trading immediately
  after a deposit, but consider a short withdrawal hold on fresh deposits to
  stop deposit→withdraw abuse (cycling money, chargeback-style disputes with
  the telco).

## 12. Security & risk controls

- Webhook endpoint: HTTPS only, verify HMAC signature if enabled, **and always
  re-fetch status from the API** before crediting (a forged webhook must never
  mint money). Return 200 fast and process from a queue.
- MarzPay keys only in server env/secret manager. Payout calls only from
  whitelisted server IPs.
- Limits by KYC level, e.g. level 1: ≤ 500k UGX/day withdraw; level 2:
  ≤ 5M UGX/day. Velocity rules (e.g. >3 new payout numbers/week → review).
- Withdrawal confirmation needs re-authentication (PIN/OTP).
- Append-only audit log for all admin actions (manual review, reversals).

## 13. Compliance checklist (Uganda) — confirm with a local lawyer

- Prediction markets are likely regulated as **betting/gaming** by the
  National Lotteries and Gaming Regulatory Board.
- Holding customer balances can fall under the **National Payment Systems
  Act 2020** (Bank of Uganda). Partnering with licensed providers reduces
  this but may not remove it.
- Using crypto (USDT) adds **virtual-asset** obligations: AML/CFT under the
  Financial Intelligence Authority, and KYC and record keeping. Bank of
  Uganda does not treat crypto as legal tender.
- Data protection: Uganda Data Protection and Privacy Act 2019 (phone
  numbers and names are personal data).

## 14. Suggested stack & build order

Node.js (TypeScript) + Fastify/NestJS · PostgreSQL · Redis/BullMQ for jobs ·
Next.js or React Native front end.

1. Ledger module + tests (invariants: sums to zero, no negative user balance)
2. Quote engine with a stub price feed
3. MarzPay client behind a `PaymentProvider` interface (sandbox mode)
4. Deposit flow + webhook inbox + status poller
5. Withdrawal flow with holds, reversal, payout-number verification
6. Reconciliation job + float alerts + admin review screen
7. Market engine hooks (lock/escrow/payout)
8. Go live: whitelist IPs, enable API disbursement, small limits first
