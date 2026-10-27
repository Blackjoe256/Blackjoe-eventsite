import {
  type IncomingOrder,
  MAX_PRICE,
  MIN_PRICE,
  type MatchResult,
  PAYOUT,
  type RestingOrder,
  type Side,
  crosses,
  match,
  opposite,
} from "./match.js";

// In-memory book for one market: per side, an array of 99 FIFO queues indexed by price.
// The price grid is tiny and fixed, so no tree or heap is needed.
// Used by tests and by the future in-memory engine (design doc §9, Phase 2).

export interface PriceLevel {
  price: number;
  qty: number;
}

export class OrderBook {
  private readonly levels: Record<Side, RestingOrder[][]> = {
    yes: Array.from({ length: MAX_PRICE + 1 }, () => []),
    no: Array.from({ length: MAX_PRICE + 1 }, () => []),
  };
  private readonly byId = new Map<string, RestingOrder>();

  /** Match an incoming order and apply the result to the book. */
  submit(order: IncomingOrder): MatchResult {
    if (this.byId.has(order.id)) throw new Error(`order ${order.id} is already on the book`);
    const result = match(order, this.crossingOrders(order.side, order.price));
    if (result.status === "rejected") return result;

    for (const id of result.selfTradeCancels) this.cancel(id);
    for (const update of result.makerUpdates) {
      if (update.remaining === 0) this.cancel(update.orderId);
      else this.byId.get(update.orderId)!.remaining = update.remaining; // keeps queue position
    }
    if (result.outcome === "rested") {
      this.rest({ id: order.id, userId: order.userId, side: order.side, price: order.price, remaining: result.remainingQty, seq: order.seq });
    }
    return result;
  }

  /** Remove a resting order. Returns false if it was not on the book. */
  cancel(orderId: string): boolean {
    const order = this.byId.get(orderId);
    if (!order) return false;
    const queue = this.levels[order.side][order.price]!;
    queue.splice(queue.indexOf(order), 1);
    this.byId.delete(orderId);
    return true;
  }

  /** Lower an order's remaining quantity without losing its place in the queue. */
  decrease(orderId: string, newRemaining: number): void {
    const order = this.byId.get(orderId);
    if (!order) throw new Error(`order ${orderId} is not on the book`);
    if (!Number.isSafeInteger(newRemaining) || newRemaining < 0 || newRemaining >= order.remaining) {
      throw new RangeError(`new remaining must be an integer in [0, ${order.remaining})`);
    }
    if (newRemaining === 0) this.cancel(orderId);
    else order.remaining = newRemaining;
  }

  get(orderId: string): Readonly<RestingOrder> | undefined {
    return this.byId.get(orderId);
  }

  bestBid(side: Side): number | null {
    for (let price = MAX_PRICE; price >= MIN_PRICE; price--) {
      if (this.levels[side][price]!.length > 0) return price;
    }
    return null;
  }

  /** Cheapest price you can buy `side` at right now (derived from the other side's best bid). */
  bestAsk(side: Side): number | null {
    const bid = this.bestBid(opposite(side));
    return bid === null ? null : PAYOUT - bid;
  }

  /** True if a YES bid and a NO bid could trade. Must never be true between commands. */
  isCrossed(): boolean {
    const yes = this.bestBid("yes");
    const no = this.bestBid("no");
    return yes !== null && no !== null && crosses(yes, no);
  }

  /** Aggregated bids for one side, ascending by price (best bid last, like Kalshi's API). */
  depth(side: Side): PriceLevel[] {
    const out: PriceLevel[] = [];
    for (let price = MIN_PRICE; price <= MAX_PRICE; price++) {
      const qty = this.levels[side][price]!.reduce((sum, o) => sum + o.remaining, 0);
      if (qty > 0) out.push({ price, qty });
    }
    return out;
  }

  /** Every resting order, both sides, in priority order. Copies, safe to inspect. */
  orders(): RestingOrder[] {
    const out: RestingOrder[] = [];
    for (const side of ["yes", "no"] as const) {
      for (let price = MAX_PRICE; price >= MIN_PRICE; price--) {
        for (const o of this.levels[side][price]!) out.push({ ...o });
      }
    }
    return out;
  }

  private crossingOrders(side: Side, price: number): RestingOrder[] {
    const other = opposite(side);
    const out: RestingOrder[] = [];
    for (let p = MAX_PRICE; p >= PAYOUT - price && p >= MIN_PRICE; p--) {
      for (const o of this.levels[other][p]!) out.push({ ...o });
    }
    return out;
  }

  private rest(order: RestingOrder): void {
    this.levels[order.side][order.price]!.push(order);
    this.byId.set(order.id, order);
  }
}
