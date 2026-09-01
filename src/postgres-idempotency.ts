import { createHash } from "node:crypto";
import { Pool } from "pg";
import type {
  IdempotencyClaimResult,
  IdempotencyStore,
  PersistedIdempotencyEntry,
} from "./idempotency.js";

interface StoredRow {
  fingerprint: string;
  state: "pending" | "fulfilled" | "rejected";
  expires_at_ms: string | number;
  created_at_ms: string | number;
  value_json: unknown | null;
  error_message: string | null;
}

const TABLE = "bayti_core_idempotency";

function keyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function asMilliseconds(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("Invalid idempotency timestamp returned from Postgres.");
  }
  return parsed;
}

function rowToEntry<T>(row: StoredRow): PersistedIdempotencyEntry<T> {
  const common = {
    fingerprint: row.fingerprint,
    expiresAtMs: asMilliseconds(row.expires_at_ms),
    createdAtMs: asMilliseconds(row.created_at_ms),
  };

  if (row.state === "pending") return { ...common, state: "pending" };
  if (row.state === "rejected") {
    return {
      ...common,
      state: "rejected",
      errorMessage: row.error_message ?? "Provider analysis failed.",
    };
  }
  if (row.value_json === null) {
    throw new Error("Fulfilled Postgres idempotency row is missing its result payload.");
  }
  return { ...common, state: "fulfilled", value: row.value_json as T };
}

/**
 * Shared, restart-safe idempotency ledger for production/multi-replica deployments.
 *
 * `claim()` uses one INSERT ... ON CONFLICT statement whose UPDATE is permitted only
 * when the existing row is expired. This makes the paid-analysis start boundary atomic
 * across different Node processes and Railway replicas.
 */
export class PostgresIdempotencyStore<T> implements IdempotencyStore<T> {
  readonly mode = "postgres" as const;
  private readonly pool: Pool;
  private initialization: Promise<void> | null = null;

  constructor(connectionString: string) {
    if (connectionString.trim().length === 0) {
      throw new Error("Postgres idempotency connection string must not be empty.");
    }
    this.pool = new Pool({ connectionString });
  }

  private async initialize(): Promise<void> {
    if (this.initialization === null) {
      this.initialization = (async () => {
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS ${TABLE} (
            key_hash TEXT PRIMARY KEY,
            fingerprint TEXT NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('pending', 'fulfilled', 'rejected')),
            expires_at_ms BIGINT NOT NULL,
            created_at_ms BIGINT NOT NULL,
            value_json JSONB,
            error_message TEXT
          )
        `);
        await this.pool.query(
          `CREATE INDEX IF NOT EXISTS ${TABLE}_expires_idx ON ${TABLE} (expires_at_ms)`,
        );
      })();
    }
    await this.initialization;
  }

  async probe(): Promise<void> {
    await this.initialize();
    await this.pool.query("SELECT 1");
    // Opportunistic bounded cleanup; expired rows for a reused key are also replaced by claim().
    await this.pool.query(
      `DELETE FROM ${TABLE} WHERE key_hash IN (
        SELECT key_hash FROM ${TABLE} WHERE expires_at_ms <= $1 ORDER BY expires_at_ms LIMIT 500
      )`,
      [Date.now()],
    );
  }

  async get(key: string): Promise<PersistedIdempotencyEntry<T> | null> {
    await this.initialize();
    const result = await this.pool.query<StoredRow>(
      `SELECT fingerprint, state, expires_at_ms, created_at_ms, value_json, error_message
       FROM ${TABLE} WHERE key_hash = $1`,
      [keyHash(key)],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToEntry<T>(row);
  }

  async claim(
    key: string,
    fingerprint: string,
    pending: Extract<PersistedIdempotencyEntry<T>, { state: "pending" }>,
  ): Promise<IdempotencyClaimResult<T>> {
    await this.initialize();
    const hash = keyHash(key);
    const result = await this.pool.query<{ key_hash: string }>(
      `INSERT INTO ${TABLE}
         (key_hash, fingerprint, state, expires_at_ms, created_at_ms, value_json, error_message)
       VALUES ($1, $2, 'pending', $3, $4, NULL, NULL)
       ON CONFLICT (key_hash) DO UPDATE SET
         fingerprint = EXCLUDED.fingerprint,
         state = 'pending',
         expires_at_ms = EXCLUDED.expires_at_ms,
         created_at_ms = EXCLUDED.created_at_ms,
         value_json = NULL,
         error_message = NULL
       WHERE ${TABLE}.expires_at_ms <= $5
       RETURNING key_hash`,
      [hash, fingerprint, pending.expiresAtMs, pending.createdAtMs, pending.createdAtMs],
    );

    if (result.rowCount === 1) return { claimed: true };

    const existing = await this.get(key);
    if (existing === null) {
      // Extremely narrow race with external/manual deletion. Fail closed rather than start
      // a paid provider operation without a durable claim.
      throw new Error("IDEMPOTENCY_ATOMIC_CLAIM_LOST");
    }
    return { claimed: false, entry: existing };
  }

  async set(key: string, entry: PersistedIdempotencyEntry<T>): Promise<void> {
    await this.initialize();
    const valueJson = entry.state === "fulfilled" ? JSON.stringify(entry.value) : null;
    const error = entry.state === "rejected" ? entry.errorMessage : null;
    const result = await this.pool.query(
      `UPDATE ${TABLE}
       SET state = $3,
           expires_at_ms = $4,
           created_at_ms = $5,
           value_json = $6::jsonb,
           error_message = $7
       WHERE key_hash = $1 AND fingerprint = $2`,
      [
        keyHash(key),
        entry.fingerprint,
        entry.state,
        entry.expiresAtMs,
        entry.createdAtMs,
        valueJson,
        error,
      ],
    );
    if (result.rowCount !== 1) {
      throw new Error("IDEMPOTENCY_PERSISTENCE_LOST");
    }
  }

  async delete(key: string): Promise<void> {
    await this.initialize();
    await this.pool.query(`DELETE FROM ${TABLE} WHERE key_hash = $1`, [keyHash(key)]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
