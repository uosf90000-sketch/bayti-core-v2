import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  analyzeBaytiCore,
  applyManualScaleToAnalysisResult,
  BAYTI_CORE_VERSION,
  refreshDerivedAnalysisResult,
  type BaytiCoreAnalysisResult,
  type VerifierMode,
} from "./core.js";
import {
  FileIdempotencyStore,
  IdempotencyRegistry,
  type IdempotencyStore,
} from "./idempotency.js";
import { LabJobRegistry } from "./lab-jobs.js";
import { baytiEngineLabHtml } from "./lab.js";
import { PostgresIdempotencyStore } from "./postgres-idempotency.js";
import type { ScaleMeasurement } from "./scale-calibration.js";

const DEFAULT_MAX_BODY_BYTES = 35 * 1024 * 1024;
const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const MAX_BODY_BYTES = Number.parseInt(
  process.env.BAYTI_CORE_MAX_BODY_BYTES ?? String(DEFAULT_MAX_BODY_BYTES),
  10,
);
const IDEMPOTENCY_TTL_MS = Number.parseInt(
  process.env.BAYTI_CORE_IDEMPOTENCY_TTL_MS ?? String(30 * 60_000),
  10,
);
const IDEMPOTENCY_DIR = process.env.BAYTI_CORE_IDEMPOTENCY_DIR?.trim() || null;
const IDEMPOTENCY_DATABASE_URL =
  process.env.BAYTI_CORE_IDEMPOTENCY_DATABASE_URL?.trim() || null;
const REQUIRE_PERSISTENT_IDEMPOTENCY = /^(1|true|yes)$/i.test(
  process.env.BAYTI_CORE_REQUIRE_PERSISTENT_IDEMPOTENCY?.trim() ?? "false",
);
const LAB_KEY = process.env.BAYTI_CORE_LAB_KEY?.trim() || null;

function idempotencyStore(): IdempotencyStore<BaytiCoreAnalysisResult> | undefined {
  if (IDEMPOTENCY_DATABASE_URL) {
    return new PostgresIdempotencyStore<BaytiCoreAnalysisResult>(IDEMPOTENCY_DATABASE_URL);
  }
  if (IDEMPOTENCY_DIR) {
    return new FileIdempotencyStore<BaytiCoreAnalysisResult>(IDEMPOTENCY_DIR);
  }
  return undefined;
}

const analysisRegistry = new IdempotencyRegistry<BaytiCoreAnalysisResult>(
  IDEMPOTENCY_TTL_MS,
  () => Date.now(),
  idempotencyStore(),
);
const labJobs = new LabJobRegistry<BaytiCoreAnalysisResult>();

interface AnalyzeRequestBody {
  fileName: string;
  fileBase64: string;
  fileMimeType: string;
  sourceImage: {
    widthPx: number;
    heightPx: number;
    mimeType: string;
  };
  replicateImageBase64?: string;
  replicateImageMimeType?: string;
  wallTracingMode?: "Polygons" | "Rectangles" | "UniformPolygons";
  verifierMode?: VerifierMode;
}

interface CalibrationRequestBody {
  analysis: Omit<BaytiCoreAnalysisResult, "engineVersion"> & { engineVersion: string };
  measurements: ScaleMeasurement[];
}

interface SafeError {
  status: number;
  code: string;
  message: string;
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...headers,
  });
  response.end(payload);
}

function sendHtml(
  response: ServerResponse,
  statusCode: number,
  html: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(html);
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0]?.trim() || null;
  return value?.trim() || null;
}

function requestId(request: IncomingMessage): string {
  const supplied = firstHeader(request.headers["x-request-id"]);
  if (supplied && supplied.length <= 128) return supplied;
  return randomUUID();
}

function bearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function authorized(request: IncomingMessage): boolean {
  const expected = process.env.BAYTI_CORE_API_KEY?.trim();
  const supplied = bearerToken(request);
  if (!expected || !supplied) return false;
  return safeEqual(supplied, expected);
}

function labAuthorized(request: IncomingMessage): boolean {
  const supplied = firstHeader(request.headers["x-bayti-lab-key"]);
  if (!LAB_KEY || !supplied) return false;
  return safeEqual(supplied, LAB_KEY);
}

