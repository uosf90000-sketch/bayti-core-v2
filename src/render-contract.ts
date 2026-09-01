import type {
  CanonicalOpening,
  CanonicalPlan,
  NormalizedPoint2D,
  OpeningKind,
  WallGeometry,
} from "./domain/canonical.js";
import {
  assessGeometryQuality,
  type GeometryQualityPolicy,
  type GeometryQualityReport,
} from "./quality.js";

export interface RenderWall {
  id: string;
  /** Authoritative horizontal wall solid footprint. Extrude this polygon; do not rebuild it from a line. */
  footprint: NormalizedPoint2D[];
  /** Optional semantic path for simple straight/arc-aware consumers. */
  geometry: WallGeometry | null;
  thicknessMeters: number | null;
  confidence: number;
}

export interface RenderOpening {
  id: string;
  kind: OpeningKind;
  /** Present for a genuine single-footprint host; null for a two-fragment bridge. */
  hostWallId: string | null;
  /** One or two wall-region solids that the opening cut belongs to. */
  supportingWallIds: string[];
  centerLine: CanonicalOpening["centerLine"];
  widthMeters: number;
  connectedRoomIds: string[];
  connectsToExterior: boolean | null;
  confidence: number;
}

export interface UnresolvedRenderOpening {
  id: string;
  kind: OpeningKind;
  supportingWallIds: string[];
  centerLine: CanonicalOpening["centerLine"];
  connectedRoomIds: string[];
  connectsToExterior: boolean | null;
  reasons: Array<"missing-wall-support" | "missing-physical-width">;
}

export interface RenderRoomSurface {
  id: string;
  label: string | null;
  polygon: NormalizedPoint2D[];
  areaSquareMeters: number | null;
  confidence: number;
}

export interface BaytiRenderContract {
  schemaVersion: "1.2";
  coordinateSystem: "full-page-normalized-0..1";
  /**
   * Horizontal geometry only. The renderer/design layer must provide ceiling height,
   * door height, window sill and window height from an explicit product/manual policy.
   * Core deliberately does not invent vertical dimensions.
   */
  verticalDimensions: "consumer-supplied";
  scale: CanonicalPlan["scale"];
  quality: GeometryQualityReport;
  walls: RenderWall[];
  openings: RenderOpening[];
  unresolvedOpenings: UnresolvedRenderOpening[];
  rooms: RenderRoomSurface[];
  notes: string[];
}

function wallSupportIds(opening: CanonicalOpening): string[] {
  if (Array.isArray(opening.supportingWallIds) && opening.supportingWallIds.length > 0) {
    return opening.supportingWallIds;
  }
  return opening.hostWallId === null ? [] : [opening.hostWallId];
}

/**
 * Stable hand-off from geometry analysis to the future UI/3D renderer.
 *
 * Complex/L-shaped/curved Tectly wall footprints remain directly renderable as polygon
 * solids even when no straight centerline can be safely derived. Openings may be
 * supported by one wall solid or bridge the two solids that border an opening void.
 */
export function buildBaytiRenderContract(
  plan: CanonicalPlan,
  policy?: GeometryQualityPolicy,
): BaytiRenderContract {
  const quality = assessGeometryQuality(plan, policy);

  const openings: RenderOpening[] = [];
  const unresolvedOpenings: UnresolvedRenderOpening[] = [];

  for (const opening of plan.openings) {
    const supportingWallIds = wallSupportIds(opening);
    const widthMeters = opening.widthMeters;
    const reasons: UnresolvedRenderOpening["reasons"] = [];
    if (supportingWallIds.length === 0) reasons.push("missing-wall-support");
    if (widthMeters === null) reasons.push("missing-physical-width");

    if (reasons.length > 0 || widthMeters === null) {
      unresolvedOpenings.push({
        id: opening.id,
        kind: opening.kind,
        supportingWallIds,
        centerLine: opening.centerLine,
        connectedRoomIds: opening.connectedRoomIds,
        connectsToExterior: opening.connectsToExterior,
        reasons,
      });
      continue;
    }

    openings.push({
      id: opening.id,
      kind: opening.kind,
      hostWallId: opening.hostWallId,
      supportingWallIds,
      centerLine: opening.centerLine,
      widthMeters,
      connectedRoomIds: opening.connectedRoomIds,
      connectsToExterior: opening.connectsToExterior,
      confidence: opening.confidence.score,
    });
  }

  const notes = [
    "Wall footprints are authoritative horizontal solids; polygon-only walls must be preserved during extrusion.",
    "An opening can reference one wall-region solid or bridge two fragments separated by the opening void.",
    "Opening-to-room connectivity is provider-backed only; missing topology stays unknown rather than being inferred by the renderer.",
    "Vertical dimensions are intentionally not inferred by Bayti Core V2.",
  ];
  if (unresolvedOpenings.length > 0) {
    notes.push(
      `${unresolvedOpenings.length} opening(s) are excluded from automatic wall cuts until wall support/width geometry is resolved.`,
    );
  }

  return {
    schemaVersion: "1.2",
    coordinateSystem: "full-page-normalized-0..1",
    verticalDimensions: "consumer-supplied",
    scale: plan.scale,
    quality,
    walls: plan.walls.map((wall) => ({
      id: wall.id,
      footprint: wall.footprint,
      geometry: wall.geometry,
      thicknessMeters: wall.thicknessMeters,
      confidence: wall.confidence.score,
    })),
    openings,
    unresolvedOpenings,
    rooms: plan.rooms.map((room) => ({
      id: room.id,
      label: room.label,
      polygon: room.polygon,
      areaSquareMeters: room.areaSquareMeters,
      confidence: room.confidence.score,
    })),
    notes,
  };
}
