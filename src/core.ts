import type {
  CanonicalPlan,
  NormalizedPoint2D,
  PlanScale,
  SourceImageInfo,
} from "./domain/canonical.js";
import { fuseTectlyWithReplicate } from "./fusion/fuse.js";
import {
  inferOpeningWallSupport,
  openingWidthMeters,
} from "./providers/opening-host.js";
import { ReplicateFloorplanClient } from "./providers/replicate-client.js";
import { TectlyClient } from "./providers/tectly-client.js";
import { mapTectlyBundleToCanonical } from "./providers/tectly-mapper.js";
import type { ReplicateVerifierResult } from "./providers/types.js";
import { fitStraightWallFootprint } from "./providers/wall-fit.js";
import { buildBaytiRenderContract, type BaytiRenderContract } from "./render-contract.js";
import { deriveManualScale, type ScaleMeasurement } from "./scale-calibration.js";

export const BAYTI_CORE_VERSION = "0.9.0" as const;

export type VerifierMode = "best-effort" | "required";
export type VerifierStatus = "succeeded" | "skipped" | "failed";

export interface AnalyzeBaytiCoreInput {
  /** Original JPG/PNG/PDF sent to Tectly. */
  tectlyFile: Blob;
  fileName: string;
  /** Raster representation used as the common 0..1 coordinate page. */
  sourceImage: SourceImageInfo;
  /** JPG/PNG, URL, or data URL sent to Replicate. For a PDF, render the same page first. */
  replicateImage: Blob | string;
  wallTracingMode?: "Polygons" | "Rectangles" | "UniformPolygons";
  /**
   * best-effort (default): Tectly remains usable when the verifier is missing/down.
   * required: fail before the Tectly upload when the verifier is not configured, and
   * run the verifier first so a verifier failure cannot consume a Tectly analysis.
   */
  verifierMode?: VerifierMode;
}

