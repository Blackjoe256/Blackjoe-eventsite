# Order Book & Matching Engine Design

Status: draft v1 · Builds on `docs/wallet-system-design.md` and the ledger in `src/ledger/`.
Many choices mirror Kalshi's public Trade API (see the teardown in the chat history).

## 1. Scope of v1

- **Binary markets.** Every contract pays **1 USDT** to the winning side (YES or NO) and 0 to the other.
- **Prices** are whole cents of USDT: **1–99 ticks**, 1 tick = 0.01 USDT. The price is the market's probability.
- **Quantities** are whole contracts (integers). Fractions can come later.
- **One order type:** "buy side S at limit price p, quantity q". Selling is buying the other side (§3).
- **Time in force:** `gtc` (rest on the book until filled or cancelled) or `ioc` (fill what you can now, cancel the rest). Optional `post_only` flag for market makers.
- **Fully collateralized.** Every open contract pair is backed by exactly 1 USDT in the market's escrow. No margin, no credit.
- **Not in v1:** scalar markets, voiding a market, combos/parlays, RFQ.

## 2. One book, bids only

A market has two queues of resting orders: **YES bids** and **NO bids**.

> A NO bid at price q is the same as a YES ask at (100 − q).

So the book never stores asks. A YES bid at p and a NO bid at q **cross** (can trade) when

```
p + q ≥ 100
```

Example book (ticks):

```
        YES bids            │            NO bids            (= YES asks)
  price  qty  (time order)  │  price  qty                   YES ask
    50    80  Dan           │    45   100  Bob                 55
                            │    42    50  Carol               58
best YES bid = 50 · best YES ask = 100 − 45 = 55 · spread = 5
```

After every command the book must be **uncrossed**: `best_yes_bid + best_no_bid < 100`.

### Execution price = the resting (maker) order's price

When a new order crosses the book, it trades at the resting order's price. The taker gets any
price improvement. For every fill:

```
yes_price + no_price = 100        (each side pays its own price; together exactly 1 USDT)
```

## 3. Selling = buying the other side, plus netting

A user holding 10 YES who wants out places **buy NO**. If it fills, they hold 10 YES and 10 NO.
One YES plus one NO always pays exactly 1 USDT, whatever the result. The engine **nets** them
right away: it removes the pair and pays the user 1 USDT per pair from escrow.

- **Net effect:** selling YES at price s means buying NO at 100 − s. The user pays (100 − s) and
  receives 100, so they net **s per contract**, which is the sale price. ✔
- **The rule:** after every fill, net each party's position: `pairs = min(yes_qty, no_qty)`.
  Redeem `pairs` contracts for 1 USDT each. So a position is always pure YES or pure NO.
- **Open interest** (OI) = number of live YES/NO pairs. A fill changes OI by:

| Taker | Maker | OI change | Escrow change |
|---|---|---|---|
| opening | opening | +q | +q USDT (both pay in) |
| closing | opening | 0 | 0 (the contract changes hands) |
| opening | closing | 0 | 0 |
| closing | closing | −q | −q USDT (both are paid out) |

You never have to code these four cases. "Pay your price, then net" produces all of them
automatically. The table is only for intuition and tests.

## 4. Matching algorithm (price–time priority)

```
match(order, book):
  opposite = book.bids[other(order.side)]          # NO bids for a YES order, and vice versa
  if order.post_only and opposite.best_price + order.price >= 100:
      reject(order, reason="would_take")          # post-only must never take liquidity
  remaining = order.qty
  for level in opposite.levels from highest price down:
      if level.price + order.price < 100: break    # no longer crosses
      for maker in level.queue (oldest first):     # FIFO = time priority
          if maker.user == order.user:              # self-trade prevention
              cancel(maker, reason="self_trade"); continue
          q = min(remaining, maker.remaining)
          emit Fill(taker=order, maker=maker, qty=q,
                    maker_price=level.price, taker_price=100 - level.price)
          remaining -= q; maker.remaining -= q
          if maker.remaining == 0: remove maker from queue
          if remaining == 0: return
  if remaining > 0:
      if order.tif == "gtc": rest order at order.price (end of its price level's queue)
      else: cancel remainder (reason="ioc")
```

