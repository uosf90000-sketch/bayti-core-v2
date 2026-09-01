# Bayti Core V2 — Real Plan Regression Corpus

The engine is not considered release-ready because unit tests pass. Release confidence comes from a fixed corpus of real plans whose provider evidence and canonical outputs are retained without customer secrets.

## Required corpus coverage

Target: 10–20 plans before the new Bayti UI is built around this core.

The corpus must collectively include:

- straight-wall apartment
- villa with many internal walls
- complex/L-shaped wall footprints
- curved exterior wall
- curved interior wall
- openings near wall junctions
- openings on complex/curved wall regions
- low-resolution raster
- high-resolution raster
- Arabic labels/dimensions
- PDF page rasterized for Replicate
- dense furniture/symbol noise
- partial/poor scan
- more than one plan on a single page

## What to retain per case

Keep only geometry/evidence needed to reproduce the result. Remove signed URLs, tokens, customer names, addresses and timestamps when they are not part of the test.

Each case should retain:

1. `sourceImage` width/height/mime metadata.
2. Tectly plan bundle(s): plan page section, floor scale, walls, rooms and wall openings.
3. Parsed Replicate verifier evidence in normalized coordinates.
4. A small expectation manifest using `RegressionExpectation` from `src/regression.ts`.
5. Notes describing any known limitation of the fixture.

Do not hand-trim polygons for a calibration fixture. A truncated contour fixture can still test parsing/noise filtering, but it must be explicitly marked unsuitable for alignment/accuracy calibration.

## Known live reference — IMG_4679

A previous live Bayti run provides the first useful baseline metadata for the corpus:

- production Tectly result: approximately **74 walls / 12 openings / 27 rooms**
- retained Tectly geometry fixture reproduced approximately **73 / 12 / 27** at a plausible image size; the one-wall difference was attributed to earlier aspect-ratio/resolution behavior
- the independent reader matched only **3 of 12** provider openings on that run
- the old reader wall fixture was later documented as **truncated** and must not be used to calibrate spatial alignment

This reference is intentionally a *baseline*, not a PASS threshold. Its weak opening agreement is evidence that a 50% proximity-style gate was too permissive. Bayti Core V2 now exposes explicit wall/opening confirmation, host-wall coverage, conflicts and review candidates so real corpus results can determine the final production thresholds.

Suggested expectation manifest once the complete sanitized fixture is copied into this repository:

```ts
{
  walls: { min: 70, max: 78 },
  openings: { min: 10, max: 14 },
  rooms: { min: 25, max: 29 },
  maxConflicts: 0
}
```

Do **not** set a minimum confirmed-opening rate for IMG_4679 until a complete, correctly calibrated Replicate fixture is present.

## Release rule

Before UI/3D product work begins, run every fixture through the current mapper/fusion/quality pipeline and record:

- wall count and confirmation rate
- opening count and confirmation rate
- host-wall rate
- physical-width rate
- room count
- scale availability
- conflicts and review candidates
- quality status

A change may improve one plan but must not silently degrade another. Count ranges should be narrow enough to catch catastrophic regressions while allowing small provider drift.
