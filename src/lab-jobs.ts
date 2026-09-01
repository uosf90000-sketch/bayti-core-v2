import { randomUUID } from "node:crypto";
import { Pool } from "pg";

export type LabJobState<T> =
  | { status: "pending"; createdAtMs: number }
  | { status: "succeeded"; createdAtMs: number; completedAtMs: number; value: T; replayed: boolean }
  | {
      status: "failed";
      createdAtMs: number;
      completedAtMs: number;
      error: { status: number; code: string; message: string };
    };

export interface LabJobRunResult<T> {
  value: T;
  replayed: boolean;
}

interface StoredLabJobRow {
  job_id: string;
  state: "pending" | "succeeded" | "failed";
  created_at_ms: string | number;
  completed_at_ms: string | number | null;
  expires_at_ms: string | number;
  value_json: unknown | null;
  replayed: boolean | null;
  error_json: unknown | null;
}

const TABLE = "bayti_core_lab_jobs";
const SCHEMA_LOCK_NAME = "bayti_core_lab_jobs_schema_v1";
const DEFAULT_INTERRUPTED_AFTER_MS = 10 * 60_000;

function asMilliseconds(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("Invalid lab-job timestamp.");
  return parsed;
}

function rowToState<T>(row: StoredLabJobRow): LabJobState<T> {
  const createdAtMs = asMilliseconds(row.created_at_ms);
  if (row.state === "pending") return { status: "pending", createdAtMs };

  const completedAtMs = row.completed_at_ms === null
    ? createdAtMs
    : asMilliseconds(row.completed_at_ms);

  if (row.state === "failed") {
    const error = row.error_json as { status?: unknown; code?: unknown; message?: unknown } | null;
    return {
      status: "failed",
      createdAtMs,
      completedAtMs,
      error: {
        status: typeof error?.status === "number" ? error.status : 500,
        code: typeof error?.code === "string" ? error.code : "LAB_JOB_FAILED",
        message: typeof error?.message === "string" ? error.message : "Analysis job failed.",
      },
    };
  }

  if (row.value_json === null) throw new Error("Succeeded lab job is missing its result payload.");
  return {
    status: "succeeded",
    createdAtMs,
    completedAtMs,
    value: row.value_json as T,
    replayed: row.replayed === true,
  };
}

/**
 * Separates a long provider analysis from the browser HTTP connection.
 *
 * Production uses the same Postgres connection as the paid-analysis ledger to persist
 * UX job state. A pending record is written before the provider operation starts. This
 * means a Railway restart can recover completed/failed jobs instead of losing them from
 * RAM. Old pending jobs are failed closed after the provider timeout envelope; they are
 * never restarted automatically, so the paid-analysis idempotency guarantee remains the
 * authority for avoiding duplicate Tectly/Replicate runs.
 */
export class LabJobRegistry<T> {
  private readonly jobs = new Map<string, LabJobState<T>>();
  private readonly pool: Pool | null;
  private initialization: Promise<void> | null = null;

  constructor(
    private readonly ttlMs = 15 * 60_000,
    private readonly now: () => number = () => Date.now(),
    connectionString = process.env.BAYTI_CORE_IDEMPOTENCY_DATABASE_URL?.trim() || null,
    private readonly interruptedAfterMs = DEFAULT_INTERRUPTED_AFTER_MS,
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("Lab job TTL must be positive.");
    if (!Number.isFinite(interruptedAfterMs) || interruptedAfterMs <= 0) {
      throw new Error("Lab job interruption threshold must be positive.");
    }
    this.pool = connectionString ? new Pool({ connectionString }) : null;
    if (this.pool !== null) void this.restore();
  }

