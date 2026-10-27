import { describe, expect, it } from "vitest";
import {
  type Fill,
  type IncomingOrder,
  type MatchResult,
  OrderBook,
  type RestingOrder,
  type Side,
  match,
} from "../src/engine/index.js";

let seq = 0n;
function order(p: Partial<IncomingOrder> & Pick<IncomingOrder, "id" | "side" | "price" | "qty">): IncomingOrder {
  seq += 1n;
  return { userId: p.id, tif: "gtc", postOnly: false, seq, ...p };
}

function accepted(result: MatchResult) {
  if (result.status !== "accepted") throw new Error(`expected accepted, got rejected: ${result.reason}`);
  return result;
}

const fillSummary = (fills: Fill[]) => fills.map((f) => `${f.makerOrderId} ${f.qty}@yes${f.yesPrice}`);

/** The book from docs/matching-engine-design.md §2. */
function exampleBook() {
  const book = new OrderBook();
  book.submit(order({ id: "dan", side: "yes", price: 50, qty: 80 }));
  book.submit(order({ id: "bob", side: "no", price: 45, qty: 100 }));
  book.submit(order({ id: "carol", side: "no", price: 42, qty: 50 }));
  return book;
}

describe("worked example (design doc §7)", () => {
  it("starts uncrossed with YES bid 50 / ask 55", () => {
    const book = exampleBook();
    expect(book.bestBid("yes")).toBe(50);
    expect(book.bestAsk("yes")).toBe(55);
    expect(book.isCrossed()).toBe(false);
  });

  it("step 1: Alice buys YES @60 ×120 and fills at the makers' prices, best first", () => {
    const book = exampleBook();
    const r = accepted(book.submit(order({ id: "alice-buy", userId: "alice", side: "yes", price: 60, qty: 120 })));
    expect(fillSummary(r.fills)).toEqual(["bob 100@yes55", "carol 20@yes58"]);
    expect(r.fills.map((f) => [f.takerPrice, f.makerPrice])).toEqual([[55, 45], [58, 42]]);
    expect(r).toMatchObject({ filledQty: 120, remainingQty: 0, outcome: "filled" });
    expect(book.depth("yes")).toEqual([{ price: 50, qty: 80 }]);
    expect(book.depth("no")).toEqual([{ price: 42, qty: 30 }]);
  });

  it("steps 2–3: Alice's sell rests at NO 48, then Erin lifts it at YES 52", () => {
    const book = exampleBook();
    book.submit(order({ id: "alice-buy", userId: "alice", side: "yes", price: 60, qty: 120 }));

    const sell = accepted(book.submit(order({ id: "alice-sell", userId: "alice", side: "no", price: 48, qty: 50 })));
    expect(sell).toMatchObject({ fills: [], outcome: "rested" }); // 48 + Dan's 50 = 98 < 100
    expect(book.bestAsk("yes")).toBe(52);

    const erin = accepted(book.submit(order({ id: "erin", side: "yes", price: 52, qty: 50 })));
    expect(fillSummary(erin.fills)).toEqual(["alice-sell 50@yes52"]);
    expect(erin.fills[0]).toMatchObject({ takerPrice: 52, makerPrice: 48, makerUserId: "alice" });
    expect(book.get("alice-sell")).toBeUndefined();
    expect(book.isCrossed()).toBe(false);
  });
});

