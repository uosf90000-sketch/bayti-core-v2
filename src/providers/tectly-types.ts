export type TectlyProcessingStatus = "Pending" | "Positive" | "Negative" | "Failed";
export type TectlyPoint = [number, number, ...number[]];

export interface TectlyPageSection {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TectlyWall {
  id: string;
  boundary: TectlyPoint[];
}

export interface TectlyRoom {
  id: string;
  caption?: string;
  type?: string;
  boundary: TectlyPoint[];
  area: number;
}

export interface TectlyHingedDoorDetails {
  type: string;
  hinge: TectlyPoint;
  closed: TectlyPoint;
  open: TectlyPoint;
  doorHeight?: number;
}

export interface TectlySlidingDoorDetails {
  type: string;
  closed: TectlyPoint;
  open: TectlyPoint;
}

export interface TectlyWindowDetails {
  type: string;
  from: TectlyPoint;
  to: TectlyPoint;
  parapetHeight?: number;
  windowHeight?: number;
}

export type TectlyOpeningDetails =
  | TectlyHingedDoorDetails
  | TectlySlidingDoorDetails
  | TectlyWindowDetails;

export interface TectlyWallOpening {
  id: string;
  rooms: string[];
  details: TectlyOpeningDetails;
}

export interface TectlyFloor {
  id: string;
  horizontalScale?: number;
  verticalScale?: number;
}

export interface TectlyPlan {
  id: string;
  floorId?: string;
  pageSection: TectlyPageSection;
  wallOpeningProcessingStatus: TectlyProcessingStatus;
  roomProcessingStatus: TectlyProcessingStatus;
  wallProcessingStatus: TectlyProcessingStatus;
  horizontalScaleProcessingStatus: TectlyProcessingStatus;
  postProcessingStatus: TectlyProcessingStatus;
}

export interface TectlyPlanBundle {
  plan: TectlyPlan;
  floor: TectlyFloor;
  walls: TectlyWall[];
  rooms: TectlyRoom[];
  wallOpenings: TectlyWallOpening[];
}

export interface TectlyDocumentAnalysis {
  provider: "tectly";
  projectId: string;
  documentId: string;
  planBundles: TectlyPlanBundle[];
  raw: unknown;
}

export function tectlyOpeningKind(
  details: TectlyOpeningDetails,
): "door" | "window" {
  if ("from" in details && "to" in details) return "window";
  return "door";
}
