import type { NormalizedPoint2D, PlanScale, SourceImageInfo } from "./domain/canonical.js";

export interface ScaleMeasurement {
  start: NormalizedPoint2D;
  end: NormalizedPoint2D;
  meters: number;
}

export interface ScaleCalibrationResult {
  scale: PlanScale;
  measurementCount: number;
  relativeSpread: number;
}

const MAX_MEASUREMENTS = 8;
const MIN_LINE_PIXELS = 4;
const MAX_RELATIVE_SPREAD = 0.03;

function validPoint(point: NormalizedPoint2D): boolean {
  return (
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    point.x >= 0 && point.x <= 1 &&
    point.y >= 0 && point.y <= 1
  );
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Derives one physical raster scale from explicit real-world dimension evidence.
 * Nothing is inferred from page size, wall count, or visual appearance. The caller must
 * provide the two image points that the printed/known dimension refers to plus metres.
 * Multiple measurements must agree tightly or calibration fails closed.
 */
export function deriveManualScale(
  measurements: ScaleMeasurement[],
  source: SourceImageInfo,
): ScaleCalibrationResult {
  if (!Number.isFinite(source.widthPx) || !Number.isFinite(source.heightPx) || source.widthPx <= 0 || source.heightPx <= 0) {
    throw new Error("MANUAL_SCALE_INVALID_SOURCE_IMAGE");
  }
  if (measurements.length === 0 || measurements.length > MAX_MEASUREMENTS) {
    throw new Error("MANUAL_SCALE_INVALID_MEASUREMENT_COUNT");
  }

  const metresPerPixel = measurements.map((measurement) => {
    if (!validPoint(measurement.start) || !validPoint(measurement.end)) {
      throw new Error("MANUAL_SCALE_INVALID_POINT");
    }
    if (!Number.isFinite(measurement.meters) || measurement.meters <= 0) {
      throw new Error("MANUAL_SCALE_INVALID_DISTANCE");
    }

    const dxPx = (measurement.end.x - measurement.start.x) * source.widthPx;
    const dyPx = (measurement.end.y - measurement.start.y) * source.heightPx;
    const lengthPx = Math.hypot(dxPx, dyPx);
    if (!Number.isFinite(lengthPx) || lengthPx < MIN_LINE_PIXELS) {
      throw new Error("MANUAL_SCALE_LINE_TOO_SHORT");
    }
    return measurement.meters / lengthPx;
  });

  const mpp = median(metresPerPixel);
  const relativeSpread = Math.max(...metresPerPixel.map((value) => Math.abs(value - mpp) / mpp));
  if (!Number.isFinite(relativeSpread) || relativeSpread > MAX_RELATIVE_SPREAD) {
    throw new Error("MANUAL_SCALE_MEASUREMENTS_CONFLICT");
  }

  const confidence = measurements.length >= 2
    ? Math.max(0.9, Math.min(0.98, 0.98 - relativeSpread * 2))
    : 0.85;

  return {
    measurementCount: measurements.length,
    relativeSpread,
    scale: {
      metersPerPixelX: mpp,
      metersPerPixelY: mpp,
      metersPerNormalizedX: mpp * source.widthPx,
      metersPerNormalizedY: mpp * source.heightPx,
      source: "manual",
      confidence,
    },
  };
}