- **Self-trade prevention:** cancel the *resting* order (cancel-maker). This stops users trading with
  themselves to fake volume, and is the simplest rule to explain.
- **Priority:** a better price always goes first; within a price, the earlier order goes first.
  Every accepted order gets a market-wide increasing `seq`, which defines "earlier".
- **Amending an order:** lowering the quantity keeps queue priority. Changing the price is a cancel plus a
  new order, and loses priority (same as Kalshi).
- **Bounded grid:** there are only 99 price levels, so a level is just `array[1..99]` of FIFO queues.
  No trees and no heaps. Finding the best price is a scan of at most 99 slots.

`match()` is a **pure function** (book + order in, fills + book changes out). It has no I/O, so it
can be tested exhaustively.

## 5. Collateral, fees and reservations

All amounts are USDT micros (1 USDT = 1,000,000), so 1 tick = 10,000 micros.

### Fee (quadratic, like Kalshi)

```
fee(q, p) = ceil( q × p × (100 − p) × rate_bps / 100 )      micros, p in ticks
```

- With `taker_fee_bps = 700` (7%): 100 contracts at 50 → `100 × 50 × 50 × 7` = 1,750,000 = **1.75 USDT**.
  100 contracts at 10 → 0.63 USDT.
- The fee is symmetric (fee at p equals fee at 100 − p), so it doesn't matter which side's price you use.
- **Taker** pays `taker_fee_bps`. **Maker** pays `maker_fee_bps` (default 0, to reward people who add liquidity).
- The fee is largest at p = 50: `max_fee_per_contract = 25 × rate_bps` micros (17,500 at 700 bps).

### Reserve the worst case when the order is placed, release the rest at each fill

When placing *buy side S, price p, qty q*:

1. **Closing part:** `closing = min(q, opposite_position − opposite_reserved)`. These contracts
   will net against what the user already holds. They need **no price collateral**, only the fee
   reserve. Mark them reserved (`opposite_reserved += closing`) so two sell orders can't sell the
   same contracts.
2. **Opening part:** `opening = q − closing`. This needs `p × 10,000` per contract.
3. **Lock** `opening × p × 10,000 + q × max_fee_per_contract` (taker rate). Move it from
   `user_available` to `user_locked` in one ledger posting. Reject with `insufficient_funds`
   if the balance is too low.

At each fill of q' contracts at the party's execution price x:
- **Consumed:** `q' × x × 10,000` for the opening part, plus the actual `fee(q', x)`.
- **Released immediately:** the reserve for those q' contracts minus what was consumed.
  This covers price improvement and fee left over from the worst-case reserve.

When an order is cancelled or finishes, release its remaining lock and position reservation.
**Invariant:** for each user, `Σ open_orders.locked_micros = user_locked balance`.

## 6. Ledger postings (built on `src/ledger`)

New account per market: `market_escrow` (owner = market id, USDT, cannot go negative).

| Event | Postings (USDT) |
|---|---|
| Order accepted | `user_available → user_locked`: reserve |
| Fill, per party | `user_locked → market_escrow`: price × q · `user_locked → fee_revenue`: fee · `user_locked → user_available`: released reserve |
| Netting after fill | `market_escrow → user_available`: 1 USDT × pairs |
| Cancel / IOC remainder | `user_locked → user_available`: remaining lock |
| Settlement | `market_escrow → user_available`: 1 USDT × winning contracts, per holder |

**One fill = one ledger transaction** covering both parties, idempotency key `fill:<fill_id>`.
The builder adds up the change for each account before posting, so each account appears once
(the ledger rejects an account appearing twice). For example, a closing party's escrow payment and
pair redemption combine into a single net credit to `user_available`.

**Market invariant:** `market_escrow balance = open_interest × 1 USDT`, and
`Σ YES positions = Σ NO positions = open_interest`.

