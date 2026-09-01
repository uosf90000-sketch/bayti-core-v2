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

export interface IdempotencyStore<T> {
  readonly mode: "memory" | "file";
  get(key: string): Promise<PersistedIdempotencyEntry<T> | null>;
  set(key: string, entry: PersistedIdempotencyEntry<T>): Promise<void>;
  delete(key: string): Promise<void>;
  probe?(): Promise<void>;
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
 * a transactional shared ledger (database/Redis) behind the same IdempotencyStore contract.
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
  promise: Promise<T>;
}

/**
 * Guard against accidental duplicate paid analyses.
 *
 * A durable `pending` record is written before the provider operation starts. If the
 * process crashes after a quota-bearing upload, a restart sees the pending record and
 * refuses to run the same key again instead of risking a second charge. Successful and
 * failed outcomes are replayed for the TTL. An intentional retry must use a new key.
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

  get mode(): IdempotencyStore<T>["mode"] {
    return this.store.mode;
  }

  async probe(): Promise<void> {
    await this.store.probe?.();
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
      return { value: await active.promise, replayed: true };
    }

    const persisted = await this.existing(key);
    if (persisted !== null) {
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

    const createdAtMs = this.now();
    const expiresAtMs = createdAtMs + this.ttlMs;
    await this.store.set(key, {
      fingerprint,
      state: "pending",
      createdAtMs,
      expiresAtMs,
    });

    const promise = operation();
    this.inFlight.set(key, { fingerprint, promise });

    try {
      const value = await promise;
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
    } finally {
      this.inFlight.delete(key);
    }
  }
}
