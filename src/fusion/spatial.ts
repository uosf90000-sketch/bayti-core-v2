import type { NormalizedPoint2D } from "../domain/canonical.js";

export function midpoint(a: NormalizedPoint2D, b: NormalizedPoint2D): NormalizedPoint2D {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Distance normalized by the full source-image diagonal, so portrait/landscape plans compare consistently. */
export function pageDistance(
  a: NormalizedPoint2D,
  b: NormalizedPoint2D,
  widthPx: number,
  heightPx: number,
): number {
  const dx = (a.x - b.x) * widthPx;
  const dy = (a.y - b.y) * heightPx;
  return Math.hypot(dx, dy) / Math.hypot(widthPx, heightPx);
}

export function pointInPolygon(point: NormalizedPoint2D, polygon: NormalizedPoint2D[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i];
    const pj = polygon[j];
    if (!pi || !pj) continue;
    const intersects =
      pi.y > point.y !== pj.y > point.y &&
      point.x < ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y || Number.EPSILON) + pi.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointSegmentDistance(
  point: NormalizedPoint2D,
  a: NormalizedPoint2D,
  b: NormalizedPoint2D,
  widthPx: number,
  heightPx: number,
): number {
  const px = point.x * widthPx;
  const py = point.y * heightPx;
  const ax = a.x * widthPx;
  const ay = a.y * heightPx;
  const bx = b.x * widthPx;
  const by = b.y * heightPx;
  const abx = bx - ax;
  const aby = by - ay;
  const denom = abx * abx + aby * aby;
  const t = denom === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / denom));
  const cx = ax + t * abx;
  const cy = ay + t * aby;
  return Math.hypot(px - cx, py - cy) / Math.hypot(widthPx, heightPx);
}

export function pointNearPolygon(
  point: NormalizedPoint2D,
  polygon: NormalizedPoint2D[],
  widthPx: number,
  heightPx: number,
  tolerance: number,
): boolean {
  if (pointInPolygon(point, polygon)) return true;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    if (!a || !b) continue;
    if (pointSegmentDistance(point, a, b, widthPx, heightPx) <= tolerance) return true;
  }
  return false;
}

export function polygonSamples(polygon: NormalizedPoint2D[]): NormalizedPoint2D[] {
  if (polygon.length === 0) return [];
  const samples: NormalizedPoint2D[] = [];
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    if (!a || !b) continue;
    samples.push(a, midpoint(a, b));
    sx += a.x;
    sy += a.y;
  }
  samples.push({ x: sx / polygon.length, y: sy / polygon.length });
  return samples;
}

export function polygonSupportScore(
  primary: NormalizedPoint2D[],
  secondary: NormalizedPoint2D[],
  widthPx: number,
  heightPx: number,
): number {
  const samples = polygonSamples(primary);
  if (samples.length === 0 || secondary.length < 3) return 0;
  const supported = samples.filter((point) =>
    pointNearPolygon(point, secondary, widthPx, heightPx, 0.008),
  ).length;
  return supported / samples.length;
}

function lineAngle(a: NormalizedPoint2D, b: NormalizedPoint2D, widthPx: number, heightPx: number): number {
  return Math.atan2((b.y - a.y) * heightPx, (b.x - a.x) * widthPx);
}

function angleDifference(a: number, b: number): number {
  let diff = Math.abs(a - b) % Math.PI;
  if (diff > Math.PI / 2) diff = Math.PI - diff;
  return Math.abs(diff);
}

export function lineMatchScore(
  a: [NormalizedPoint2D, NormalizedPoint2D],
  b: [NormalizedPoint2D, NormalizedPoint2D],
  widthPx: number,
  heightPx: number,
): number {
  const midDistance = pageDistance(midpoint(a[0], a[1]), midpoint(b[0], b[1]), widthPx, heightPx);
  if (midDistance > 0.04) return 0;

  const angle = angleDifference(
    lineAngle(a[0], a[1], widthPx, heightPx),
    lineAngle(b[0], b[1], widthPx, heightPx),
  );
  if (angle > Math.PI / 4) return 0;

  const lengthA = pageDistance(a[0], a[1], widthPx, heightPx);
  const lengthB = pageDistance(b[0], b[1], widthPx, heightPx);
  const lengthRatio = Math.min(lengthA, lengthB) / Math.max(lengthA, lengthB, Number.EPSILON);

  const distanceScore = Math.max(0, 1 - midDistance / 0.04);
  const angleScore = Math.max(0, 1 - angle / (Math.PI / 4));
  return 0.55 * distanceScore + 0.3 * angleScore + 0.15 * lengthRatio;
}

export function lineLengthNormalized(
  line: [NormalizedPoint2D, NormalizedPoint2D],
  widthPx: number,
  heightPx: number,
): number {
  return pageDistance(line[0], line[1], widthPx, heightPx);
}
