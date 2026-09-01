import type { CanonicalPlan, SourceImageInfo } from "./domain/canonical.js";
import { fuseTectlyWithReplicate } from "./fusion/fuse.js";
import { ReplicateFloorplanClient } from "./providers/replicate-client.js";
import { TectlyClient } from "./providers/tectly-client.js";
import { mapTectlyBundleToCanonical } from "./providers/tectly-mapper.js";

export interface AnalyzeBaytiCoreInput {
  /** Original JPG/PNG/PDF sent to Tectly. */
  tectlyFile: Blob;
  fileName: string;
  /** Raster representation used as the common 0..1 coordinate page. */
  sourceImage: SourceImageInfo;
  /** JPG/PNG, URL, or data URL sent to Replicate. For a PDF, render the same page first. */
  replicateImage: Blob | string;
  wallTracingMode?: "Polygons" | "Rectangles" | "UniformPolygons";
}

export interface BaytiCoreAnalysisResult {
  tectlyProjectId: string;
  tectlyDocumentId: string;
  replicateRequestId: string | null;
  plans: CanonicalPlan[];
}

/**
 * V2 core entry point.
 *
 * Order matters: authenticate Tectly first without consuming an analysis. Only after
 * authentication succeeds do we start the quota-bearing Tectly upload and Replicate verifier.
 */
export async function analyzeBaytiCore(
  input: AnalyzeBaytiCoreInput,
  clients: {
    tectly?: TectlyClient;
    replicate?: ReplicateFloorplanClient;
  } = {},
): Promise<BaytiCoreAnalysisResult> {
  const tectly = clients.tectly ?? new TectlyClient();
  const replicate = clients.replicate ?? new ReplicateFloorplanClient();

  await tectly.authenticate();

  const [tectlyResult, verifier] = await Promise.all([
    tectly.analyze({
      file: input.tectlyFile,
      fileName: input.fileName,
      consumeAnalysis: true,
      wallTracingMode: input.wallTracingMode ?? "Polygons",
      title: `Bayti Core V2 — ${input.fileName}`,
    }),
    replicate.run({
      image: input.replicateImage,
      widthPx: input.sourceImage.widthPx,
      heightPx: input.sourceImage.heightPx,
    }),
  ]);

  const plans = tectlyResult.planBundles.map((bundle) => {
    const primary = mapTectlyBundleToCanonical(bundle, input.sourceImage);
    return fuseTectlyWithReplicate(primary, verifier);
  });

  if (plans.length === 0) {
    throw new Error("Tectly completed but returned no usable floor plan/floor geometry.");
  }

  return {
    tectlyProjectId: tectlyResult.projectId,
    tectlyDocumentId: tectlyResult.documentId,
    replicateRequestId: verifier.meta.requestId ?? null,
    plans,
  };
}