export interface BaytiCoreAnalysisResult {
  engineVersion: typeof BAYTI_CORE_VERSION;
  tectlyProjectId: string;
  tectlyDocumentId: string;
  replicateRequestId: string | null;
  verifierStatus: VerifierStatus;
  verifierMessage: string | null;
  /** Full diagnostic/source-aware canonical plans. */
  plans: CanonicalPlan[];
  /** Stable product/3D handoff. Future UI should consume these rather than provider shapes. */
  renderContracts: BaytiRenderContract[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function polygonAreaSquareMeters(points: NormalizedPoint2D[], scale: PlanScale): number | null {
  const sx = scale.metersPerNormalizedX;
  const sy = scale.metersPerNormalizedY;
  if (sx === null || sy === null || sx <= 0 || sy <= 0 || points.length < 3) return null;

  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    if (!current || !next) continue;
    const x1 = current.x * sx;
    const y1 = current.y * sy;
    const x2 = next.x * sx;
    const y2 = next.y * sy;
    twiceArea += x1 * y2 - x2 * y1;
  }
  const area = Math.abs(twiceArea) / 2;
  return Number.isFinite(area) && area > 0 ? area : null;
}

function markVerifierUnavailable(primary: CanonicalPlan, message: string): CanonicalPlan {
  return {
    ...primary,
    qa: {
      ...primary.qa,
      status: primary.qa.status === "blocked" ? "blocked" : "review",
      notes: [...primary.qa.notes, `Independent verifier unavailable: ${message}`],
    },
  };
}

function mapPlans(
  tectlyResult: Awaited<ReturnType<TectlyClient["analyze"]>>,
  sourceImage: SourceImageInfo,
  verifier: ReplicateVerifierResult | null,
  verifierMessage: string | null,
): CanonicalPlan[] {
  return tectlyResult.planBundles.map((bundle) => {
    const primary = mapTectlyBundleToCanonical(bundle, sourceImage);
    if (verifier !== null) return fuseTectlyWithReplicate(primary, verifier);
    return markVerifierUnavailable(primary, verifierMessage ?? "not configured");
  });
}

/**
 * Recomputes deterministic Core-derived geometry from an already-paid canonical result.
 * No provider/network calls occur here. This is also the path used after evidence-based
 * scale calibration so wall thicknesses, opening widths, room areas and render gates all
 * agree on the same physical scale.
 */
function refreshDerivedPlan(plan: CanonicalPlan): CanonicalPlan {
  const walls = plan.walls.map((wall) => {
    const fit = fitStraightWallFootprint(wall.footprint, plan.sourceImage, plan.scale);
    return {
      ...wall,
      geometry: fit?.geometry ?? wall.geometry,
      thicknessMeters: fit?.thicknessMeters ?? wall.thicknessMeters,
    };
  });

  let supportedOpeningCount = 0;
  let hostedOpeningCount = 0;
  let bridgedOpeningCount = 0;
  let measuredOpeningCount = 0;

  const openings = plan.openings.map((opening) => {
    const wallSupport = inferOpeningWallSupport(opening.centerLine, walls, plan.sourceImage);
    const widthMeters = openingWidthMeters(opening.centerLine, plan.scale);

    if (wallSupport.supportingWallIds.length > 0) supportedOpeningCount += 1;
    if (wallSupport.hostWallId !== null) hostedOpeningCount += 1;
    if (wallSupport.supportingWallIds.length === 2) bridgedOpeningCount += 1;
    if (widthMeters !== null) measuredOpeningCount += 1;

    return {
      ...opening,
      hostWallId: wallSupport.hostWallId,
      supportingWallIds: wallSupport.supportingWallIds,
      widthMeters,
    };
  });

  let measuredRoomCount = 0;
  const rooms = plan.rooms.map((room) => {
    const areaSquareMeters = polygonAreaSquareMeters(room.polygon, plan.scale);
    if (areaSquareMeters !== null) measuredRoomCount += 1;
    return { ...room, areaSquareMeters };
  });

  const notes = plan.qa.notes.filter(
    (note) =>
      !note.startsWith("Opening geometry:") &&
      !note.startsWith("Opening wall support:") &&
      !note.startsWith("Opening wall support (derived refresh):") &&
      !note.startsWith("Room geometry (derived refresh):") &&
      !note.startsWith("Physical scale calibration:"),
  );
  if (openings.length > 0) {
    notes.push(
      `Opening wall support (derived refresh): ${supportedOpeningCount}/${openings.length} openings have unambiguous wall-region support (${hostedOpeningCount} single-footprint, ${bridgedOpeningCount} bridged across two fragments); ${measuredOpeningCount}/${openings.length} have a physical width.`,
    );
  }
  if (rooms.length > 0) {
    notes.push(
      `Room geometry (derived refresh): ${measuredRoomCount}/${rooms.length} rooms have an area derived from canonical physical scale.`,
    );
  }

  return {
    ...plan,
    walls,
    openings,
    rooms,
    qa: {
      ...plan.qa,
      notes,
    },
  };
}

/**
 * Upgrades an analysis payload stored by an older Core version using only its canonical
 * geometry. Provider ids/evidence remain untouched; render contracts are rebuilt from
 * the refreshed plans under the current engine contract.
 */
export function refreshDerivedAnalysisResult(
  result: Omit<BaytiCoreAnalysisResult, "engineVersion"> & { engineVersion: string },
): BaytiCoreAnalysisResult {
  const plans = result.plans.map((plan) => refreshDerivedPlan(plan));
  return {
    ...result,
    engineVersion: BAYTI_CORE_VERSION,
    plans,
    renderContracts: plans.map((plan) => buildBaytiRenderContract(plan)),
  };
}

/**
 * Applies explicit real-world dimension evidence to an existing paid analysis. This is
 * intentionally provider-free: it never uploads a document or starts a Replicate run.
 * Every plan on the same raster page receives the same physical pixel scale.
 */
export function applyManualScaleToAnalysisResult(
  result: Omit<BaytiCoreAnalysisResult, "engineVersion"> & { engineVersion: string },
  measurements: ScaleMeasurement[],
): BaytiCoreAnalysisResult {
  if (!Array.isArray(result.plans) || result.plans.length === 0) {
    throw new Error("MANUAL_SCALE_ANALYSIS_HAS_NO_PLANS");
  }

  const plans = result.plans.map((plan) => {
    const calibration = deriveManualScale(measurements, plan.sourceImage);
    const calibrated: CanonicalPlan = {
      ...plan,
      scale: calibration.scale,
      qa: {
        ...plan.qa,
        notes: [
          ...plan.qa.notes.filter((note) => !note.startsWith("Physical scale calibration:")),
          `Physical scale calibration: ${calibration.measurementCount} explicit measurement(s), relative spread ${(calibration.relativeSpread * 100).toFixed(2)}%, confidence ${calibration.scale.confidence.toFixed(2)}.`,
        ],
      },
    };
    return refreshDerivedPlan(calibrated);
  });

  return {
    ...result,
    engineVersion: BAYTI_CORE_VERSION,
    plans,
    renderContracts: plans.map((plan) => buildBaytiRenderContract(plan)),
  };
}

/**
 * V2 core entry point.
 *
 * Tectly is the primary geometry source. Replicate is deliberately an independent
 * verifier, so the default mode does not throw away a paid Tectly result merely because
 * the verifier is unavailable. Callers that require two-provider evidence can opt into
 * `verifierMode: "required"`.
 */
export async function analyzeBaytiCore(
  input: AnalyzeBaytiCoreInput,
  clients: {
    tectly?: TectlyClient;
    replicate?: ReplicateFloorplanClient;
  } = {},
): Promise<BaytiCoreAnalysisResult> {
  const tectly = clients.tectly ?? new TectlyClient();
  const verifierMode = input.verifierMode ?? "best-effort";

  let replicate: ReplicateFloorplanClient | null = clients.replicate ?? null;
  let verifierSetupMessage: string | null = null;
  if (replicate === null) {
    try {
      replicate = new ReplicateFloorplanClient();
    } catch (error) {
      verifierSetupMessage = errorMessage(error);
    }
  }

  // Authentication is free/quota-neutral and always happens before a Tectly upload.
  await tectly.authenticate();

  if (verifierMode === "required" && replicate === null) {
    throw new Error(`Replicate verifier is required but unavailable: ${verifierSetupMessage ?? "not configured"}`);
  }

  let tectlyResult: Awaited<ReturnType<TectlyClient["analyze"]>>;
  let verifier: ReplicateVerifierResult | null = null;
  let verifierStatus: VerifierStatus = replicate === null ? "skipped" : "failed";
  let verifierMessage = verifierSetupMessage;

  if (verifierMode === "required") {
    verifier = await replicate!.run({
      image: input.replicateImage,
      widthPx: input.sourceImage.widthPx,
      heightPx: input.sourceImage.heightPx,
    });
    verifierStatus = "succeeded";
    verifierMessage = null;

    tectlyResult = await tectly.analyze({
      file: input.tectlyFile,
      fileName: input.fileName,
      consumeAnalysis: true,
      wallTracingMode: input.wallTracingMode ?? "Polygons",
      title: `Bayti Core V2 — ${input.fileName}`,
    });
  } else if (replicate !== null) {
    const verifierPromise = replicate
      .run({
        image: input.replicateImage,
        widthPx: input.sourceImage.widthPx,
        heightPx: input.sourceImage.heightPx,
      })
      .then((result) => ({ result, error: null as string | null }))
      .catch((error: unknown) => ({ result: null, error: errorMessage(error) }));

    const [primaryResult, verifierOutcome] = await Promise.all([
      tectly.analyze({
        file: input.tectlyFile,
        fileName: input.fileName,
        consumeAnalysis: true,
        wallTracingMode: input.wallTracingMode ?? "Polygons",
        title: `Bayti Core V2 — ${input.fileName}`,
      }),
      verifierPromise,
    ]);

    tectlyResult = primaryResult;
    verifier = verifierOutcome.result;
    verifierStatus = verifier === null ? "failed" : "succeeded";
    verifierMessage = verifierOutcome.error;
  } else {
    tectlyResult = await tectly.analyze({
      file: input.tectlyFile,
      fileName: input.fileName,
      consumeAnalysis: true,
      wallTracingMode: input.wallTracingMode ?? "Polygons",
      title: `Bayti Core V2 — ${input.fileName}`,
    });
  }

  const plans = mapPlans(tectlyResult, input.sourceImage, verifier, verifierMessage);

  if (plans.length === 0) {
    throw new Error("Tectly completed but returned no usable floor plan/floor geometry.");
  }

  return refreshDerivedAnalysisResult({
    engineVersion: BAYTI_CORE_VERSION,
    tectlyProjectId: tectlyResult.projectId,
    tectlyDocumentId: tectlyResult.documentId,
    replicateRequestId: verifier?.meta.requestId ?? null,
    verifierStatus,
    verifierMessage,
    plans,
    renderContracts: [],
  });
}
