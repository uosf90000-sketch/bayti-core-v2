import { describe, expect, it } from "vitest";
import { fuseTectlyWithReplicate } from "../src/fusion/fuse.js";
import { mapTectlyBundleToCanonical } from "../src/providers/tectly-mapper.js";
import type { ReplicateVerifierResult } from "../src/providers/types.js";
import type { TectlyPlanBundle } from "../src/providers/tectly-types.js";

function verifier(kitchenContours: ReplicateVerifierResult["kitchenContours"]): ReplicateVerifierResult {
  return {
    meta: { provider: "replicate", requestId: "semantics" },
    wallContours: [],
    doorContours: [],
    entryDoorContours: [],
    windowContours: [],
    kitchenContours,
    doorCenterLines: [],
    entryDoorCenterLines: [],
    windowCenterLines: [],
    raw: {},
  };
}

function plan(labels: Array<string | null>) {
  const rooms: TectlyPlanBundle["rooms"] = labels.map((label, index) => {
    const left = 0.05 + index * 0.45;
    const right = left + 0.4;
    return {
      id: `room-${index + 1}`,
      caption: label ?? undefined,
      type: label === null ? undefined : "Other",
      area: 10,
      boundary: [
        [left, 0.2],
        [right, 0.2],
        [right, 0.8],
        [left, 0.8],
      ],
    };
  });

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
    walls: [
      { id: "wall", boundary: [[0.02, 0.1], [0.98, 0.1], [0.98, 0.15], [0.02, 0.15]] },
    ],
    rooms,
    wallOpenings: [],
  };

  return mapTectlyBundleToCanonical(bundle, {
    widthPx: 1000,
    heightPx: 1000,
    mimeType: "image/jpeg",
  });
}

describe("room semantic enrichment", () => {
  it("labels a generic room Kitchen only when one Replicate kitchen contour is unambiguous", () => {
    const primary = plan(["Other", "Other"]);
    const fused = fuseTectlyWithReplicate(
      primary,
      verifier([
        [
          { x: 0.12, y: 0.3 },
          { x: 0.30, y: 0.3 },
          { x: 0.30, y: 0.55 },
          { x: 0.12, y: 0.55 },
        ],
      ]),
    );

    expect(fused.rooms[0]?.label).toBe("Kitchen");
    expect(fused.rooms[1]?.label).toBe("Other");
    expect(fused.qa.notes.some((note) => note.includes("1 generic room(s) labelled Kitchen"))).toBe(true);
  });

  it("never overwrites a meaningful Tectly room label", () => {
    const primary = plan(["Bedroom"]);
    const fused = fuseTectlyWithReplicate(
      primary,
      verifier([
        [
          { x: 0.12, y: 0.3 },
          { x: 0.30, y: 0.3 },
          { x: 0.30, y: 0.55 },
          { x: 0.12, y: 0.55 },
        ],
      ]),
    );

    expect(fused.rooms[0]?.label).toBe("Bedroom");
  });

  it("ignores a kitchen contour that ambiguously spans two rooms", () => {
    const primary = plan(["Other", "Other"]);
    const fused = fuseTectlyWithReplicate(
      primary,
      verifier([
        [
          { x: 0.38, y: 0.3 },
          { x: 0.58, y: 0.3 },
          { x: 0.58, y: 0.55 },
          { x: 0.38, y: 0.55 },
        ],
      ]),
    );

    expect(fused.rooms.every((room) => room.label !== "Kitchen")).toBe(true);
    expect(fused.qa.notes.some((note) => note.includes("ambiguous kitchen contour"))).toBe(true);
  });
});
