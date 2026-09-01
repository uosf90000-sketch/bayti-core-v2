export type ProviderName = "tectly" | "replicate";

export interface NormalizedPoint2D {
  /** normalized to the full source page/image width: 0..1 */
  x: number;
  /** normalized to the full source page/image height: 0..1 */
  y: number;
}

export interface SourceEvidence {
  provider: ProviderName;
  providerElementId: string | null;
  confidence: number;
}

export interface ElementConfidence {
  /** 0..1. Two independent sources agreeing should normally be >= 0.9. */
  score: number;
  agreement: "confirmed" | "single-source" | "conflict" | "unverified";
  evidence: SourceEvidence[];
}

export type WallGeometry =
  | {
      type: "line";
      start: NormalizedPoint2D;
      end: NormalizedPoint2D;
    }
  | {
      type: "arc";
      center: NormalizedPoint2D;
      radiusNormalized: number;
      startAngleRad: number;
      endAngleRad: number;
      clockwise: boolean;
    }
  | {
      /** Provider contour retained without pretending it is a straight wall. */
      type: "polyline";
      points: NormalizedPoint2D[];
    };

export interface CanonicalWall {
  id: string;
  /** Authoritative wall-region polygon. V2 never collapses a complex Tectly polygon into one thick line. */
  footprint: NormalizedPoint2D[];
  /** Optional derived path. Null until a line/curve fit is actually trustworthy. */
  geometry: WallGeometry | null;
  /** Null unless explicitly known or safely derived later. */
  thicknessMeters: number | null;
  confidence: ElementConfidence;
}

export type OpeningKind = "door" | "entry-door" | "window";

export interface CanonicalOpening {
  id: string;
  kind: OpeningKind;
  centerLine: {
    start: NormalizedPoint2D;
    end: NormalizedPoint2D;
  };
  /**
   * Tectly does not expose a wall host directly. Bayti may fill this only when the
   * opening line is geometrically supported by one wall footprint unambiguously;
   * junction/tie cases stay null rather than being guessed.
   */
  hostWallId: string | null;
  /** Physical line width derived only when both canonical physical axes are known. */
  widthMeters: number | null;
  /** Canonical room ids explicitly associated with the opening by the primary provider. */
  connectedRoomIds: string[];
  /**
   * Exterior connectivity is evidence-only. `null` means no provider/verifier explicitly
   * established it. Core never infers exterior merely because one room id was returned.
   */
  connectsToExterior: boolean | null;
  confidence: ElementConfidence;
}

export interface CanonicalRoom {
  id: string;
  label: string | null;
  polygon: NormalizedPoint2D[];
  areaSquareMeters: number | null;
  confidence: ElementConfidence;
}

export interface PlanScale {
  /** Raster convenience value for X when the source is a raster image; null for unknown/PDF page pixels. */
  metersPerPixelX: number | null;
  metersPerPixelY: number | null;
  /** Conversion from canonical full-page normalized coordinates to real metres. */
  metersPerNormalizedX: number | null;
  metersPerNormalizedY: number | null;
  source: "tectly" | "manual" | "unknown";
  confidence: number;
}

export interface SourceImageInfo {
  widthPx: number;
  heightPx: number;
  mimeType: string;
}

export interface ReviewCandidate {
  id: string;
  provider: ProviderName;
  kind: "wall" | "door" | "entry-door" | "window";
  reason: string;
  centerLine: { start: NormalizedPoint2D; end: NormalizedPoint2D } | null;
  contour: NormalizedPoint2D[] | null;
}

export interface CanonicalPlan {
  schemaVersion: "2.2";
  sourceImage: SourceImageInfo;
  scale: PlanScale;
  walls: CanonicalWall[];
  openings: CanonicalOpening[];
  rooms: CanonicalRoom[];
  reviewCandidates: ReviewCandidate[];
  qa: {
    status: "pass" | "review" | "blocked";
    conflicts: string[];
    notes: string[];
  };
}
