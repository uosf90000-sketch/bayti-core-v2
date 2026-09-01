import type { CanonicalPlan } from "./domain/canonical.js";
import { assessGeometryQuality, type GeometryQualityReport } from "./quality.js";

export interface CountRange {
  min: number;
  max: number;
}

export interface RegressionExpectation {
  walls: CountRange;
  openings: CountRange;
  rooms: CountRange;
  requireKnownScale?: boolean;
  minHostedOpeningRate?: number;
  minConfirmedOpeningRate?: number;
  maxReviewCandidates?: number;
  maxConflicts?: number;
}

export interface RegressionEvaluation {
  passed: boolean;
  failures: string[];
  quality: GeometryQualityReport;
}

function checkRange(name: string, value: number, range: CountRange, failures: string[]): void {
  if (!Number.isInteger(range.min) || !Number.isInteger(range.max) || range.min < 0 || range.max < range.min) {
    throw new Error(`Invalid ${name} expectation range.`);
  }
  if (value < range.min || value > range.max) {
    failures.push(`${name} count ${value} is outside expected range ${range.min}..${range.max}.`);
  }
}

function checkRatio(name: string, value: number, minimum: number | undefined, failures: string[]): void {
  if (minimum === undefined) return;
  if (!Number.isFinite(minimum) || minimum < 0 || minimum > 1) {
    throw new Error(`Invalid ${name} minimum.`);
  }
  if (value < minimum) {
    failures.push(`${name} ${(value * 100).toFixed(1)}% is below ${(minimum * 100).toFixed(1)}%.`);
  }
}

/**
 * Evaluates a canonical result against a per-plan baseline. Count ranges intentionally
 * allow small provider drift while still catching catastrophic regressions such as
 * 74 walls becoming 7 or 12 openings becoming 0.
 */
export function evaluateRegressionPlan(
  plan: CanonicalPlan,
  expected: RegressionExpectation,
): RegressionEvaluation {
  const failures: string[] = [];
  const quality = assessGeometryQuality(plan);

  checkRange("wall", plan.walls.length, expected.walls, failures);
  checkRange("opening", plan.openings.length, expected.openings, failures);
  checkRange("room", plan.rooms.length, expected.rooms, failures);

  if (expected.requireKnownScale === true && !quality.metrics.hasKnownScale) {
    failures.push("Expected a known physical scale, but the result scale is unknown.");
  }

  checkRatio(
    "hosted opening rate",
    quality.metrics.hostedOpeningRate,
    expected.minHostedOpeningRate,
    failures,
  );
  checkRatio(
    "confirmed opening rate",
    quality.metrics.openingConfirmationRate,
    expected.minConfirmedOpeningRate,
    failures,
  );

  if (
    expected.maxReviewCandidates !== undefined &&
    plan.reviewCandidates.length > expected.maxReviewCandidates
  ) {
    failures.push(
      `Review candidate count ${plan.reviewCandidates.length} exceeds ${expected.maxReviewCandidates}.`,
    );
  }
  if (expected.maxConflicts !== undefined && plan.qa.conflicts.length > expected.maxConflicts) {
    failures.push(`Conflict count ${plan.qa.conflicts.length} exceeds ${expected.maxConflicts}.`);
  }

  return { passed: failures.length === 0, failures, quality };
}
