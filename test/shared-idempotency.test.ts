import { describe, expect, it, vi } from "vitest";
import type {
  IdempotencyClaimResult,
  IdempotencyStore,
  PersistedIdempotencyEntry,
} from "../src/idempotency.js";
import { IdempotencyRegistry } from "../src/idempotency.js";

class SharedAtomicStore<T> implements IdempotencyStore<T> {
  readonly mode = "postgres" as const;
  private readonly entries = new Map<string, PersistedIdempotencyEntry<T>>();

  async get(key: string): Promise<PersistedIdempotencyEntry<T> | null> {
    return this.entries.get(key) ?? null;
  }

  async claim(
    key: string,
    _fingerprint: string,
    pending: Extract<PersistedIdempotencyEntry<T>, { state: "pending" }>,
  ): Promise<IdempotencyClaimResult<T>> {
    const current = this.entries.get(key);
    if (current === undefined || current.expiresAtMs <= pending.createdAtMs) {
      this.entries.set(key, pending);
      return { claimed: true };
    }
    return { claimed: false, entry: current };
  }

  async set(key: string, entry: PersistedIdempotencyEntry<T>): Promise<void> {
    this.entries.set(key, entry);
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

describe("shared atomic idempotency store", () => {
  it("allows only one replica to cross the paid provider start boundary", async () => {
    const store = new SharedAtomicStore<string>();
    const replicaA = new IdempotencyRegistry(60_000, () => 1_000, store);
    const replicaB = new IdempotencyRegistry(60_000, () => 1_000, store);

    let markStarted: (() => void) | undefined;
    let releaseProvider: ((value: string) => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const providerResult = new Promise<string>((resolve) => {
      releaseProvider = resolve;
    });
    const operation = vi.fn(() => {
      markStarted?.();
      return providerResult;
    });

    const first = replicaA.run("analysis-123", "fingerprint-a", operation);
    await started;

    await expect(
      replicaB.run("analysis-123", "fingerprint-a", operation),
    ).rejects.toThrow("IDEMPOTENCY_REQUEST_IN_PROGRESS_OR_INTERRUPTED");
    expect(operation).toHaveBeenCalledTimes(1);

    releaseProvider?.("result");
    await expect(first).resolves.toEqual({ value: "result", replayed: false });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("allows an expired shared claim to be replaced atomically", async () => {
    const store = new SharedAtomicStore<string>();
    const old = new IdempotencyRegistry(100, () => 1_000, store);
    await old.run("analysis-123", "fingerprint-a", async () => "old");

    const afterExpiry = new IdempotencyRegistry(100, () => 1_101, store);
    const next = await afterExpiry.run("analysis-123", "fingerprint-a", async () => "new");

    expect(next).toEqual({ value: "new", replayed: false });
  });
});
