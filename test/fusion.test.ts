import { describe, expect, it } from "vitest";
import { fuseTectlyWithReplicate } from "../src/fusion/fuse.js";
import { mapTectlyBundleToCanonical } from "../src/providers/tectly-mapper.js";
import type { ReplicateVerifierResult } from "../src/providers/types.js";
import type { TectlyPlanBundle } from "../src/providers/tectly-types.js";

function primaryPlan() {
  const bundle: TectlyPlanBundle = {
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
    rooms: [{ id: "room-a", caption: "Room", type: "Bedroom", area: 12, boundary: [[0.1, 0.15], [0.9, 0.15], [0.9, 0.9], [0.1, 0.9]] }],
    wallOpenings: [{ id: "door-a", rooms: ["room-a"], details: { type: "Door", hinge: [0.3, 0.1], closed: [0.4, 0.1], open: [0.3, 0.2] } }],
  };
  return mapTectlyBundleToCanonical(bundle, { widthPx: 1000, heightPx: 1000, mimeType: "image/jpeg" });
}

function verifier(overrides: Partial<ReplicateVerifierResult> = {}): ReplicateVerifierResult {
  return {
    meta: { provider: "replicate", requestId: "r1" },
    wallContours: [[[0.09, 0.09], [0.91, 0.09], [0.91, 0.16], [0.09, 0.16]].map(([x, y]) => ({ x: x ?? 0, y: y ?? 0 }))],
    doorContours: [],
    entryDoorContours: [],
    windowContours: [],
    kitchenContours: [],
    doorCenterLines: [[{ x: 0.3, y: 0.1 }, { x: 0.4, y: 0.1 }]],
    entryDoorCenterLines: [],
    windowCenterLines: [],
    raw: {},
    ...overrides,
  };
}

describe("Tectly + Replicate fusion", () => {
  it("raises confidence when independent wall/opening evidence agrees without replacing Tectly geometry", () => {
    const primary = primaryPlan();
    const originalFootprint = primary.walls[0]?.footprint;
    const fused = fuseTectlyWithReplicate(primary, verifier());

    expect(fused.walls[0]?.footprint).toEqual(originalFootprint);
    expect(fused.walls[0]?.confidence.agreement).toBe("confirmed");
    expect(fused.openings[0]?.confidence.agreement).toBe("confirmed");
    expect(fused.walls[0]?.confidence.score).toBeGreaterThanOrEqual(0.9);
  });

  it("keeps a Replicate-only suspicious opening as review evidence instead of accepting it", () => {
    const fused = fuseTectlyWithReplicate(
      primaryPlan(),
      verifier({
        windowCenterLines: [[{ x: 0.1, y: 0.2 }, { x: 0.9, y: 0.9 }]],
      }),
    );

    expect(fused.openings).toHaveLength(1);
    expect(fused.reviewCandidates.some((candidate) => candidate.kind === "window")).toBe(true);
    expect(fused.qa.status).toBe("review");
  });
});
