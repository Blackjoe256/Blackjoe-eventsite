import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  IdempotencyConflictError,
  InsufficientFundsError,
  InvalidPostingError,
  type Ledger,
  type SystemAccounts,
  type UserWallet,
  depositCredit,
  openSystemAccounts,
  openUserWallet,
  validatePosting,
  withdrawalComplete,
  withdrawalHold,
  withdrawalReverse,
} from "../src/ledger/index.js";
import type { Db } from "../src/ledger/db.js";
import { createTestLedger } from "./helpers.js";

let ledger: Ledger;
let db: Db;
let system: SystemAccounts;
let wallet: UserWallet;

beforeEach(async () => {
  ({ ledger, db } = await createTestLedger());
  system = await openSystemAccounts(ledger);
  wallet = await openUserWallet(ledger, randomUUID());
});

// Numbers from the design doc: 50,000 UGX at 3,755.5 UGX/USDT -> 13.313806 USDT.
async function deposit(ugx = 50_000n, usdt = 13_313_806n, depositId: string = randomUUID()) {
  return ledger.post(depositCredit({ depositId, system, wallet, ugxAmount: ugx, usdtMicros: usdt }));
}

describe("accounts", () => {
  it("openAccount is get-or-create", async () => {
    const userId = randomUUID();
    const a = await ledger.openAccount({ ownerId: userId, kind: "user_available", currency: "USDT" });
    const b = await ledger.openAccount({ ownerId: userId, kind: "user_available", currency: "USDT" });
    expect(b.id).toBe(a.id);
    expect(a.allowNegative).toBe(false);
    expect((await openSystemAccounts(ledger)).fxPoolUsdt).toBe(system.fxPoolUsdt);
  });

  it("enforces who may own each kind of account", async () => {
    await expect(ledger.openAccount({ ownerId: null, kind: "user_available", currency: "USDT" })).rejects.toThrow(
      InvalidPostingError,
    );
    await expect(ledger.openAccount({ ownerId: randomUUID(), kind: "fx_pool", currency: "UGX" })).rejects.toThrow(
      InvalidPostingError,
    );
  });
});

describe("posting validation (pure, before the database)", () => {
  const a = randomUUID();
  const b = randomUUID();

  it("rejects postings that do not sum to zero per currency", () => {
    expect(() =>
      validatePosting({
        type: "t",
        externalRef: "r",
        entries: [
          { accountId: a, currency: "USDT", amount: 5n },
          { accountId: b, currency: "USDT", amount: -4n },
        ],
      }),
    ).toThrow(/sum to 1/);
  });

  it("does not let one currency balance another", () => {
    expect(() =>
      validatePosting({
        type: "t",
        externalRef: "r",
        entries: [
          { accountId: a, currency: "USDT", amount: 5n },
          { accountId: b, currency: "UGX", amount: -5n },
        ],
      }),
    ).toThrow(InvalidPostingError);
  });

  it("rejects zero amounts, single entries, duplicate accounts and missing keys", () => {
    const bad = [
      { type: "t", externalRef: "r", entries: [{ accountId: a, currency: "USDT" as const, amount: 0n }, { accountId: b, currency: "USDT" as const, amount: 0n }] },
      { type: "t", externalRef: "r", entries: [{ accountId: a, currency: "USDT" as const, amount: 0n }] },
      { type: "t", externalRef: "r", entries: [{ accountId: a, currency: "USDT" as const, amount: 1n }, { accountId: a, currency: "USDT" as const, amount: -1n }] },
      { type: "t", externalRef: " ", entries: [{ accountId: a, currency: "USDT" as const, amount: 1n }, { accountId: b, currency: "USDT" as const, amount: -1n }] },
    ];
    for (const input of bad) expect(() => validatePosting(input)).toThrow(InvalidPostingError);
  });
});