## 7. Worked example (every number checked)

Market: *"Will the Uganda Cranes qualify for AFCON 2027?"* · taker 700 bps · maker 0 bps.
Book from §2: Dan YES 50 ×80 · Bob NO 45 ×100 · Carol NO 42 ×50 (everyone else is opening).

**Step 1. Alice: buy YES @ 60 × 120 (opening, gtc)**
- Reserve: `120 × (60 × 10,000 + 17,500)` = 74,100,000 → **74.10 USDT** locked.
- It crosses NO bids ≥ 40. Best is Bob's 45, so YES price = 55.
  - **Fill 1:** 100 @ YES 55 / NO 45 with Bob. Alice pays 55.00, Bob pays 45.00, escrow +100.
    Alice's fee = `100 × 55 × 45 × 7` = 1,732,500 (1.7325 USDT).
    Released: 61,750,000 − (55,000,000 + 1,732,500) = 5,017,500.
  - **Fill 2:** 20 @ YES 58 / NO 42 with Carol. Alice pays 11.60, Carol pays 8.40, escrow +20.
    Fee = `20 × 58 × 42 × 7` = 341,040. Released: 12,350,000 − 11,941,040 = 408,960.
- Alice is fully filled. Total released 5,426,460 → she paid **66.60 + 2.07354 fees**.
- Book now: Dan YES 50 ×80 · Carol NO 42 ×30. **OI = 120, escrow = 120 USDT** ✔

**Step 2. Alice sells 50 YES at 52 → buy NO @ 48 × 50**
- She holds 120 YES, so all 50 are closing. Reserve only the fee: `50 × 17,500` = 875,000.
- Does it cross YES bids ≥ 52? Dan is at 50 (48 + 50 = 98 < 100), so no. It **rests**.
- Book: YES bids Dan 50 · NO bids Alice 48 (YES ask 52), Carol 42 (YES ask 58).

**Step 3. Erin: buy YES @ 52 × 50 (opening)**
- Reserve `50 × (520,000 + 17,500)` = 26,875,000.
- Crosses Alice's NO 48 → **fill 50 @ YES 52 / NO 48**.
  - Erin pays 26.00 into escrow. Fee `50 × 52 × 48 × 7` = 873,600. Released 1,400.
  - Alice (maker, fee 0) "pays" 24.00. Then netting redeems 50 pairs for 50.00, so she
    **nets +26.00**, which is 52¢ per contract, her sale price ✔. Her 875,000 fee reserve is released.
  - Escrow: +26 + 24 − 50 = **0**. OI stays 120 (the contract changed hands) ✔
- Positions: Alice YES 70 · Erin YES 50 · Bob NO 100 · Carol NO 20 → YES 120 = NO 120 = OI ✔

**Step 4. Market resolves YES** (after the settlement timer)
- Escrow pays 1 USDT per YES: Alice 70.00, Erin 50.00 → **escrow 120 → 0** ✔
- Alice's result: −66.60 − 2.07354 + 26.00 + 70.00 = **+27.32646 USDT**.

## 8. Data model (PostgreSQL)

