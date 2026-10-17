import { createHash, randomUUID } from "node:crypto";
import type { Db, Queryable } from "./db.js";
import { IdempotencyConflictError, InsufficientFundsError, InvalidPostingError } from "./errors.js";
import { type Currency, isCurrency, toBigInt } from "./money.js";
import { LEDGER_SCHEMA_SQL } from "./schema.js";

// Sign convention: the whole ledger is a closed system, so all balances in a currency sum to zero.
// Positive on a user account = money the platform owes that user.
// The system accounts that mirror outside money (clearing, FX pool, treasury) may go negative.
export const ACCOUNT_KINDS = {
  user_available: { owner: "user", allowNegative: false },
  user_locked: { owner: "user", allowNegative: false }, // funds tied up in open positions
  market_escrow: { owner: "market", allowNegative: false },
  withdrawal_pending: { owner: "system", allowNegative: false }, // held while a payout is in flight
  provider_clearing: { owner: "system", allowNegative: true }, // money sitting at MarzPay
  fx_pool: { owner: "system", allowNegative: true }, // UGX <-> USDT conversion position
  treasury: { owner: "system", allowNegative: true }, // real USDT reserve
  fee_revenue: { owner: "system", allowNegative: false },
} as const;

export type AccountKind = keyof typeof ACCOUNT_KINDS;

export interface Account {
  id: string;
  ownerId: string | null;
  kind: AccountKind;
  currency: Currency;
  allowNegative: boolean;
  balance: bigint;
}

export interface PostingEntry {
  accountId: string;
  currency: Currency;
  /** Positive = credit, negative = debit, in minor units. */
  amount: bigint;
}

export interface PostingInput {
  type: string;
  /** Idempotency key. Posting the same key twice is a no-op that returns the original. */
  externalRef: string;
  entries: PostingEntry[];
  metadata?: Record<string, unknown>;
}

export interface PostResult {
  transactionId: string;
  /** true when this externalRef was already posted and nothing new was written. */
  replayed: boolean;
}

export interface IntegrityReport {
  ok: boolean;
  /** Accounts whose cached balance differs from the sum of their entries. */
  balanceMismatches: { accountId: string; cached: bigint; computed: bigint }[];
  /** Transactions whose entries do not sum to zero for some currency. */
  unbalancedTransactions: { transactionId: string; currency: string; total: bigint }[];
  /** Sum of every account balance per currency; must be 0 in a closed ledger. */
  currencyTotals: Record<string, bigint>;
}

/** Pure validation, run before touching the database. */
export function validatePosting(input: PostingInput): void {
  if (!input.type.trim()) throw new InvalidPostingError("type is required");
  if (!input.externalRef.trim()) throw new InvalidPostingError("externalRef is required");
  if (input.entries.length < 2) throw new InvalidPostingError("a posting needs at least two entries");

  const seen = new Set<string>();
  const totals = new Map<Currency, bigint>();
  for (const entry of input.entries) {
    if (typeof entry.amount !== "bigint") throw new InvalidPostingError("amounts must be bigint minor units");
    if (entry.amount === 0n) throw new InvalidPostingError(`zero amount for account ${entry.accountId}`);
    if (!isCurrency(entry.currency)) throw new InvalidPostingError(`unknown currency ${String(entry.currency)}`);
    if (seen.has(entry.accountId)) {
      throw new InvalidPostingError(`account ${entry.accountId} appears more than once`);
    }
    seen.add(entry.accountId);
    totals.set(entry.currency, (totals.get(entry.currency) ?? 0n) + entry.amount);
  }
  for (const [currency, total] of totals) {
    if (total !== 0n) throw new InvalidPostingError(`${currency} entries sum to ${total}, expected 0`);
  }
}

function fingerprint(input: PostingInput): string {
  const canonical = [...input.entries]
    .sort((a, b) => a.accountId.localeCompare(b.accountId))
    .map((e) => `${e.accountId}:${e.currency}:${e.amount}`)
    .join("|");
  return createHash("sha256").update(`${input.type}|${canonical}`).digest("hex");
}

