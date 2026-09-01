import type {
  CanonicalOpening,
  CanonicalWall,
  NormalizedPoint2D,
  PlanScale,
  SourceImageInfo,
} from "../domain/canonical.js";

interface PixelPoint {
  x: number;
  y: number;
}

function toPixel(point: NormalizedPoint2D, source: SourceImageInfo): PixelPoint {
  return { x: point.x * source.widthPx, y: point.y * source.heightPx };
}

function midpoint(a: NormalizedPoint2D, b: NormalizedPoint2D): NormalizedPoint2D {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function pointInPolygon(point: PixelPoint, polygon: PixelPoint[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (!a || !b) continue;
    const crosses =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || Number.EPSILON) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointSegmentDistance(point: PixelPoint, a: PixelPoint, b: PixelPoint): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const denom = abx * abx + aby * aby;
  const t =
    denom === 0
      ? 0
      : Math.max(0, Math.min(1, ((point.x - a.x) * abx + (point.y - a.y) * aby) / denom));
  return Math.hypot(point.x - (a.x + t * abx), point.y - (a.y + t * aby));
}

function pointPolygonDistance(point: PixelPoint, polygon: PixelPoint[]): number {
  if (polygon.length < 3) return Number.POSITIVE_INFINITY;
  if (pointInPolygon(point, polygon)) return 0;
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    if (!a || !b) continue;
    best = Math.min(best, pointSegmentDistance(point, a, b));
  }
  return best;
}

/**
 * Tectly currently links openings to rooms, not directly to walls. Infer a host only
 * when the opening line is supported by one wall footprint clearly better than every
 * other candidate. Ambiguous corner/junction cases deliberately remain `null`.
 */
export function inferOpeningHostWallId(
  line: CanonicalOpening["centerLine"],
  walls: CanonicalWall[],
  source: SourceImageInfo,
): string | null {
  if (walls.length === 0 || source.widthPx <= 0 || source.heightPx <= 0) return null;

  const samples = [line.start, midpoint(line.start, line.end), line.end].map((point) =>
    toPixel(point, source),
  );
  const diagonal = Math.hypot(source.widthPx, source.heightPx);
  const tolerancePx = Math.max(6, diagonal * 0.006);

  const candidates = walls
    .map((wall) => {
      const polygon = wall.footprint.map((point) => toPixel(point, source));
      const distances = samples.map((point) => pointPolygonDistance(point, polygon));
      const supported = distances.filter((distance) => distance <= tolerancePx).length;
      const averageDistance = distances.reduce((sum, value) => sum + value, 0) / distances.length;
      return { wallId: wall.id, supported, averageDistance };
    })
    .filter((candidate) => candidate.supported >= 2)
    .sort((a, b) => b.supported - a.supported || a.averageDistance - b.averageDistance);

  const best = candidates[0];
  if (!best) return null;
  const runnerUp = candidates[1];
  if (!runnerUp) return best.wallId;

  if (best.supported > runnerUp.supported) return best.wallId;

  const requiredSeparationPx = Math.max(3, tolerancePx * 0.25);
  return runnerUp.averageDistance - best.averageDistance >= requiredSeparationPx
    ? best.wallId
    : null;
}

export function openingWidthMeters(
  line: CanonicalOpening["centerLine"],
  scale: PlanScale,
): number | null {
  const sx = scale.metersPerNormalizedX;
  const sy = scale.metersPerNormalizedY;
  if (sx === null || sy === null || sx <= 0 || sy <= 0) return null;

  const dx = (line.end.x - line.start.x) * sx;
  const dy = (line.end.y - line.start.y) * sy;
  const width = Math.hypot(dx, dy);
  return Number.isFinite(width) && width > 0 ? width : null;
}
