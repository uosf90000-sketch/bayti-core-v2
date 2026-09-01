import { randomUUID } from "node:crypto";

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

/**
 * Separates a long provider analysis from the browser HTTP connection. The paid-analysis
 * boundary remains owned by the persistent IdempotencyRegistry used inside `run`; this
 * class only tracks lab UX state. A process restart may lose this transient status, but
 * the durable paid-analysis ledger still fails closed and prevents a blind re-upload.
 */
export class LabJobRegistry<T> {
  private readonly jobs = new Map<string, LabJobState<T>>();

  constructor(
    private readonly ttlMs = 15 * 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("Lab job TTL must be positive.");
  }

  private cleanup(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, job] of this.jobs) {
      const timestamp = job.status === "pending" ? job.createdAtMs : job.completedAtMs;
      if (timestamp <= cutoff) this.jobs.delete(id);
    }
  }

  start(
    run: () => Promise<LabJobRunResult<T>>,
    mapError: (error: unknown) => { status: number; code: string; message: string },
  ): string {
    this.cleanup();
    const jobId = randomUUID();
    const createdAtMs = this.now();
    this.jobs.set(jobId, { status: "pending", createdAtMs });

    setImmediate(() => {
      void run()
        .then((result) => {
          this.jobs.set(jobId, {
            status: "succeeded",
            createdAtMs,
            completedAtMs: this.now(),
            value: result.value,
            replayed: result.replayed,
          });
        })
        .catch((error: unknown) => {
          this.jobs.set(jobId, {
            status: "failed",
            createdAtMs,
            completedAtMs: this.now(),
            error: mapError(error),
          });
        });
    });

    return jobId;
  }

  get(jobId: string): LabJobState<T> | null {
    this.cleanup();
    return this.jobs.get(jobId) ?? null;
  }
}
