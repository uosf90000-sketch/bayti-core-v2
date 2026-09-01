import { describe, expect, it } from "vitest";
import type { CanonicalPlan } from "../src/domain/canonical.js";
import { assessGeometryQuality } from "../src/quality.js";
import { validateCanonicalPlan } from "../src/validation.js";

function validPlan(): CanonicalPlan {
  return {
    schemaVersion: "2.2",
    sourceImage: { widthPx: 1000, heightPx: 1000, mimeType: "image/jpeg" },
    scale: {
      metersPerPixelX: 0.01,
      metersPerPixelY: 0.01,
      metersPerNormalizedX: 10,
      metersPerNormalizedY: 10,
      source: "tectly",
      confidence: 0.9,
    },
    walls: [
      {
        id: "wall-1",
        footprint: [
          { x: 0.1, y: 0.1 },
          { x: 0.8, y: 0.1 },
          { x: 0.8, y: 0.15 },
          { x: 0.1, y: 0.15 },
        ],
        geometry: null,
        thicknessMeters: null,
        confidence: {
          score: 0.95,
          agreement: "confirmed",
          evidence: [{ provider: "tectly", providerElementId: "w1", confidence: 0.8 }],
        },
      },
    ],
    openings: [
      {
        id: "opening-1",
        kind: "door",
        centerLine: { start: { x: 0.2, y: 0.1 }, end: { x: 0.3, y: 0.1 } },
        hostWallId: "wall-1",
        widthMeters: 1,
        connectedRoomIds: ["room-1"],
        connectsToExterior: true,
        confidence: {
          score: 0.96,
          agreement: "confirmed",
          evidence: [{ provider: "tectly", providerElementId: "o1", confidence: 0.82 }],
        },
      },
    ],
    rooms: [
      {
        id: "room-1",
        label: "Room",
        polygon: [
          { x: 0.1, y: 0.15 },
          { x: 0.8, y: 0.15 },
          { x: 0.8, y: 0.8 },
          { x: 0.1, y: 0.8 },
        ],
        areaSquareMeters: 20,
        confidence: {
          score: 0.85,
          agreement: "single-source",
          evidence: [{ provider: "tectly", providerElementId: "r1", confidence: 0.85 }],
        },
      },
    ],
    reviewCandidates: [],
    qa: { status: "pass", conflicts: [], notes: [] },
  };
}

describe("canonical plan validation", () => {
  it("accepts a well-formed canonical plan", () => {
    expect(validateCanonicalPlan(validPlan())).toEqual({ valid: true, errors: [], warnings: [] });
  });

  it("rejects degenerate wall polygons, zero-length openings and missing topology references", () => {
    const plan = validPlan();
    plan.walls[0]!.footprint = [
      { x: 0.1, y: 0.1 },
      { x: 0.2, y: 0.1 },
      { x: 0.3, y: 0.1 },
    ];
    plan.openings[0]!.centerLine.end = { ...plan.openings[0]!.centerLine.start };
    plan.openings[0]!.hostWallId = "wall-missing";
    plan.openings[0]!.connectedRoomIds = ["room-missing"];

    const validation = validateCanonicalPlan(plan);
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((error) => error.includes("zero-area footprint"))).toBe(true);
    expect(validation.errors.some((error) => error.includes("zero-length center line"))).toBe(true);
    expect(validation.errors.some((error) => error.includes("missing host wall"))).toBe(true);
    expect(validation.errors.some((error) => error.includes("missing connected room"))).toBe(true);

    const quality = assessGeometryQuality(plan);
    expect(quality.status).toBe("blocked");
    expect(quality.blockers.some((blocker) => blocker.startsWith("Invalid canonical geometry:"))).toBe(true);
  });
});
