// Ledger schema. Requires PostgreSQL 15+ (UNIQUE NULLS NOT DISTINCT).
// The application validates every posting, and the database enforces the same rules
// again, so a bug or a hand-written SQL statement still cannot break the books.

export const LEDGER_SCHEMA_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS ledger_accounts (
  id             UUID PRIMARY KEY,
  owner_id       UUID,                          -- user id, market id, or NULL for system accounts
  kind           TEXT NOT NULL,
  currency       TEXT NOT NULL CHECK (currency IN ('UGX', 'USDT')),
  allow_negative BOOLEAN NOT NULL,
  balance        BIGINT NOT NULL DEFAULT 0,     -- cached sum of entries, updated in the same DB transaction
  version        BIGINT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ledger_accounts_owner_kind_currency UNIQUE NULLS NOT DISTINCT (owner_id, kind, currency),
  CONSTRAINT ledger_accounts_id_currency UNIQUE (id, currency),
  CONSTRAINT ledger_accounts_balance_non_negative CHECK (allow_negative OR balance >= 0)
);

CREATE TABLE IF NOT EXISTS ledger_transactions (
  id           UUID PRIMARY KEY,
  type         TEXT NOT NULL,
  external_ref TEXT NOT NULL UNIQUE,            -- idempotency key, e.g. "deposit:<uuid>"
  fingerprint  TEXT NOT NULL,                   -- hash of the postings, detects conflicting retries
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id             BIGSERIAL PRIMARY KEY,
  transaction_id UUID NOT NULL REFERENCES ledger_transactions(id),
  account_id     UUID NOT NULL,
  currency       TEXT NOT NULL,
  amount         BIGINT NOT NULL CHECK (amount <> 0),   -- + credit, - debit, in minor units
  -- Composite FK: an entry's currency must equal its account's currency.
  FOREIGN KEY (account_id, currency) REFERENCES ledger_accounts(id, currency)
);

CREATE INDEX IF NOT EXISTS ledger_entries_account_idx ON ledger_entries (account_id, id);
CREATE INDEX IF NOT EXISTS ledger_entries_transaction_idx ON ledger_entries (transaction_id);

-- History is append-only: corrections are new reversing transactions, never edits.
CREATE OR REPLACE FUNCTION ledger_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger history is append-only (% on %)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;

DROP TRIGGER IF EXISTS ledger_entries_immutable ON ledger_entries;
CREATE TRIGGER ledger_entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_forbid_mutation();

DROP TRIGGER IF EXISTS ledger_transactions_immutable ON ledger_transactions;
CREATE TRIGGER ledger_transactions_immutable BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION ledger_forbid_mutation();

-- Every transaction must sum to zero per currency. Checked at COMMIT (deferred),
-- because entries are inserted one statement at a time.
CREATE OR REPLACE FUNCTION ledger_check_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  unbalanced RECORD;
BEGIN
  SELECT currency, SUM(amount) AS total INTO unbalanced
    FROM ledger_entries
   WHERE transaction_id = NEW.transaction_id
   GROUP BY currency
  HAVING SUM(amount) <> 0
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced: % sums to %',
      NEW.transaction_id, unbalanced.currency, unbalanced.total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS ledger_entries_balanced ON ledger_entries;
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced();
`;
