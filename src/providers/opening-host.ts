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

interface WallDistance {
  wallId: string;
  distance: number;
}

export interface OpeningWallSupport {
  /** One logical footprint contains/supports the opening line clearly. */
  hostWallId: string | null;
  /** One or two authoritative wall-region footprints supporting the opening. */
  supportingWallIds: string[];
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

function distancesToWalls(
  point: PixelPoint,
  walls: CanonicalWall[],
  source: SourceImageInfo,
): WallDistance[] {
  return walls
    .map((wall) => ({
      wallId: wall.id,
      distance: pointPolygonDistance(
        point,
        wall.footprint.map((candidate) => toPixel(candidate, source)),
      ),
    }))
    .sort((a, b) => a.distance - b.distance);
}

function uniqueEndpointWall(
  point: PixelPoint,
  walls: CanonicalWall[],
  source: SourceImageInfo,
  tolerancePx: number,
): string | null {
  const ranked = distancesToWalls(point, walls, source);
  const best = ranked[0];
  if (!best || best.distance > tolerancePx) return null;

  const runnerUp = ranked[1];
  if (!runnerUp || runnerUp.distance > tolerancePx) return best.wallId;

  // At an actual corner/junction, two regions can be equally close. Do not manufacture
  // support there. Real opening endpoints normally land clearly on one side fragment.
  const requiredSeparationPx = Math.max(2, tolerancePx * 0.2);
  return runnerUp.distance - best.distance >= requiredSeparationPx ? best.wallId : null;
}

function legacySingleHost(
  line: CanonicalOpening["centerLine"],
  walls: CanonicalWall[],
  source: SourceImageInfo,
  tolerancePx: number,
): string | null {
  const samples = [line.start, midpoint(line.start, line.end), line.end].map((point) =>
    toPixel(point, source),
  );

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

/**
 * Tectly polygon mode can split one logical wall run into separate solid regions at a
 * door/window void. In that case the opening endpoints are supported by two different
 * wall footprints, and forcing one `hostWallId` is geometrically wrong. Preserve both
 * support ids while keeping `hostWallId` only for genuine single-footprint support.
 */
export function inferOpeningWallSupport(
  line: CanonicalOpening["centerLine"],
  walls: CanonicalWall[],
  source: SourceImageInfo,
): OpeningWallSupport {
  if (walls.length === 0 || source.widthPx <= 0 || source.heightPx <= 0) {
    return { hostWallId: null, supportingWallIds: [] };
  }

  const diagonal = Math.hypot(source.widthPx, source.heightPx);
  const tolerancePx = Math.max(6, diagonal * 0.006);
  const startWallId = uniqueEndpointWall(toPixel(line.start, source), walls, source, tolerancePx);
  const endWallId = uniqueEndpointWall(toPixel(line.end, source), walls, source, tolerancePx);

  if (startWallId !== null && endWallId !== null) {
    if (startWallId === endWallId) {
      return { hostWallId: startWallId, supportingWallIds: [startWallId] };
    }
    return { hostWallId: null, supportingWallIds: [startWallId, endWallId] };
  }

  // Preserve the old conservative behavior for openings lying along/inside one polygon,
  // where one endpoint may not resolve uniquely but the line as a whole clearly does.
  const hostWallId = legacySingleHost(line, walls, source, tolerancePx);
  return {
    hostWallId,
    supportingWallIds: hostWallId === null ? [] : [hostWallId],
  };
}

/** Backward-compatible convenience for consumers that still require one host wall. */
export function inferOpeningHostWallId(
  line: CanonicalOpening["centerLine"],
  walls: CanonicalWall[],
  source: SourceImageInfo,
): string | null {
  return inferOpeningWallSupport(line, walls, source).hostWallId;
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
