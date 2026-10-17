export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The posting itself is malformed (unbalanced, zero amounts, unknown account...). */
export class InvalidPostingError extends LedgerError {}

/** Applying the posting would take an account that must stay >= 0 below zero. */
export class InsufficientFundsError extends LedgerError {
  constructor(
    readonly accountId: string,
    readonly balance: bigint,
    readonly attemptedDelta: bigint,
  ) {
    super(`Insufficient funds in account ${accountId}: balance ${balance}, change ${attemptedDelta}`);
  }
}

/** The idempotency key was already used for a *different* posting. */
export class IdempotencyConflictError extends LedgerError {
  constructor(readonly externalRef: string) {
    super(`external_ref "${externalRef}" was already used for a different posting`);
  }
}
