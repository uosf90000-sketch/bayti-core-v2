import { describe, expect, it } from "vitest";
import {
  BAYTI_CORE_VERSION,
  refreshDerivedAnalysisResult,
} from "../src/core.js";
import type { CanonicalPlan } from "../src/domain/canonical.js";

function oldPlan(): CanonicalPlan {
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
        id: "wall-left",
        footprint: [
          { x: 0.1, y: 0.1 },
          { x: 0.4, y: 0.1 },
          { x: 0.4, y: 0.13 },
          { x: 0.1, y: 0.13 },
        ],
        geometry: null,
        thicknessMeters: null,
        confidence: { score: 0.95, agreement: "confirmed", evidence: [] },
      },
      {
        id: "wall-right",
        footprint: [
          { x: 0.5, y: 0.1 },
          { x: 0.9, y: 0.1 },
          { x: 0.9, y: 0.13 },
          { x: 0.5, y: 0.13 },
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
        centerLine: { start: { x: 0.4, y: 0.11 }, end: { x: 0.5, y: 0.11 } },
        // Simulates a payload persisted before bridged wall support existed.
        hostWallId: null,
        widthMeters: null,
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
          { x: 0.1, y: 0.13 },
          { x: 0.9, y: 0.13 },
          { x: 0.9, y: 0.9 },
          { x: 0.1, y: 0.9 },
        ],
        areaSquareMeters: 61.6,
        confidence: { score: 0.85, agreement: "single-source", evidence: [] },
      },
    ],
    reviewCandidates: [],
    qa: {
      status: "pass",
      conflicts: [],
      notes: ["Opening geometry: 0/1 openings received an unambiguous host wall; 0/1 received a physical width."],
    },
  };
}

describe("idempotent replay derived-geometry refresh", () => {
  it("upgrades an old cached result without changing provider evidence ids", () => {
    const refreshed = refreshDerivedAnalysisResult({
      engineVersion: "0.7.0",
      tectlyProjectId: "paid-project-1",
      tectlyDocumentId: "paid-document-1",
      replicateRequestId: "replicate-request-1",
      verifierStatus: "succeeded",
      verifierMessage: null,
      plans: [oldPlan()],
      renderContracts: [],
    });

    expect(refreshed.engineVersion).toBe(BAYTI_CORE_VERSION);
    expect(refreshed.tectlyProjectId).toBe("paid-project-1");
    expect(refreshed.tectlyDocumentId).toBe("paid-document-1");
    expect(refreshed.replicateRequestId).toBe("replicate-request-1");

    const opening = refreshed.plans[0]?.openings[0];
    expect(opening?.hostWallId).toBeNull();
    expect(opening?.supportingWallIds).toEqual(["wall-left", "wall-right"]);
    expect(opening?.widthMeters).toBeCloseTo(1);
    expect(refreshed.plans[0]?.qa.notes.some((note) => note.startsWith("Opening geometry:"))).toBe(false);
    expect(
      refreshed.plans[0]?.qa.notes.some((note) => note.includes("derived refresh")),
    ).toBe(true);

    const contract = refreshed.renderContracts[0];
    expect(contract?.schemaVersion).toBe("1.2");
    expect(contract?.quality.metrics.supportedOpeningRate).toBe(1);
    expect(contract?.openings).toHaveLength(1);
    expect(contract?.openings[0]?.supportingWallIds).toEqual(["wall-left", "wall-right"]);
  });
});