describe("crossing rule", () => {
  it("trades exactly at p + q = 100 but not at 99", () => {
    const resting: RestingOrder[] = [{ id: "m", userId: "m", side: "no", price: 40, remaining: 5, seq: 1n }];
    expect(accepted(match(order({ id: "a", side: "yes", price: 60, qty: 1 }), resting)).fills).toHaveLength(1);
    expect(accepted(match(order({ id: "b", side: "yes", price: 59, qty: 1 }), resting)).fills).toHaveLength(0);
  });

  it("gives the taker price improvement: executes at the maker's price", () => {
    const book = new OrderBook();
    book.submit(order({ id: "m", side: "yes", price: 30, qty: 10 }));
    const r = accepted(book.submit(order({ id: "t", side: "no", price: 90, qty: 10 })));
    expect(r.fills[0]).toMatchObject({ makerPrice: 30, takerPrice: 70, yesPrice: 30 });
  });

  it("ignores resting orders on the same side or that do not cross", () => {
    const resting: RestingOrder[] = [
      { id: "same", userId: "x", side: "yes", price: 99, remaining: 5, seq: 1n },
      { id: "far", userId: "y", side: "no", price: 10, remaining: 5, seq: 2n },
    ];
    const r = accepted(match(order({ id: "t", side: "yes", price: 50, qty: 3 }), resting));
    expect(r.fills).toEqual([]);
    expect(r.outcome).toBe("rested");
  });
});

describe("price-time priority", () => {
  it("fills better prices before worse ones regardless of arrival", () => {
    const book = new OrderBook();
    book.submit(order({ id: "worse-early", side: "no", price: 40, qty: 5 }));
    book.submit(order({ id: "better-late", side: "no", price: 45, qty: 5 }));
    const r = accepted(book.submit(order({ id: "t", side: "yes", price: 60, qty: 7 })));
    expect(fillSummary(r.fills)).toEqual(["better-late 5@yes55", "worse-early 2@yes60"]);
  });

  it("is FIFO within a price level", () => {
    const book = new OrderBook();
    for (const id of ["first", "second", "third"]) book.submit(order({ id, side: "no", price: 45, qty: 4 }));
    const r = accepted(book.submit(order({ id: "t", side: "yes", price: 55, qty: 6 })));
    expect(fillSummary(r.fills)).toEqual(["first 4@yes55", "second 2@yes55"]);
  });

  it("match() sorts by seq itself: input order does not matter", () => {
    const resting: RestingOrder[] = [
      { id: "late", userId: "x", side: "no", price: 45, remaining: 5, seq: 30n },
      { id: "early", userId: "y", side: "no", price: 45, remaining: 5, seq: 10n },
      { id: "middle", userId: "z", side: "no", price: 45, remaining: 5, seq: 20n },
    ];
    const r = accepted(match(order({ id: "t", side: "yes", price: 55, qty: 7 }), resting));
    expect(fillSummary(r.fills)).toEqual(["early 5@yes55", "middle 2@yes55"]);
  });

  it("a partially filled maker keeps its place at the front", () => {
    const book = new OrderBook();
    book.submit(order({ id: "first", side: "no", price: 45, qty: 10 }));
    book.submit(order({ id: "second", side: "no", price: 45, qty: 10 }));
    book.submit(order({ id: "t1", side: "yes", price: 55, qty: 3 }));
    const r = accepted(book.submit(order({ id: "t2", side: "yes", price: 55, qty: 9 })));
    expect(fillSummary(r.fills)).toEqual(["first 7@yes55", "second 2@yes55"]);
  });

  it("decrease keeps priority; cancel removes", () => {
    const book = new OrderBook();
    book.submit(order({ id: "first", side: "no", price: 45, qty: 10 }));
    book.submit(order({ id: "second", side: "no", price: 45, qty: 10 }));
    book.decrease("first", 2);
    expect(fillSummary(accepted(book.submit(order({ id: "t", side: "yes", price: 55, qty: 3 }))).fills)).toEqual([
      "first 2@yes55",
      "second 1@yes55",
    ]);
    expect(book.cancel("second")).toBe(true);
    expect(book.cancel("second")).toBe(false);
    expect(book.depth("no")).toEqual([]);
    expect(() => book.decrease("missing", 1)).toThrow();
  });
});

