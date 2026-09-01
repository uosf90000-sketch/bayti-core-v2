import { describe, expect, it } from "vitest";
import {
  inferOpeningHostWallId,
  inferOpeningWallSupport,
  openingWidthMeters,
} from "../src/providers/opening-host.js";
import type { CanonicalWall, PlanScale, SourceImageInfo } from "../src/domain/canonical.js";

const source: SourceImageInfo = { widthPx: 1000, heightPx: 1000, mimeType: "image/png" };

function wall(id: string, minX: number, minY: number, maxX: number, maxY: number): CanonicalWall {
  return {
    id,
    footprint: [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ],
    geometry: null,
    thicknessMeters: null,
    confidence: { score: 0.8, agreement: "single-source", evidence: [] },
  };
}

describe("opening wall support", () => {
  it("assigns a clearly supported opening to one wall footprint", () => {
    const host = inferOpeningHostWallId(
      { start: { x: 0.2, y: 0.11 }, end: { x: 0.4, y: 0.11 } },
      [wall("top", 0.1, 0.1, 0.9, 0.13), wall("bottom", 0.1, 0.7, 0.9, 0.73)],
      source,
    );
    expect(host).toBe("top");
  });

  it("preserves both wall fragments when an opening bridges a polygon void", () => {
    const support = inferOpeningWallSupport(
      { start: { x: 0.4, y: 0.11 }, end: { x: 0.5, y: 0.11 } },
      [
        wall("left-fragment", 0.1, 0.1, 0.4, 0.13),
        wall("right-fragment", 0.5, 0.1, 0.9, 0.13),
      ],
      source,
    );

    expect(support.hostWallId).toBeNull();
    expect(support.supportingWallIds).toEqual(["left-fragment", "right-fragment"]);
  });

  it("leaves an ambiguous junction unhosted instead of guessing", () => {
    const support = inferOpeningWallSupport(
      { start: { x: 0.49, y: 0.49 }, end: { x: 0.51, y: 0.51 } },
      [wall("horizontal", 0.2, 0.49, 0.8, 0.51), wall("vertical", 0.49, 0.2, 0.51, 0.8)],
      source,
    );
    expect(support.hostWallId).toBeNull();
    expect(support.supportingWallIds).toEqual([]);
  });
});

describe("openingWidthMeters", () => {
  it("uses anisotropic normalized scale without inventing a raster assumption", () => {
    const scale: PlanScale = {
      metersPerPixelX: 0.01,
      metersPerPixelY: 0.02,
      metersPerNormalizedX: 10,
      metersPerNormalizedY: 20,
      source: "tectly",
      confidence: 0.9,
    };
    const width = openingWidthMeters(
      { start: { x: 0.1, y: 0.1 }, end: { x: 0.4, y: 0.3 } },
      scale,
    );
    expect(width).toBeCloseTo(5);
  });

  it("keeps width unknown when either physical axis is unknown", () => {
    const scale: PlanScale = {
      metersPerPixelX: null,
      metersPerPixelY: null,
      metersPerNormalizedX: 10,
      metersPerNormalizedY: null,
      source: "tectly",
      confidence: 0.9,
    };
    expect(
      openingWidthMeters(
        { start: { x: 0.1, y: 0.1 }, end: { x: 0.2, y: 0.1 } },
        scale,
      ),
    ).toBeNull();
  });
});