  private async initialize(): Promise<void> {
    if (this.pool === null) return;
    if (this.initialization === null) {
      this.initialization = (async () => {
        const client = await this.pool!.connect();
        try {
          await client.query("BEGIN");
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [SCHEMA_LOCK_NAME]);
          await client.query(`
            CREATE TABLE IF NOT EXISTS ${TABLE} (
              job_id TEXT PRIMARY KEY,
              state TEXT NOT NULL CHECK (state IN ('pending', 'succeeded', 'failed')),
              created_at_ms BIGINT NOT NULL,
              completed_at_ms BIGINT,
              expires_at_ms BIGINT NOT NULL,
              value_json JSONB,
              replayed BOOLEAN,
              error_json JSONB
            )
          `);
          await client.query(
            `CREATE INDEX IF NOT EXISTS ${TABLE}_expires_idx ON ${TABLE} (expires_at_ms)`,
          );
          await client.query("COMMIT");
        } catch (error) {
          try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
          throw error;
        } finally {
          client.release();
        }
      })();
    }
    await this.initialization;
  }

  private async restore(): Promise<void> {
    if (this.pool === null) return;
    try {
      await this.initialize();
      const now = this.now();
      await this.pool.query(`DELETE FROM ${TABLE} WHERE expires_at_ms <= $1`, [now]);
      const rows = await this.pool.query<StoredLabJobRow>(
        `SELECT job_id, state, created_at_ms, completed_at_ms, expires_at_ms, value_json, replayed, error_json
         FROM ${TABLE} WHERE expires_at_ms > $1`,
        [now],
      );
      for (const row of rows.rows) this.jobs.set(row.job_id, rowToState<T>(row));
      this.failInterruptedPendingJobs();
    } catch {
      // The paid-analysis ledger still protects provider cost. Lab persistence is a UX
      // hardening layer, so a startup restore failure must not crash the service.
    }
  }

  private failInterruptedPendingJobs(): void {
    const now = this.now();
    for (const [jobId, job] of this.jobs) {
      if (job.status !== "pending" || now - job.createdAtMs < this.interruptedAfterMs) continue;
      const failed: LabJobState<T> = {
        status: "failed",
        createdAtMs: job.createdAtMs,
        completedAtMs: now,
        error: {
          status: 503,
          code: "ANALYSIS_JOB_INTERRUPTED",
          message: "The analysis worker was interrupted. The paid analysis will not be restarted automatically; inspect the prior provider run before intentionally starting a new one.",
        },
      };
      this.jobs.set(jobId, failed);
      void this.persist(jobId, failed);
    }
  }

  private cleanup(): void {
    this.failInterruptedPendingJobs();
    const cutoff = this.now() - this.ttlMs;
    for (const [id, job] of this.jobs) {
      const timestamp = job.status === "pending" ? job.createdAtMs : job.completedAtMs;
      if (timestamp <= cutoff) this.jobs.delete(id);
    }
  }

  private async persist(jobId: string, state: LabJobState<T>): Promise<void> {
    if (this.pool === null) return;
    await this.initialize();
    const completedAtMs = state.status === "pending" ? null : state.completedAtMs;
    const value = state.status === "succeeded" ? JSON.stringify(state.value) : null;
    const replayed = state.status === "succeeded" ? state.replayed : null;
    const error = state.status === "failed" ? JSON.stringify(state.error) : null;
    await this.pool.query(
      `INSERT INTO ${TABLE}
         (job_id, state, created_at_ms, completed_at_ms, expires_at_ms, value_json, replayed, error_json)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb)
       ON CONFLICT (job_id) DO UPDATE SET
         state = EXCLUDED.state,
         created_at_ms = EXCLUDED.created_at_ms,
         completed_at_ms = EXCLUDED.completed_at_ms,
         expires_at_ms = EXCLUDED.expires_at_ms,
         value_json = EXCLUDED.value_json,
         replayed = EXCLUDED.replayed,
         error_json = EXCLUDED.error_json`,
      [
        jobId,
        state.status,
        state.createdAtMs,
        completedAtMs,
        state.createdAtMs + this.ttlMs,
        value,
        replayed,
        error,
      ],
    );
  }

  start(
    run: () => Promise<LabJobRunResult<T>>,
    mapError: (error: unknown) => { status: number; code: string; message: string },
  ): string {
    this.cleanup();
    const jobId = randomUUID();
    const createdAtMs = this.now();
    const pending: LabJobState<T> = { status: "pending", createdAtMs };
    this.jobs.set(jobId, pending);

    setImmediate(() => {
      void (async () => {
        if (this.pool !== null) {
          try {
            // Fail closed before provider work if persistent lab tracking was configured
            // but the pending job cannot be durably recorded.
            await this.persist(jobId, pending);
          } catch {
            const failed: LabJobState<T> = {
              status: "failed",
              createdAtMs,
              completedAtMs: this.now(),
              error: {
                status: 503,
                code: "LAB_JOB_PERSISTENCE_FAILED",
                message: "Could not persist the analysis job before provider execution. No paid analysis was started.",
              },
            };
            this.jobs.set(jobId, failed);
            return;
          }
        }

        try {
          const result = await run();
          const succeeded: LabJobState<T> = {
            status: "succeeded",
            createdAtMs,
            completedAtMs: this.now(),
            value: result.value,
            replayed: result.replayed,
          };
          this.jobs.set(jobId, succeeded);
          try { await this.persist(jobId, succeeded); } catch { /* result remains in memory */ }
        } catch (error: unknown) {
          const failed: LabJobState<T> = {
            status: "failed",
            createdAtMs,
            completedAtMs: this.now(),
            error: mapError(error),
          };
          this.jobs.set(jobId, failed);
          try { await this.persist(jobId, failed); } catch { /* error remains in memory */ }
        }
      })();
    });

    return jobId;
  }

  get(jobId: string): LabJobState<T> | null {
    this.cleanup();
    return this.jobs.get(jobId) ?? null;
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }
}
