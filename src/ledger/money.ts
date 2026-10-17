// Money is always an integer count of the currency's smallest unit ("minor units").
// UGX has no subunit in practice, so 1 UGX = 1 minor unit.
// USDT is tracked to 6 decimals (matching the token contract), so 1 USDT = 1_000_000 micros.

export const CURRENCIES = {
  UGX: { decimals: 0 },
  USDT: { decimals: 6 },
} as const;

export type Currency = keyof typeof CURRENCIES;

export function isCurrency(value: string): value is Currency {
  return Object.hasOwn(CURRENCIES, value);
}

const DECIMAL_PATTERN = /^(-)?(\d+)(?:\.(\d+))?$/;

/**
 * Parse a human decimal string ("13.313806") into minor units (13313806n).
 * Takes strings only: a JS number like 0.1 is already imprecise before we see it.
 */
export function toMinorUnits(amount: string, currency: Currency): bigint {
  const match = DECIMAL_PATTERN.exec(amount.trim());
  if (!match) throw new RangeError(`Invalid ${currency} amount: "${amount}"`);
  const [, sign, whole = "0", fraction = ""] = match;
  const { decimals } = CURRENCIES[currency];
  if (fraction.length > decimals) {
    throw new RangeError(`${currency} supports at most ${decimals} decimal places: "${amount}"`);
  }
  const minor = BigInt(whole + fraction.padEnd(decimals, "0"));
  return sign ? -minor : minor;
}

/** Format minor units back to a decimal string: 13313806n USDT -> "13.313806". */
export function formatMinorUnits(minor: bigint, currency: Currency): string {
  const { decimals } = CURRENCIES[currency];
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString();
  if (decimals === 0) return (negative ? "-" : "") + digits;
  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** Normalise a BIGINT coming back from a driver (pg returns strings, PGlite returns bigint). */
export function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  throw new TypeError(`Expected an integer, got ${String(value)}`);
}
