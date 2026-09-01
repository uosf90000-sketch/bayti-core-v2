# Bayti Core — Field Validation Candidate

Bayti Core is code-complete enough to enter **field validation**. This does not mean provider accuracy is proven. The remaining release gate is empirical validation across a diverse corpus of 10–20 real plans before Bayti UI/3D is built around the engine.

## What is frozen for validation

- Tectly is the primary geometry provider.
- Replicate is an independent verifier; it does not silently replace Tectly geometry.
- Wall footprints are authoritative. Complex/L/curved footprints are never collapsed into one guessed straight wall.
- Openings can be supported by one wall footprint or bridge two Tectly wall fragments.
- Room/opening topology is provider-backed only; exterior connectivity is never guessed.
- Physical scale comes from Tectly when available or explicit manual dimension evidence when not.
- Manual calibration is local and does not rerun Tectly/Replicate.
- Quality is `PASS / REVIEW / BLOCKED` from current canonical geometry, not from a stale historical source status.
- Paid analysis starts behind a durable Postgres idempotency claim.
- Engine Lab job state is also persisted in Postgres so mobile disconnects/restarts do not silently lose completed results.
- Replicate kitchen segmentation may enrich a generic `Other/Unknown` room to `Kitchen` only when the match is strong and unambiguous. Other room types are not guessed.

## Scale policy

The current verified Tectly REST integration reads `horizontalScale` and `verticalScale` from the floor object. If only one axis is present, Core uses the source raster's square-pixel assumption to complete the second axis at lower evidence depth.

Tectly's official PHP SDK documents `scaleLines` among `fetchFloorElements()` results. The exact REST endpoint/response schema has not yet been verified against our TypeScript integration, so Core intentionally does **not** invent a `scaleLines` endpoint. Manual calibration remains the safe fallback until that provider contract is verified.

## Field-validation corpus target

Collect 10–20 real plans covering, as far as practical:

- simple straight-wall apartment
- larger villa
- L-shaped wall regions
- curved/irregular walls
- openings near corners/junctions
- many doors/windows
- low-resolution image
- high-resolution image
- Arabic room labels/dimensions
- PDF input
- furniture-heavy drawing
- poor scan/noisy drawing
- more than one plan on one page
- plans where Tectly scale succeeds
- plans where Tectly scale fails and manual calibration is required

Do not weaken thresholds merely to make an individual plan pass.

## Per-plan procedure

1. Open Engine Lab and use `Best effort + Polygons` unless testing another mode intentionally.
2. Run the plan once. Do not retry a quota-bearing analysis blindly.
3. Inspect the overlay visually: wall footprints, rooms, openings and room labels.
4. Record wall/opening/room counts and quality status.
5. If scale is unknown but printed dimensions are visible, add at least one explicit measurement; two independent horizontal/vertical dimensions are preferred.
6. Re-check physical opening widths and room areas after calibration.
7. Record unresolved provider conflicts/review candidates rather than deleting them.
8. Download the full Engine Lab JSON when deeper debugging is required.
9. For corpus metrics, generate `buildSanitizedAnalysisObservation(result)`. This strips provider project/document/request/element IDs and raw payloads while retaining the metrics needed for regression analysis.

## Privacy-safe observation

`buildSanitizedAnalysisObservation()` records only validation-oriented information such as:

- engine/verifier status
- source image dimensions and MIME type
- wall/opening/room counts
- independent confirmation rates
- opening wall-support and physical-width coverage
- scale source/confidence
- generic vs meaningful room-label counts
- conflicts/review-candidate counts
- current quality status/blockers/review reasons

It intentionally excludes provider project IDs, document IDs, request IDs, provider element IDs, raw provider payloads and source filenames.

## Release decision

The engine may proceed to Bayti UI/3D only after the corpus shows that:

- catastrophic geometry failures are not recurring,
- scale behavior is reliable or safely blocked/reviewed,
- opening-to-wall support is stable enough for wall cuts,
- quality gates separate trustworthy plans from uncertain plans,
- the render contract remains consistent across diverse geometry,
- any adjusted numerical thresholds are justified by the whole corpus, not one preferred plan.

Until then, the correct state is **field-validation candidate**, not "accuracy complete".
