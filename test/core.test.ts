import { describe, expect, it, vi } from "vitest";
import { analyzeBaytiCore } from "../src/core.js";
import { ReplicateFloorplanClient } from "../src/providers/replicate-client.js";
import { TectlyClient } from "../src/providers/tectly-client.js";
import type { TectlyDocumentAnalysis, TectlyPlanBundle } from "../src/providers/tectly-types.js";

function bundle(): TectlyPlanBundle {
  return {
    plan: {
      id: "plan",
      floorId: "floor",
      pageSection: { left: 0, top: 0, width: 1, height: 1 },
      wallOpeningProcessingStatus: "Positive",
      roomProcessingStatus: "Positive",
      wallProcessingStatus: "Positive",
      horizontalScaleProcessingStatus: "Positive",
      postProcessingStatus: "Positive",
    },
    floor: { id: "floor", horizontalScale: 0.1, verticalScale: 0.1 },
    walls: [{ id: "wall-a", boundary: [[0.1, 0.1], [0.9, 0.1], [0.9, 0.15], [0.1, 0.15]] }],
    rooms: [{ id: "room-a", caption: "Room", area: 12, boundary: [[0.1, 0.15], [0.9, 0.15], [0.9, 0.9], [0.1, 0.9]] }],
    wallOpenings: [],
  };
}

function tectlyAnalysis(): TectlyDocumentAnalysis {
  return {
    provider: "tectly",
    projectId: "project-1",
    documentId: "document-1",
    planBundles: [bundle()],
    raw: {},
  };
}

function input(verifierMode: "best-effort" | "required" = "best-effort") {
  return {
    tectlyFile: new Blob(["plan"], { type: "image/jpeg" }),
    fileName: "plan.jpg",
    sourceImage: { widthPx: 1000, heightPx: 1000, mimeType: "image/jpeg" },
    replicateImage: new Blob(["plan"], { type: "image/jpeg" }),
    verifierMode,
  } as const;
}

describe("Bayti Core verifier policy", () => {
  it("preserves the Tectly result when best-effort verification fails", async () => {
    const analyze = vi.fn(async () => tectlyAnalysis());
    const tectly = {
      authenticate: vi.fn(async () => undefined),
      analyze,
    } as unknown as TectlyClient;
    const replicate = {
      run: vi.fn(async () => {
        throw new Error("verifier outage");
      }),
    } as unknown as ReplicateFloorplanClient;

    const result = await analyzeBaytiCore(input(), { tectly, replicate });

    expect(analyze).toHaveBeenCalledTimes(1);
    expect(result.verifierStatus).toBe("failed");
    expect(result.replicateRequestId).toBeNull();
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]?.qa.status).toBe("review");
    expect(result.plans[0]?.qa.notes.some((note) => note.includes("verifier outage"))).toBe(true);
  });

  it("does not start a paid Tectly analysis when required verification fails", async () => {
    const analyze = vi.fn(async () => tectlyAnalysis());
    const tectly = {
      authenticate: vi.fn(async () => undefined),
      analyze,
    } as unknown as TectlyClient;
    const replicate = {
      run: vi.fn(async () => {
        throw new Error("required verifier failed");
      }),
    } as unknown as ReplicateFloorplanClient;

    await expect(analyzeBaytiCore(input("required"), { tectly, replicate })).rejects.toThrow(
      "required verifier failed",
    );
    expect(analyze).not.toHaveBeenCalled();
  });
});
