import { describe, expect, it } from "vitest";
import type { CanonicalPlan } from "../src/domain/canonical.js";
import { assessGeometryQuality } from "../src/quality.js";
import { buildBaytiRenderContract } from "../src/render-contract.js";

function plan(): CanonicalPlan {
  return {
    schemaVersion: "2.1",
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
        // L-shaped footprint deliberately has no fake straight centerline.
        footprint: [
          { x: 0.1, y: 0.1 },
          { x: 0.6, y: 0.1 },
          { x: 0.6, y: 0.2 },
          { x: 0.2, y: 0.2 },
          { x: 0.2, y: 0.6 },
          { x: 0.1, y: 0.6 },
        ],
        geometry: null,
        thicknessMeters: null,
        confidence: {
          score: 0.95,
          agreement: "confirmed",
          evidence: [
            { provider: "tectly", providerElementId: "w1", confidence: 0.8 },
            { provider: "replicate", providerElementId: "rw1", confidence: 0.9 },
          ],
        },
      },
    ],
    openings: [
      {
        id: "opening-1",
        kind: "door",
        centerLine: { start: { x: 0.25, y: 0.1 }, end: { x: 0.35, y: 0.1 } },
        hostWallId: "wall-1",
        widthMeters: 1,
        confidence: {
          score: 0.96,
          agreement: "confirmed",
          evidence: [
            { provider: "tectly", providerElementId: "o1", confidence: 0.82 },
            { provider: "replicate", providerElementId: "ro1", confidence: 0.9 },
          ],
        },
      },
    ],
    rooms: [
      {
        id: "room-1",
        label: "Living",
        polygon: [
          { x: 0.2, y: 0.2 },
          { x: 0.6, y: 0.2 },
          { x: 0.6, y: 0.6 },
          { x: 0.2, y: 0.6 },
        ],
        areaSquareMeters: 16,
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

describe("geometry quality and render contract", () => {
  it("allows a complex footprint to pass without inventing a straight wall", () => {
    const report = assessGeometryQuality(plan());
    expect(report.status).toBe("pass");
    expect(report.metrics.complexWallCount).toBe(1);
  });

  it("blocks room-level product geometry when rooms or scale are missing", () => {
    const missing = plan();
    missing.rooms = [];
    missing.scale = {
      metersPerPixelX: null,
      metersPerPixelY: null,
      metersPerNormalizedX: null,
      metersPerNormalizedY: null,
      source: "unknown",
      confidence: 0,
    };

    const report = assessGeometryQuality(missing);
    expect(report.status).toBe("blocked");
    expect(report.blockers).toContain("No room polygons are available for room-level design.");
    expect(report.blockers).toContain("Complete real-world X/Y scale is unknown.");
  });

  it("preserves polygon-only walls in the future 3D handoff", () => {
    const contract = buildBaytiRenderContract(plan());
    expect(contract.quality.status).toBe("pass");
    expect(contract.walls[0]?.geometry).toBeNull();
    expect(contract.walls[0]?.footprint).toHaveLength(6);
    expect(contract.openings).toHaveLength(1);
    expect(contract.unresolvedOpenings).toHaveLength(0);
    expect(contract.verticalDimensions).toBe("consumer-supplied");
  });

  it("never creates an automatic wall cut for an opening with ambiguous host/width", () => {
    const ambiguous = plan();
    const opening = ambiguous.openings[0];
    if (!opening) throw new Error("fixture opening missing");
    opening.hostWallId = null;
    opening.widthMeters = null;

    const contract = buildBaytiRenderContract(ambiguous);
    expect(contract.openings).toHaveLength(0);
    expect(contract.unresolvedOpenings[0]?.reasons).toEqual([
      "missing-host-wall",
      "missing-physical-width",
    ]);
  });
});