describe("deposit", () => {
  it("credits the user and keeps every currency summing to zero", async () => {
    const result = await deposit();
    expect(result.replayed).toBe(false);
    expect(await ledger.balance(wallet.availableUsdt)).toBe(13_313_806n);
    expect(await ledger.balance(system.providerClearingUgx)).toBe(50_000n);
    expect(await ledger.balance(system.fxPoolUgx)).toBe(-50_000n);
    expect(await ledger.balance(system.fxPoolUsdt)).toBe(-13_313_806n);

    const report = await ledger.verifyIntegrity();
    expect(report).toMatchObject({ ok: true, currencyTotals: { UGX: 0n, USDT: 0n } });
  });

  it("is idempotent: a duplicate webhook does not credit twice", async () => {
    const depositId = randomUUID();
    const first = await deposit(50_000n, 13_313_806n, depositId);
    const second = await deposit(50_000n, 13_313_806n, depositId);
    expect(second).toEqual({ transactionId: first.transactionId, replayed: true });
    expect(await ledger.balance(wallet.availableUsdt)).toBe(13_313_806n);
  });

  it("refuses to reuse a key for a different amount", async () => {
    const depositId = randomUUID();
    await deposit(50_000n, 13_313_806n, depositId);
    await expect(deposit(60_000n, 15_976_567n, depositId)).rejects.toThrow(IdempotencyConflictError);
    expect(await ledger.balance(wallet.availableUsdt)).toBe(13_313_806n);
  });
});

describe("withdrawal", () => {
  const TEN_USDT = 10_000_000n;

  it("hold then complete: USDT leaves the user, UGX leaves the provider float", async () => {
    await deposit();
    const withdrawalId = randomUUID();
    await ledger.post(withdrawalHold({ withdrawalId, system, wallet, usdtMicros: TEN_USDT }));
    expect(await ledger.balance(wallet.availableUsdt)).toBe(3_313_806n);
    expect(await ledger.balance(system.withdrawalPendingUsdt)).toBe(TEN_USDT);

    await ledger.post(
      withdrawalComplete({ withdrawalId, system, usdtMicros: TEN_USDT, ugxPaidOut: 36_445n, providerFeeUgx: 500n }),
    );
    expect(await ledger.balance(system.withdrawalPendingUsdt)).toBe(0n);
    expect(await ledger.balance(system.providerClearingUgx)).toBe(50_000n - 36_945n);
    expect((await ledger.verifyIntegrity()).ok).toBe(true);
  });

  it("hold then reverse: a failed payout gives the user their USDT back", async () => {
    await deposit();
    const withdrawalId = randomUUID();
    await ledger.post(withdrawalHold({ withdrawalId, system, wallet, usdtMicros: TEN_USDT }));
    await ledger.post(withdrawalReverse({ withdrawalId, system, wallet, usdtMicros: TEN_USDT }));
    expect(await ledger.balance(wallet.availableUsdt)).toBe(13_313_806n);
    expect(await ledger.balance(system.withdrawalPendingUsdt)).toBe(0n);
  });

  it("cannot overdraw, and a rejected posting leaves no trace", async () => {
    await deposit(); // 13.313806 USDT
    const withdrawalId = randomUUID();
    const tooMuch = withdrawalHold({ withdrawalId, system, wallet, usdtMicros: 20_000_000n });
    await expect(ledger.post(tooMuch)).rejects.toThrow(InsufficientFundsError);
    expect(await ledger.balance(wallet.availableUsdt)).toBe(13_313_806n);

    // The idempotency key was rolled back too, so the same withdrawal can succeed later.
    await deposit(30_000n, 7_988_283n);
    expect((await ledger.post(tooMuch)).replayed).toBe(false);
    expect((await ledger.verifyIntegrity()).ok).toBe(true);
  });

  it("prevents double-spending the same balance", async () => {
    await deposit(); // 13.313806 USDT, enough for one 10 USDT withdrawal but not two
    const attempts = await Promise.allSettled([
      ledger.post(withdrawalHold({ withdrawalId: randomUUID(), system, wallet, usdtMicros: TEN_USDT })),
      ledger.post(withdrawalHold({ withdrawalId: randomUUID(), system, wallet, usdtMicros: TEN_USDT })),
    ]);
    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((a) => a.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientFundsError);
    expect(await ledger.balance(wallet.availableUsdt)).toBe(3_313_806n);
  });

  it("rejects an entry whose currency does not match its account", async () => {
    await expect(
      ledger.post({
        type: "bad",
        externalRef: randomUUID(),
        entries: [
          { accountId: system.fxPoolUgx, currency: "USDT", amount: -1n },
          { accountId: wallet.availableUsdt, currency: "USDT", amount: 1n },
        ],
      }),
    ).rejects.toThrow(/holds UGX/);
  });
});

