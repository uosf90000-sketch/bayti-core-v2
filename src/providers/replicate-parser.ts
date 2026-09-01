import type { NormalizedPoint2D } from "../domain/canonical.js";
import type { ReplicateVerifierResult } from "./types.js";

type PixelPoint = [number, number];
type PixelLine = [PixelPoint, PixelPoint];

interface RawReplicateGeometry {
  wall?: PixelPoint[][];
  door?: PixelPoint[][];
  entry_door?: PixelPoint[][];
  window?: PixelPoint[][];
  kitchen?: PixelPoint[][];
  door_center_line?: PixelLine[];
  entry_door_center_line?: PixelLine[];
  window_center_line?: PixelLine[];
}

export interface ReplicatePredictionLike {
  id?: string;
  version?: string;
  output: string | RawReplicateGeometry;
  metrics?: {
    predict_time?: number;
  };
}

function normalizePoint(
  point: PixelPoint,
  widthPx: number,
  heightPx: number,
): NormalizedPoint2D {
  if (widthPx <= 0 || heightPx <= 0) {
    throw new Error("Source image dimensions must be positive.");
  }

  return {
    x: point[0] / widthPx,
    y: point[1] / heightPx,
  };
}

function normalizeContours(
  contours: PixelPoint[][] | undefined,
  widthPx: number,
  heightPx: number,
): NormalizedPoint2D[][] {
  return (contours ?? []).map((contour) =>
    contour.map((point) => normalizePoint(point, widthPx, heightPx)),
  );
}

function normalizeLines(
  lines: PixelLine[] | undefined,
  widthPx: number,
  heightPx: number,
): Array<[NormalizedPoint2D, NormalizedPoint2D]> {
  return (lines ?? []).map(([start, end]) => [
    normalizePoint(start, widthPx, heightPx),
    normalizePoint(end, widthPx, heightPx),
  ]);
}

function parseRawOutput(output: string | RawReplicateGeometry): RawReplicateGeometry {
  if (typeof output !== "string") return output;

  const parsed: unknown = JSON.parse(output);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Replicate floor-plan output is not an object.");
  }

  return parsed as RawReplicateGeometry;
}

/**
 * Converts Replicate's pixel-space verifier result into Bayti's provider-neutral
 * normalized coordinate space. No architectural meaning is invented here.
 */
export function parseReplicatePrediction(
  prediction: ReplicatePredictionLike,
  sourceImage: { widthPx: number; heightPx: number },
): ReplicateVerifierResult {
  const raw = parseRawOutput(prediction.output);

  return {
    meta: {
      provider: "replicate",
      requestId: prediction.id,
      modelVersion: prediction.version,
      durationMs:
        typeof prediction.metrics?.predict_time === "number"
          ? prediction.metrics.predict_time * 1000
          : undefined,
    },
    wallContours: normalizeContours(raw.wall, sourceImage.widthPx, sourceImage.heightPx),
    doorContours: normalizeContours(raw.door, sourceImage.widthPx, sourceImage.heightPx),
    entryDoorContours: normalizeContours(raw.entry_door, sourceImage.widthPx, sourceImage.heightPx),
    windowContours: normalizeContours(raw.window, sourceImage.widthPx, sourceImage.heightPx),
    kitchenContours: normalizeContours(raw.kitchen, sourceImage.widthPx, sourceImage.heightPx),
    doorCenterLines: normalizeLines(raw.door_center_line, sourceImage.widthPx, sourceImage.heightPx),
    entryDoorCenterLines: normalizeLines(
      raw.entry_door_center_line,
      sourceImage.widthPx,
      sourceImage.heightPx,
    ),
    windowCenterLines: normalizeLines(
      raw.window_center_line,
      sourceImage.widthPx,
      sourceImage.heightPx,
    ),
    raw,
  };
}
