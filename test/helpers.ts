import { PGlite } from "@electric-sql/pglite";
import type { Db, Queryable, Row } from "../src/ledger/db.js";
import { Ledger } from "../src/ledger/ledger.js";

// PGlite is real Postgres compiled to WASM: real SQL, constraints and triggers, no server.
// Its query() uses the extended protocol (one statement); calls without params go through
// exec(), which accepts multi-statement scripts like the schema.
function adapt(target: Pick<PGlite, "query" | "exec">): Queryable {
  return {
    async query<T extends Row>(sql: string, params?: unknown[]) {
      if (!params || params.length === 0) {
        const results = await target.exec(sql);
        return { rows: (results.at(-1)?.rows ?? []) as T[] };
      }
      const result = await target.query<T>(sql, params);
      return { rows: result.rows };
    },
  };
}

export async function createTestLedger(): Promise<{ ledger: Ledger; db: Db; pg: PGlite }> {
  const pg = new PGlite();
  const db: Db = {
    ...adapt(pg),
    transaction: (fn) => pg.transaction((tx) => fn(adapt(tx))),
  };
  const ledger = new Ledger(db);
  await ledger.migrate();
  return { ledger, db, pg };
}
