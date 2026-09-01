import type {
  CanonicalOpening,
  CanonicalPlan,
  CanonicalRoom,
  CanonicalWall,
  NormalizedPoint2D,
  PlanScale,
  SourceImageInfo,
} from "../domain/canonical.js";
import type {
  TectlyOpeningDetails,
  TectlyPageSection,
  TectlyPlanBundle,
  TectlyPoint,
} from "./tectly-types.js";
import { inferOpeningHostWallId, openingWidthMeters } from "./opening-host.js";
import { tectlyOpeningKind } from "./tectly-types.js";
import { fitStraightWallFootprint } from "./wall-fit.js";

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Tectly element coordinates are plan-local 0..1; canonical coordinates are full-page 0..1. */
export function mapTectlyPointToPage(
  point: TectlyPoint,
  section: TectlyPageSection,
): NormalizedPoint2D {
  return {
    x: clamp01(section.left + point[0] * section.width),
    y: clamp01(section.top + point[1] * section.height),
  };
}

function mapPolygon(points: TectlyPoint[], section: TectlyPageSection): NormalizedPoint2D[] {
  return points.map((point) => mapTectlyPointToPage(point, section));
}

function openingLine(details: TectlyOpeningDetails): [TectlyPoint, TectlyPoint] {
  if ("hinge" in details) return [details.hinge, details.closed];
  if ("from" in details) return [details.from, details.to];
  return [details.closed, details.open];
}

function scaleFromTectly(bundle: TectlyPlanBundle, source: SourceImageInfo): PlanScale {
  const section = bundle.plan.pageSection;
  const horizontal = bundle.floor.horizontalScale;
  const vertical = bundle.floor.verticalScale;

  let metersPerPixelX: number | null = null;
  let metersPerPixelY: number | null = null;
  let metersPerNormalizedX: number | null = null;
  let metersPerNormalizedY: number | null = null;

  if (typeof horizontal === "number" && horizontal > 0 && section.width > 0) {
    metersPerNormalizedX = 1 / (horizontal * section.width);
    metersPerPixelX = metersPerNormalizedX / source.widthPx;
  }

  if (typeof vertical === "number" && vertical > 0 && section.height > 0) {
    metersPerNormalizedY = 1 / (vertical * section.height);
    metersPerPixelY = metersPerNormalizedY / source.heightPx;
  } else if (metersPerPixelX !== null) {
    // Raster/PDF render pixels share one physical scale. This keeps Y usable when Tectly only exposes horizontal scale.
    metersPerPixelY = metersPerPixelX;
    metersPerNormalizedY = metersPerPixelX * source.heightPx;
  }

  const known = metersPerNormalizedX !== null || metersPerNormalizedY !== null;
  return {
    metersPerPixelX,
    metersPerPixelY,
    metersPerNormalizedX,
    metersPerNormalizedY,
    source: known ? "tectly" : "unknown",
    confidence: known ? 0.9 : 0,
  };
}

function polygonAreaSquareMeters(points: NormalizedPoint2D[], scale: PlanScale): number | null {
  const sx = scale.metersPerNormalizedX;
  const sy = scale.metersPerNormalizedY;
  if (sx === null || sy === null || sx <= 0 || sy <= 0 || points.length < 3) return null;

  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    if (!current || !next) continue;
    const x1 = current.x * sx;
    const y1 = current.y * sy;
    const x2 = next.x * sx;
    const y2 = next.y * sy;
    twiceArea += x1 * y2 - x2 * y1;
  }
  const area = Math.abs(twiceArea) / 2;
  return Number.isFinite(area) && area > 0 ? area : null;
}

