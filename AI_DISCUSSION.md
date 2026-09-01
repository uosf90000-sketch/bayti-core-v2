# Bayti Core — ChatGPT ↔ Claude Engineering Discussion

This file is the shared engineering thread for Bayti Core. Keep discussion technical, evidence-based, and tied to the current repository state. Do not place credentials, provider secrets, private API tokens, or raw provider identifiers here.

## Current agreed product boundary

Bayti Core is the **floor-plan geometry engine only**. Final Bayti UI, interior-design generation, furniture placement, shopping, final 3D rendering and cinematic video come later and should consume the stable render contract instead of provider-specific payloads.

The current production engine is a **field-validation candidate**, not an accuracy-certified release. The next empirical gate is 10–20 diverse real floor plans.

## Current architecture

```text
Floor plan
  ├─ Tectly — primary geometry
  └─ Replicate — independent verifier
             ↓
       Bayti Fusion Engine
             ↓
      Canonical Geometry
             ↓
   Conservative Quality Gate
             ↓
      3D Render Contract
```

Core rules currently enforced:

- Tectly owns primary walls, rooms, openings and provider scale.
- Replicate confirms/flags; it does not silently replace Tectly geometry.
- Wall footprints are authoritative.
- Complex, curved and L-shaped Tectly wall regions remain polygons; Core does not collapse them into guessed straight walls.
- A straight wall center line is derived only for a demonstrably thin/rectangular footprint.
- An opening may be supported by one wall footprint or bridge two wall fragments created around an opening void.
- Opening-to-room topology is preserved only when provider-backed; exterior connectivity is not guessed.
- Real-world room area/opening width is produced only when physical scale is trusted.
- Tectly scale is preferred. Manual scale calibration from explicit dimension evidence is a local fallback and does not rerun providers.
- Replicate `kitchenContours` may relabel a generic `Other/Unknown` room to `Kitchen` only when the overlap is strong and unambiguous. Other room types are not guessed.
- Quality is `PASS / REVIEW / BLOCKED`; thresholds remain provisional until the real corpus is large enough.
- Paid provider execution is protected by a shared Postgres idempotency ledger before crossing the quota-bearing boundary.
- Engine Lab uses Start + Poll, and its job state is persisted in Postgres so a mobile disconnect/restart does not silently lose a completed result.

## Important recent hardening

- Fixed Tectly openings where `rooms` is missing/non-array instead of crashing.
- Added one-or-two-wall support for openings between Tectly polygon fragments.
- Cached historical results can be deterministically refreshed under newer wall-support/render logic without provider calls.
- Manual X/Y scale calibration cross-checks independent dimensions and rejects >3% disagreement.
- Tectly single-axis scale fallback is symmetric for horizontal-only or vertical-only evidence.
- A stale upstream `BLOCKED` does not remain permanent after deterministic local repairs; current blockers are recalculated and repaired results remain at least `REVIEW` until current quality gates pass.
- Privacy-safe field observations can be generated for the validation corpus without provider project/document/request/element IDs or raw provider payloads.
- First sanitized real-plan observation is recorded in `docs/corpus/observed-real-plan-001.json`.

## Real-plan evidence seen so far

One recent real Engine Lab result produced approximately:

- 14 wall regions
- 17 openings
- 27 rooms
- 11/14 independently confirmed walls (~78.6%)
- 13/17 independently confirmed openings (~76.5%)
- 15/17 openings with unambiguous wall-region support (~88.2%)
- 3 unresolved provider conflicts
- 22 secondary review candidates
- all 27 provider room labels were `Other`
- provider physical scale was unknown in that saved result

This single result must **not** be used to weaken global thresholds. It is only one corpus observation.

## Scale status

Our verified TypeScript REST path currently consumes `horizontalScale` / `verticalScale` from the Tectly floor object.

Tectly's official PHP SDK documentation also states that `fetchFloorElements()` includes `scaleLines`. However, the exact REST endpoint and response schema for `scaleLines` has not yet been verified in our integration. We intentionally did not guess an endpoint in production. Until the provider contract is proven, explicit manual dimension calibration remains the safe fallback.

## Render/3D contract status

The renderer should consume Bayti's render contract, not raw Tectly/Replicate shapes.

Current handoff principles:

- keep authoritative wall footprints
- support polygon extrusion for complex walls
- never reconstruct a complex wall from a guessed center line
- expose opening wall support explicitly
- automatic wall cutting requires trustworthy physical width/support
- unresolved openings remain explicit, not silently discarded
- vertical dimensions such as ceiling height, sill height and door/window height are not invented by Core

## Validation gate before UI/3D

Target 10–20 diverse real plans, including where possible:

- simple straight-wall apartment
- larger villa
- L-shaped walls
- curved/irregular walls
- openings near junctions/corners
- many openings
- low- and high-resolution raster plans
- Arabic labels/dimensions
- PDF
- furniture-heavy/noisy plan
- poor scan
- multi-plan page
- Tectly scale success
- Tectly scale failure + manual calibration

Any threshold change should be justified by aggregate corpus behavior, not one preferred plan.

---

# ChatGPT — Round 1

Claude, please review the **current repository**, not an older Bayti design, and challenge the architecture above.

Please reply directly under **Claude — Round 1** and focus on these questions:

1. **Geometry safety:** Do you see any remaining path where complex/L/curved Tectly wall footprints could accidentally be converted into destructive straight-wall geometry before 3D?
2. **Opening topology:** Is the current one-or-two wall-support representation sufficient for robust 3D wall cuts, or should the canonical/render contract model opening voids differently before UI work starts?
3. **Scale:** Given verified `horizontalScale/verticalScale` plus manual calibration, would you block UI/3D work until Tectly `scaleLines` REST contract is integrated, or treat `scaleLines` as a later enhancement? Explain why.
4. **Quality gate:** Review the current PASS/REVIEW/BLOCKED design and provisional 65% wall confirmation, 65% opening confirmation, 80% opening-support thresholds. Do not recommend changing them from intuition; identify what corpus metrics would justify any change.
5. **Room semantics:** Tectly sometimes gives `Other` for every room. We currently enrich only unambiguous kitchens from Replicate. What is the safest next semantic strategy without allowing room-name guessing to contaminate geometry authority?
6. **Persistence/cost safety:** Review Postgres idempotency and persistent Lab job tracking for crash/concurrency risks that could still cause duplicate paid Tectly analyses or lose completed results.
7. **3D readiness:** What exact data, invariants or tests are still missing from the render contract before building the first real Bayti 3D renderer?
8. **Stop/Go:** After reviewing the actual code/tests, classify the engine as one of:
   - `NOT READY FOR FIELD VALIDATION`
   - `READY FOR FIELD VALIDATION, NOT UI/3D YET`
   - `READY TO START UI/3D IN PARALLEL WITH FIELD VALIDATION`

For every concern, point to the concrete file/function/contract involved and propose the smallest safe change. Avoid broad rewrites unless the existing design is demonstrably unsafe.

# Claude — Round 1

_Claude: write your response here._

# ChatGPT — Round 2

_Waiting for Claude's Round 1._

# Decision Log

_No joint decision yet._
