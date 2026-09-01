import type {
  NormalizedPoint2D,
  PlanScale,
  SourceImageInfo,
  WallGeometry,
} from "../domain/canonical.js";

interface PixelPoint {
  x: number;
  y: number;
}

export interface StraightWallFit {
  geometry: Extract<WallGeometry, { type: "line" }>;
  thicknessMeters: number | null;
  aspectRatio: number;
  rectangularity: number;
}

const MIN_ASPECT_RATIO = 2.5;
const MIN_RECTANGULARITY = 0.72;
const MIN_MINOR_EXTENT_PX = 1;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function polygonArea(points: PixelPoint[]): number {
  if (points.length < 3) return 0;
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    if (!current || !next) continue;
    twiceArea += current.x * next.y - next.x * current.y;
  }
  return Math.abs(twiceArea) / 2;
}

function toPixel(point: NormalizedPoint2D, source: SourceImageInfo): PixelPoint {
  return { x: point.x * source.widthPx, y: point.y * source.heightPx };
}

function toNormalized(point: PixelPoint, source: SourceImageInfo): NormalizedPoint2D {
  return {
    x: clamp01(point.x / source.widthPx),
    y: clamp01(point.y / source.heightPx),
  };
}

function thicknessInMeters(
  thicknessPx: number,
  normal: PixelPoint,
  scale: PlanScale,
): number | null {
  const sx = scale.metersPerPixelX;
  const sy = scale.metersPerPixelY;
  if (sx === null || sy === null || sx <= 0 || sy <= 0) return null;

  const dxMeters = normal.x * thicknessPx * sx;
  const dyMeters = normal.y * thicknessPx * sy;
  const value = Math.hypot(dxMeters, dyMeters);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Fits a center line only when a wall footprint is demonstrably a thin, mostly
 * rectangular bar. Complex chains, L-shapes and curved footprints deliberately stay
 * polygon-only so V2 cannot recreate the old "one giant thick wall" failure.
 */
export function fitStraightWallFootprint(
  footprint: NormalizedPoint2D[],
  source: SourceImageInfo,
  scale: PlanScale,
): StraightWallFit | null {
  if (
    footprint.length < 4 ||
    !Number.isFinite(source.widthPx) ||
    !Number.isFinite(source.heightPx) ||
    source.widthPx <= 0 ||
    source.heightPx <= 0
  ) {
    return null;
  }

  const points = footprint.map((point) => toPixel(point, source));
  const mean = points.reduce(
    (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
    { x: 0, y: 0 },
  );
  mean.x /= points.length;
  mean.y /= points.length;

  let covXX = 0;
  let covXY = 0;
  let covYY = 0;
  for (const point of points) {
    const dx = point.x - mean.x;
    const dy = point.y - mean.y;
    covXX += dx * dx;
    covXY += dx * dy;
    covYY += dy * dy;
  }
  covXX /= points.length;
  covXY /= points.length;
  covYY /= points.length;

  if (covXX + covYY <= Number.EPSILON) return null;

  const theta = 0.5 * Math.atan2(2 * covXY, covXX - covYY);
  let axis = { x: Math.cos(theta), y: Math.sin(theta) };
  let normal = { x: -axis.y, y: axis.x };

  const project = (vector: PixelPoint): [number, number] => [
    vector.x * axis.x + vector.y * axis.y,
    vector.x * normal.x + vector.y * normal.y,
  ];

  let projected = points.map((point) => project({ x: point.x - mean.x, y: point.y - mean.y }));
  let minMajor = Math.min(...projected.map(([major]) => major));
  let maxMajor = Math.max(...projected.map(([major]) => major));
  let minMinor = Math.min(...projected.map(([, minor]) => minor));
  let maxMinor = Math.max(...projected.map(([, minor]) => minor));
  let majorExtent = maxMajor - minMajor;
  let minorExtent = maxMinor - minMinor;

  // Numerical covariance ties (e.g. almost-square polygons) can choose the shorter
  // projection as the principal direction. Normalize the axes before applying gates.
  if (minorExtent > majorExtent) {
    const oldAxis = axis;
    axis = normal;
    normal = { x: -oldAxis.x, y: -oldAxis.y };
    projected = points.map((point) => {
      const dx = point.x - mean.x;
      const dy = point.y - mean.y;
      return [dx * axis.x + dy * axis.y, dx * normal.x + dy * normal.y] as [number, number];
    });
    minMajor = Math.min(...projected.map(([major]) => major));
    maxMajor = Math.max(...projected.map(([major]) => major));
    minMinor = Math.min(...projected.map(([, minor]) => minor));
    maxMinor = Math.max(...projected.map(([, minor]) => minor));
    majorExtent = maxMajor - minMajor;
    minorExtent = maxMinor - minMinor;
  }

  if (minorExtent < MIN_MINOR_EXTENT_PX || majorExtent <= minorExtent) return null;

  const aspectRatio = majorExtent / minorExtent;
  const orientedBoxArea = majorExtent * minorExtent;
  const area = polygonArea(points);
  const rectangularity = orientedBoxArea > 0 ? Math.min(1, area / orientedBoxArea) : 0;

  if (aspectRatio < MIN_ASPECT_RATIO || rectangularity < MIN_RECTANGULARITY) return null;

  const centerMinor = (minMinor + maxMinor) / 2;
  const pointAt = (major: number): PixelPoint => ({
    x: mean.x + axis.x * major + normal.x * centerMinor,
    y: mean.y + axis.y * major + normal.y * centerMinor,
  });

  return {
    geometry: {
      type: "line",
      start: toNormalized(pointAt(minMajor), source),
      end: toNormalized(pointAt(maxMajor), source),
    },
    thicknessMeters: thicknessInMeters(minorExtent, normal, scale),
    aspectRatio,
    rectangularity,
  };
}
