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
  hostWallId: string;
  centerLine: CanonicalOpening["centerLine"];
  widthMeters: number;
  connectedRoomIds: string[];
  connectsToExterior: boolean | null;
  confidence: number;
}

export interface UnresolvedRenderOpening {
  id: string;
  kind: OpeningKind;
  centerLine: CanonicalOpening["centerLine"];
  connectedRoomIds: string[];
  connectsToExterior: boolean | null;
  reasons: Array<"missing-host-wall" | "missing-physical-width">;
}

export interface RenderRoomSurface {
  id: string;
  label: string | null;
  polygon: NormalizedPoint2D[];
  areaSquareMeters: number | null;
  confidence: number;
}

export interface BaytiRenderContract {
  schemaVersion: "1.1";
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

/**
 * Stable hand-off from geometry analysis to the future UI/3D renderer.
 *
 * Complex/L-shaped/curved Tectly wall footprints remain directly renderable as polygon
 * solids even when no straight centerline can be safely derived. This is the contract
 * that prevents a renderer from recreating the old "collapse everything to one thick
 * straight wall" failure.
 */
export function buildBaytiRenderContract(
  plan: CanonicalPlan,
  policy?: GeometryQualityPolicy,
): BaytiRenderContract {
  const quality = assessGeometryQuality(plan, policy);

  const openings: RenderOpening[] = [];
  const unresolvedOpenings: UnresolvedRenderOpening[] = [];

  for (const opening of plan.openings) {
    const hostWallId = opening.hostWallId;
    const widthMeters = opening.widthMeters;
    const reasons: UnresolvedRenderOpening["reasons"] = [];
    if (hostWallId === null) reasons.push("missing-host-wall");
    if (widthMeters === null) reasons.push("missing-physical-width");

    if (reasons.length > 0 || hostWallId === null || widthMeters === null) {
      unresolvedOpenings.push({
        id: opening.id,
        kind: opening.kind,
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
      hostWallId,
      centerLine: opening.centerLine,
      widthMeters,
      connectedRoomIds: opening.connectedRoomIds,
      connectsToExterior: opening.connectsToExterior,
      confidence: opening.confidence.score,
    });
  }

  const notes = [
    "Wall footprints are authoritative horizontal solids; polygon-only walls must be preserved during extrusion.",
    "Opening-to-room connectivity is provider-backed only; missing topology stays unknown rather than being inferred by the renderer.",
    "Vertical dimensions are intentionally not inferred by Bayti Core V2.",
  ];
  if (unresolvedOpenings.length > 0) {
    notes.push(
      `${unresolvedOpenings.length} opening(s) are excluded from automatic wall cuts until host/width geometry is resolved.`,
    );
  }

  return {
    schemaVersion: "1.1",
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
