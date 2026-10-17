import type { Ledger, PostingInput } from "./ledger.js";

// Builders for the wallet's money movements (see docs/wallet-system-design.md §7–8).
// They only describe entries; Ledger.post() validates and records them.

export interface SystemAccounts {
  providerClearingUgx: string;
  fxPoolUgx: string;
  fxPoolUsdt: string;
  withdrawalPendingUsdt: string;
}

export interface UserWallet {
  availableUsdt: string;
  lockedUsdt: string;
}

export async function openSystemAccounts(ledger: Ledger): Promise<SystemAccounts> {
  const [providerClearingUgx, fxPoolUgx, fxPoolUsdt, withdrawalPendingUsdt] = await Promise.all([
    ledger.openAccount({ ownerId: null, kind: "provider_clearing", currency: "UGX" }),
    ledger.openAccount({ ownerId: null, kind: "fx_pool", currency: "UGX" }),
    ledger.openAccount({ ownerId: null, kind: "fx_pool", currency: "USDT" }),
    ledger.openAccount({ ownerId: null, kind: "withdrawal_pending", currency: "USDT" }),
  ]);
  return {
    providerClearingUgx: providerClearingUgx.id,
    fxPoolUgx: fxPoolUgx.id,
    fxPoolUsdt: fxPoolUsdt.id,
    withdrawalPendingUsdt: withdrawalPendingUsdt.id,
  };
}

export async function openUserWallet(ledger: Ledger, userId: string): Promise<UserWallet> {
  const [available, locked] = await Promise.all([
    ledger.openAccount({ ownerId: userId, kind: "user_available", currency: "USDT" }),
    ledger.openAccount({ ownerId: userId, kind: "user_locked", currency: "USDT" }),
  ]);
  return { availableUsdt: available.id, lockedUsdt: locked.id };
}

function assertPositive(name: string, value: bigint): void {
  if (value <= 0n) throw new RangeError(`${name} must be positive, got ${value}`);
}

/** Mobile money arrived at the provider: credit the user the quoted USDT. */
export function depositCredit(p: {
  depositId: string;
  system: SystemAccounts;
  wallet: UserWallet;
  ugxAmount: bigint;
  usdtMicros: bigint;
}): PostingInput {
  assertPositive("ugxAmount", p.ugxAmount);
  assertPositive("usdtMicros", p.usdtMicros);
  return {
    type: "deposit",
    externalRef: `deposit:${p.depositId}`,
    entries: [
      { accountId: p.system.providerClearingUgx, currency: "UGX", amount: p.ugxAmount },
      { accountId: p.system.fxPoolUgx, currency: "UGX", amount: -p.ugxAmount },
      { accountId: p.system.fxPoolUsdt, currency: "USDT", amount: -p.usdtMicros },
      { accountId: p.wallet.availableUsdt, currency: "USDT", amount: p.usdtMicros },
    ],
    metadata: { depositId: p.depositId },
  };
}

/** Step 1 of a withdrawal: reserve the USDT before calling the payout API. */
export function withdrawalHold(p: {
  withdrawalId: string;
  system: SystemAccounts;
  wallet: UserWallet;
  usdtMicros: bigint;
}): PostingInput {
  assertPositive("usdtMicros", p.usdtMicros);
  return {
    type: "withdrawal_hold",
    externalRef: `withdrawal:${p.withdrawalId}:hold`,
    entries: [
      { accountId: p.wallet.availableUsdt, currency: "USDT", amount: -p.usdtMicros },
      { accountId: p.system.withdrawalPendingUsdt, currency: "USDT", amount: p.usdtMicros },
    ],
    metadata: { withdrawalId: p.withdrawalId },
  };
}

/** Step 2a: the provider confirmed the UGX payout. The held USDT is converted and paid out. */
export function withdrawalComplete(p: {
  withdrawalId: string;
  system: SystemAccounts;
  usdtMicros: bigint;
  ugxPaidOut: bigint;
  providerFeeUgx: bigint;
}): PostingInput {
  assertPositive("usdtMicros", p.usdtMicros);
  assertPositive("ugxPaidOut", p.ugxPaidOut);
  if (p.providerFeeUgx < 0n) throw new RangeError("providerFeeUgx cannot be negative");
  const ugxTotal = p.ugxPaidOut + p.providerFeeUgx;
  return {
    type: "withdrawal",
    externalRef: `withdrawal:${p.withdrawalId}:complete`,
    entries: [
      { accountId: p.system.withdrawalPendingUsdt, currency: "USDT", amount: -p.usdtMicros },
      { accountId: p.system.fxPoolUsdt, currency: "USDT", amount: p.usdtMicros },
      { accountId: p.system.fxPoolUgx, currency: "UGX", amount: ugxTotal },
      { accountId: p.system.providerClearingUgx, currency: "UGX", amount: -ugxTotal },
    ],
    metadata: { withdrawalId: p.withdrawalId, ugxPaidOut: p.ugxPaidOut.toString() },
  };
}

/** Step 2b: the provider confirmed the payout FAILED. Return the held USDT to the user. */
export function withdrawalReverse(p: {
  withdrawalId: string;
  system: SystemAccounts;
  wallet: UserWallet;
  usdtMicros: bigint;
}): PostingInput {
  assertPositive("usdtMicros", p.usdtMicros);
  return {
    type: "withdrawal_reversal",
    externalRef: `withdrawal:${p.withdrawalId}:reverse`,
    entries: [
      { accountId: p.system.withdrawalPendingUsdt, currency: "USDT", amount: -p.usdtMicros },
      { accountId: p.wallet.availableUsdt, currency: "USDT", amount: p.usdtMicros },
    ],
    metadata: { withdrawalId: p.withdrawalId },
  };
}
