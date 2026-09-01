import { describe, expect, it } from "vitest";
import { deriveManualScale } from "../src/scale-calibration.js";

const source = { widthPx: 2000, heightPx: 3000, mimeType: "image/jpeg" };

describe("axis-aware manual scale calibration", () => {
  it("preserves independently measured X and Y scales when they agree within tolerance", () => {
    const result = deriveManualScale(
      [
        // 1000 px = 10.00 m -> 0.0100 m/px on X
        { start: { x: 0.1, y: 0.1 }, end: { x: 0.6, y: 0.1 }, meters: 10 },
        // 1500 px = 15.15 m -> 0.0101 m/px on Y (1% difference)
        { start: { x: 0.1, y: 0.1 }, end: { x: 0.1, y: 0.6 }, meters: 15.15 },
      ],
      source,
    );

    expect(result.scale.metersPerPixelX).toBeCloseTo(0.01, 8);
    expect(result.scale.metersPerPixelY).toBeCloseTo(0.0101, 8);
    expect(result.relativeSpread).toBeLessThan(0.011);
    expect(result.scale.confidence).toBeGreaterThanOrEqual(0.92);
  });

  it("uses a single trusted axis isotropically with reduced confidence", () => {
    const result = deriveManualScale(
      [{ start: { x: 0.1, y: 0.2 }, end: { x: 0.6, y: 0.2 }, meters: 10 }],
      source,
    );

    expect(result.scale.metersPerPixelX).toBeCloseTo(0.01, 8);
    expect(result.scale.metersPerPixelY).toBeCloseTo(0.01, 8);
    expect(result.scale.confidence).toBe(0.85);
  });
});
