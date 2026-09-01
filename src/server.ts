import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { analyzeBaytiCore, type VerifierMode } from "./core.js";

const DEFAULT_MAX_BODY_BYTES = 35 * 1024 * 1024;
const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const MAX_BODY_BYTES = Number.parseInt(
  process.env.BAYTI_CORE_MAX_BODY_BYTES ?? String(DEFAULT_MAX_BODY_BYTES),
  10,
);

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

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

function bearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function authorized(request: IncomingMessage): boolean {
  const expected = process.env.BAYTI_CORE_API_KEY?.trim();
  if (!expected) return false;
  return bearerToken(request) === expected;
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

function safeError(error: unknown): { status: number; code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "REQUEST_BODY_TOO_LARGE") {
    return { status: 413, code: message, message: "Request body is too large." };
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
    message,
  };
}

const server = createServer(async (request, response) => {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      status: "ok",
      service: "bayti-core-v2",
      version: "0.3.0",
    });
    return;
  }

  if (method === "GET" && url.pathname === "/ready") {
    sendJson(response, 200, {
      status: "ok",
      tectlyConfigured: Boolean(
        process.env.TECTLY_CLIENT_ID?.trim() && process.env.TECTLY_CLIENT_SECRET?.trim(),
      ),
      replicateConfigured: Boolean(process.env.REPLICATE_API_TOKEN?.trim()),
      apiKeyConfigured: Boolean(process.env.BAYTI_CORE_API_KEY?.trim()),
    });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/analyze") {
    if (!authorized(request)) {
      sendJson(response, 401, { error: "UNAUTHORIZED" });
      return;
    }

    try {
      const body = parseAnalyzeBody(await readJsonBody(request));
      const tectlyFile = decodeBlob(body.fileBase64, body.fileMimeType);
      const replicateImage = body.replicateImageBase64
        ? decodeBlob(
            body.replicateImageBase64,
            body.replicateImageMimeType ?? body.sourceImage.mimeType,
          )
        : tectlyFile;

      if (body.fileMimeType.toLowerCase().includes("pdf") && !body.replicateImageBase64) {
        sendJson(response, 400, {
          error: "PDF_REQUIRES_REPLICATE_RASTER",
          message: "Provide replicateImageBase64 for the same rendered PDF page.",
        });
        return;
      }

      const result = await analyzeBaytiCore({
        tectlyFile,
        fileName: body.fileName,
        sourceImage: body.sourceImage,
        replicateImage,
        wallTracingMode: body.wallTracingMode,
        verifierMode: body.verifierMode,
      });

      sendJson(response, 200, result);
    } catch (error) {
      const safe = safeError(error);
      sendJson(response, safe.status, { error: safe.code, message: safe.message });
    }
    return;
  }

  sendJson(response, 404, { error: "NOT_FOUND" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Bayti Core V2 listening on port ${PORT}`);
});
