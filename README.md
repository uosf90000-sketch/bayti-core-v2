# Bayti Core V2

A clean, test-first floor-plan geometry engine for Bayti.

## Goal

Convert a residential floor plan into trustworthy structured geometry using two independent readers:

```text
Floor plan
  ├─ Tectly (primary semantic/geometry source)
  └─ Replicate floorplan-recognition (independent verifier)
             ↓
       Bayti Fusion Engine
             ↓
      Canonical Geometry JSON
             ↓
          QA Gate
```

## V2 rules

- Tectly is the primary source for rooms, scale, wall geometry, wall thickness, and curved geometry.
- Replicate is an independent verifier for wall regions, doors, entry doors, windows, and opening center lines.
- No provider result is silently "fixed" by old Bayti heuristics.
- Provider disagreement is preserved as uncertainty instead of being guessed away.
- Curved walls remain explicit geometry; they must not be flattened just to make 3D easier.
- Provider raw results are kept for debugging and reproducibility.
- Secrets remain server-side and are never committed to Git.

## First milestone

For one uploaded JPG/PNG floor plan, produce JSON containing:

- walls
- rooms
- doors
- windows
- curves
- scale
- confidence
- source agreement / disagreement

Then validate the same engine against 10–20 real plans before building the new Bayti UI or interior-design features.

## Status

Repository initialized. Provider adapters and fusion rules are the next implementation step.
