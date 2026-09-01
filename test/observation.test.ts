import { describe, expect, it } from "vitest";
import type { BaytiCoreAnalysisResult } from "../src/core.js";
import { buildSanitizedAnalysisObservation } from "../src/observation.js";

function result(): BaytiCoreAnalysisResult {
  return {
    engineVersion: "0.9.0",
    tectlyProjectId: "secret-project",
    tectlyDocumentId: "secret-document",
    replicateRequestId: "secret-replicate",
    verifierStatus: "succeeded",
    verifierMessage: null,
    plans: [
      {
        schemaVersion: "2.2",
        sourceImage: { widthPx: 1200, heightPx: 1600, mimeType: "image/jpeg" },
        scale: {
          metersPerPixelX: 0.01,
          metersPerPixelY: 0.01,
          metersPerNormalizedX: 12,
          metersPerNormalizedY: 16,
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
            confidence: {
              score: 0.95,
              agreement: "confirmed",
              evidence: [
                { provider: "tectly", providerElementId: "secret-element", confidence: 0.8 },
              ],
            },
          },
        ],
        openings: [
          {
            id: "opening-1",
            kind: "door",
            centerLine: { start: { x: 0.4, y: 0.11 }, end: { x: 0.5, y: 0.11 } },
            hostWallId: "wall-1",
            supportingWallIds: ["wall-1"],
            widthMeters: 1.2,
            connectedRoomIds: ["room-1"],
            connectsToExterior: null,
            confidence: { score: 0.96, agreement: "confirmed", evidence: [] },
          },
        ],
        rooms: [
          {
            id: "room-1",
            label: "Kitchen",
            polygon: [
              { x: 0.2, y: 0.2 },
              { x: 0.8, y: 0.2 },
              { x: 0.8, y: 0.8 },
              { x: 0.2, y: 0.8 },
            ],
            areaSquareMeters: 69.12,
            confidence: { score: 0.85, agreement: "single-source", evidence: [] },
          },
          {
            id: "room-2",
            label: "Other",
            polygon: [
              { x: 0.05, y: 0.2 },
              { x: 0.15, y: 0.2 },
              { x: 0.15, y: 0.3 },
              { x: 0.05, y: 0.3 },
            ],
            areaSquareMeters: 1.92,
            confidence: { score: 0.85, agreement: "single-source", evidence: [] },
          },
        ],
        reviewCandidates: [],
        qa: { status: "review", conflicts: [], notes: [] },
      },
    ],
    renderContracts: [],
  };
}

describe("sanitized field observations", () => {
  it("keeps validation metrics while stripping every provider identifier and raw payload", () => {
    const observation = buildSanitizedAnalysisObservation(result());
    const serialized = JSON.stringify(observation);

    expect(observation.planCount).toBe(1);
    expect(observation.plans[0]?.counts).toEqual({ walls: 1, openings: 1, rooms: 2 });
    expect(observation.plans[0]?.roomSemantics).toEqual({
      genericRoomLabels: 1,
      meaningfulRoomLabels: 1,
      kitchenLabels: 1,
    });
    expect(observation.plans[0]?.scale.known).toBe(true);
    expect(serialized).not.toContain("secret-project");
    expect(serialized).not.toContain("secret-document");
    expect(serialized).not.toContain("secret-replicate");
    expect(serialized).not.toContain("secret-element");
    expect(observation.privacy.providerElementIdsRetained).toBe(false);
  });
});