```sql
CREATE TABLE markets (
  id               UUID PRIMARY KEY,
  ticker           TEXT UNIQUE NOT NULL,          -- e.g. CRANES-AFCON27
  title            TEXT NOT NULL,
  rules            TEXT NOT NULL,                  -- exact resolution wording
  settlement_source TEXT NOT NULL,                 -- named data source
  status           TEXT NOT NULL,                  -- initialized|active|paused|closed|determined|disputed|finalized
  open_time        TIMESTAMPTZ NOT NULL,
  close_time       TIMESTAMPTZ NOT NULL,
  taker_fee_bps    INT NOT NULL DEFAULT 700,
  maker_fee_bps    INT NOT NULL DEFAULT 0,
  max_position     INT NOT NULL DEFAULT 100000,    -- per user, contracts
  result           TEXT CHECK (result IN ('yes','no')),
  settlement_timer_seconds INT NOT NULL DEFAULT 1800,
  determined_at    TIMESTAMPTZ,
  next_seq         BIGINT NOT NULL DEFAULT 1        -- per-market sequence for priority + feed
);

CREATE TABLE orders (
  id              UUID PRIMARY KEY,
  market_id       UUID NOT NULL REFERENCES markets(id),
  user_id         UUID NOT NULL,
  client_order_id TEXT NOT NULL,                   -- idempotency from the app
  side            TEXT NOT NULL CHECK (side IN ('yes','no')),
  price           SMALLINT NOT NULL CHECK (price BETWEEN 1 AND 99),
  qty             INT NOT NULL CHECK (qty > 0),
  filled_qty      INT NOT NULL DEFAULT 0 CHECK (filled_qty BETWEEN 0 AND qty),
  closing_qty     INT NOT NULL DEFAULT 0,          -- part reserved against the opposite position
  tif             TEXT NOT NULL CHECK (tif IN ('gtc','ioc')),
  post_only       BOOLEAN NOT NULL DEFAULT false,
  status          TEXT NOT NULL,                   -- open | filled | cancelled | rejected
  cancel_reason   TEXT,                            -- user | ioc | self_trade | market_paused | market_closed
  seq             BIGINT NOT NULL,                 -- time priority
  locked_micros   BIGINT NOT NULL DEFAULT 0,       -- remaining reserve in user_locked
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_order_id)
);
-- The matching query: best opposite price first, oldest first.
CREATE INDEX orders_book_idx ON orders (market_id, side, price DESC, seq) WHERE status = 'open';

CREATE TABLE fills (
  id             UUID PRIMARY KEY,
  market_id      UUID NOT NULL REFERENCES markets(id),
  seq            BIGINT NOT NULL,
  taker_order_id UUID NOT NULL REFERENCES orders(id),
  maker_order_id UUID NOT NULL REFERENCES orders(id),
  taker_side     TEXT NOT NULL,
  yes_price      SMALLINT NOT NULL CHECK (yes_price BETWEEN 1 AND 99),   -- no_price = 100 - yes_price
  qty            INT NOT NULL CHECK (qty > 0),
  taker_fee      BIGINT NOT NULL,
  maker_fee      BIGINT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE positions (
  user_id      UUID NOT NULL,
  market_id    UUID NOT NULL REFERENCES markets(id),
  yes_qty      INT NOT NULL DEFAULT 0 CHECK (yes_qty >= 0),
  no_qty       INT NOT NULL DEFAULT 0 CHECK (no_qty >= 0),
  yes_reserved INT NOT NULL DEFAULT 0,            -- held by resting closing (buy-NO) orders
  no_reserved  INT NOT NULL DEFAULT 0,
  cost_micros  BIGINT NOT NULL DEFAULT 0,          -- for average price / PnL display only
  PRIMARY KEY (user_id, market_id),
  CHECK (yes_qty = 0 OR no_qty = 0),              -- always netted
  CHECK (yes_reserved BETWEEN 0 AND yes_qty AND no_reserved BETWEEN 0 AND no_qty)
);

-- Transactional outbox: events become visible to the feed only after COMMIT.
CREATE TABLE market_events (
  market_id UUID NOT NULL, seq BIGINT NOT NULL, type TEXT NOT NULL, payload JSONB NOT NULL,
  published_at TIMESTAMPTZ, PRIMARY KEY (market_id, seq)
);
```

## 9. Engine architecture

### Phase 1 (recommended to start): database-native, one writer per market

Each command (`place`, `cancel`, `decrease`) is **one Postgres transaction**:

```
BEGIN
  SELECT pg_advisory_xact_lock(<market lock key>)          -- one writer per market, others queue
  check market is active; validate order; idempotency on (user_id, client_order_id)
  reserve collateral (ledger posting) + position reservation
  load crossing orders:  SELECT … FROM orders WHERE market_id=$1 AND side=$opp AND status='open'
                         AND price >= 100 - $p ORDER BY price DESC, seq LIMIT 200 FOR UPDATE
  fills = match(order, loadedLevels)                       -- the pure function from §4
  for each fill: insert fill, update both orders, update positions + netting, post ledger
  rest or cancel the remainder; write market_events rows (book deltas, trades)
COMMIT
-- after commit, an outbox worker publishes market_events to WebSocket clients in seq order
```

