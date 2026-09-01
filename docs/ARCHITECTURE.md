# Bayti Core V2 Architecture

## Scope

V2 starts with geometry only. No UI, interior design, rendering, shopping, or cinematic video is part of this milestone.

## Provider responsibilities

### Tectly — primary reader

Use Tectly for semantic architectural data:

- plans/floors
- rooms
- walls
- wall openings
- scale / measurements
- curved/complex wall geometry when available

Tectly data is mapped into a new canonical model. The old Bayti wall-splitting/fallback heuristics are not copied into V2 by default.

### Replicate — independent verifier

Model: `ton731/floorplan-recognition`.

Use Replicate only as independent evidence for:

- wall regions
- doors
- entry doors
- windows
- door center lines
- window center lines

Replicate is not trusted as the source of:

- rooms
- real-world scale
- wall thickness
- true arc semantics

## Coordinate system

Every provider is normalized into source-image coordinates in the range `0..1` before comparison.

```text
nx = x_px / image_width_px
ny = y_px / image_height_px
```

Real-world dimensions remain separate and come from a trusted scale source, initially Tectly or manual calibration.

## Fusion rules (initial)

1. Tectly geometry is the primary candidate.
2. Replicate does not overwrite Tectly geometry.
3. Spatial agreement increases confidence.
4. Spatial disagreement creates a conflict; it is not silently guessed away.
5. A Replicate-only door/window becomes a review candidate, not an automatically accepted opening.
6. Curved walls are retained from Tectly; Replicate contour points can only act as supporting evidence.
7. The QA gate blocks 3D when critical geometry is unresolved.

## Confidence states

- `confirmed`: two independent sources agree within configured tolerances.
- `single-source`: only the primary source detected the element.
- `conflict`: sources disagree materially.
- `unverified`: not enough evidence was available to compare.

## Test strategy

Do not optimize for one plan. Build a fixed regression corpus of 10–20 real plans including:

- straight-wall apartment
- villa with many internal walls
- curved exterior wall
- curved interior wall
- openings on curved walls
- low-resolution raster plan
- Arabic labels and dimensions
- PDF plan
- dense furniture symbols
- partial/poor scan

Every provider raw response and final canonical result should be retained as a fixture (with private customer data removed) so a fix for one plan cannot silently break another.
