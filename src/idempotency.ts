import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface IdempotentRunResult<T> {
  value: T;
  replayed: boolean;
}

export type PersistedIdempotencyEntry<T> =
  | {
      fingerprint: string;
      state: "pending";
      expiresAtMs: number;
      createdAtMs: number;
    }
  | {
      fingerprint: string;
      state: "fulfilled";
      expiresAtMs: number;
      createdAtMs: number;
      value: T;
    }
  | {
      fingerprint: string;
      state: "rejected";
      expiresAtMs: number;
      createdAtMs: number;
      errorMessage: string;
    };

export type IdempotencyStoreMode = "memory" | "file" | "postgres";

export type IdempotencyClaimResult<T> =
  | { claimed: true }
  | { claimed: false; entry: PersistedIdempotencyEntry<T> };

export interface IdempotencyStore<T> {
  readonly mode: IdempotencyStoreMode;
  get(key: string): Promise<PersistedIdempotencyEntry<T> | null>;
  set(key: string, entry: PersistedIdempotencyEntry<T>): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * Optional cross-process atomic claim. Shared stores should implement this so only
   * one replica can create/replace an expired pending record for a logical request.
   */
  claim?(
    key: string,
    fingerprint: string,
    pending: Extract<PersistedIdempotencyEntry<T>, { state: "pending" }>,
  ): Promise<IdempotencyClaimResult<T>>;
  probe?(): Promise<void>;
  close?(): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class MemoryIdempotencyStore<T> implements IdempotencyStore<T> {
  readonly mode = "memory" as const;
  private readonly entries = new Map<string, PersistedIdempotencyEntry<T>>();

  async get(key: string): Promise<PersistedIdempotencyEntry<T> | null> {
    return this.entries.get(key) ?? null;
  }

  async set(key: string, entry: PersistedIdempotencyEntry<T>): Promise<void> {
    this.entries.set(key, entry);
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

/**
 * Restart-safe single-replica store. Point `directory` at a mounted persistent volume.
 * File names are hashes, so caller-provided idempotency keys never become paths.
 *
 * The atomic temp-file + rename write protects against partial JSON records. This store
 * intentionally targets one application replica. Multi-replica deployments should use
 * a shared store with atomic `claim`, such as Postgres.
 */
export class FileIdempotencyStore<T> implements IdempotencyStore<T> {
  readonly mode = "file" as const;

  constructor(private readonly directory: string) {
    if (directory.trim().length === 0) {
      throw new Error("Persistent idempotency directory must not be empty.");
    }
  }

  private pathFor(key: string): string {
    const name = createHash("sha256").update(key).digest("hex");
    return join(this.directory, `${name}.json`);
  }

  async probe(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, `.probe-${randomUUID()}`);
    await writeFile(path, "ok", { encoding: "utf8", flag: "wx" });
    await unlink(path);
  }

  async get(key: string): Promise<PersistedIdempotencyEntry<T> | null> {
    await mkdir(this.directory, { recursive: true });
    try {
      const raw = await readFile(this.pathFor(key), "utf8");
      return JSON.parse(raw) as PersistedIdempotencyEntry<T>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async set(key: string, entry: PersistedIdempotencyEntry<T>): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const target = this.pathFor(key);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(entry), { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.pathFor(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

interface InFlightEntry<T> {
  fingerprint: string;
  promise: Promise<IdempotentRunResult<T>>;
}

/**
 * Guard against accidental duplicate paid analyses.
 *
 * The in-process reservation is installed synchronously before any persistent-store
 * await. Shared stores can additionally implement atomic `claim`, which closes the same
 * race across multiple application replicas. A durable pending record exists before the
 * quota-bearing provider operation starts; interrupted requests are never blindly rerun.
 */
export class IdempotencyRegistry<T> {
  private readonly inFlight = new Map<string, InFlightEntry<T>>();

  constructor(
    private readonly ttlMs = 30 * 60_000,
    private readonly now: () => number = () => Date.now(),
    private readonly store: IdempotencyStore<T> = new MemoryIdempotencyStore<T>(),
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("Idempotency TTL must be positive.");
    }
  }

  get mode(): IdempotencyStoreMode {
    return this.store.mode;
  }

  async probe(): Promise<void> {
    await this.store.probe?.();
  }

  async close(): Promise<void> {
    await this.store.close?.();
  }

  private async existing(key: string): Promise<PersistedIdempotencyEntry<T> | null> {
    const entry = await this.store.get(key);
    if (entry === null) return null;
    if (entry.expiresAtMs <= this.now()) {
      await this.store.delete(key);
      return null;
    }
    return entry;
  }

  private replayOrThrow(
    fingerprint: string,
    persisted: PersistedIdempotencyEntry<T>,
  ): IdempotentRunResult<T> {
    if (persisted.fingerprint !== fingerprint) {
      throw new Error("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST");
    }
    if (persisted.state === "fulfilled") {
      return { value: persisted.value, replayed: true };
    }
    if (persisted.state === "rejected") {
      throw new Error(persisted.errorMessage);
    }
    throw new Error("IDEMPOTENCY_REQUEST_IN_PROGRESS_OR_INTERRUPTED");
  }

  private async execute(
    key: string,
    fingerprint: string,
    operation: () => Promise<T>,
  ): Promise<IdempotentRunResult<T>> {
    const createdAtMs = this.now();
    const expiresAtMs = createdAtMs + this.ttlMs;
    const pending: Extract<PersistedIdempotencyEntry<T>, { state: "pending" }> = {
      fingerprint,
      state: "pending",
      createdAtMs,
      expiresAtMs,
    };

    if (this.store.claim !== undefined) {
      const claim = await this.store.claim(key, fingerprint, pending);
      if (!claim.claimed) return this.replayOrThrow(fingerprint, claim.entry);
    } else {
      const persisted = await this.existing(key);
      if (persisted !== null) return this.replayOrThrow(fingerprint, persisted);
      await this.store.set(key, pending);
    }

    try {
      const value = await operation();
      await this.store.set(key, {
        fingerprint,
        state: "fulfilled",
        createdAtMs,
        expiresAtMs,
        value,
      });
      return { value, replayed: false };
    } catch (error) {
      await this.store.set(key, {
        fingerprint,
        state: "rejected",
        createdAtMs,
        expiresAtMs,
        errorMessage: errorMessage(error),
      });
      throw error;
    }
  }

  async run(
    key: string,
    fingerprint: string,
    operation: () => Promise<T>,
  ): Promise<IdempotentRunResult<T>> {
    const active = this.inFlight.get(key);
    if (active !== undefined) {
      if (active.fingerprint !== fingerprint) {
        throw new Error("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST");
      }
      const result = await active.promise;
      return { value: result.value, replayed: true };
    }

    const promise = this.execute(key, fingerprint, operation);
    this.inFlight.set(key, { fingerprint, promise });

    try {
      return await promise;
    } finally {
      const current = this.inFlight.get(key);
      if (current?.promise === promise) this.inFlight.delete(key);
    }
  }
}
