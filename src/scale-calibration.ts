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

interface PreparedMeasurement extends ScaleMeasurement {
  dxPx: number;
  dyPx: number;
  lengthPx: number;
  orientation: "horizontal" | "vertical" | "diagonal";
}

const MAX_MEASUREMENTS = 8;
const MIN_LINE_PIXELS = 4;
const MAX_RELATIVE_SPREAD = 0.03;
const AXIS_DOMINANCE_RATIO = 3;

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

function relativeDifference(a: number, b: number): number {
  const base = (Math.abs(a) + Math.abs(b)) / 2;
  return base > 0 ? Math.abs(a - b) / base : Number.POSITIVE_INFINITY;
}

function spread(values: number[], center: number): number {
  if (values.length === 0) return 0;
  return Math.max(...values.map((value) => Math.abs(value - center) / center));
}

function prepareMeasurements(
  measurements: ScaleMeasurement[],
  source: SourceImageInfo,
): PreparedMeasurement[] {
  return measurements.map((measurement) => {
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

    const absX = Math.abs(dxPx);
    const absY = Math.abs(dyPx);
    const orientation: PreparedMeasurement["orientation"] =
      absX >= absY * AXIS_DOMINANCE_RATIO
        ? "horizontal"
        : absY >= absX * AXIS_DOMINANCE_RATIO
          ? "vertical"
          : "diagonal";

    return { ...measurement, dxPx, dyPx, lengthPx, orientation };
  });
}

/**
 * Derives physical raster scale from explicit real-world dimension evidence only.
 *
 * Near-horizontal and near-vertical dimensions are solved independently so an X/Y pair
 * can detect accidental raster distortion or bad endpoint selection. Because browser/PDF
 * raster pixels are expected to be square, the two axis scales must still agree within
 * 3%. If only one axis (or only diagonal evidence) is available, Core uses the measured
 * metres-per-pixel isotropically with reduced confidence rather than inventing a second
 * independent scale.
 */
export function deriveManualScale(
  measurements: ScaleMeasurement[],
  source: SourceImageInfo,
): ScaleCalibrationResult {
  if (
    !Number.isFinite(source.widthPx) ||
    !Number.isFinite(source.heightPx) ||
    source.widthPx <= 0 ||
    source.heightPx <= 0
  ) {
    throw new Error("MANUAL_SCALE_INVALID_SOURCE_IMAGE");
  }
  if (measurements.length === 0 || measurements.length > MAX_MEASUREMENTS) {
    throw new Error("MANUAL_SCALE_INVALID_MEASUREMENT_COUNT");
  }

  const prepared = prepareMeasurements(measurements, source);
  const horizontal = prepared.filter((item) => item.orientation === "horizontal");
  const vertical = prepared.filter((item) => item.orientation === "vertical");
  const diagonal = prepared.filter((item) => item.orientation === "diagonal");

  const horizontalMpp = horizontal.map((item) => item.meters / Math.abs(item.dxPx));
  const verticalMpp = vertical.map((item) => item.meters / Math.abs(item.dyPx));
  const diagonalMpp = diagonal.map((item) => item.meters / item.lengthPx);

  let metersPerPixelX: number;
  let metersPerPixelY: number;
  let relativeSpread = 0;
  let axisEvidence = 0;

  if (horizontalMpp.length > 0 && verticalMpp.length > 0) {
    metersPerPixelX = median(horizontalMpp);
    metersPerPixelY = median(verticalMpp);
    axisEvidence = 2;
    relativeSpread = Math.max(
      spread(horizontalMpp, metersPerPixelX),
      spread(verticalMpp, metersPerPixelY),
      relativeDifference(metersPerPixelX, metersPerPixelY),
    );

    for (const item of diagonal) {
      const predictedMeters = Math.hypot(
        item.dxPx * metersPerPixelX,
        item.dyPx * metersPerPixelY,
      );
      relativeSpread = Math.max(
        relativeSpread,
        Math.abs(predictedMeters - item.meters) / item.meters,
      );
    }
  } else {
    const direct = horizontalMpp.length > 0
      ? horizontalMpp
      : verticalMpp.length > 0
        ? verticalMpp
        : diagonalMpp;
    const mpp = median(direct);
    metersPerPixelX = mpp;
    metersPerPixelY = mpp;
    axisEvidence = horizontalMpp.length > 0 || verticalMpp.length > 0 ? 1 : 0;
    relativeSpread = spread(direct, mpp);

    for (const diagonalValue of diagonalMpp) {
      relativeSpread = Math.max(relativeSpread, Math.abs(diagonalValue - mpp) / mpp);
    }
  }

  if (!Number.isFinite(relativeSpread) || relativeSpread > MAX_RELATIVE_SPREAD) {
    throw new Error("MANUAL_SCALE_MEASUREMENTS_CONFLICT");
  }

  const confidence = axisEvidence === 2
    ? Math.max(0.92, Math.min(0.99, 0.99 - relativeSpread * 2))
    : measurements.length >= 2
      ? Math.max(0.88, Math.min(0.95, 0.95 - relativeSpread * 2))
      : axisEvidence === 1
        ? 0.85
        : 0.8;

  return {
    measurementCount: measurements.length,
    relativeSpread,
    scale: {
      metersPerPixelX,
      metersPerPixelY,
      metersPerNormalizedX: metersPerPixelX * source.widthPx,
      metersPerNormalizedY: metersPerPixelY * source.heightPx,
      source: "manual",
      confidence,
    },
  };
}