function readIdempotencyKey(request: IncomingMessage): string | null {
  const key = firstHeader(request.headers["idempotency-key"]);
  if (!key || key.length < 8 || key.length > 200) return null;
  return key;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error("REQUEST_BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim().length === 0) throw new Error("EMPTY_REQUEST_BODY");
  return JSON.parse(raw) as unknown;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function parseAnalyzeBody(value: unknown): AnalyzeRequestBody {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_REQUEST_BODY");
  }
  const input = value as Record<string, unknown>;
  const sourceImage = input.sourceImage;
  if (sourceImage === null || typeof sourceImage !== "object" || Array.isArray(sourceImage)) {
    throw new Error("INVALID_SOURCE_IMAGE");
  }
  const image = sourceImage as Record<string, unknown>;
  if (
    typeof input.fileName !== "string" || input.fileName.trim().length === 0 ||
    typeof input.fileBase64 !== "string" || input.fileBase64.length === 0 ||
    typeof input.fileMimeType !== "string" || input.fileMimeType.trim().length === 0 ||
    !isPositiveFiniteNumber(image.widthPx) || !isPositiveFiniteNumber(image.heightPx) ||
    typeof image.mimeType !== "string" || image.mimeType.trim().length === 0
  ) {
    throw new Error("INVALID_ANALYZE_INPUT");
  }

  const wallTracingMode = input.wallTracingMode;
  if (
    wallTracingMode !== undefined && wallTracingMode !== "Polygons" &&
    wallTracingMode !== "Rectangles" && wallTracingMode !== "UniformPolygons"
  ) throw new Error("INVALID_WALL_TRACING_MODE");

  const verifierMode = input.verifierMode;
  if (verifierMode !== undefined && verifierMode !== "best-effort" && verifierMode !== "required") {
    throw new Error("INVALID_VERIFIER_MODE");
  }
  if (input.replicateImageBase64 !== undefined && typeof input.replicateImageBase64 !== "string") {
    throw new Error("INVALID_REPLICATE_IMAGE");
  }
  if (input.replicateImageMimeType !== undefined && typeof input.replicateImageMimeType !== "string") {
    throw new Error("INVALID_REPLICATE_IMAGE_MIME_TYPE");
  }

  return {
    fileName: input.fileName,
    fileBase64: input.fileBase64,
    fileMimeType: input.fileMimeType,
    sourceImage: {
      widthPx: image.widthPx,
      heightPx: image.heightPx,
      mimeType: image.mimeType,
    },
    replicateImageBase64: input.replicateImageBase64 as string | undefined,
    replicateImageMimeType: input.replicateImageMimeType as string | undefined,
    wallTracingMode,
    verifierMode,
  };
}

function parseCalibrationBody(value: unknown): CalibrationRequestBody {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_CALIBRATION_REQUEST");
  }
  const body = value as Record<string, unknown>;
  if (body.analysis === null || typeof body.analysis !== "object" || Array.isArray(body.analysis)) {
    throw new Error("INVALID_CALIBRATION_ANALYSIS");
  }
  const analysis = body.analysis as Record<string, unknown>;
  if (!Array.isArray(analysis.plans) || analysis.plans.length === 0) {
    throw new Error("INVALID_CALIBRATION_ANALYSIS");
  }
  if (!Array.isArray(body.measurements) || body.measurements.length === 0 || body.measurements.length > 8) {
    throw new Error("INVALID_CALIBRATION_MEASUREMENTS");
  }

  const measurements: ScaleMeasurement[] = body.measurements.map((raw) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("INVALID_CALIBRATION_MEASUREMENT");
    }
    const item = raw as Record<string, unknown>;
    const readPoint = (point: unknown) => {
      if (point === null || typeof point !== "object" || Array.isArray(point)) {
        throw new Error("INVALID_CALIBRATION_POINT");
      }
      const p = point as Record<string, unknown>;
      if (typeof p.x !== "number" || typeof p.y !== "number") {
        throw new Error("INVALID_CALIBRATION_POINT");
      }
      return { x: p.x, y: p.y };
    };
    if (typeof item.meters !== "number") throw new Error("INVALID_CALIBRATION_DISTANCE");
    return { start: readPoint(item.start), end: readPoint(item.end), meters: item.meters };
  });

  return {
    analysis: body.analysis as CalibrationRequestBody["analysis"],
    measurements,
  };
}

function decodeBlob(base64: string, mimeType: string): Blob {
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length === 0) throw new Error("EMPTY_DECODED_FILE");
  return new Blob([new Uint8Array(buffer)], { type: mimeType });
}

