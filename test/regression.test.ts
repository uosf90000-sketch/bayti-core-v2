import { describe, expect, it } from "vitest";
import type { CanonicalPlan } from "../src/domain/canonical.js";
import { evaluateRegressionPlan } from "../src/regression.js";

function plan(): CanonicalPlan {
  return {
    schemaVersion: "2.1",
    sourceImage: { widthPx: 1200, heightPx: 1600, mimeType: "image/jpeg" },
    scale: {
      metersPerPixelX: 0.01,
      metersPerPixelY: 0.01,
      metersPerNormalizedX: 12,
      metersPerNormalizedY: 16,
      source: "tectly",
      confidence: 0.9,
    },
    walls: Array.from({ length: 10 }, (_, index) => ({
      id: `wall-${index}`,
      footprint: [
        { x: 0.1, y: 0.1 + index * 0.01 },
        { x: 0.9, y: 0.1 + index * 0.01 },
        { x: 0.9, y: 0.105 + index * 0.01 },
        { x: 0.1, y: 0.105 + index * 0.01 },
      ],
      geometry: null,
      thicknessMeters: null,
      confidence: {
        score: 0.95,
        agreement: "confirmed" as const,
        evidence: [{ provider: "tectly" as const, providerElementId: `w-${index}`, confidence: 0.8 }],
      },
    })),
    openings: [
      {
        id: "opening-1",
        kind: "door",
        centerLine: { start: { x: 0.2, y: 0.1 }, end: { x: 0.3, y: 0.1 } },
        hostWallId: "wall-0",
        widthMeters: 1.2,
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
          { x: 0.2, y: 0.2 },
          { x: 0.8, y: 0.2 },
          { x: 0.8, y: 0.8 },
          { x: 0.2, y: 0.8 },
        ],
        areaSquareMeters: 30,
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

describe("real-plan regression evaluator", () => {
  it("accepts small provider count drift inside explicit ranges", () => {
    const result = evaluateRegressionPlan(plan(), {
      walls: { min: 9, max: 11 },
      openings: { min: 1, max: 2 },
      rooms: { min: 1, max: 1 },
      requireKnownScale: true,
      minHostedOpeningRate: 0.8,
      minConfirmedOpeningRate: 0.8,
      maxReviewCandidates: 0,
      maxConflicts: 0,
    });

    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("catches catastrophic geometry count regressions", () => {
    const result = evaluateRegressionPlan(plan(), {
      walls: { min: 70, max: 78 },
      openings: { min: 10, max: 14 },
      rooms: { min: 25, max: 29 },
    });

    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.includes("wall count"))).toBe(true);
    expect(result.failures.some((failure) => failure.includes("opening count"))).toBe(true);
    expect(result.failures.some((failure) => failure.includes("room count"))).toBe(true);
  });
});