export function mapTectlyBundleToCanonical(
  bundle: TectlyPlanBundle,
  sourceImage: SourceImageInfo,
): CanonicalPlan {
  const section = bundle.plan.pageSection;
  const scale = scaleFromTectly(bundle, sourceImage);
  let fittedWallCount = 0;

  const roomIdMap = new Map<string, string>(
    bundle.rooms.map((room, index) => [room.id, `room-${index + 1}`]),
  );

  const walls: CanonicalWall[] = bundle.walls.map((wall, index) => {
    const footprint = mapPolygon(wall.boundary, section);
    const fit = fitStraightWallFootprint(footprint, sourceImage, scale);
    if (fit !== null) fittedWallCount += 1;

    return {
      id: `wall-${index + 1}`,
      footprint,
      // Critical V2 rule: wall polygons stay authoritative. A center line is derived
      // only for a thin, strongly rectangular footprint; complex/curved chains remain null.
      geometry: fit?.geometry ?? null,
      thicknessMeters: fit?.thicknessMeters ?? null,
      confidence: {
        score: 0.8,
        agreement: "single-source",
        evidence: [{ provider: "tectly", providerElementId: wall.id, confidence: 0.8 }],
      },
    };
  });

  let hostedOpeningCount = 0;
  let measuredOpeningCount = 0;
  let topologizedOpeningCount = 0;
  let unknownTopologyReferenceCount = 0;
  const openings: CanonicalOpening[] = bundle.wallOpenings.map((opening, index) => {
    const [a, b] = openingLine(opening.details);
    const kind = tectlyOpeningKind(opening.details);
    const centerLine = {
      start: mapTectlyPointToPage(a, section),
      end: mapTectlyPointToPage(b, section),
    };
    const hostWallId = inferOpeningHostWallId(centerLine, walls, sourceImage);
    const widthMeters = openingWidthMeters(centerLine, scale);
    const connectedRoomIds: string[] = [];
    for (const providerRoomId of opening.rooms) {
      const canonicalRoomId = roomIdMap.get(providerRoomId);
      if (canonicalRoomId !== undefined && !connectedRoomIds.includes(canonicalRoomId)) {
        connectedRoomIds.push(canonicalRoomId);
      }
    }
    const unknownRoomRefs = opening.rooms.length - connectedRoomIds.length;
    if (unknownRoomRefs > 0) unknownTopologyReferenceCount += unknownRoomRefs;
    if (connectedRoomIds.length > 0) topologizedOpeningCount += 1;

    if (hostWallId !== null) hostedOpeningCount += 1;
    if (widthMeters !== null) measuredOpeningCount += 1;

    return {
      id: `opening-${index + 1}`,
      kind,
      centerLine,
      // This is geometric inference, not a provider claim. Ambiguous junctions remain null.
      hostWallId,
      widthMeters,
      connectedRoomIds,
      // Tectly's room-id list is preserved, but Core does not equate "one room" with exterior.
      connectsToExterior: null,
      confidence: {
        score: 0.82,
        agreement: "single-source",
        evidence: [{ provider: "tectly", providerElementId: opening.id, confidence: 0.82 }],
      },
    };
  });

  let measuredRoomCount = 0;
  const rooms: CanonicalRoom[] = bundle.rooms.map((room, index) => {
    const polygon = mapPolygon(room.boundary, section);
    const areaSquareMeters = polygonAreaSquareMeters(polygon, scale);
    if (areaSquareMeters !== null) measuredRoomCount += 1;

    return {
      id: `room-${index + 1}`,
      label: room.caption ?? room.type ?? null,
      polygon,
      // Tectly can expose a numeric `area` even when scale processing failed. That value
      // is not safe to label as square metres. Canonical m² is therefore derived only
      // from the mapped polygon and trusted physical X/Y scale.
      areaSquareMeters,
      confidence: {
        score: 0.85,
        agreement: "single-source",
        evidence: [{ provider: "tectly", providerElementId: room.id, confidence: 0.85 }],
      },
    };
  });

  const qaNotes: string[] = [];
  if (walls.length === 0) qaNotes.push("Tectly returned no walls.");
  if (rooms.length === 0) qaNotes.push("Tectly returned no rooms.");
  if (openings.length === 0) qaNotes.push("Tectly returned no wall openings.");
  if (walls.length > 0) {
    qaNotes.push(
      `Safe straight-wall fitting: ${fittedWallCount}/${walls.length} wall footprints received derived center lines; complex footprints remain polygon-only.`,
    );
  }
  if (openings.length > 0) {
    qaNotes.push(
      `Opening geometry: ${hostedOpeningCount}/${openings.length} openings received an unambiguous host wall; ${measuredOpeningCount}/${openings.length} received a physical width.`,
    );
    qaNotes.push(
      `Opening topology: ${topologizedOpeningCount}/${openings.length} openings include provider-backed room connectivity; exterior connectivity remains unknown unless explicit evidence exists.`,
    );
    if (unknownTopologyReferenceCount > 0) {
      qaNotes.push(
        `Opening topology warning: ${unknownTopologyReferenceCount} provider room reference(s) did not resolve to a room in the current plan.`,
      );
    }
  }
  if (rooms.length > 0) {
    qaNotes.push(
      `Room geometry: ${measuredRoomCount}/${rooms.length} rooms received an area derived from canonical physical scale.`,
    );
  }

  return {
    schemaVersion: "2.2",
    sourceImage,
    scale,
    walls,
    openings,
    rooms,
    reviewCandidates: [],
    qa: {
      status: walls.length === 0 ? "blocked" : "review",
      conflicts: [],
      notes: qaNotes,
    },
  };
}
