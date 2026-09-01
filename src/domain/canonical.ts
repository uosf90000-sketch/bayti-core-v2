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
  /** Tectly does not currently expose a wall host directly, so V2 never invents one. */
  hostWallId: string | null;
  widthMeters: number | null;
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
  schemaVersion: "2.1";
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
