import { Pool, type QueryResultRow, type QueryResult } from 'pg';

/**
 * Phase 2 — Postgres connection.
 *
 * Single shared `pg.Pool` constructed lazily on first query. The connection
 * string is read from SUPABASE_DB_URL at construction time, so the pool picks
 * up `.env` changes only on process restart — same behavior as the rest of
 * the engine.
 *
 * `query<T>` and `queryOne<T>` are thin wrappers that return parsed rows so
 * call sites don't have to type-assert `QueryResult.rows`.
 */

let pool: Pool | null = null;

function getPool(): Pool {
  if (pool) return pool;

  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error(
      'SUPABASE_DB_URL is not set — cannot talk to the Phase 2 database. ' +
        'Add it to your local .env (see apps/api/src/db/schema.sql).',
    );
  }

  pool = new Pool({
    connectionString,
    // Supabase's pooled connection (port 6543) requires TLS off for the
    // direct host; the pooler terminates TLS for us. Setting `ssl: false`
    // here is correct for the pooler endpoint. If someone accidentally
    // points at the direct host (port 5432), they should switch back to
    // the pooler string instead of flipping this flag.
    ssl: false,
    max: 10,
    idleTimeoutMillis: 30_000,
  });

  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result: QueryResult<T> = await getPool().query<T>(sql, params as unknown[]);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

/**
 * Best-effort: drop the pool on process exit so the API doesn't hang on
 * shutdown. Registered once per process.
 */
let exitHandlerRegistered = false;
export function registerShutdownHandlers(): void {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;
  const close = () => {
    if (pool) {
      void pool.end();
      pool = null;
    }
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