describe("time in force and post-only", () => {
  it("IOC fills what it can and drops the rest", () => {
    const book = new OrderBook();
    book.submit(order({ id: "m", side: "no", price: 45, qty: 3 }));
    const r = accepted(book.submit(order({ id: "t", side: "yes", price: 60, qty: 10, tif: "ioc" })));
    expect(r).toMatchObject({ filledQty: 3, remainingQty: 7, outcome: "ioc_cancelled" });
    expect(book.depth("yes")).toEqual([]);
  });

  it("post-only rejects if it would trade, rests otherwise", () => {
    const book = new OrderBook();
    book.submit(order({ id: "m", side: "no", price: 45, qty: 3 }));
    expect(book.submit(order({ id: "p1", side: "yes", price: 55, qty: 1, postOnly: true }))).toEqual({
      status: "rejected",
      reason: "would_take",
    });
    expect(accepted(book.submit(order({ id: "p2", side: "yes", price: 54, qty: 1, postOnly: true }))).outcome).toBe(
      "rested",
    );
    expect(book.depth("no")).toEqual([{ price: 45, qty: 3 }]); // untouched
  });
});

describe("self-trade prevention", () => {
  it("cancels the user's own resting order and keeps matching others", () => {
    const book = new OrderBook();
    book.submit(order({ id: "mine", userId: "u1", side: "no", price: 45, qty: 5 }));
    book.submit(order({ id: "theirs", userId: "u2", side: "no", price: 45, qty: 5 }));
    const r = accepted(book.submit(order({ id: "t", userId: "u1", side: "yes", price: 55, qty: 5 })));
    expect(r.selfTradeCancels).toEqual(["mine"]);
    expect(fillSummary(r.fills)).toEqual(["theirs 5@yes55"]);
    expect(book.get("mine")).toBeUndefined();
  });
});

