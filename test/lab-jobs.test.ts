import { describe, expect, it } from "vitest";
import { LabJobRegistry } from "../src/lab-jobs.js";

const waitFor = async <T>(read: () => T, predicate: (value: T) => boolean): Promise<T> => {
  for (let index = 0; index < 50; index += 1) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for lab job test.");
};

describe("LabJobRegistry", () => {
  it("returns immediately as pending and later exposes the successful result", async () => {
    const registry = new LabJobRegistry<string>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const jobId = registry.start(
      async () => {
        await gate;
        return { value: "done", replayed: false };
      },
      () => ({ status: 500, code: "TEST", message: "failed" }),
    );

    expect(registry.get(jobId)?.status).toBe("pending");
    release();
    const completed = await waitFor(() => registry.get(jobId), (job) => job?.status === "succeeded");
    expect(completed?.status).toBe("succeeded");
    if (completed?.status === "succeeded") expect(completed.value).toBe("done");
  });

  it("stores a safe structured failure for polling", async () => {
    const registry = new LabJobRegistry<string>();
    const jobId = registry.start(
      async () => { throw new Error("provider secret detail"); },
      () => ({ status: 502, code: "SAFE", message: "Provider failed safely." }),
    );

    const completed = await waitFor(() => registry.get(jobId), (job) => job?.status === "failed");
    expect(completed?.status).toBe("failed");
    if (completed?.status === "failed") {
      expect(completed.error.code).toBe("SAFE");
      expect(completed.error.message).not.toContain("secret");
    }
  });
});
