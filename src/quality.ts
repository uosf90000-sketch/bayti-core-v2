import type { CanonicalOpening, CanonicalPlan } from "./domain/canonical.js";
import { validateCanonicalPlan, type CanonicalValidationReport } from "./validation.js";

export interface GeometryQualityPolicy {
  minWallConfirmationRate: number;
  minOpeningConfirmationRate: number;
  /** Legacy field name: applied to unambiguous opening wall-support coverage. */
  minHostedOpeningRate: number;
  requireKnownScale: boolean;
  requireRooms: boolean;
  allowConflictsForPass: boolean;
  allowReviewCandidatesForPass: boolean;
}

export const DEFAULT_GEOMETRY_QUALITY_POLICY: GeometryQualityPolicy = {
  // Deliberately stricter than the original 0.50 fusion heuristic. These are provisional
  // release gates and should be recalibrated from the real 10–20 plan regression corpus.
  minWallConfirmationRate: 0.65,
  minOpeningConfirmationRate: 0.65,
  minHostedOpeningRate: 0.8,
  requireKnownScale: true,
  requireRooms: true,
  allowConflictsForPass: false,
  allowReviewCandidatesForPass: false,
};

export interface GeometryQualityMetrics {
  wallCount: number;
  openingCount: number;
  roomCount: number;
  confirmedWallCount: number;
  confirmedOpeningCount: number;
  hostedOpeningCount: number;
  supportedOpeningCount: number;
  measuredOpeningCount: number;
  wallConfirmationRate: number;
  openingConfirmationRate: number;
  hostedOpeningRate: number;
  supportedOpeningRate: number;
  /** UI/backward-compatible alias for supportedOpeningRate. */
  openingHostCoverage: number;
  measuredOpeningRate: number;
  complexWallCount: number;
  conflictCount: number;
  reviewCandidateCount: number;
  hasKnownScale: boolean;
}

export interface GeometryQualityReport {
  status: "pass" | "review" | "blocked";
  metrics: GeometryQualityMetrics;
  validation: CanonicalValidationReport;
  blockers: string[];
  reviewReasons: string[];
  policy: GeometryQualityPolicy;
}

function rate(numerator: number, denominator: number, emptyValue: number): number {
  return denominator === 0 ? emptyValue : numerator / denominator;
}

function validRatio(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be between 0 and 1.`);
  }
}

function wallSupportIds(opening: CanonicalOpening): string[] {
  if (Array.isArray(opening.supportingWallIds) && opening.supportingWallIds.length > 0) {
    return opening.supportingWallIds;
  }
  return opening.hostWallId === null ? [] : [opening.hostWallId];
}

export function assessGeometryQuality(
  plan: CanonicalPlan,
  policy: GeometryQualityPolicy = DEFAULT_GEOMETRY_QUALITY_POLICY,
): GeometryQualityReport {
  validRatio(policy.minWallConfirmationRate, "minWallConfirmationRate");
  validRatio(policy.minOpeningConfirmationRate, "minOpeningConfirmationRate");
  validRatio(policy.minHostedOpeningRate, "minHostedOpeningRate");

  const validation = validateCanonicalPlan(plan);
  const confirmedWallCount = plan.walls.filter(
    (wall) => wall.confidence.agreement === "confirmed",
  ).length;
  const confirmedOpeningCount = plan.openings.filter(
    (opening) => opening.confidence.agreement === "confirmed",
  ).length;
  const hostedOpeningCount = plan.openings.filter((opening) => opening.hostWallId !== null).length;
  const supportedOpeningCount = plan.openings.filter((opening) => wallSupportIds(opening).length > 0).length;
  const measuredOpeningCount = plan.openings.filter((opening) => opening.widthMeters !== null).length;
  const complexWallCount = plan.walls.filter((wall) => wall.geometry === null).length;
  const hasKnownScale =
    plan.scale.source !== "unknown" &&
    plan.scale.metersPerNormalizedX !== null &&
    plan.scale.metersPerNormalizedX > 0 &&
    plan.scale.metersPerNormalizedY !== null &&
    plan.scale.metersPerNormalizedY > 0;
  const supportedOpeningRate = rate(supportedOpeningCount, plan.openings.length, 1);

  const metrics: GeometryQualityMetrics = {
    wallCount: plan.walls.length,
    openingCount: plan.openings.length,
    roomCount: plan.rooms.length,
    confirmedWallCount,
    confirmedOpeningCount,
    hostedOpeningCount,
    supportedOpeningCount,
    measuredOpeningCount,
    wallConfirmationRate: rate(confirmedWallCount, plan.walls.length, 0),
    openingConfirmationRate: rate(confirmedOpeningCount, plan.openings.length, 1),
    hostedOpeningRate: rate(hostedOpeningCount, plan.openings.length, 1),
    supportedOpeningRate,
    openingHostCoverage: supportedOpeningRate,
    measuredOpeningRate: rate(measuredOpeningCount, plan.openings.length, 1),
    complexWallCount,
    conflictCount: plan.qa.conflicts.length,
    reviewCandidateCount: plan.reviewCandidates.length,
    hasKnownScale,
  };

  const blockers: string[] = validation.errors.map((error) => `Invalid canonical geometry: ${error}`);
  const reviewReasons: string[] = validation.warnings.map(
    (warning) => `Canonical geometry warning: ${warning}`,
  );

  if (plan.walls.length === 0) blockers.push("No wall geometry is available.");
  if (policy.requireRooms && plan.rooms.length === 0) {
    blockers.push("No room polygons are available for room-level design.");
  }
  if (policy.requireKnownScale && !hasKnownScale) {
    blockers.push("Complete real-world X/Y scale is unknown.");
  }

  if (metrics.wallConfirmationRate < policy.minWallConfirmationRate) {
    reviewReasons.push(
      `Independent wall confirmation is ${(metrics.wallConfirmationRate * 100).toFixed(1)}%, below ${(policy.minWallConfirmationRate * 100).toFixed(0)}%.`,
    );
  }
  if (metrics.openingConfirmationRate < policy.minOpeningConfirmationRate) {
    reviewReasons.push(
      `Independent opening confirmation is ${(metrics.openingConfirmationRate * 100).toFixed(1)}%, below ${(policy.minOpeningConfirmationRate * 100).toFixed(0)}%.`,
    );
  }
  if (metrics.supportedOpeningRate < policy.minHostedOpeningRate) {
    reviewReasons.push(
      `Only ${(metrics.supportedOpeningRate * 100).toFixed(1)}% of openings have unambiguous wall-region support.`,
    );
  }
  if (!policy.allowConflictsForPass && metrics.conflictCount > 0) {
    reviewReasons.push(`${metrics.conflictCount} provider conflict(s) remain unresolved.`);
  }
  if (!policy.allowReviewCandidatesForPass && metrics.reviewCandidateCount > 0) {
    reviewReasons.push(`${metrics.reviewCandidateCount} secondary detection(s) still require review.`);
  }
  if (plan.qa.status === "blocked" && blockers.length === 0) {
    blockers.push("The provider/fusion QA gate marked this plan as blocked.");
  }

  const status: GeometryQualityReport["status"] =
    blockers.length > 0 ? "blocked" : reviewReasons.length > 0 ? "review" : "pass";

  return {
    status,
    metrics,
    validation,
    blockers,
    reviewReasons,
    policy: { ...policy },
  };
}
