import { describe, expect, it } from "vitest";
import { parseReplicatePrediction } from "../src/providers/replicate-parser.js";

describe("parseReplicatePrediction", () => {
  it("normalizes Replicate pixel geometry into full-page 0..1 coordinates", () => {
    const result = parseReplicatePrediction(
      {
        id: "prediction-1",
        version: "test-version",
        output: JSON.stringify({
          wall: [[[100, 50], [200, 50], [200, 100], [100, 100]]],
          door_center_line: [[[250, 100], [350, 100]]],
          window_center_line: [[[500, 200], [700, 200]]],
        }),
      },
      { widthPx: 1000, heightPx: 500 },
    );

    expect(result.wallContours[0]?.[0]).toEqual({ x: 0.1, y: 0.1 });
    expect(result.doorCenterLines[0]?.[0]).toEqual({ x: 0.25, y: 0.2 });
    expect(result.windowCenterLines[0]?.[1]).toEqual({ x: 0.7, y: 0.4 });
    expect(result.meta.requestId).toBe("prediction-1");
  });
});
