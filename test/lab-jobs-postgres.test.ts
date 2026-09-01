import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LabJobRegistry } from "../src/lab-jobs.js";

const connectionString = process.env.TEST_POSTGRES_URL;
const describePostgres = connectionString ? describe : describe.skip;

async function waitFor<T>(read: () => T, predicate: (value: T) => boolean): Promise<T> {
  for (let index = 0; index < 100; index += 1) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for durable lab job state.");
}

describePostgres("LabJobRegistry Postgres persistence", () => {
  if (!connectionString) return;

  it("restores a completed analysis job after a fresh registry instance starts", async () => {
    const registryA = new LabJobRegistry<{ marker: string }>(60_000, () => Date.now(), connectionString);
    const marker = randomUUID();
    const jobId = registryA.start(
      async () => ({ value: { marker }, replayed: false }),
      () => ({ status: 500, code: "TEST", message: "failed" }),
    );

    const first = await waitFor(
      () => registryA.get(jobId),
      (job) => job?.status === "succeeded",
    );
    expect(first?.status).toBe("succeeded");
    await registryA.close();

    const registryB = new LabJobRegistry<{ marker: string }>(60_000, () => Date.now(), connectionString);
    const restored = await waitFor(
      () => registryB.get(jobId),
      (job) => job?.status === "succeeded",
    );
    expect(restored?.status).toBe("succeeded");
    if (restored?.status === "succeeded") {
      expect(restored.value.marker).toBe(marker);
      expect(restored.replayed).toBe(false);
    }
    await registryB.close();
  });
});
