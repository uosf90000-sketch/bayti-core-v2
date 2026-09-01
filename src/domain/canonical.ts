export type ProviderName = "tectly" | "replicate";

export interface Point2D {
  x: number;
  y: number;
}

export interface NormalizedPoint2D {
  /** normalized to the source image width: 0..1 */
  x: number;
  /** normalized to the source image height: 0..1 */
  y: number;
}

export interface SourceEvidence {
  provider: ProviderName;
  providerElementId?: string;
  confidence?: number;
}

export interface ElementConfidence {
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
      /** retained when a provider gives a curved/irregular contour that is not safely fit as an arc */
      type: "polyline";
      points: NormalizedPoint2D[];
    };

export interface CanonicalWall {
  id: string;
  geometry: WallGeometry;
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
  metersPerPixel: number | null;
  source: "tectly" | "manual" | "unknown";
  confidence: number;
}

export interface SourceImageInfo {
  widthPx: number;
  heightPx: number;
  mimeType: string;
}

export interface CanonicalPlan {
  schemaVersion: "2.0";
  sourceImage: SourceImageInfo;
  scale: PlanScale;
  walls: CanonicalWall[];
  openings: CanonicalOpening[];
  rooms: CanonicalRoom[];
  qa: {
    status: "pass" | "review" | "blocked";
    conflicts: string[];
    notes: string[];
  };
}
