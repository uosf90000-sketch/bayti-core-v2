import { describe, expect, it } from "vitest";
import { fitStraightWallFootprint } from "../src/providers/wall-fit.js";
import type { PlanScale, SourceImageInfo } from "../src/domain/canonical.js";

const source: SourceImageInfo = {
  widthPx: 1000,
  heightPx: 1000,
  mimeType: "image/png",
};

const scale: PlanScale = {
  metersPerPixelX: 0.01,
  metersPerPixelY: 0.01,
  metersPerNormalizedX: 10,
  metersPerNormalizedY: 10,
  source: "tectly",
  confidence: 0.9,
};

describe("fitStraightWallFootprint", () => {
  it("fits a thin rectangular wall footprint", () => {
    const fit = fitStraightWallFootprint(
      [
        { x: 0.1, y: 0.1 },
        { x: 0.7, y: 0.1 },
        { x: 0.7, y: 0.12 },
        { x: 0.1, y: 0.12 },
      ],
      source,
      scale,
    );

    expect(fit).not.toBeNull();
    expect(fit?.geometry.type).toBe("line");
    expect(fit?.rectangularity).toBeCloseTo(1);
    expect(fit?.aspectRatio).toBeGreaterThan(20);
    expect(fit?.thicknessMeters).toBeCloseTo(0.2);
  });

  it("rejects an L-shaped wall chain instead of collapsing it into one thick line", () => {
    const fit = fitStraightWallFootprint(
      [
        { x: 0.1, y: 0.1 },
        { x: 0.7, y: 0.1 },
        { x: 0.7, y: 0.4 },
        { x: 0.68, y: 0.4 },
        { x: 0.68, y: 0.12 },
        { x: 0.1, y: 0.12 },
      ],
      source,
      scale,
    );

    expect(fit).toBeNull();
  });

  it("keeps thickness unknown when real-world scale is unavailable", () => {
    const fit = fitStraightWallFootprint(
      [
        { x: 0.2, y: 0.2 },
        { x: 0.8, y: 0.2 },
        { x: 0.8, y: 0.22 },
        { x: 0.2, y: 0.22 },
      ],
      source,
      {
        metersPerPixelX: null,
        metersPerPixelY: null,
        metersPerNormalizedX: null,
        metersPerNormalizedY: null,
        source: "unknown",
        confidence: 0,
      },
    );

    expect(fit?.geometry.type).toBe("line");
    expect(fit?.thicknessMeters).toBeNull();
  });
});
