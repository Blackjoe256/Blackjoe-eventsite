// Binary-market matching (docs/matching-engine-design.md §2–4).
//
// Prices are integer ticks 1..99 (1 tick = 0.01 USDT); a contract pays 100 ticks to the winner.
// The book holds only bids: a NO bid at q is a YES ask at 100 - q. A YES bid at p and a NO bid
// at q cross when p + q >= 100, and trade at the resting (maker) order's price.
//
// match() is pure: no I/O, no mutation of its inputs. It returns a plan that the caller
// persists (Phase 1: Postgres) or applies to an in-memory book (Phase 2 / tests).

export type Side = "yes" | "no";
export type TimeInForce = "gtc" | "ioc";

export const MIN_PRICE = 1;
export const MAX_PRICE = 99;
export const PAYOUT = 100; // ticks paid per winning contract

export interface RestingOrder {
  id: string;
  userId: string;
  side: Side;
  price: number;
  /** Unfilled quantity still on the book. */
  remaining: number;
  /** Market-wide arrival sequence; lower = earlier = higher priority within a price. */
  seq: bigint;
}

export interface IncomingOrder {
  id: string;
  userId: string;
  side: Side;
  price: number;
  qty: number;
  tif: TimeInForce;
  postOnly: boolean;
  seq: bigint;
}

export interface Fill {
  takerOrderId: string;
  makerOrderId: string;
  takerUserId: string;
  makerUserId: string;
  takerSide: Side;
  qty: number;
  /** Execution price for each party; makerPrice + takerPrice = 100 always. */
  makerPrice: number;
  takerPrice: number;
  /** The YES leg's price, the canonical price of the trade. */
  yesPrice: number;
}

export interface MakerUpdate {
  orderId: string;
  filledQty: number;
  remaining: number;
}

export type RejectReason = "invalid_side" | "invalid_price" | "invalid_qty" | "would_take";

export type MatchResult =
  | { status: "rejected"; reason: RejectReason }
  | {
      status: "accepted";
      fills: Fill[];
      /** Resting orders touched by fills, with their new remaining quantity. */
      makerUpdates: MakerUpdate[];
      /** Resting orders of the same user that would have traded with it (self-trade prevention). */
      selfTradeCancels: string[];
      filledQty: number;
      remainingQty: number;
      /** filled: fully matched · rested: remainder now rests at order.price · ioc_cancelled: remainder dropped */
      outcome: "filled" | "rested" | "ioc_cancelled";
    };

export function opposite(side: Side): Side {
  return side === "yes" ? "no" : "yes";
}

export function crosses(price: number, oppositePrice: number): boolean {
  return price + oppositePrice >= PAYOUT;
}

export function isValidPrice(price: number): boolean {
  return Number.isInteger(price) && price >= MIN_PRICE && price <= MAX_PRICE;
}

/** Price-time priority: higher price first, then earlier seq. */
export function comparePriority(a: RestingOrder, b: RestingOrder): number {
  if (a.price !== b.price) return b.price - a.price;
  return a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0;
}

/**
 * Match an incoming order against resting orders on the opposite side.
 *
 * `restingOpposite` must contain every resting opposite-side order at a crossing price
 * (order does not matter; it is sorted here). Orders on the wrong side or at prices that
 * do not cross are ignored.
 */
export function match(order: IncomingOrder, restingOpposite: readonly RestingOrder[]): MatchResult {
  if (order.side !== "yes" && order.side !== "no") return { status: "rejected", reason: "invalid_side" };
  if (!isValidPrice(order.price)) return { status: "rejected", reason: "invalid_price" };
  if (!Number.isSafeInteger(order.qty) || order.qty <= 0) return { status: "rejected", reason: "invalid_qty" };

  const candidates = restingOpposite
    .filter((r) => r.side === opposite(order.side) && r.remaining > 0 && crosses(order.price, r.price))
    .sort(comparePriority);

  // Post-only orders exist to add liquidity, so they must never trade on arrival.
  if (order.postOnly && candidates.length > 0) return { status: "rejected", reason: "would_take" };

  const fills: Fill[] = [];
  const makerUpdates: MakerUpdate[] = [];
  const selfTradeCancels: string[] = [];
  let remaining = order.qty;

  for (const maker of candidates) {
    if (remaining === 0) break;
    if (maker.userId === order.userId) {
      selfTradeCancels.push(maker.id); // cancel-maker: the resting order is removed
      continue;
    }
    const qty = Math.min(remaining, maker.remaining);
    const takerPrice = PAYOUT - maker.price;
    fills.push({
      takerOrderId: order.id,
      makerOrderId: maker.id,
      takerUserId: order.userId,
      makerUserId: maker.userId,
      takerSide: order.side,
      qty,
      makerPrice: maker.price,
      takerPrice,
      yesPrice: order.side === "yes" ? takerPrice : maker.price,
    });
    makerUpdates.push({ orderId: maker.id, filledQty: qty, remaining: maker.remaining - qty });
    remaining -= qty;
  }

  const filledQty = order.qty - remaining;
  const outcome = remaining === 0 ? "filled" : order.tif === "gtc" ? "rested" : "ioc_cancelled";
  return { status: "accepted", fills, makerUpdates, selfTradeCancels, filledQty, remainingQty: remaining, outcome };
}