describe("validation and purity", () => {
  it("rejects bad prices, quantities and sides", () => {
    for (const price of [0, 100, 50.5, -1, Number.NaN]) {
      expect(match(order({ id: "x", side: "yes", price, qty: 1 }), [])).toEqual({ status: "rejected", reason: "invalid_price" });
    }
    for (const qty of [0, -3, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(match(order({ id: "x", side: "yes", price: 50, qty }), [])).toEqual({ status: "rejected", reason: "invalid_qty" });
    }
    expect(match(order({ id: "x", side: "maybe" as Side, price: 50, qty: 1 }), [])).toEqual({
      status: "rejected",
      reason: "invalid_side",
    });
  });

  it("does not mutate its inputs", () => {
    const resting: RestingOrder[] = [
      { id: "b", userId: "b", side: "no", price: 42, remaining: 5, seq: 2n },
      { id: "a", userId: "a", side: "no", price: 45, remaining: 5, seq: 1n },
    ];
    const snapshot = structuredClone(resting);
    Object.freeze(resting);
    resting.forEach((r) => Object.freeze(r));
    const incoming = Object.freeze(order({ id: "t", side: "yes", price: 60, qty: 7 }));
    accepted(match(incoming, resting));
    expect(resting).toEqual(snapshot);
  });

  it("refuses to submit an order id twice", () => {
    const book = new OrderBook();
    book.submit(order({ id: "dup", side: "yes", price: 10, qty: 1 }));
    expect(() => book.submit(order({ id: "dup", side: "yes", price: 10, qty: 1 }))).toThrow();
  });
});

// A deliberately naive matcher: repeatedly pick the single best crossing order from a flat list.
// Too simple to be wrong, so the real engine must agree with it fill for fill.
class ReferenceBook {
  resting: RestingOrder[] = [];
  submit(o: IncomingOrder): { fills: string[]; rested: boolean } {
    const fills: string[] = [];
    let remaining = o.qty;
    while (remaining > 0) {
      const candidates = this.resting.filter((r) => r.side !== o.side && r.price + o.price >= 100);
      if (candidates.length === 0) break;
      const best = candidates.reduce((a, b) => (b.price > a.price || (b.price === a.price && b.seq < a.seq) ? b : a));
      if (best.userId === o.userId) {
        this.resting = this.resting.filter((r) => r !== best);
        continue;
      }
      const q = Math.min(remaining, best.remaining);
      fills.push(`${best.id} ${q}@${100 - best.price}`);
      best.remaining -= q;
      remaining -= q;
      if (best.remaining === 0) this.resting = this.resting.filter((r) => r !== best);
    }
    const rested = remaining > 0 && o.tif === "gtc";
    if (rested) this.resting.push({ id: o.id, userId: o.userId, side: o.side, price: o.price, remaining, seq: o.seq });
    return { fills, rested };
  }
}

describe("randomized: agrees with the reference matcher and keeps invariants", () => {
  it("over 3,000 random orders and cancels", () => {
    // mulberry32: tiny seeded PRNG with good bit quality. (A plain LCG with `state % n`
    // has badly periodic low bits; rand(2) would just alternate.)
    let state = 7;
    const rand = (n: number) => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 2 ** 32) * n);
    };
    const book = new OrderBook();
    const reference = new ReferenceBook();
    const live: string[] = [];
    const coverage = { multiMakerFills: 0, sameLevelFills: 0, selfTrades: 0, maxDepth: 0 };

    for (let i = 0; i < 3_000; i++) {
      if (live.length > 0 && rand(10) === 0) {
        const id = live.splice(rand(live.length), 1)[0]!; // may already be filled; cancel is then a no-op
        book.cancel(id);
        reference.resting = reference.resting.filter((r) => r.id !== id);
        continue;
      }
      const o = order({
        id: `o${i}`,
        userId: `u${rand(5)}`,
        side: rand(2) === 0 ? "yes" : "no",
        // Mostly passive orders just below fair value (builds depth), sometimes an
        // aggressive one that sweeps several levels.
        price: rand(4) === 0 ? 50 + rand(20) : 49 - rand(10),
        qty: 1 + rand(20),
        tif: rand(4) === 0 ? "ioc" : "gtc",
      });
      // The pure function must give the same answer on shuffled input (as a DB query might return).
      const shuffled = book.orders().sort(() => rand(3) - 1);
      const pure = accepted(match(o, shuffled));
      const r = accepted(book.submit(o));
      expect(pure.fills).toEqual(r.fills);
      const expected = reference.submit(o);

      expect(r.fills.map((f) => `${f.makerOrderId} ${f.qty}@${f.takerPrice}`)).toEqual(expected.fills);
      expect(r.outcome === "rested").toBe(expected.rested);

      // Invariants after every command.
      for (const f of r.fills) {
        expect(f.makerPrice + f.takerPrice).toBe(100);
        expect(f.takerPrice).toBeLessThanOrEqual(o.price); // never worse than the limit
        expect(f.makerUserId).not.toBe(f.takerUserId);
      }
      for (let k = 1; k < r.fills.length; k++) {
        expect(r.fills[k]!.makerPrice).toBeLessThanOrEqual(r.fills[k - 1]!.makerPrice); // best price first
      }
      expect(r.filledQty + r.remainingQty).toBe(o.qty);
      expect(r.fills.reduce((s, f) => s + f.qty, 0)).toBe(r.filledQty);
      expect(book.isCrossed()).toBe(false);
      if (r.outcome === "rested") live.push(o.id);

      if (r.fills.length > 1) coverage.multiMakerFills++;
      if (r.fills.some((f, k) => k > 0 && f.makerPrice === r.fills[k - 1]!.makerPrice)) coverage.sameLevelFills++;
      coverage.selfTrades += r.selfTradeCancels.length;
      coverage.maxDepth = Math.max(coverage.maxDepth, book.orders().length);
    }

    // Guard against a weak generator: the run must actually exercise the hard paths.
    expect(coverage.multiMakerFills).toBeGreaterThan(200);
    expect(coverage.sameLevelFills).toBeGreaterThan(50);
    expect(coverage.selfTrades).toBeGreaterThan(20);
    expect(coverage.maxDepth).toBeGreaterThan(50);

    const normalise = (orders: RestingOrder[]) =>
      orders.map((o) => `${o.id}:${o.remaining}`).sort();
    expect(normalise(book.orders())).toEqual(normalise(reference.resting));
  });
});
