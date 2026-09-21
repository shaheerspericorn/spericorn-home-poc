# Coordinate contract

One convention, defined once in `cad-worker/cadworker/reconstruct.py` and consumed everywhere else.

| | Plan / analysis JSON | GLB / Three.js scene |
|---|---|---|
| Units | metres (converted from `$INSUNITS`, or inferred/overridden – always reported) | metres |
| Origin | centre of the wall-layer extents (1st–99th percentile, so a stray entity cannot move it) | same point |
| Axes | +x east, +y north, z up | +X east, **+Y up**, **−Z north** |
| Mapping | `(x, y)` | `(x, 0, −y)` |
| Floor | – | finished floor level is `Y = 0`; slab hangs below |

* Drawing coordinates such as `(125483.22, 98221.55)` never reach the GLB: the origin is subtracted **before** scaling
  and meshing, so Three.js works near `(0, 0, 0)` with full float precision.
* `analysis.json` carries both frames for rooms and openings: `center` / `polygon` (plan) and `center3d` / `polygon3d`
  (scene, `polygon3d[i] = [x, -y]`). The frontend never converts coordinates itself.
* The local-pipeline viewer uses `preserveOrigin` so **world == GLB coordinates**; furniture positions in the saved
  configuration are therefore directly meaningful to any future consumer of the GLB.
* Furniture GLBs: metres, Y-up, origin at the footprint centre on the floor → `scale = 1`, `position.y = 0`,
  rotation only about Y (radians, counter-clockwise seen from above).
* The 2D SVG preview draws plan coordinates inside one `scale(1,-1)` group (SVG y grows downwards); labels are placed at `(x, −y)`.

Verified by: `cad-worker/tests/test_glb_and_pipeline.py::test_plan_to_scene_mapping_is_x_0_minus_y`,
`::test_wall_extrusion_floor_and_axes`, `frontend/lib/configuration.test.ts`, and visually (top view matches the 2D review).
