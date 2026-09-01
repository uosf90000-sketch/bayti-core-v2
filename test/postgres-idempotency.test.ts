import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { PersistedIdempotencyEntry } from "../src/idempotency.js";
import { PostgresIdempotencyStore } from "../src/postgres-idempotency.js";

const connectionString = process.env.TEST_POSTGRES_URL;
const describePostgres = connectionString ? describe : describe.skip;

describePostgres("PostgresIdempotencyStore integration", () => {
  if (!connectionString) return;

  const storeA = new PostgresIdempotencyStore<{ result: string }>(connectionString);
  const storeB = new PostgresIdempotencyStore<{ result: string }>(connectionString);

  afterAll(async () => {
    await Promise.all([storeA.close(), storeB.close()]);
  });

  it("atomically allows only one replica to claim the same paid analysis", async () => {
    const key = `pg-${randomUUID()}`;
    const pending: Extract<PersistedIdempotencyEntry<{ result: string }>, { state: "pending" }> = {
      fingerprint: "fingerprint-a",
      state: "pending",
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    };

    const [a, b] = await Promise.all([
      storeA.claim(key, "fingerprint-a", pending),
      storeB.claim(key, "fingerprint-a", pending),
    ]);

    expect([a.claimed, b.claimed].filter(Boolean)).toHaveLength(1);
    const loser = a.claimed ? b : a;
    expect(loser.claimed).toBe(false);
    if (!loser.claimed) {
      expect(loser.entry.state).toBe("pending");
      expect(loser.entry.fingerprint).toBe("fingerprint-a");
    }

    await storeA.set(key, {
      fingerprint: "fingerprint-a",
      state: "fulfilled",
      createdAtMs: pending.createdAtMs,
      expiresAtMs: pending.expiresAtMs,
      value: { result: "done" },
    });
    await expect(storeB.get(key)).resolves.toMatchObject({
      state: "fulfilled",
      value: { result: "done" },
    });
  });

  it("does not let a different request fingerprint steal an unexpired claim", async () => {
    const key = `pg-${randomUUID()}`;
    const now = Date.now();
    const first = await storeA.claim(key, "fingerprint-a", {
      fingerprint: "fingerprint-a",
      state: "pending",
      createdAtMs: now,
      expiresAtMs: now + 60_000,
    });
    expect(first.claimed).toBe(true);

    const second = await storeB.claim(key, "fingerprint-b", {
      fingerprint: "fingerprint-b",
      state: "pending",
      createdAtMs: now + 1,
      expiresAtMs: now + 60_001,
    });
    expect(second.claimed).toBe(false);
    if (!second.claimed) expect(second.entry.fingerprint).toBe("fingerprint-a");
  });

  it("replaces an expired claim atomically", async () => {
    const key = `pg-${randomUUID()}`;
    const now = Date.now();
    const first = await storeA.claim(key, "fingerprint-a", {
      fingerprint: "fingerprint-a",
      state: "pending",
      createdAtMs: now - 1_000,
      expiresAtMs: now - 1,
    });
    expect(first.claimed).toBe(true);

    const replacement = await storeB.claim(key, "fingerprint-b", {
      fingerprint: "fingerprint-b",
      state: "pending",
      createdAtMs: now,
      expiresAtMs: now + 60_000,
    });
    expect(replacement.claimed).toBe(true);

    await expect(storeA.get(key)).resolves.toMatchObject({
      state: "pending",
      fingerprint: "fingerprint-b",
    });
  });
});
