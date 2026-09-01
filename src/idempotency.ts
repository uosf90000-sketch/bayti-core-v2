export interface IdempotentRunResult<T> {
  value: T;
  replayed: boolean;
}

interface RegistryEntry<T> {
  fingerprint: string;
  promise: Promise<T>;
  expiresAtMs: number;
}

/**
 * Process-local guard against accidental duplicate paid analyses.
 *
 * Completed successes AND failures are retained for the TTL. That is deliberate: if
 * Tectly accepted a quota-bearing upload and a later step failed, blindly retrying the
 * same request could charge twice. An operator can intentionally retry with a new key.
 *
 * This registry is not persistent across container restarts; callers still need stable
 * idempotency keys and a future persistent ledger for restart-safe deduplication.
 */
export class IdempotencyRegistry<T> {
  private readonly entries = new Map<string, RegistryEntry<T>>();

  constructor(
    private readonly ttlMs = 30 * 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("Idempotency TTL must be positive.");
    }
  }

  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAtMs <= now) this.entries.delete(key);
    }
  }

  async run(
    key: string,
    fingerprint: string,
    operation: () => Promise<T>,
  ): Promise<IdempotentRunResult<T>> {
    this.prune();
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new Error("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST");
      }
      return { value: await existing.promise, replayed: true };
    }

    const promise = operation();
    this.entries.set(key, {
      fingerprint,
      promise,
      expiresAtMs: this.now() + this.ttlMs,
    });

    return { value: await promise, replayed: false };
  }
}