type AccountRow = {
  id: string;
  owner_id: string | null;
  kind: string;
  currency: string;
  allow_negative: boolean;
  balance: unknown;
};

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    ownerId: row.owner_id,
    kind: row.kind as AccountKind,
    currency: row.currency as Currency,
    allowNegative: row.allow_negative,
    balance: toBigInt(row.balance),
  };
}

const ACCOUNT_COLUMNS = "id, owner_id, kind, currency, allow_negative, balance";

export class Ledger {
  constructor(private readonly db: Db) {}

  async migrate(): Promise<void> {
    await this.db.query(LEDGER_SCHEMA_SQL);
  }

  /** Get-or-create the account for (owner, kind, currency). Safe to call repeatedly. */
  async openAccount(params: { ownerId: string | null; kind: AccountKind; currency: Currency }): Promise<Account> {
    const policy = ACCOUNT_KINDS[params.kind];
    if (!policy) throw new InvalidPostingError(`unknown account kind ${params.kind}`);
    if ((policy.owner === "system") !== (params.ownerId === null)) {
      throw new InvalidPostingError(
        policy.owner === "system"
          ? `${params.kind} is a system account and takes no owner`
          : `${params.kind} requires a ${policy.owner} owner id`,
      );
    }
    await this.db.query(
      `INSERT INTO ledger_accounts (id, owner_id, kind, currency, allow_negative)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT ON CONSTRAINT ledger_accounts_owner_kind_currency DO NOTHING`,
      [randomUUID(), params.ownerId, params.kind, params.currency, policy.allowNegative],
    );
    const { rows } = await this.db.query<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM ledger_accounts
        WHERE owner_id IS NOT DISTINCT FROM $1 AND kind = $2 AND currency = $3`,
      [params.ownerId, params.kind, params.currency],
    );
    return toAccount(rows[0]!);
  }

  async getAccount(accountId: string): Promise<Account | null> {
    const { rows } = await this.db.query<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM ledger_accounts WHERE id = $1`,
      [accountId],
    );
    return rows[0] ? toAccount(rows[0]) : null;
  }

  async balance(accountId: string): Promise<bigint> {
    const account = await this.getAccount(accountId);
    if (!account) throw new InvalidPostingError(`unknown account ${accountId}`);
    return account.balance;
  }

  /**
   * Atomically record a balanced set of entries.
   *
   * 1. Validate in code (cheap, clear errors).
   * 2. Claim the idempotency key; a concurrent duplicate waits on the unique index, then replays.
   * 3. Lock the touched accounts in a fixed order (prevents deadlocks), check overdrafts.
   * 4. Insert entries and update cached balances. The DB re-checks balance at COMMIT.
   */
  async post(input: PostingInput): Promise<PostResult> {
    validatePosting(input);
    const print = fingerprint(input);

    return this.db.transaction(async (tx) => {
      const transactionId = randomUUID();
      const claimed = await tx.query<{ id: string }>(
        `INSERT INTO ledger_transactions (id, type, external_ref, fingerprint, metadata)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (external_ref) DO NOTHING
         RETURNING id`,
        [transactionId, input.type, input.externalRef, print, JSON.stringify(input.metadata ?? {})],
      );
      if (claimed.rows.length === 0) return this.replay(tx, input.externalRef, print);

      const accountIds = [...new Set(input.entries.map((e) => e.accountId))].sort();
      const locked = await tx.query<AccountRow>(
        `SELECT ${ACCOUNT_COLUMNS} FROM ledger_accounts
          WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
        [accountIds],
      );
      const accounts = new Map(locked.rows.map((row) => [row.id, toAccount(row)]));

      for (const entry of input.entries) {
        const account = accounts.get(entry.accountId);
        if (!account) throw new InvalidPostingError(`unknown account ${entry.accountId}`);
        if (account.currency !== entry.currency) {
          throw new InvalidPostingError(
            `account ${account.id} holds ${account.currency}, entry is ${entry.currency}`,
          );
        }
        if (!account.allowNegative && account.balance + entry.amount < 0n) {
          throw new InsufficientFundsError(account.id, account.balance, entry.amount);
        }
      }

      const values: unknown[] = [];
      const tuples = input.entries.map((entry, i) => {
        values.push(transactionId, entry.accountId, entry.currency, entry.amount.toString());
        const p = i * 4;
        return `($${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}::bigint)`;
      });
      await tx.query(
        `INSERT INTO ledger_entries (transaction_id, account_id, currency, amount) VALUES ${tuples.join(", ")}`,
        values,
      );

      for (const entry of input.entries) {
        await tx.query(
          `UPDATE ledger_accounts SET balance = balance + $2::bigint, version = version + 1 WHERE id = $1`,
          [entry.accountId, entry.amount.toString()],
        );
      }

      return { transactionId, replayed: false };
    });
  }

  private async replay(tx: Queryable, externalRef: string, print: string): Promise<PostResult> {
    const { rows } = await tx.query<{ id: string; fingerprint: string }>(
      `SELECT id, fingerprint FROM ledger_transactions WHERE external_ref = $1`,
      [externalRef],
    );
    const existing = rows[0]!;
    if (existing.fingerprint !== print) throw new IdempotencyConflictError(externalRef);
    return { transactionId: existing.id, replayed: true };
  }

  async entries(accountId: string, limit = 50) {
    const { rows } = await this.db.query<{
      transaction_id: string;
      type: string;
      external_ref: string;
      amount: unknown;
      created_at: unknown;
    }>(
      `SELECT e.transaction_id, t.type, t.external_ref, e.amount, t.created_at
         FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id
        WHERE e.account_id = $1
        ORDER BY e.id DESC
        LIMIT $2`,
      [accountId, limit],
    );
    return rows.map((r) => ({
      transactionId: r.transaction_id,
      type: r.type,
      externalRef: r.external_ref,
      amount: toBigInt(r.amount),
      createdAt: new Date(r.created_at as string | Date),
    }));
  }

  /** Recompute everything from raw entries. Run nightly and alert on any finding. */
  async verifyIntegrity(): Promise<IntegrityReport> {
    const mismatches = await this.db.query<{ id: string; balance: unknown; computed: unknown }>(
      `SELECT a.id, a.balance, COALESCE(SUM(e.amount), 0)::bigint AS computed
         FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
        GROUP BY a.id, a.balance
       HAVING a.balance <> COALESCE(SUM(e.amount), 0)`,
    );
    const unbalanced = await this.db.query<{ transaction_id: string; currency: string; total: unknown }>(
      `SELECT transaction_id, currency, SUM(amount)::bigint AS total
         FROM ledger_entries GROUP BY transaction_id, currency
       HAVING SUM(amount) <> 0`,
    );
    const totals = await this.db.query<{ currency: string; total: unknown }>(
      `SELECT currency, SUM(balance)::bigint AS total FROM ledger_accounts GROUP BY currency`,
    );

    const currencyTotals = Object.fromEntries(totals.rows.map((r) => [r.currency, toBigInt(r.total)]));
    const report: IntegrityReport = {
      ok: false,
      balanceMismatches: mismatches.rows.map((r) => ({
        accountId: r.id,
        cached: toBigInt(r.balance),
        computed: toBigInt(r.computed),
      })),
      unbalancedTransactions: unbalanced.rows.map((r) => ({
        transactionId: r.transaction_id,
        currency: r.currency,
        total: toBigInt(r.total),
      })),
      currencyTotals,
    };
    report.ok =
      report.balanceMismatches.length === 0 &&
      report.unbalancedTransactions.length === 0 &&
      Object.values(currencyTotals).every((total) => total === 0n);
    return report;
  }
}
