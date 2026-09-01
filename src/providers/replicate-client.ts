import { parseReplicatePrediction, type ReplicatePredictionLike } from "./replicate-parser.js";
import type { ReplicateVerifierResult } from "./types.js";

const API_BASE = "https://api.replicate.com/v1";
const DEFAULT_VERSION = "6d9285b49483724cfa20294f80f711ca32fc1c488bb98ca01f0499651d966773";
const DEFAULT_TIMEOUT_MS = 90_000;

type FetchLike = typeof fetch;

type PredictionStatus = "starting" | "processing" | "succeeded" | "failed" | "canceled";

interface PredictionResponse {
  id: string;
  version?: string;
  status: PredictionStatus;
  output?: unknown;
  error?: string | null;
  metrics?: { predict_time?: number };
  urls?: { get?: string; cancel?: string; web?: string };
}

export interface ReplicateClientOptions {
  token?: string;
  version?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface RunReplicateInput {
  image: string | Blob;
  widthPx: number;
  heightPx: number;
}

function tokenFromEnv(): string {
  const token = process.env.REPLICATE_API_TOKEN?.trim();
  if (!token) throw new Error("Replicate is not configured. Set REPLICATE_API_TOKEN in server secrets.");
  return token;
}

async function blobDataUrl(blob: Blob): Promise<string> {
  const bytes = Buffer.from(await blob.arrayBuffer());
  const mime = blob.type || "application/octet-stream";
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function isTerminal(status: PredictionStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ReplicateFloorplanClient {
  private readonly token: string;
  private readonly version: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: ReplicateClientOptions = {}) {
    this.token = options.token ?? tokenFromEnv();
    this.version = options.version ?? process.env.REPLICATE_FLOORPLAN_VERSION?.trim() ?? DEFAULT_VERSION;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async request(url: string, init: RequestInit): Promise<PredictionResponse> {
    const response = await this.fetchImpl(url, init);
    if (!response.ok) {
      // Deliberately never include Authorization headers/token in errors.
      throw new Error(`Replicate request failed with HTTP ${response.status}.`);
    }
    return (await response.json()) as PredictionResponse;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
      ...extra,
    };
  }

  async run(input: RunReplicateInput): Promise<ReplicateVerifierResult> {
    if (input.widthPx <= 0 || input.heightPx <= 0) {
      throw new Error("Replicate source dimensions must be positive.");
    }
    const image = typeof input.image === "string" ? input.image : await blobDataUrl(input.image);
    const prediction = await this.request(`${API_BASE}/predictions`, {
      method: "POST",
      headers: this.headers({
        "Content-Type": "application/json",
        // Replicate may return the completed prediction in the same request when it finishes quickly.
        Prefer: "wait=60",
      }),
      body: JSON.stringify({ version: this.version, input: { image } }),
    });

    const deadline = Date.now() + this.timeoutMs;
    let current = prediction;
    while (!isTerminal(current.status)) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for Replicate floor-plan recognition.");
      const getUrl = current.urls?.get;
      if (!getUrl) throw new Error("Replicate prediction has no polling URL.");
      await sleep(750);
      current = await this.request(getUrl, { method: "GET", headers: this.headers() });
    }

    if (current.status !== "succeeded") {
      throw new Error(`Replicate floor-plan recognition ${current.status}${current.error ? `: ${current.error}` : "."}`);
    }
    if (current.output === undefined || current.output === null) {
      throw new Error("Replicate succeeded but returned no output.");
    }

    const predictionLike: ReplicatePredictionLike = {
      id: current.id,
      version: current.version ?? this.version,
      output: current.output as ReplicatePredictionLike["output"],
      metrics: current.metrics,
    };
    return parseReplicatePrediction(predictionLike, {
      widthPx: input.widthPx,
      heightPx: input.heightPx,
    });
  }
}
