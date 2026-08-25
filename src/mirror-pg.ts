// ============================================================
// mirror-pg.ts -- read-only Supabase mirror access for audit composites.
//
// The MIRROR_HYPERDRIVE credential has SELECT grants on a short, explicit
// mirror-table list. Keep queries static and parameterized; the database role
// and read-only transaction are independent backstops against writes.
// ============================================================

import postgres from 'postgres';
import type { Env } from './env';

const TABLE_NAME_RE = /^[a-z_]+$/;
const STATEMENT_TIMEOUT_MS = 20_000;

/** Execute one static, parameterized read against the private mirror schema. */
export async function readMirror<Row = Record<string, unknown>>(
  env: Env,
  statement: string,
  params: readonly unknown[] = [],
): Promise<Row[]> {
  const sqlText = statement.trim();
  if (!/^(SELECT|WITH)\b/i.test(sqlText)) {
    throw new Error('readMirror: only SELECT/WITH statements are permitted');
  }

  const sql = postgres(env.MIRROR_HYPERDRIVE.connectionString, {
    max: 1,
    fetch_types: false,
  });

  try {
    const rows = await sql.begin('read only', async (tx) => {
      await tx.unsafe(`set local statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
      return tx.unsafe(sqlText, params as any);
    });
    return rows as unknown as Row[];
  } finally {
    await sql.end();
  }
}

/** Fetch MAX(synced_at) for constant mirror table names without widening access. */
export async function fetchMirrorTableMax(
  env: Env,
  tables: readonly string[],
): Promise<Record<string, unknown>> {
  if (tables.length === 0 || tables.some((table) => !TABLE_NAME_RE.test(table))) return {};

  try {
    const tableMax = Object.fromEntries(tables.map((table) => [table, null])) as Record<string, unknown>;
    const statement = tables
      .map((table) => `SELECT '${table}' AS t, MAX(synced_at)::text AS m FROM mirror.${table}`)
      .join(' UNION ALL ');
    const rows = await readMirror<{ t: string; m: string | null }>(env, statement);
    for (const row of rows) {
      if (row.t in tableMax) tableMax[row.t] = row.m;
    }
    return tableMax;
  } catch {
    return {};
  }
}
