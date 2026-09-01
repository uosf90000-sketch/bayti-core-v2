import type { NormalizedPoint2D, ProviderName } from "../domain/canonical.js";

export interface ProviderRunMeta {
  provider: ProviderName;
  requestId?: string;
  modelVersion?: string;
  durationMs?: number;
}

export interface ReplicateVerifierResult {
  meta: ProviderRunMeta & { provider: "replicate" };
  wallContours: NormalizedPoint2D[][];
  doorContours: NormalizedPoint2D[][];
  entryDoorContours: NormalizedPoint2D[][];
  windowContours: NormalizedPoint2D[][];
  kitchenContours: NormalizedPoint2D[][];
  doorCenterLines: Array<[NormalizedPoint2D, NormalizedPoint2D]>;
  entryDoorCenterLines: Array<[NormalizedPoint2D, NormalizedPoint2D]>;
  windowCenterLines: Array<[NormalizedPoint2D, NormalizedPoint2D]>;
  raw: unknown;
}

export interface TectlyPrimaryResult {
  meta: ProviderRunMeta & { provider: "tectly" };
  raw: unknown;
}