function requestFingerprint(body: AnalyzeRequestBody): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeProviderError(message: string): SafeError | null {
  if (message.startsWith("Tectly authentication failed with HTTP ")) {
    return { status: 502, code: "TECTLY_AUTHENTICATION_FAILED", message };
  }
  if (message === "Tectly authentication returned no token.") {
    return { status: 502, code: "TECTLY_AUTHENTICATION_INVALID_RESPONSE", message };
  }
  if (message.startsWith("Tectly request failed: HTTP ")) {
    return { status: 502, code: "TECTLY_REQUEST_FAILED", message };
  }
  if (message.startsWith("Timed out waiting for Tectly ")) {
    return { status: 504, code: "TECTLY_PROCESSING_TIMEOUT", message };
  }
  if (message.startsWith("Invalid Tectly response:")) {
    return { status: 502, code: "TECTLY_INVALID_RESPONSE", message };
  }
  if (message.startsWith("Tectly is not configured.")) {
    return { status: 503, code: "TECTLY_NOT_CONFIGURED", message: "Tectly credentials are not configured on the server." };
  }
  if (message === "Tectly completed but returned no usable floor plan/floor geometry.") {
    return { status: 422, code: "TECTLY_NO_USABLE_PLAN", message: "Tectly completed the document but returned no usable floor-plan geometry." };
  }
  if (
    message === "fetch failed" || message.toLowerCase().includes("operation was aborted") ||
    message.toLowerCase().includes("network")
  ) {
    return { status: 502, code: "TECTLY_NETWORK_FAILED", message: "Tectly network request failed before a usable response was received." };
  }
  if (message.startsWith("Replicate verifier is required but unavailable:")) {
    return { status: 503, code: "REPLICATE_REQUIRED_UNAVAILABLE", message };
  }
  if (message.startsWith("Replicate request failed")) {
    return { status: 502, code: "REPLICATE_REQUEST_FAILED", message };
  }
  return null;
}

function safeError(error: unknown): SafeError {
  const message = errorMessage(error);
  if (message === "REQUEST_BODY_TOO_LARGE") {
    return { status: 413, code: message, message: "Request body is too large." };
  }
  if (message === "PDF_REQUIRES_REPLICATE_RASTER") {
    return { status: 400, code: message, message: "PDF analysis requires a raster image of the same page for the independent verifier." };
  }
  if (message === "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST") {
    return { status: 409, code: message, message: "Idempotency key was already used for a different analysis request." };
  }
  if (message === "IDEMPOTENCY_REQUEST_IN_PROGRESS_OR_INTERRUPTED") {
    return {
      status: 409,
      code: message,
      message: "This paid analysis key is still pending or was interrupted. It will not be run again automatically; inspect the prior run before intentionally using a new key.",
    };
  }
  if (message === "MANUAL_SCALE_MEASUREMENTS_CONFLICT") {
    return { status: 400, code: message, message: "The supplied real-world dimensions disagree by more than the allowed 3%. Recheck the selected endpoints and distances." };
  }
  if (
    message.startsWith("INVALID_") || message.startsWith("MANUAL_SCALE_") ||
    message === "EMPTY_REQUEST_BODY" || message === "EMPTY_DECODED_FILE"
  ) {
    return { status: 400, code: message, message: "Invalid analysis or scale-calibration request." };
  }

  const provider = safeProviderError(message);
  if (provider !== null) return provider;
  return { status: 502, code: "PROVIDER_ANALYSIS_FAILED", message: "Floor-plan provider analysis failed." };
}

async function executeAnalysis(
  body: AnalyzeRequestBody,
  idempotencyKey: string,
): Promise<{ value: BaytiCoreAnalysisResult; replayed: boolean }> {
  if (body.fileMimeType.toLowerCase().includes("pdf") && !body.replicateImageBase64) {
    throw new Error("PDF_REQUIRES_REPLICATE_RASTER");
  }
  const fingerprint = requestFingerprint(body);
  const run = await analysisRegistry.run(idempotencyKey, fingerprint, async () => {
    const tectlyFile = decodeBlob(body.fileBase64, body.fileMimeType);
    const replicateImage = body.replicateImageBase64
      ? decodeBlob(body.replicateImageBase64, body.replicateImageMimeType ?? body.sourceImage.mimeType)
      : tectlyFile;
    return analyzeBaytiCore({
      tectlyFile,
      fileName: body.fileName,
      sourceImage: body.sourceImage,
      replicateImage,
      wallTracingMode: body.wallTracingMode,
      verifierMode: body.verifierMode,
    });
  });
  return { ...run, value: refreshDerivedAnalysisResult(run.value) };
}

