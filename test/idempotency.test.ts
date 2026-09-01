import { describe, expect, it, vi } from "vitest";
import { IdempotencyRegistry } from "../src/idempotency.js";

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
});
