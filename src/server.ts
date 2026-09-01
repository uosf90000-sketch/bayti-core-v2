import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { analyzeBaytiCore, type BaytiCoreAnalysisResult, type VerifierMode } from "./core.js";
import { IdempotencyRegistry } from "./idempotency.js";

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

const analysisRegistry = new IdempotencyRegistry<BaytiCoreAnalysisResult>(IDEMPOTENCY_TTL_MS);

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
    if (total > MAX_BODY_BYTES) {
      throw new Error("REQUEST_BODY_TOO_LARGE");
    }
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
    typeof input.fileName !== "string" ||
    input.fileName.trim().length === 0 ||
    typeof input.fileBase64 !== "string" ||
    input.fileBase64.length === 0 ||
    typeof input.fileMimeType !== "string" ||
    input.fileMimeType.trim().length === 0 ||
    !isPositiveFiniteNumber(image.widthPx) ||
    !isPositiveFiniteNumber(image.heightPx) ||
    typeof image.mimeType !== "string" ||
    image.mimeType.trim().length === 0
  ) {
    throw new Error("INVALID_ANALYZE_INPUT");
  }

  const wallTracingMode = input.wallTracingMode;
  if (
    wallTracingMode !== undefined &&
    wallTracingMode !== "Polygons" &&
    wallTracingMode !== "Rectangles" &&
    wallTracingMode !== "UniformPolygons"
  ) {
    throw new Error("INVALID_WALL_TRACING_MODE");
  }

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

function safeError(error: unknown): { status: number; code: string; message: string } {
  const message = errorMessage(error);
  if (message === "REQUEST_BODY_TOO_LARGE") {
    return { status: 413, code: message, message: "Request body is too large." };
  }
  if (message === "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST") {
    return {
      status: 409,
      code: message,
      message: "Idempotency key was already used for a different analysis request.",
    };
  }
  if (
    message.startsWith("INVALID_") ||
    message === "EMPTY_REQUEST_BODY" ||
    message === "EMPTY_DECODED_FILE"
  ) {
    return { status: 400, code: message, message: "Invalid analysis request." };
  }
  return {
    status: 502,
    code: "PROVIDER_ANALYSIS_FAILED",
    // Provider internals stay in server logs; callers get a correlation id instead.
    message: "Floor-plan provider analysis failed.",
  };
}

const server = createServer(async (request, response) => {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const correlationId = requestId(request);
  const commonHeaders = { "x-request-id": correlationId };

  if (method === "GET" && url.pathname === "/health") {
    sendJson(
      response,
      200,
      {
        status: "ok",
        service: "bayti-core-v2",
        version: "0.4.0",
      },
      commonHeaders,
    );
    return;
  }

  if (method === "GET" && url.pathname === "/ready") {
    const tectlyConfigured = Boolean(
      process.env.TECTLY_CLIENT_ID?.trim() && process.env.TECTLY_CLIENT_SECRET?.trim(),
    );
    const replicateConfigured = Boolean(process.env.REPLICATE_API_TOKEN?.trim());
    const apiKeyConfigured = Boolean(process.env.BAYTI_CORE_API_KEY?.trim());
    const ready = tectlyConfigured && apiKeyConfigured;

    sendJson(
      response,
      ready ? 200 : 503,
      {
        status: ready ? "ready" : "not-ready",
        tectlyConfigured,
        replicateConfigured,
        apiKeyConfigured,
        note: replicateConfigured
          ? null
          : "Replicate is optional in best-effort mode and required only for verifierMode=required.",
      },
      commonHeaders,
    );
    return;
  }

  if (method === "POST" && url.pathname === "/v1/analyze") {
    if (!authorized(request)) {
      sendJson(response, 401, { error: "UNAUTHORIZED", requestId: correlationId }, commonHeaders);
      return;
    }

    const idempotencyKey = readIdempotencyKey(request);
    if (idempotencyKey === null) {
      sendJson(
        response,
        400,
        {
          error: "IDEMPOTENCY_KEY_REQUIRED",
          message: "Send a stable Idempotency-Key header (8–200 characters) for each logical analysis.",
          requestId: correlationId,
        },
        commonHeaders,
      );
      return;
    }

    try {
      const body = parseAnalyzeBody(await readJsonBody(request));

      if (body.fileMimeType.toLowerCase().includes("pdf") && !body.replicateImageBase64) {
        sendJson(
          response,
          400,
          {
            error: "PDF_REQUIRES_REPLICATE_RASTER",
            message: "Provide replicateImageBase64 for the same rendered PDF page.",
            requestId: correlationId,
          },
          commonHeaders,
        );
        return;
      }

      const fingerprint = requestFingerprint(body);
      const run = await analysisRegistry.run(idempotencyKey, fingerprint, async () => {
        const tectlyFile = decodeBlob(body.fileBase64, body.fileMimeType);
        const replicateImage = body.replicateImageBase64
          ? decodeBlob(
              body.replicateImageBase64,
              body.replicateImageMimeType ?? body.sourceImage.mimeType,
            )
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

      sendJson(response, 200, run.value, {
        ...commonHeaders,
        "x-idempotency-replayed": run.replayed ? "true" : "false",
      });
    } catch (error) {
      const safe = safeError(error);
      if (safe.status >= 500) {
        console.error(`[analysis ${correlationId}] ${errorMessage(error)}`);
      }
      sendJson(
        response,
        safe.status,
        { error: safe.code, message: safe.message, requestId: correlationId },
        commonHeaders,
      );
    }
    return;
  }

  sendJson(response, 404, { error: "NOT_FOUND", requestId: correlationId }, commonHeaders);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Bayti Core V2 listening on port ${PORT}`);
});
