# Bayti Core V2

A floor-plan geometry engine built around **Tectly as the primary reader** and **Replicate as an independent verifier**.

```text
Floor plan
  ├─ Tectly (primary)
  └─ Replicate floorplan-recognition (verifier)
             ↓
       Bayti Fusion Engine
             ↓
      Canonical Geometry JSON
             ↓
   Conservative Quality Gate
             ↓
      3D Render Contract
```

## Scope

Bayti Core V2 is the geometry engine only. It intentionally does not include the Bayti UI, interior design generation, shopping, furniture placement, final 3D rendering or cinematic video. Those product layers should consume the stable render contract after the geometry engine is validated.

## Core rules

- Tectly owns rooms, scale and primary wall/opening geometry.
- Replicate verifies wall regions, doors, entry doors and windows.
- Replicate never silently overwrites a Tectly wall.
- A Replicate-only opening is a review candidate, not an accepted opening.
- Complex Tectly wall polygons are preserved as wall footprints. V2 does **not** collapse a complex wall-chain polygon into one straight thick wall.
- A straight center line and thickness are derived only when the footprint is a thin, strongly rectangular bar. L-shaped, curved and otherwise complex footprints remain polygon-only.
- Polygon-only walls remain directly usable by the render handoff as horizontal solids; a future renderer should extrude the authoritative footprint rather than reconstructing the wall from a guessed center line.
- All comparison happens in one full-page `0..1` coordinate system.
- Replicate evidence is scoped to the current Tectly plan before fusion, so a second plan on the same PDF/image page cannot create false conflicts.
- Provider disagreement remains visible in `qa`, `reviewCandidates` and per-element confidence.
- Tectly authentication runs before any quota-bearing upload.
- There is no automatic retry of a Tectly upload.
- Provider secrets are read from server environment variables only and must never be committed.

## Verifier policy

`analyzeBaytiCore` supports two policies:

- `best-effort` (default): Tectly remains the authoritative result if Replicate is missing or temporarily fails. The plan is marked `review` and the verifier failure is preserved in QA notes instead of throwing away a paid Tectly analysis.
- `required`: Replicate must succeed before the quota-bearing Tectly upload starts. This is intended for a premium/two-provider path where independent confirmation is mandatory.

The result exposes `verifierStatus`, `verifierMessage` and `replicateRequestId` so the caller can show exactly what happened rather than infer it from geometry.

## Quality gate

`assessGeometryQuality(plan)` provides a product-facing release gate independent of the original fusion heuristic. It reports:

- wall/opening/room counts
- independent wall confirmation rate
- independent opening confirmation rate
- opening host-wall coverage
- physical opening-width coverage
- complex/polygon-only wall count
- scale availability
- conflicts and review candidates

The default PASS policy is intentionally conservative and currently requires:

- real wall geometry
- room polygons
- known physical scale on both axes
- at least 65% independently confirmed walls
- at least 65% independently confirmed openings
- at least 80% of openings assigned to an unambiguous host wall
- no unresolved conflicts or review candidates

These percentages are **provisional release gates**, not scientific truths. They must be recalibrated from the real 10–20 plan regression corpus rather than weakened to make one plan pass.

## 3D/render handoff

`buildBaytiRenderContract(plan)` creates the geometry handoff that the future Bayti UI/3D layer should consume.

Important rules:

- every wall keeps its authoritative footprint
- complex/L-shaped/curved wall footprints are not rejected merely because no straight center line exists
- only openings with both an unambiguous `hostWallId` and physical `widthMeters` are eligible for automatic wall cuts
- unresolved openings are emitted separately with explicit reasons
- vertical dimensions (ceiling height, door height, window sill/height) are **consumer-supplied**; Core V2 does not invent them

This contract is the guardrail that prevents the future renderer from recreating the old “giant thick straight wall” failure.

## HTTP safety and paid-analysis protection

- `POST /v1/analyze` requires both the Bearer API key and a stable `Idempotency-Key` header.
- Reusing the same key for different content returns HTTP `409`.
- The engine writes an idempotency record **before** the provider operation starts.
- With `BAYTI_CORE_IDEMPOTENCY_DIR` configured on a mounted persistent volume, `pending`, `fulfilled` and `rejected` analysis records survive a process/container restart.
- A request found in durable `pending` state after restart is **not rerun automatically**; it returns a conflict so a possibly charged Tectly upload cannot be duplicated blindly.
- Successful and failed outcomes are retained for the TTL and replayed/rejected without invoking providers again.
- The built-in file ledger is intended for a single application replica. Multi-replica production should implement a transactional shared `IdempotencyStore` using a database or Redis.
- Set `BAYTI_CORE_REQUIRE_PERSISTENT_IDEMPOTENCY=true` to make `/ready` return `503` unless persistent file-backed idempotency is configured and writable.
- Provider failure details stay in server logs. HTTP callers receive a generic error plus `x-request-id` for correlation.

## Implemented

- Tectly Basic-auth → JWT/Bearer client using the working `/api/v1` endpoint contract.
- Explicit paid-analysis guard for Tectly uploads.
- Tectly document/page/plan polling with hard timeouts.
- Replicate prediction client pinned to the tested `ton731/floorplan-recognition` version.
- Replicate pixel-output parser and normalization.
- Tectly plan-local → full-page coordinate mapper.
- Footprint-first canonical geometry schema.
- Conservative straight-wall fitting with real thickness only when scale is known.
- Conservative opening host-wall inference and physical opening width derivation.
- Spatial wall support matching.
- Door/window center-line matching.
- Entry-door enrichment only when the primary door geometry is independently confirmed.
- Suspicious/unmatched secondary detections routed to review.
- Multi-plan page scoping for verifier detections.
- Best-effort verifier outage fallback without losing the primary result.
- Required-verifier mode that avoids starting a Tectly paid analysis when verification already failed.
- Fusion QA plus independent conservative product quality reporting.
- Stable future 3D/render geometry contract.
- Restart-safe single-replica paid-analysis idempotency ledger.
- Per-plan regression expectation evaluator for the real corpus.
- Unit/regression tests and GitHub Actions CI.
- Authenticated Railway HTTP service: `/health`, `/ready`, and `POST /v1/analyze`.

## Secure configuration

Copy `.env.example` only as a template. Put real values in deployment/server secrets, never in Git or chat:

```text
TECTLY_CLIENT_ID
TECTLY_CLIENT_SECRET
TECTLY_API_BASE_URL
REPLICATE_API_TOKEN
REPLICATE_FLOORPLAN_VERSION
BAYTI_CORE_API_KEY
BAYTI_CORE_IDEMPOTENCY_TTL_MS
BAYTI_CORE_IDEMPOTENCY_DIR
BAYTI_CORE_REQUIRE_PERSISTENT_IDEMPOTENCY
BAYTI_CORE_MAX_BODY_BYTES
```

Tectly defaults to the sandbox host. Production must be selected explicitly with `TECTLY_API_BASE_URL=https://platform.tectly.com/api/v1`.

## Regression corpus

See `docs/REGRESSION_CORPUS.md`.

A previous real Bayti reference plan (IMG_4679) produced roughly 74 walls / 12 openings / 27 rooms from Tectly. The old independent-reader run matched only 3 of the 12 provider openings, which is exactly why proximity-style 50% PASS logic must not be treated as a production accuracy threshold. The historical reader wall fixture was later documented as truncated and must not be used for calibration.

The final engine validation step is to copy complete sanitized provider evidence for that reference and additional real plans into this repository, then run the current mapper/fusion/quality/regression pipeline across 10–20 plans.

## Current version

`0.5.0`