function idempotencyRequired(
  request: IncomingMessage,
  response: ServerResponse,
  correlationId: string,
  commonHeaders: Record<string, string>,
): string | null {
  const idempotencyKey = readIdempotencyKey(request);
  if (idempotencyKey !== null) return idempotencyKey;
  sendJson(response, 400, {
    error: "IDEMPOTENCY_KEY_REQUIRED",
    message: "Send a stable Idempotency-Key header (8–200 characters) for each logical analysis.",
    requestId: correlationId,
  }, commonHeaders);
  return null;
}

async function handleAnalysis(
  request: IncomingMessage,
  response: ServerResponse,
  correlationId: string,
  commonHeaders: Record<string, string>,
): Promise<void> {
  const idempotencyKey = idempotencyRequired(request, response, correlationId, commonHeaders);
  if (idempotencyKey === null) return;
  try {
    const body = parseAnalyzeBody(await readJsonBody(request));
    const run = await executeAnalysis(body, idempotencyKey);
    sendJson(response, 200, run.value, {
      ...commonHeaders,
      "x-idempotency-replayed": run.replayed ? "true" : "false",
    });
  } catch (error) {
    const safe = safeError(error);
    if (safe.status >= 500) console.error(`[analysis ${correlationId}] ${errorMessage(error)}`);
    sendJson(response, safe.status, { error: safe.code, message: safe.message, requestId: correlationId }, commonHeaders);
  }
}

async function handleLabAnalysisStart(
  request: IncomingMessage,
  response: ServerResponse,
  correlationId: string,
  commonHeaders: Record<string, string>,
): Promise<void> {
  const idempotencyKey = idempotencyRequired(request, response, correlationId, commonHeaders);
  if (idempotencyKey === null) return;
  try {
    const body = parseAnalyzeBody(await readJsonBody(request));
    const jobId = labJobs.start(
      () => executeAnalysis(body, idempotencyKey),
      (error) => {
        const safe = safeError(error);
        if (safe.status >= 500) console.error(`[analysis-job ${correlationId}] ${errorMessage(error)}`);
        return safe;
      },
    );
    sendJson(response, 202, { jobId, status: "pending", requestId: correlationId }, commonHeaders);
  } catch (error) {
    const safe = safeError(error);
    sendJson(response, safe.status, { error: safe.code, message: safe.message, requestId: correlationId }, commonHeaders);
  }
}

function handleLabJobStatus(
  response: ServerResponse,
  jobId: string,
  correlationId: string,
  commonHeaders: Record<string, string>,
): void {
  const job = labJobs.get(jobId);
  if (job === null) {
    sendJson(response, 404, { error: "LAB_JOB_NOT_FOUND", message: "This lab job is no longer available. The paid-analysis ledger was not changed.", requestId: correlationId }, commonHeaders);
    return;
  }
  if (job.status === "pending") {
    sendJson(response, 202, { jobId, status: "pending", requestId: correlationId }, commonHeaders);
    return;
  }
  if (job.status === "failed") {
    sendJson(response, 200, {
      jobId,
      status: "failed",
      error: job.error.code,
      message: job.error.message,
      providerStatus: job.error.status,
      requestId: correlationId,
    }, commonHeaders);
    return;
  }
  sendJson(response, 200, {
    jobId,
    status: "succeeded",
    replayed: job.replayed,
    result: job.value,
    requestId: correlationId,
  }, commonHeaders);
}

async function handleCalibration(
  request: IncomingMessage,
  response: ServerResponse,
  correlationId: string,
  commonHeaders: Record<string, string>,
): Promise<void> {
  try {
    const body = parseCalibrationBody(await readJsonBody(request));
    const result = applyManualScaleToAnalysisResult(body.analysis, body.measurements);
    sendJson(response, 200, result, commonHeaders);
  } catch (error) {
    const safe = safeError(error);
    sendJson(response, safe.status, { error: safe.code, message: safe.message, requestId: correlationId }, commonHeaders);
  }
}

