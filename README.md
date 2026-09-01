# Bayti Core V2

A clean floor-plan geometry engine built around **Tectly as the primary reader** and **Replicate as an independent verifier**.

```text
Floor plan
  ├─ Tectly (primary)
  └─ Replicate floorplan-recognition (verifier)
             ↓
       Bayti Fusion Engine
             ↓
      Canonical Geometry JSON
             ↓
          QA Gate
```

## Core rules

- Tectly owns rooms, scale and primary wall/opening geometry.
- Replicate verifies wall regions, doors, entry doors and windows.
- Replicate never silently overwrites a Tectly wall.
- A Replicate-only opening is a review candidate, not an accepted opening.
- Complex Tectly wall polygons are preserved as wall footprints. V2 does **not** repeat the old Bayti mistake of collapsing a complex wall-chain polygon into one straight thick wall.
- A straight center line and thickness are derived only when the footprint is a thin, strongly rectangular bar. L-shaped, curved and otherwise complex footprints remain polygon-only.
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

## HTTP safety

- `POST /v1/analyze` requires both the Bearer API key and a stable `Idempotency-Key` header.
- Repeating the same key and exact request within the process TTL replays the original promise/result instead of starting another provider analysis.
- Reusing the same key for different content returns HTTP `409`.
- Failed provider runs are also retained during the TTL because a failure may happen after Tectly already accepted a quota-bearing upload.
- The idempotency registry is intentionally documented as **process-local**. A container restart clears it, so restart-safe deduplication still needs a persistent ledger before high-volume production.
- `/ready` returns `503` when Tectly credentials or the Bayti API key are missing. Replicate remains optional for `best-effort` mode.
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
- Spatial wall support matching.
- Door/window center-line matching.
- Entry-door enrichment only when the primary door geometry is independently confirmed.
- Suspicious/unmatched secondary detections routed to review.
- Multi-plan page scoping for verifier detections.
- Best-effort verifier outage fallback without losing the primary result.
- Required-verifier mode that avoids starting a Tectly paid analysis when verification already failed.
- QA status (`pass`, `review`, `blocked`) and confidence evidence.
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
```

Tectly defaults to the sandbox host. Production must be selected explicitly with `TECTLY_API_BASE_URL=https://platform.tectly.com/api/v1`.

## Current verification

TypeScript typecheck and the current core/fusion/mapping/parser/idempotency regression tests pass in GitHub Actions.

The remaining provider verification step is a **live same-plan run** with real Tectly and Replicate credentials configured securely. That run should be performed on the same reference floor plan already used to compare providers, then expanded into a 10–20 plan regression corpus before building the new Bayti UI/3D product around the core.