- **No in-memory state to lose or rebuild.** A crash mid-command rolls back cleanly.
- **Markets don't block each other.** Each has its own advisory lock. Postgres row locks plus the
  ledger's sorted `FOR UPDATE` keep shared user balances correct across markets.
- **Throughput:** comfortably tens to a few hundred orders/second per market. That's far more than
  a new app needs.
- **Prerequisite:** `Ledger.post()` currently opens its own transaction. Add
  `Ledger.postWithin(tx, input)` so fills, orders and ledger entries commit together.

### Phase 2 (only when one market needs more): in-memory engine

One process owns a group of markets (a "shard", like Kalshi's 4). It keeps each book as `array[1..99]`
of FIFO queues per side and processes commands one at a time from a log. Order of operations:
**compute the plan → persist atomically → apply in memory → publish**. Recovery = load open
orders by `(price, seq)`. The same `match()` function is reused, which is why it's pure.

### Idempotency keys

| Operation | Key |
|---|---|
| Place order | `(user_id, client_order_id)`, from the app, retried safely |
| Lock posting | `order:<id>:lock` |
| Fill posting | `fill:<fill_id>` |
| Release posting | `order:<id>:release` |
| Settlement posting | `settle:<market_id>:<user_id>` |

## 10. Market data feed

- `GET /markets/:ticker/orderbook` returns aggregated YES bids and NO bids plus `seq`. Asks are derived (100 − price).
- WebSocket `orderbook_delta {seq, side, price, delta_qty}` and `trade {seq, yes_price, qty, taker_side}`.
- **Client rule:** load the snapshot, then apply deltas with `seq > snapshot.seq`. If a seq is
  skipped, reload the snapshot. This is how every exchange keeps clients in sync.

## 11. Market lifecycle hooks

| Transition | Engine action |
|---|---|
| `initialized → active` | accept orders |
| `active → paused` | reject new orders; **cancel all resting orders** (stale after news) |
| `active → closed` (close_time) | reject all order operations; cancel resting orders |
| `closed → determined` | record result; start the settlement timer; disputes allowed |
| `determined → finalized` | pay 1 USDT per winning contract from escrow; escrow must end at exactly 0 |

## 12. Invariants (each becomes a test)

1. Every fill: `yes_price + no_price = 100`, and `1 ≤ yes_price ≤ 99`.
2. After every command the book is uncrossed: `best_yes_bid + best_no_bid < 100`.
3. Per market: `escrow = OI × 1 USDT` and `Σ YES positions = Σ NO positions = OI`.
4. Per user: `Σ open orders.locked_micros = user_locked`; reservations ≤ positions.
5. Positions are always netted (`yes_qty = 0 OR no_qty = 0`).
6. Price-time priority: no fill at a worse price while a better crossing price had quantity, and
   FIFO within a level.
7. A replayed command (same `client_order_id`) produces no new fills or postings.
8. After settlement: escrow = 0, and Σ payouts = OI × 1 USDT.

Test approach: hand-written cases (this doc's worked example, verbatim), then a **randomized
simulation**: thousands of random orders and cancels from several users, checking invariants 1–5
after each command.

## 13. Build order

1. `match()` pure function + priority/self-trade/post-only/IOC tests
2. Fee + reservation math module (integer only) + tests using §7's numbers
3. `Ledger.postWithin(tx)` + fill posting builder (net change per account)
4. Schema + `placeOrder` / `cancelOrder` commands (Phase 1 engine) + idempotency
5. Positions & netting; invariant checker; randomized simulation test
6. Lifecycle (pause/close/settle) + escrow-zero check
7. Order book REST + WebSocket feed via outbox
8. Market-maker bot account to seed liquidity on new markets
