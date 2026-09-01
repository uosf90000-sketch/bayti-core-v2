import { describe, expect, it } from "vitest";
import { applyManualScaleToAnalysisResult } from "../src/core.js";
import { deriveManualScale } from "../src/scale-calibration.js";
import type { CanonicalPlan } from "../src/domain/canonical.js";

const source = { widthPx: 2400, heightPx: 3322, mimeType: "image/jpeg" };

describe("manual scale calibration", () => {
  it("accepts two independent dimensions that agree on physical raster scale", () => {
    const result = deriveManualScale(
      [
        { start: { x: 0.1, y: 0.1 }, end: { x: 0.1 + 1600 / 2400, y: 0.1 }, meters: 16 },
        { start: { x: 0.1, y: 0.05 }, end: { x: 0.1, y: 0.05 + 2861 / 3322 }, meters: 28.61 },
      ],
      source,
    );

    expect(result.scale.source).toBe("manual");
    expect(result.scale.metersPerPixelX).toBeCloseTo(0.01, 8);
    expect(result.scale.metersPerPixelY).toBeCloseTo(0.01, 8);
    expect(result.scale.metersPerNormalizedX).toBeCloseTo(24, 8);
    expect(result.scale.metersPerNormalizedY).toBeCloseTo(33.22, 8);
    expect(result.relativeSpread).toBeLessThan(0.000001);
    expect(result.scale.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("fails closed when independent measurements disagree materially", () => {
    expect(() =>
      deriveManualScale(
        [
          { start: { x: 0.1, y: 0.1 }, end: { x: 0.6, y: 0.1 }, meters: 12 },
          { start: { x: 0.1, y: 0.1 }, end: { x: 0.1, y: 0.6 }, meters: 25 },
        ],
        source,
      ),
    ).toThrow("MANUAL_SCALE_MEASUREMENTS_CONFLICT");
  });

  it("recomputes physical opening width and room area without a provider call", () => {
    const plan: CanonicalPlan = {
      schemaVersion: "2.2",
      sourceImage: { widthPx: 1000, heightPx: 1000, mimeType: "image/jpeg" },
      scale: {
        metersPerPixelX: null,
        metersPerPixelY: null,
        metersPerNormalizedX: null,
        metersPerNormalizedY: null,
        source: "unknown",
        confidence: 0,
      },
      walls: [
        {
          id: "wall-1",
          footprint: [
            { x: 0.1, y: 0.09 },
            { x: 0.9, y: 0.09 },
            { x: 0.9, y: 0.11 },
            { x: 0.1, y: 0.11 },
          ],
          geometry: null,
          thicknessMeters: null,
          confidence: { score: 0.95, agreement: "confirmed", evidence: [] },
        },
      ],
      openings: [
        {
          id: "opening-1",
          kind: "door",
          centerLine: { start: { x: 0.4, y: 0.1 }, end: { x: 0.5, y: 0.1 } },
          hostWallId: "wall-1",
          supportingWallIds: ["wall-1"],
          widthMeters: null,
          connectedRoomIds: [],
          connectsToExterior: null,
          confidence: { score: 0.95, agreement: "confirmed", evidence: [] },
        },
      ],
      rooms: [
        {
          id: "room-1",
          label: "Room",
          polygon: [
            { x: 0.2, y: 0.2 },
            { x: 0.4, y: 0.2 },
            { x: 0.4, y: 0.4 },
            { x: 0.2, y: 0.4 },
          ],
          areaSquareMeters: null,
          confidence: { score: 0.85, agreement: "single-source", evidence: [] },
        },
      ],
      reviewCandidates: [],
      qa: { status: "review", conflicts: [], notes: [] },
    };

    const calibrated = applyManualScaleToAnalysisResult(
      {
        engineVersion: "0.8.0",
        tectlyProjectId: "project",
        tectlyDocumentId: "document",
        replicateRequestId: null,
        verifierStatus: "skipped",
        verifierMessage: null,
        plans: [plan],
        renderContracts: [],
      },
      [{ start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, meters: 10 }],
    );

    expect(calibrated.engineVersion).toBe("0.9.0");
    expect(calibrated.plans[0]!.openings[0]!.widthMeters).toBeCloseTo(1, 6);
    expect(calibrated.plans[0]!.rooms[0]!.areaSquareMeters).toBeCloseTo(4, 6);
    expect(calibrated.plans[0]!.walls[0]!.thicknessMeters).toBeCloseTo(0.2, 6);
  });
});
