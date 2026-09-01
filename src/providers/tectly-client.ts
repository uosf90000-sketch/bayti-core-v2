import type {
  TectlyDocumentAnalysis,
  TectlyFloor,
  TectlyPlan,
  TectlyPlanBundle,
  TectlyRoom,
  TectlyWall,
  TectlyWallOpening,
} from "./tectly-types.js";

const SANDBOX_BASE_URL = "https://sandbox.platform.tectly.com/api/v1";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SETTLE_TIMEOUT_MS = 5 * 60_000;

type FetchLike = typeof fetch;

interface TectlyCredentials {
  clientId: string;
  clientSecret: string;
}

interface DocumentSummary {
  id: string;
  pageRenderingStatus: string;
}

interface DocumentPageSummary {
  id: string;
}

interface DocumentFull extends DocumentSummary {
  documentPages: DocumentPageSummary[];
}

interface PlanSummary {
  id: string;
}

interface DocumentPageFull {
  id: string;
  planDetectionStatus: string;
  plans: PlanSummary[];
}

interface TokenPayload {
  token?: string;
  expiryDate?: string;
}

export interface TectlyClientOptions {
  credentials?: TectlyCredentials;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  requestTimeoutMs?: number;
  settleTimeoutMs?: number;
}

export interface AnalyzeTectlyInput {
  file: Blob;
  fileName: string;
  /** Explicit paid/quota guard. A caller must consciously opt in to the upload. */
  consumeAnalysis: true;
  wallTracingMode?: "Polygons" | "Rectangles" | "UniformPolygons";
  title?: string;
}

function envCredentials(): TectlyCredentials {
  const clientId = process.env.TECTLY_CLIENT_ID?.trim();
  const clientSecret = process.env.TECTLY_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error("Tectly is not configured. Set TECTLY_CLIENT_ID and TECTLY_CLIENT_SECRET in server secrets.");
  }
  return { clientId, clientSecret };
}

function baseUrlFromEnv(): string {
  return (process.env.TECTLY_API_BASE_URL?.trim() || SANDBOX_BASE_URL).replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireId(value: unknown, context: string): asserts value is { id: string } {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) {
    throw new Error(`Invalid Tectly response: ${context} is missing id.`);
  }
}

function settledStatus(value: unknown): boolean {
  return value !== "Pending";
}

