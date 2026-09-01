import { expect, test } from "vitest";
import { mapTectlyBundleToCanonical } from "../src/providers/tectly-mapper.js";
import type { TectlyPlanBundle } from "../src/providers/tectly-types.js";

const sourceImage = {
  widthPx: 1000,
  heightPx: 1000,
  mimeType: "image/jpeg",
};

test("missing Tectly opening.rooms leaves topology unknown instead of throwing", () => {
  const bundle = {
    plan: {
      id: "plan-1",
      floorId: "floor-1",
      pageSection: { left: 0, top: 0, width: 1, height: 1 },
      wallOpeningProcessingStatus: "Positive",
      roomProcessingStatus: "Positive",
      wallProcessingStatus: "Positive",
      horizontalScaleProcessingStatus: "Positive",
      postProcessingStatus: "Positive",
    },
    floor: { id: "floor-1", horizontalScale: 0.1, verticalScale: 0.1 },
    walls: [
      {
        id: "wall-provider-1",
        boundary: [
          [0.1, 0.1],
          [0.9, 0.1],
          [0.9, 0.13],
          [0.1, 0.13],
        ],
      },
    ],
    rooms: [
      {
        id: "room-provider-1",
        caption: "Room",
        boundary: [
          [0.1, 0.13],
          [0.9, 0.13],
          [0.9, 0.9],
          [0.1, 0.9],
        ],
        area: 1,
      },
    ],
    wallOpenings: [
      {
        id: "opening-provider-1",
        rooms: undefined,
        details: {
          type: "SlidingDoor",
          closed: [0.45, 0.1],
          open: [0.55, 0.1],
        },
      },
    ],
  } as unknown as TectlyPlanBundle;

  const plan = mapTectlyBundleToCanonical(bundle, sourceImage);
  expect(plan.openings).toHaveLength(1);
  expect(plan.openings[0]?.connectedRoomIds).toEqual([]);
  expect(
    plan.qa.notes.some((note) => note.includes("did not include a provider room-id list")),
  ).toBe(true);
});
