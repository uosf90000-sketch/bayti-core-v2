import { describe, expect, it } from "vitest";
import { mapTectlyBundleToCanonical } from "../src/providers/tectly-mapper.js";
import type { TectlyPlanBundle } from "../src/providers/tectly-types.js";

const bundle: TectlyPlanBundle = {
  plan: {
    id: "plan-1",
    floorId: "floor-1",
    pageSection: { left: 0.1, top: 0.2, width: 0.5, height: 0.4 },
    wallOpeningProcessingStatus: "Positive",
    roomProcessingStatus: "Positive",
    wallProcessingStatus: "Positive",
    horizontalScaleProcessingStatus: "Positive",
    postProcessingStatus: "Positive",
  },
  floor: { id: "floor-1", horizontalScale: 0.1, verticalScale: 0.2 },
  walls: [
    {
      id: "tw-1",
      boundary: [[0, 0], [1, 0], [1, 0.1], [0, 0.1]],
    },
  ],
  rooms: [
    {
      id: "tr-1",
      caption: "Living",
      type: "LivingRoom",
      boundary: [[0, 0.1], [1, 0.1], [1, 1], [0, 1]],
      // Deliberately inconsistent with polygon+scale. Core must not trust this as m².
      area: 20,
    },
  ],
  wallOpenings: [
    {
      id: "to-1",
      rooms: ["tr-1"],
      details: {
        type: "Door",
        hinge: [0.2, 0.1],
        closed: [0.4, 0.1],
        open: [0.2, 0.3],
      },
    },
  ],
};

describe("mapTectlyBundleToCanonical", () => {
  it("maps coordinates, physical areas, topology, fits simple walls, and hosts an unambiguous opening", () => {
    const plan = mapTectlyBundleToCanonical(bundle, {
      widthPx: 1000,
      heightPx: 500,
      mimeType: "image/jpeg",
    });

    expect(plan.schemaVersion).toBe("2.2");
    expect(plan.walls[0]?.footprint[0]).toEqual({ x: 0.1, y: 0.2 });
    expect(plan.walls[0]?.footprint[1]).toEqual({ x: 0.6, y: 0.2 });
    expect(plan.walls[0]?.geometry?.type).toBe("line");
    if (plan.walls[0]?.geometry?.type === "line") {
      expect(plan.walls[0].geometry.start.y).toBeCloseTo(0.22);
      expect(plan.walls[0].geometry.end.y).toBeCloseTo(0.22);
      expect(Math.abs(plan.walls[0].geometry.end.x - plan.walls[0].geometry.start.x)).toBeCloseTo(0.5);
    }
    expect(plan.walls[0]?.thicknessMeters).toBeCloseTo(0.5);
    expect(plan.openings[0]?.centerLine.start.x).toBeCloseTo(0.2);
    expect(plan.openings[0]?.centerLine.start.y).toBeCloseTo(0.24);
    expect(plan.openings[0]?.hostWallId).toBe("wall-1");
    expect(plan.openings[0]?.widthMeters).toBeCloseTo(2);
    expect(plan.openings[0]?.connectedRoomIds).toEqual(["room-1"]);
    expect(plan.openings[0]?.connectsToExterior).toBe(true);
    expect(plan.rooms[0]?.areaSquareMeters).toBeCloseTo(45);
    expect(plan.scale.metersPerNormalizedX).toBeCloseTo(20);
    expect(plan.scale.metersPerNormalizedY).toBeCloseTo(12.5);
    expect(plan.scale.metersPerPixelX).toBeCloseTo(0.02);
    expect(plan.scale.metersPerPixelY).toBeCloseTo(0.025);
    expect(plan.qa.notes.some((note) => note.includes("1/1"))).toBe(true);
  });

  it("does not label provider area as square metres when physical scale is unavailable", () => {
    const noScale: TectlyPlanBundle = {
      ...bundle,
      plan: {
        ...bundle.plan,
        horizontalScaleProcessingStatus: "Negative",
      },
      floor: { id: "floor-1" },
    };

    const plan = mapTectlyBundleToCanonical(noScale, {
      widthPx: 1000,
      heightPx: 500,
      mimeType: "image/jpeg",
    });

    expect(plan.scale.source).toBe("unknown");
    expect(plan.rooms[0]?.areaSquareMeters).toBeNull();
    expect(plan.openings[0]?.widthMeters).toBeNull();
  });

  it("keeps missing provider topology unknown instead of guessing room connectivity", () => {
    const noTopology: TectlyPlanBundle = {
      ...bundle,
      wallOpenings: bundle.wallOpenings.map((opening) => ({ ...opening, rooms: [] })),
    };

    const plan = mapTectlyBundleToCanonical(noTopology, {
      widthPx: 1000,
      heightPx: 500,
      mimeType: "image/jpeg",
    });

    expect(plan.openings[0]?.connectedRoomIds).toEqual([]);
    expect(plan.openings[0]?.connectsToExterior).toBeNull();
  });
});