describe("database safety net (rules hold even if application code is bypassed)", () => {
  it("rejects an unbalanced transaction at COMMIT", async () => {
    const txId = randomUUID();
    await expect(
      db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO ledger_transactions (id, type, external_ref, fingerprint) VALUES ($1, 'hack', $2, 'x')`,
          [txId, randomUUID()],
        );
        await tx.query(
          `INSERT INTO ledger_entries (transaction_id, account_id, currency, amount) VALUES ($1, $2, 'USDT', 1000000)`,
          [txId, wallet.availableUsdt],
        );
      }),
    ).rejects.toThrow(/unbalanced/);
  });

  it("makes ledger history append-only", async () => {
    await deposit();
    await expect(db.query(`UPDATE ledger_entries SET amount = amount * 2 WHERE amount > $1`, [0])).rejects.toThrow(
      /append-only/,
    );
    await expect(db.query(`DELETE FROM ledger_transactions WHERE type = $1`, ["deposit"])).rejects.toThrow(
      /append-only/,
    );
  });

  it("refuses a negative balance on a user account", async () => {
    await expect(
      db.query(`UPDATE ledger_accounts SET balance = -1 WHERE id = $1`, [wallet.availableUsdt]),
    ).rejects.toThrow(/balance_non_negative/);
  });

  it("verifyIntegrity catches a tampered cached balance", async () => {
    await deposit();
    await db.query(`UPDATE ledger_accounts SET balance = balance + 1000000 WHERE id = $1`, [wallet.availableUsdt]);
    const report = await ledger.verifyIntegrity();
    expect(report.ok).toBe(false);
    expect(report.balanceMismatches).toEqual([
      { accountId: wallet.availableUsdt, cached: 14_313_806n, computed: 13_313_806n },
    ]);
  });
});

describe("invariants under many random operations", () => {
  it("stays balanced and never lets a user go negative", async () => {
    let seed = 42;
    const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
    const wallets = await Promise.all(Array.from({ length: 4 }, () => openUserWallet(ledger, randomUUID())));

    for (let i = 0; i < 150; i++) {
      const w = wallets[Math.floor(random() * wallets.length)]!;
      const usdt = BigInt(1 + Math.floor(random() * 20_000_000));
      const id = randomUUID();
      const roll = random();
      try {
        if (roll < 0.4) {
          const ugx = (usdt * 3_755n) / 1_000_000n + 1n;
          await ledger.post(depositCredit({ depositId: id, system, wallet: w, ugxAmount: ugx, usdtMicros: usdt }));
        } else {
          await ledger.post(withdrawalHold({ withdrawalId: id, system, wallet: w, usdtMicros: usdt }));
          if (roll < 0.75) {
            const ugx = (usdt * 3_644n) / 1_000_000n + 1n;
            await ledger.post(withdrawalComplete({ withdrawalId: id, system, usdtMicros: usdt, ugxPaidOut: ugx, providerFeeUgx: 0n }));
          } else {
            await ledger.post(withdrawalReverse({ withdrawalId: id, system, wallet: w, usdtMicros: usdt }));
          }
        }
      } catch (error) {
        expect(error).toBeInstanceOf(InsufficientFundsError);
      }
    }

    for (const w of wallets) expect(await ledger.balance(w.availableUsdt)).toBeGreaterThanOrEqual(0n);
    expect(await ledger.balance(system.withdrawalPendingUsdt)).toBe(0n);
    const report = await ledger.verifyIntegrity();
    expect(report.balanceMismatches).toEqual([]);
    expect(report.unbalancedTransactions).toEqual([]);
    expect(report.ok).toBe(true);
  });
});
