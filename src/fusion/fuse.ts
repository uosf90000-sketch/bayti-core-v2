import type {
  CanonicalOpening,
  CanonicalPlan,
  NormalizedPoint2D,
  OpeningKind,
  ReviewCandidate,
} from "../domain/canonical.js";
import type { ReplicateVerifierResult } from "../providers/types.js";
import {
  lineLengthNormalized,
  lineMatchScore,
  polygonSupportScore,
} from "./spatial.js";

interface SecondaryOpening {
  id: string;
  kind: OpeningKind;
  line: [CanonicalOpening["centerLine"]["start"], CanonicalOpening["centerLine"]["end"]];
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function verifierOpenings(verifier: ReplicateVerifierResult): SecondaryOpening[] {
  const out: SecondaryOpening[] = [];
  verifier.doorCenterLines.forEach((line, index) => {
    out.push({ id: `replicate-door-${index + 1}`, kind: "door", line });
  });
  verifier.entryDoorCenterLines.forEach((line, index) => {
    out.push({ id: `replicate-entry-door-${index + 1}`, kind: "entry-door", line });
  });
  verifier.windowCenterLines.forEach((line, index) => {
    out.push({ id: `replicate-window-${index + 1}`, kind: "window", line });
  });
  return out;
}

function compatible(primary: OpeningKind, secondary: OpeningKind): boolean {
  if (primary === "window") return secondary === "window";
  return secondary === "door" || secondary === "entry-door";
}

function boundsForPoints(points: NormalizedPoint2D[]): Bounds | null {
  if (points.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { minX, minY, maxX, maxY };
}

function expanded(bounds: Bounds, margin = 0.025): Bounds {
  return {
    minX: Math.max(0, bounds.minX - margin),
    minY: Math.max(0, bounds.minY - margin),
    maxX: Math.min(1, bounds.maxX + margin),
    maxY: Math.min(1, bounds.maxY + margin),
  };
}

function intersects(a: Bounds, b: Bounds): boolean {
  return !(a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY);
}

function primaryBounds(primary: CanonicalPlan): Bounds | null {
  const points: NormalizedPoint2D[] = [];
  primary.walls.forEach((wall) => points.push(...wall.footprint));
  primary.rooms.forEach((room) => points.push(...room.polygon));
  primary.openings.forEach((opening) => {
    points.push(opening.centerLine.start, opening.centerLine.end);
  });
  const bounds = boundsForPoints(points);
  return bounds === null ? null : expanded(bounds);
}

function contourInScope(contour: NormalizedPoint2D[], scope: Bounds): boolean {
  const bounds = boundsForPoints(contour);
  return bounds !== null && intersects(bounds, scope);
}

function lineInScope(
  line: [NormalizedPoint2D, NormalizedPoint2D],
  scope: Bounds,
): boolean {
  const bounds = boundsForPoints(line);
  return bounds !== null && intersects(bounds, scope);
}

/**
 * Replicate operates on the whole raster page. A PDF/image page may contain more than
 * one detected plan, while this fusion function receives one Tectly plan at a time.
 * Scope secondary evidence to the current primary geometry so another plan on the same
 * page cannot manufacture false "Replicate-only" conflicts here.
 */
function scopeVerifierToPrimary(
  primary: CanonicalPlan,
  verifier: ReplicateVerifierResult,
): { verifier: ReplicateVerifierResult; removedEvidenceCount: number } {
  const scope = primaryBounds(primary);
  if (scope === null) return { verifier, removedEvidenceCount: 0 };

  const wallContours = verifier.wallContours.filter((contour) => contourInScope(contour, scope));
  const doorContours = verifier.doorContours.filter((contour) => contourInScope(contour, scope));
  const entryDoorContours = verifier.entryDoorContours.filter((contour) => contourInScope(contour, scope));
  const windowContours = verifier.windowContours.filter((contour) => contourInScope(contour, scope));
  const kitchenContours = verifier.kitchenContours.filter((contour) => contourInScope(contour, scope));
  const doorCenterLines = verifier.doorCenterLines.filter((line) => lineInScope(line, scope));
  const entryDoorCenterLines = verifier.entryDoorCenterLines.filter((line) => lineInScope(line, scope));
  const windowCenterLines = verifier.windowCenterLines.filter((line) => lineInScope(line, scope));

  const before =
    verifier.wallContours.length +
    verifier.doorContours.length +
    verifier.entryDoorContours.length +
    verifier.windowContours.length +
    verifier.kitchenContours.length +
    verifier.doorCenterLines.length +
    verifier.entryDoorCenterLines.length +
    verifier.windowCenterLines.length;
  const after =
    wallContours.length +
    doorContours.length +
    entryDoorContours.length +
    windowContours.length +
    kitchenContours.length +
    doorCenterLines.length +
    entryDoorCenterLines.length +
    windowCenterLines.length;

  return {
    verifier: {
      ...verifier,
      wallContours,
      doorContours,
      entryDoorContours,
      windowContours,
      kitchenContours,
      doorCenterLines,
      entryDoorCenterLines,
      windowCenterLines,
    },
    removedEvidenceCount: Math.max(0, before - after),
  };
}

/**
 * Tectly stays authoritative. Replicate can confirm, flag, or add a review candidate;
 * it never silently replaces a Tectly wall/opening geometry.
 */
export function fuseTectlyWithReplicate(
  primary: CanonicalPlan,
  verifier: ReplicateVerifierResult,
): CanonicalPlan {
  const { widthPx, heightPx } = primary.sourceImage;
  const conflicts = [...primary.qa.conflicts];
  const notes = [...primary.qa.notes];
  const reviewCandidates: ReviewCandidate[] = [...primary.reviewCandidates];
  const scoped = scopeVerifierToPrimary(primary, verifier);
  const secondaryVerifier = scoped.verifier;

  if (scoped.removedEvidenceCount > 0) {
    notes.push(
      `Ignored ${scoped.removedEvidenceCount} verifier detections outside this plan's geometry bounds.`,
    );
  }

  let confirmedWalls = 0;
  const walls = primary.walls.map((wall) => {
    let bestScore = 0;
    let bestIndex = -1;
    secondaryVerifier.wallContours.forEach((contour, index) => {
      const score = polygonSupportScore(wall.footprint, contour, widthPx, heightPx);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });

    if (bestScore < 0.55 || bestIndex < 0) return wall;
    confirmedWalls += 1;
    return {
      ...wall,
      confidence: {
        score: Math.max(wall.confidence.score, 0.95),
        agreement: "confirmed" as const,
        evidence: [
          ...wall.confidence.evidence,
          {
            provider: "replicate" as const,
            providerElementId: `wall-contour-${bestIndex + 1}`,
            confidence: Math.min(0.9, 0.6 + bestScore * 0.3),
          },
        ],
      },
    };
  });

  // Replicate wall contours are connected segmentation regions, not semantic walls.
  // Only surface a contour when it supports no Tectly wall at all.
  secondaryVerifier.wallContours.forEach((contour, index) => {
    const bestPrimary = primary.walls.reduce(
      (best, wall) => Math.max(best, polygonSupportScore(wall.footprint, contour, widthPx, heightPx)),
      0,
    );
    if (bestPrimary < 0.25) {
      reviewCandidates.push({
        id: `review-replicate-wall-${index + 1}`,
        provider: "replicate",
        kind: "wall",
        reason: "Replicate detected a wall region that does not support any Tectly wall.",
        centerLine: null,
        contour,
      });
    }
  });

  const secondary = verifierOpenings(secondaryVerifier);
  const used = new Set<string>();
  let confirmedOpenings = 0;

  const openings = primary.openings.map((opening) => {
    const primaryLine: SecondaryOpening["line"] = [opening.centerLine.start, opening.centerLine.end];
    let best: SecondaryOpening | null = null;
    let bestScore = 0;

    for (const candidate of secondary) {
      if (used.has(candidate.id) || !compatible(opening.kind, candidate.kind)) continue;
      const score = lineMatchScore(primaryLine, candidate.line, widthPx, heightPx);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    if (best === null || bestScore < 0.55) return opening;
    used.add(best.id);
    confirmedOpenings += 1;

    return {
      ...opening,
      // Tectly confirms the opening geometry; Replicate may safely add the entry-door label.
      kind: opening.kind === "door" && best.kind === "entry-door" ? "entry-door" : opening.kind,
      confidence: {
        score: Math.max(opening.confidence.score, 0.96),
        agreement: "confirmed" as const,
        evidence: [
          ...opening.confidence.evidence,
          {
            provider: "replicate" as const,
            providerElementId: best.id,
            confidence: Math.min(0.92, 0.65 + bestScore * 0.3),
          },
        ],
      },
    };
  });

  for (const candidate of secondary) {
    if (used.has(candidate.id)) continue;

    let bestAnyScore = 0;
    let bestAnyKind: OpeningKind | null = null;
    for (const opening of primary.openings) {
      const score = lineMatchScore(
        [opening.centerLine.start, opening.centerLine.end],
        candidate.line,
        widthPx,
        heightPx,
      );
      if (score > bestAnyScore) {
        bestAnyScore = score;
        bestAnyKind = opening.kind;
      }
    }

    const tooLong = lineLengthNormalized(candidate.line, widthPx, heightPx) > 0.25;
    const typeConflict = bestAnyScore >= 0.6 && bestAnyKind !== null && !compatible(bestAnyKind, candidate.kind);
    if (typeConflict) {
      conflicts.push(
        `${candidate.id} overlaps a Tectly ${bestAnyKind} but Replicate classifies it as ${candidate.kind}.`,
      );
    }

    reviewCandidates.push({
      id: `review-${candidate.id}`,
      provider: "replicate",
      kind: candidate.kind,
      reason: tooLong
        ? "Replicate-only opening has an unusually long center line and is treated as suspicious."
        : typeConflict
          ? "Replicate and Tectly disagree on the opening type."
          : "Replicate detected an opening that Tectly did not confirm.",
      centerLine: { start: candidate.line[0], end: candidate.line[1] },
      contour: null,
    });
  }

  const wallConfirmationRate = walls.length === 0 ? 0 : confirmedWalls / walls.length;
  const openingConfirmationRate = openings.length === 0 ? 1 : confirmedOpenings / openings.length;
  notes.push(
    `Replicate confirmation: ${confirmedWalls}/${walls.length} walls, ${confirmedOpenings}/${openings.length} openings.`,
  );

  let status: CanonicalPlan["qa"]["status"] = "review";
  if (walls.length === 0) {
    status = "blocked";
  } else if (
    reviewCandidates.length === 0 &&
    conflicts.length === 0 &&
    primary.scale.source !== "unknown" &&
    wallConfirmationRate >= 0.5 &&
    openingConfirmationRate >= 0.5
  ) {
    status = "pass";
  }

  return {
    ...primary,
    walls,
    openings,
    reviewCandidates,
    qa: { status, conflicts, notes },
  };
}
