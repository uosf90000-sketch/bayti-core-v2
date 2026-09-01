import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  FileIdempotencyStore,
  IdempotencyRegistry,
} from "../src/idempotency.js";

describe("IdempotencyRegistry", () => {
  it("replays the same logical request without invoking the paid operation twice", async () => {
    const registry = new IdempotencyRegistry<string>();
    const operation = vi.fn(async () => "result");

    const first = await registry.run("analysis-123", "fingerprint-a", operation);
    const second = await registry.run("analysis-123", "fingerprint-a", operation);

    expect(first).toEqual({ value: "result", replayed: false });
    expect(second).toEqual({ value: "result", replayed: true });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("coalesces simultaneous requests before either can start a second paid operation", async () => {
    const registry = new IdempotencyRegistry<string>();
    let release: ((value: string) => void) | undefined;
    const providerResult = new Promise<string>((resolve) => {
      release = resolve;
    });
    const operation = vi.fn(() => providerResult);

    const firstPromise = registry.run("analysis-123", "fingerprint-a", operation);
    const secondPromise = registry.run("analysis-123", "fingerprint-a", operation);

    // Allow the first execution to reach the provider operation.
    await Promise.resolve();
    await Promise.resolve();
    expect(operation).toHaveBeenCalledTimes(1);

    release?.("result");
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first).toEqual({ value: "result", replayed: false });
    expect(second).toEqual({ value: "result", replayed: true });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("rejects reuse of a key for a different request", async () => {
    const registry = new IdempotencyRegistry<string>();
    await registry.run("analysis-123", "fingerprint-a", async () => "first");

    await expect(
      registry.run("analysis-123", "fingerprint-b", async () => "second"),
    ).rejects.toThrow("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST");
  });

  it("retains a failed operation during the TTL so a retry cannot silently double-charge", async () => {
    const registry = new IdempotencyRegistry<string>();
    const operation = vi.fn(async () => {
      throw new Error("provider failed after upload");
    });

    await expect(registry.run("analysis-123", "fingerprint-a", operation)).rejects.toThrow(
      "provider failed after upload",
    );
    await expect(registry.run("analysis-123", "fingerprint-a", operation)).rejects.toThrow(
      "provider failed after upload",
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("allows a new operation after the TTL expires", async () => {
    let now = 1_000;
    const registry = new IdempotencyRegistry<string>(100, () => now);
    const operation = vi.fn(async () => `run-${operation.mock.calls.length}`);

    const first = await registry.run("analysis-123", "fingerprint-a", operation);
    now += 101;
    const second = await registry.run("analysis-123", "fingerprint-a", operation);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(false);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("replays a completed paid analysis after a process restart when file persistence is configured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bayti-idempotency-"));
    try {
      const operation = vi.fn(async () => ({ plans: 1 }));
      const firstRegistry = new IdempotencyRegistry(
        60_000,
        () => 1_000,
        new FileIdempotencyStore<{ plans: number }>(directory),
      );
      const first = await firstRegistry.run("analysis-123", "fingerprint-a", operation);

      const afterRestart = new IdempotencyRegistry(
        60_000,
        () => 1_500,
        new FileIdempotencyStore<{ plans: number }>(directory),
      );
      const replay = await afterRestart.run("analysis-123", "fingerprint-a", operation);

      expect(first).toEqual({ value: { plans: 1 }, replayed: false });
      expect(replay).toEqual({ value: { plans: 1 }, replayed: true });
      expect(operation).toHaveBeenCalledTimes(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses to repeat an interrupted pending paid analysis after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bayti-idempotency-"));
    try {
      const store = new FileIdempotencyStore<string>(directory);
      await store.set("analysis-123", {
        fingerprint: "fingerprint-a",
        state: "pending",
        createdAtMs: 1_000,
        expiresAtMs: 61_000,
      });

      const afterRestart = new IdempotencyRegistry(60_000, () => 1_500, store);
      const operation = vi.fn(async () => "must-not-run");

      await expect(
        afterRestart.run("analysis-123", "fingerprint-a", operation),
      ).rejects.toThrow("IDEMPOTENCY_REQUEST_IN_PROGRESS_OR_INTERRUPTED");
      expect(operation).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
