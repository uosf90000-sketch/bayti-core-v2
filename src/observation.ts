import type { BaytiCoreAnalysisResult } from "./core.js";
import type { CanonicalRoom } from "./domain/canonical.js";
import { assessGeometryQuality } from "./quality.js";

export interface SanitizedPlanObservation {
  planIndex: number;
  sourceImage: {
    widthPx: number;
    heightPx: number;
    mimeType: string;
  };
  counts: {
    walls: number;
    openings: number;
    rooms: number;
  };
  confirmation: {
    wallsConfirmed: number;
    wallConfirmationRate: number;
    openingsConfirmed: number;
    openingConfirmationRate: number;
  };
  openingGeometry: {
    supportedOpenings: number;
    supportedOpeningRate: number;
    physicallyMeasuredOpenings: number;
    physicallyMeasuredOpeningRate: number;
  };
  scale: {
    known: boolean;
    source: "tectly" | "manual" | "unknown";
    confidence: number;
  };
  roomSemantics: {
    genericRoomLabels: number;
    meaningfulRoomLabels: number;
    kitchenLabels: number;
  };
  review: {
    conflicts: number;
    reviewCandidates: number;
  };
  quality: {
    status: "pass" | "review" | "blocked";
    blockers: string[];
    reviewReasons: string[];
  };
}

export interface SanitizedAnalysisObservation {
  schemaVersion: "1.0";
  kind: "bayti-core-field-observation";
  engineVersion: string;
  verifierStatus: BaytiCoreAnalysisResult["verifierStatus"];
  planCount: number;
  plans: SanitizedPlanObservation[];
  privacy: {
    providerProjectIdsRetained: false;
    providerDocumentIdsRetained: false;
    providerRequestIdsRetained: false;
    providerElementIdsRetained: false;
    sourceFileNameRetained: false;
    rawProviderPayloadRetained: false;
  };
}

const GENERIC_ROOM_LABELS = new Set([
  "",
  "other",
  "room",
  "unknown",
  "unclassified",
  "غير معروف",
  "اخرى",
  "أخرى",
]);

function normalizedRoomLabel(room: CanonicalRoom): string {
  return (room.label ?? "").trim().toLocaleLowerCase("en-US");
}

/**
 * Produces the small privacy-safe payload needed for the 10–20-plan field-validation
 * corpus. Provider/project/document/request/element identifiers and raw provider payloads
 * are intentionally excluded. The observation is a metrics baseline, not a replay fixture.
 */
export function buildSanitizedAnalysisObservation(
  result: Omit<BaytiCoreAnalysisResult, "engineVersion"> & { engineVersion: string },
): SanitizedAnalysisObservation {
  const plans = result.plans.map((plan, index): SanitizedPlanObservation => {
    const quality = assessGeometryQuality(plan);
    const genericRoomLabels = plan.rooms.filter((room) =>
      GENERIC_ROOM_LABELS.has(normalizedRoomLabel(room)),
    ).length;
    const kitchenLabels = plan.rooms.filter(
      (room) => normalizedRoomLabel(room) === "kitchen",
    ).length;

    return {
      planIndex: index,
      sourceImage: { ...plan.sourceImage },
      counts: {
        walls: plan.walls.length,
        openings: plan.openings.length,
        rooms: plan.rooms.length,
      },
      confirmation: {
        wallsConfirmed: quality.metrics.confirmedWallCount,
        wallConfirmationRate: quality.metrics.wallConfirmationRate,
        openingsConfirmed: quality.metrics.confirmedOpeningCount,
        openingConfirmationRate: quality.metrics.openingConfirmationRate,
      },
      openingGeometry: {
        supportedOpenings: quality.metrics.supportedOpeningCount,
        supportedOpeningRate: quality.metrics.supportedOpeningRate,
        physicallyMeasuredOpenings: quality.metrics.measuredOpeningCount,
        physicallyMeasuredOpeningRate: quality.metrics.measuredOpeningRate,
      },
      scale: {
        known: quality.metrics.hasKnownScale,
        source: plan.scale.source,
        confidence: plan.scale.confidence,
      },
      roomSemantics: {
        genericRoomLabels,
        meaningfulRoomLabels: plan.rooms.length - genericRoomLabels,
        kitchenLabels,
      },
      review: {
        conflicts: plan.qa.conflicts.length,
        reviewCandidates: plan.reviewCandidates.length,
      },
      quality: {
        status: quality.status,
        blockers: [...quality.blockers],
        reviewReasons: [...quality.reviewReasons],
      },
    };
  });

  return {
    schemaVersion: "1.0",
    kind: "bayti-core-field-observation",
    engineVersion: result.engineVersion,
    verifierStatus: result.verifierStatus,
    planCount: plans.length,
    plans,
    privacy: {
      providerProjectIdsRetained: false,
      providerDocumentIdsRetained: false,
      providerRequestIdsRetained: false,
      providerElementIdsRetained: false,
      sourceFileNameRetained: false,
      rawProviderPayloadRetained: false,
    },
  };
}
