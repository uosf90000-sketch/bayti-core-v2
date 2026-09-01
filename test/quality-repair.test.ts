import { describe, expect, it } from "vitest";
import type { CanonicalPlan } from "../src/domain/canonical.js";
import { assessGeometryQuality } from "../src/quality.js";

function repairedPlan(): CanonicalPlan {
  return {
    schemaVersion: "2.2",
    sourceImage: { widthPx: 1000, heightPx: 1000, mimeType: "image/jpeg" },
    scale: {
      metersPerPixelX: 0.01,
      metersPerPixelY: 0.01,
      metersPerNormalizedX: 10,
      metersPerNormalizedY: 10,
      source: "manual",
      confidence: 0.95,
    },
    walls: [
      {
        id: "wall-1",
        footprint: [
          { x: 0.1, y: 0.1 },
          { x: 0.9, y: 0.1 },
          { x: 0.9, y: 0.12 },
          { x: 0.1, y: 0.12 },
        ],
        geometry: null,
        thicknessMeters: 0.2,
        confidence: { score: 0.95, agreement: "confirmed", evidence: [] },
      },
    ],
    openings: [
      {
        id: "opening-1",
        kind: "door",
        centerLine: { start: { x: 0.4, y: 0.11 }, end: { x: 0.5, y: 0.11 } },
        hostWallId: "wall-1",
        supportingWallIds: ["wall-1"],
        widthMeters: 1,
        connectedRoomIds: ["room-1"],
        connectsToExterior: null,
        confidence: { score: 0.96, agreement: "confirmed", evidence: [] },
      },
    ],
    rooms: [
      {
        id: "room-1",
        label: "Room",
        polygon: [
          { x: 0.2, y: 0.2 },
          { x: 0.8, y: 0.2 },
          { x: 0.8, y: 0.8 },
          { x: 0.2, y: 0.8 },
        ],
        areaSquareMeters: 36,
        confidence: { score: 0.9, agreement: "confirmed", evidence: [] },
      },
    ],
    reviewCandidates: [],
    qa: { status: "blocked", conflicts: [], notes: ["old source-stage blocker"] },
  };
}

describe("quality after deterministic repairs", () => {
  it("does not inherit a stale source-stage BLOCKED forever", () => {
    const report = assessGeometryQuality(repairedPlan());
    expect(report.status).toBe("review");
    expect(report.blockers).toEqual([]);
    expect(report.reviewReasons.join(" ")).toContain("previously blocked");
  });

  it("still blocks when a concrete current requirement is missing", () => {
    const plan = repairedPlan();
    plan.scale = {
      metersPerPixelX: null,
      metersPerPixelY: null,
      metersPerNormalizedX: null,
      metersPerNormalizedY: null,
      source: "unknown",
      confidence: 0,
    };
    const report = assessGeometryQuality(plan);
    expect(report.status).toBe("blocked");
    expect(report.blockers).toContain("Complete real-world X/Y scale is unknown.");
  });
});
