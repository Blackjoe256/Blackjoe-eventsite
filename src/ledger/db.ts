import type { Pool } from "pg";

// The ledger only needs "run a query" and "run these queries atomically".
// Keeping the interface this small lets production use node-postgres and tests use PGlite.

export type Row = Record<string, unknown>;

export interface Queryable {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  /** Run `fn` inside BEGIN/COMMIT; any thrown error rolls everything back. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

export function createPgDb(pool: Pool): Db {
  return {
    async query<T extends Row>(sql: string, params: unknown[] = []) {
      const result = await pool.query(sql, params);
      return { rows: result.rows as T[] };
    },
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const tx: Queryable = {
          async query<R extends Row>(sql: string, params: unknown[] = []) {
            const result = await client.query(sql, params);
            return { rows: result.rows as R[] };
          },
        };
        const value = await fn(tx);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