function planSettled(plan: TectlyPlan): boolean {
  return (
    settledStatus(plan.wallOpeningProcessingStatus) &&
    settledStatus(plan.roomProcessingStatus) &&
    settledStatus(plan.wallProcessingStatus) &&
    settledStatus(plan.horizontalScaleProcessingStatus) &&
    settledStatus(plan.postProcessingStatus)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TectlyClient {
  private readonly credentials: TectlyCredentials;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly requestTimeoutMs: number;
  private readonly settleTimeoutMs: number;
  private cachedToken: { token: string; expiresAt: number } | null = null;

  constructor(options: TectlyClientOptions = {}) {
    this.credentials = options.credentials ?? envCredentials();
    this.baseUrl = options.baseUrl ?? baseUrlFromEnv();
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.settleTimeoutMs = options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
  }

  private async fetchTimed(pathOrUrl: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`;
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async issueToken(): Promise<string> {
    const basic = Buffer.from(
      `${this.credentials.clientId}:${this.credentials.clientSecret}`,
      "utf8",
    ).toString("base64");
    const response = await this.fetchTimed("/issue-authentication-token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        Accept: "application/json",
        "X-Requested-With": "XMLHttpRequest",
      },
    });
    if (!response.ok) {
      throw new Error(`Tectly authentication failed with HTTP ${response.status}.`);
    }
    const payload = (await response.json()) as TokenPayload;
    if (!payload.token) throw new Error("Tectly authentication returned no token.");
    const parsedExpiry = payload.expiryDate ? Date.parse(payload.expiryDate) : Number.NaN;
    this.cachedToken = {
      token: payload.token,
      expiresAt: Number.isFinite(parsedExpiry) ? parsedExpiry : Date.now() + 10 * 60_000,
    };
    return payload.token;
  }

  private async token(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt - 60_000 > Date.now()) {
      return this.cachedToken.token;
    }
    return this.issueToken();
  }

  async authenticate(): Promise<void> {
    await this.token();
  }

  private async json<T>(path: string, init: RequestInit = { method: "GET" }): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await this.token()}`);
    headers.set("Accept", "application/json");
    const response = await this.fetchTimed(path, { ...init, headers });
    if (!response.ok) {
      throw new Error(`Tectly request failed: HTTP ${response.status} ${path}`);
    }
    return (await response.json()) as T;
  }

  private async createProject(input: AnalyzeTectlyInput): Promise<{ id: string }> {
    const body: Record<string, unknown> = {
      title: input.title ?? `Bayti Core V2 — ${input.fileName}`,
      configuration: { wallTracingMode: input.wallTracingMode ?? "Polygons" },
    };
    const project = await this.json<unknown>("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    requireId(project, "project");
    return project;
  }

  private async uploadDocument(projectId: string, file: Blob, fileName: string): Promise<DocumentSummary> {
    const form = new FormData();
    form.append("document", file, fileName);
    const uploaded = await this.json<unknown>(
      `/projects/${encodeURIComponent(projectId)}/documents`,
      { method: "POST", body: form },
    );
    requireId(uploaded, "document upload");
    return uploaded as unknown as DocumentSummary;
  }

  private async poll<T>(label: string, read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
    const deadline = Date.now() + this.settleTimeoutMs;
    let intervalMs = 500;
    let value = await read();
    while (!done(value)) {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for Tectly ${label}.`);
      await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
      intervalMs = Math.min(Math.ceil(intervalMs * 1.25), 10_000);
      value = await read();
    }
    return value;
  }

  private fetchDocument(documentId: string): Promise<DocumentFull> {
    return this.json<DocumentFull>(`/documents/${encodeURIComponent(documentId)}`);
  }

  private fetchPage(pageId: string): Promise<DocumentPageFull> {
    return this.json<DocumentPageFull>(`/document-pages/${encodeURIComponent(pageId)}`);
  }

  private fetchPlan(planId: string): Promise<TectlyPlan> {
    return this.json<TectlyPlan>(`/plans/${encodeURIComponent(planId)}`);
  }

  private fetchFloor(floorId: string): Promise<TectlyFloor> {
    return this.json<TectlyFloor>(`/floors/${encodeURIComponent(floorId)}`);
  }

  private fetchWalls(floorId: string): Promise<TectlyWall[]> {
    return this.json<TectlyWall[]>(`/floors/${encodeURIComponent(floorId)}/walls`);
  }

  private fetchRooms(floorId: string): Promise<TectlyRoom[]> {
    return this.json<TectlyRoom[]>(`/floors/${encodeURIComponent(floorId)}/rooms`);
  }

  private fetchOpenings(floorId: string): Promise<TectlyWallOpening[]> {
    return this.json<TectlyWallOpening[]>(`/floors/${encodeURIComponent(floorId)}/wall-openings`);
  }

  /**
   * Runs exactly one Tectly upload. There is intentionally no automatic upload retry:
   * the upload is quota-bearing, so a caller must decide whether another analysis is worth paying for.
   */
  async analyze(input: AnalyzeTectlyInput): Promise<TectlyDocumentAnalysis> {
    if (input.consumeAnalysis !== true) {
      throw new Error("Tectly analysis requires consumeAnalysis: true.");
    }

    await this.authenticate();
    const project = await this.createProject(input);
    const uploaded = await this.uploadDocument(project.id, input.file, input.fileName);

    const document = await this.poll(
      "document rendering",
      () => this.fetchDocument(uploaded.id),
      (value) => settledStatus(value.pageRenderingStatus),
    );

    const bundles: TectlyPlanBundle[] = [];
    const rawPages: unknown[] = [];

    for (const pageSummary of document.documentPages ?? []) {
      const page = await this.poll(
        "plan detection",
        () => this.fetchPage(pageSummary.id),
        (value) => settledStatus(value.planDetectionStatus),
      );
      rawPages.push(page);

      for (const planSummary of page.plans ?? []) {
        const plan = await this.poll(
          "plan processing",
          () => this.fetchPlan(planSummary.id),
          planSettled,
        );
        if (!plan.floorId) continue;
        const [floor, walls, rooms, wallOpenings] = await Promise.all([
          this.fetchFloor(plan.floorId),
          this.fetchWalls(plan.floorId),
          this.fetchRooms(plan.floorId),
          this.fetchOpenings(plan.floorId),
        ]);
        bundles.push({ plan, floor, walls, rooms, wallOpenings });
      }
    }

    return {
      provider: "tectly",
      projectId: project.id,
      documentId: uploaded.id,
      planBundles: bundles,
      raw: { document, pages: rawPages },
    };
  }
}
