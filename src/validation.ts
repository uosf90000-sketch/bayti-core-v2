import type { CanonicalPlan, NormalizedPoint2D } from "./domain/canonical.js";

export interface CanonicalValidationReport {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const EPSILON = 1e-8;

function pointValid(point: NormalizedPoint2D): boolean {
  return (
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    point.x >= 0 &&
    point.x <= 1 &&
    point.y >= 0 &&
    point.y <= 1
  );
}

function polygonArea(points: NormalizedPoint2D[]): number {
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

function lineLengthSquared(a: NormalizedPoint2D, b: NormalizedPoint2D): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return dx * dx + dy * dy;
}

function duplicateIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    else seen.add(id);
  }
  return [...duplicates];
}

/**
 * Runtime integrity check for canonical geometry before product/render consumption.
 * Provider data is external input even when its TypeScript shape is known, so this
 * validates numeric/topological invariants that static types cannot guarantee.
 */
export function validateCanonicalPlan(plan: CanonicalPlan): CanonicalValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!Number.isFinite(plan.sourceImage.widthPx) || plan.sourceImage.widthPx <= 0) {
    errors.push("Source image width must be a positive finite number.");
  }
  if (!Number.isFinite(plan.sourceImage.heightPx) || plan.sourceImage.heightPx <= 0) {
    errors.push("Source image height must be a positive finite number.");
  }

  const wallIds = new Set(plan.walls.map((wall) => wall.id));
  const roomIds = new Set(plan.rooms.map((room) => room.id));
  for (const id of duplicateIds(plan.walls.map((wall) => wall.id))) {
    errors.push(`Duplicate wall id: ${id}.`);
  }
  for (const id of duplicateIds(plan.openings.map((opening) => opening.id))) {
    errors.push(`Duplicate opening id: ${id}.`);
  }
  for (const id of duplicateIds(plan.rooms.map((room) => room.id))) {
    errors.push(`Duplicate room id: ${id}.`);
  }

  for (const wall of plan.walls) {
    if (wall.footprint.length < 3) {
      errors.push(`${wall.id} has fewer than 3 footprint points.`);
      continue;
    }
    if (wall.footprint.some((point) => !pointValid(point))) {
      errors.push(`${wall.id} contains an invalid/out-of-range footprint point.`);
    }
    if (polygonArea(wall.footprint) <= EPSILON) {
      errors.push(`${wall.id} has a degenerate zero-area footprint.`);
    }
    if (wall.thicknessMeters !== null && (!Number.isFinite(wall.thicknessMeters) || wall.thicknessMeters <= 0)) {
      errors.push(`${wall.id} has a non-positive/invalid physical thickness.`);
    }
    if (wall.geometry?.type === "line") {
      if (!pointValid(wall.geometry.start) || !pointValid(wall.geometry.end)) {
        errors.push(`${wall.id} has an invalid derived center line.`);
      } else if (lineLengthSquared(wall.geometry.start, wall.geometry.end) <= EPSILON) {
        errors.push(`${wall.id} has a zero-length derived center line.`);
      }
    } else if (wall.geometry?.type === "polyline") {
      if (wall.geometry.points.length < 2 || wall.geometry.points.some((point) => !pointValid(point))) {
        errors.push(`${wall.id} has an invalid derived polyline.`);
      }
    } else if (wall.geometry?.type === "arc") {
      if (
        !pointValid(wall.geometry.center) ||
        !Number.isFinite(wall.geometry.radiusNormalized) ||
        wall.geometry.radiusNormalized <= 0 ||
        !Number.isFinite(wall.geometry.startAngleRad) ||
        !Number.isFinite(wall.geometry.endAngleRad)
      ) {
        errors.push(`${wall.id} has invalid derived arc geometry.`);
      }
    }
  }

  for (const opening of plan.openings) {
    const { start, end } = opening.centerLine;
    if (!pointValid(start) || !pointValid(end)) {
      errors.push(`${opening.id} has an invalid/out-of-range center line.`);
    } else if (lineLengthSquared(start, end) <= EPSILON) {
      errors.push(`${opening.id} has a zero-length center line.`);
    }
    if (opening.hostWallId !== null && !wallIds.has(opening.hostWallId)) {
      errors.push(`${opening.id} references missing host wall ${opening.hostWallId}.`);
    }

    if (opening.supportingWallIds !== undefined) {
      if (!Array.isArray(opening.supportingWallIds)) {
        errors.push(`${opening.id} has invalid supporting wall ids.`);
      } else {
        if (opening.supportingWallIds.length > 2) {
          errors.push(`${opening.id} references more than two supporting wall regions.`);
        }
        for (const duplicate of duplicateIds(opening.supportingWallIds)) {
          errors.push(`${opening.id} contains duplicate supporting wall ${duplicate}.`);
        }
        for (const wallId of opening.supportingWallIds) {
          if (!wallIds.has(wallId)) {
            errors.push(`${opening.id} references missing supporting wall ${wallId}.`);
          }
        }
        if (
          opening.hostWallId !== null &&
          opening.supportingWallIds.length > 0 &&
          !opening.supportingWallIds.includes(opening.hostWallId)
        ) {
          errors.push(`${opening.id} host wall is not included in its supporting wall ids.`);
        }
      }
    }

    if (opening.widthMeters !== null && (!Number.isFinite(opening.widthMeters) || opening.widthMeters <= 0)) {
      errors.push(`${opening.id} has a non-positive/invalid physical width.`);
    }
    for (const duplicate of duplicateIds(opening.connectedRoomIds)) {
      errors.push(`${opening.id} contains duplicate connected room ${duplicate}.`);
    }
    for (const roomId of opening.connectedRoomIds) {
      if (!roomIds.has(roomId)) {
        errors.push(`${opening.id} references missing connected room ${roomId}.`);
      }
    }
    if (opening.connectedRoomIds.length === 0 && opening.connectsToExterior !== null) {
      errors.push(`${opening.id} declares exterior topology without any provider-backed room.`);
    }
    if (opening.connectedRoomIds.length === 1 && opening.connectsToExterior === false) {
      warnings.push(`${opening.id} has one connected room but is marked non-exterior.`);
    }
    if (opening.connectedRoomIds.length >= 2 && opening.connectsToExterior === true) {
      warnings.push(`${opening.id} has multiple connected rooms but is marked exterior.`);
    }
  }

  for (const room of plan.rooms) {
    if (room.polygon.length < 3) {
      errors.push(`${room.id} has fewer than 3 polygon points.`);
      continue;
    }
    if (room.polygon.some((point) => !pointValid(point))) {
      errors.push(`${room.id} contains an invalid/out-of-range polygon point.`);
    }
    if (polygonArea(room.polygon) <= EPSILON) {
      errors.push(`${room.id} has a degenerate zero-area polygon.`);
    }
    if (room.areaSquareMeters !== null && (!Number.isFinite(room.areaSquareMeters) || room.areaSquareMeters <= 0)) {
      warnings.push(`${room.id} has a non-positive/invalid reported room area.`);
    }
  }

  const scaleValues = [
    plan.scale.metersPerPixelX,
    plan.scale.metersPerPixelY,
    plan.scale.metersPerNormalizedX,
    plan.scale.metersPerNormalizedY,
  ];
  if (scaleValues.some((value) => value !== null && (!Number.isFinite(value) || value <= 0))) {
    errors.push("Plan scale contains a non-positive/invalid physical conversion.");
  }

  return { valid: errors.length === 0, errors, warnings };
}