const server = createServer(async (request, response) => {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const correlationId = requestId(request);
  const commonHeaders = { "x-request-id": correlationId };

  if (method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      status: "ok",
      service: "bayti-core-v2",
      version: BAYTI_CORE_VERSION,
      idempotencyMode: analysisRegistry.mode,
    }, commonHeaders);
    return;
  }

  if (method === "GET" && url.pathname === "/ready") {
    const tectlyConfigured = Boolean(process.env.TECTLY_CLIENT_ID?.trim() && process.env.TECTLY_CLIENT_SECRET?.trim());
    const replicateConfigured = Boolean(process.env.REPLICATE_API_TOKEN?.trim());
    const apiKeyConfigured = Boolean(process.env.BAYTI_CORE_API_KEY?.trim());
    const persistentIdempotency = analysisRegistry.mode !== "memory";
    let idempotencyWritable = true;
    let idempotencyMessage: string | null = null;
    try {
      await analysisRegistry.probe();
    } catch (error) {
      idempotencyWritable = false;
      idempotencyMessage = errorMessage(error);
    }
    const persistenceRequirementSatisfied = !REQUIRE_PERSISTENT_IDEMPOTENCY || persistentIdempotency;
    const ready = tectlyConfigured && apiKeyConfigured && idempotencyWritable && persistenceRequirementSatisfied;
    sendJson(response, ready ? 200 : 503, {
      status: ready ? "ready" : "not-ready",
      tectlyConfigured,
      replicateConfigured,
      apiKeyConfigured,
      labConfigured: LAB_KEY !== null,
      idempotencyMode: analysisRegistry.mode,
      idempotencyWritable,
      persistentIdempotencyRequired: REQUIRE_PERSISTENT_IDEMPOTENCY,
      persistentIdempotencyConfigured: persistentIdempotency,
      idempotencyMessage,
      note: replicateConfigured ? null : "Replicate is optional in best-effort mode and required only for verifierMode=required.",
    }, commonHeaders);
    return;
  }

  if (method === "GET" && url.pathname === "/lab") {
    if (LAB_KEY === null) {
      sendJson(response, 404, { error: "LAB_DISABLED", requestId: correlationId }, commonHeaders);
      return;
    }
    sendHtml(response, 200, baytiEngineLabHtml(), commonHeaders);
    return;
  }

  if (url.pathname.startsWith("/lab/")) {
    if (!labAuthorized(request)) {
      sendJson(response, 401, { error: "UNAUTHORIZED", requestId: correlationId }, commonHeaders);
      return;
    }
    if (method === "POST" && url.pathname === "/lab/analyze/start") {
      await handleLabAnalysisStart(request, response, correlationId, commonHeaders);
      return;
    }
    if (method === "GET" && url.pathname.startsWith("/lab/analyze/jobs/")) {
      const jobId = decodeURIComponent(url.pathname.slice("/lab/analyze/jobs/".length));
      if (!jobId) {
        sendJson(response, 400, { error: "INVALID_LAB_JOB_ID", requestId: correlationId }, commonHeaders);
        return;
      }
      handleLabJobStatus(response, jobId, correlationId, commonHeaders);
      return;
    }
    if (method === "POST" && url.pathname === "/lab/calibrate") {
      await handleCalibration(request, response, correlationId, commonHeaders);
      return;
    }
    if (method === "POST" && url.pathname === "/lab/analyze") {
      await handleAnalysis(request, response, correlationId, commonHeaders);
      return;
    }
  }

  if (method === "POST" && url.pathname === "/v1/analyze") {
    if (!authorized(request)) {
      sendJson(response, 401, { error: "UNAUTHORIZED", requestId: correlationId }, commonHeaders);
      return;
    }
    await handleAnalysis(request, response, correlationId, commonHeaders);
    return;
  }

  if (method === "POST" && url.pathname === "/v1/calibrate") {
    if (!authorized(request)) {
      sendJson(response, 401, { error: "UNAUTHORIZED", requestId: correlationId }, commonHeaders);
      return;
    }
    await handleCalibration(request, response, correlationId, commonHeaders);
    return;
  }

  sendJson(response, 404, { error: "NOT_FOUND", requestId: correlationId }, commonHeaders);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Bayti Core V2 listening on port ${PORT} (idempotency=${analysisRegistry.mode}, persistentRequired=${REQUIRE_PERSISTENT_IDEMPOTENCY}, lab=${LAB_KEY ? "enabled" : "disabled"})`,
  );
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Bayti Core V2 received ${signal}; closing shared resources.`);
  server.close();
  try {
    await analysisRegistry.close();
  } finally {
    process.exit(0);
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
