import type { CanonicalPlan, SourceImageInfo } from "./domain/canonical.js";
import { fuseTectlyWithReplicate } from "./fusion/fuse.js";
import { ReplicateFloorplanClient } from "./providers/replicate-client.js";
import { TectlyClient } from "./providers/tectly-client.js";
import { mapTectlyBundleToCanonical } from "./providers/tectly-mapper.js";
import type { ReplicateVerifierResult } from "./providers/types.js";
import { buildBaytiRenderContract, type BaytiRenderContract } from "./render-contract.js";

export const BAYTI_CORE_VERSION = "0.6.0" as const;

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
    // In required mode, verify first. If it fails, no quota-bearing Tectly upload occurs.
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
    // Best-effort mode keeps latency low while preserving the primary result if the
    // independent verifier fails after the paid Tectly analysis has started.
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

  const renderContracts = plans.map((plan) => buildBaytiRenderContract(plan));

  return {
    engineVersion: BAYTI_CORE_VERSION,
    tectlyProjectId: tectlyResult.projectId,
    tectlyDocumentId: tectlyResult.documentId,
    replicateRequestId: verifier?.meta.requestId ?? null,
    verifierStatus,
    verifierMessage,
    plans,
    renderContracts,
  };
}
