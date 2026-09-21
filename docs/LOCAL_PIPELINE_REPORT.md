# 2D DWG → 3D villa: local pipeline POC report

Date: 2026-09-21 · Provider: `CAD_CONVERSION_PROVIDER=local` · Status: **end-to-end flow demonstrated on a real 2D DWG**

> **Verdict for the tested drawing.** `Apartment-413201.dwg` (a real 2D architectural floor plate) **was converted into a
> usable, structured 3D model**: 19 wall bodies, 20 enclosed rooms, 16 doors, 14 windows, exported as a valid 135 KB GLB,
> loaded in the browser, and furnished (place / drag / rotate / remove / save / reload verified in Chrome).
> Assumptions that were required are listed in §20; one of them (drawing units) contradicts the file's own header and is
> reported to the user rather than applied silently. This is **one** drawing – see §20–§23 for what that does and does not prove.
>
> No DWG was attached to the request, so the most recent 2D plan found in `~/Downloads` was used as the first test case.
> **The client's own drawings still need to be run through the 2D review screen** – that is what this POC is built to measure.

## 1. Architecture

```
Browser (Next.js)                       Node.js backend (Express)                         Python CAD worker (CLI, child process)
─────────────────                       ────────────────────────                          ─────────────────────────────────────
Upload ─────────────POST /models/upload▶ ModelService ─ create job, return modelId
Progress ◀──────────GET  /models/:id/status (poll 2.2 s)
                                         │  CadConversionService (interface)
                                         │   ├─ ApsCadConversionService      (unchanged)  ──▶ Autodesk Platform Services
                                         │   ├─ SampleModeConversionService  (unchanged)
                                         │   └─ LocalCadConversionService ── spawn ──────▶ python -m cadworker analyze
                                         │        + PlanReviewCapable                        DWG ─ODA File Converter▶ DXF
                                         │                                                   DXF ─ezdxf▶ NormalizedCadDocument (metres, centred)
2D review ◀─────────GET  /models/:id/analysis ◀──────── analysis.json ◀────────────────────  walls → openings → rooms (Shapely rules)
  (SVG + diagnostics + overrides)        status = awaiting_review
Generate 3D ────────POST /models/:id/generate ─────────── spawn ─────────────────────────▶ python -m cadworker generate
                                                                                             extrude (trimesh) → named scene → model.glb
3D viewer ◀─────────GET  /models/:id/model.glb
Furniture ──────────PUT/GET /models/:id/configuration ─▶ configuration.json
```

* The rest of the backend never checks the provider name. The review pause is an optional **capability**
  (`PlanReviewCapable` / `supportsPlanReview()`), not an `if (provider === "local")`.
* All geometry logic is in Python; Node only orchestrates (argv array, no shell; JSON-lines protocol; timeout; kill).
* No Docker, queue, Redis or microservice was added. Jobs run in-process exactly like the existing APS jobs.

## 2. Files created / modified

**Created – Python worker (`cad-worker/`)**: `cadworker/{__init__,__main__,config,errors,converter,units,normalize,detect_walls,detect_openings,detect_rooms,reconstruct,pipeline}.py`,
`config/detection.default.json`, `scripts/make_furniture.py`, `tests/{conftest,test_converter,test_parsing_and_detection,test_glb_and_pipeline}.py`, `requirements.txt`, `README.md`.

**Created – backend**: `src/infrastructure/local/{local-cad-conversion-service,python-cad-worker}.ts`, `src/types/configuration.ts`,
`test/{local-conversion,plan-review-flow,api-local-pipeline}.test.ts`, `test/fixtures/simple-plan.dxf`.

**Created – frontend**: `components/{PlanReview,FurnitureLayer,FurniturePanel}.tsx`, `app/review/[id]/page.tsx`,
`lib/{cad-analysis,configuration,furniture-catalog,use-model-status}.ts`, `public/furniture/{sofa,bed,dining-table}.glb`, tests for each.

**Created – docs**: `docs/LOCAL_PIPELINE_REPORT.md`, `docs/COORDINATES.md`.

**Modified (additive)**: `backend/src/{config,app}.ts`, `types/{model,conversion}.ts`, `services/conversion/create-cad-conversion-service.ts`,
`services/model/model-service.ts`, `services/model/model-repository.ts` (write serialisation – see §22), `services/storage/file-system-storage.ts`,
`controllers/model-controller.ts`, `routes/model-routes.ts`, `test/model-service.test.ts` (pinned env);
`frontend/components/{ModelViewer,ViewerWorkspace,ConversionProgress,UploadWorkspace}.tsx`, `lib/api.ts`, `app/globals.css`;
`.env.example`, `.gitignore`, `README.md`. Your local `.env` / `backend/.env`: `CAD_CONVERSION_PROVIDER` switched `aps → local`, defaults appended; APS keys untouched.

**Not touched**: `backend/src/infrastructure/aps/autodesk-aps-conversion-service.ts`, the sample provider.

## 3–7. Setup, environment

See `cad-worker/README.md` (ODA File Converter per OS, headless Linux, Python venv) and `.env.example` (every variable, commented). Short version:

```bash
npm install                                             # Node 20+
cd cad-worker && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m cadworker doctor                    # confirms ezdxf/shapely/trimesh + ODA executable
cd .. && cp .env.example .env                           # CAD_CONVERSION_PROVIDER=local
npm run dev                                             # frontend :3000, backend :PORT
```

| Variable | Purpose |
|---|---|
| `CAD_CONVERSION_PROVIDER` | `local` \| `aps` \| `sample` |
| `ODA_FILE_CONVERTER_PATH` | executable; empty = auto-detect |
| `CAD_WORK_DIR`, `CAD_OUTPUT_DIR` | per-job DXF/analysis; GLB output (overrides `OUTPUT_DIR`) |
| `CAD_PYTHON_PATH`, `CAD_WORKER_DIR`, `CAD_WORKER_TIMEOUT_MS`, `CAD_CONVERTER_TIMEOUT_SEC` | worker process |
| `DEFAULT_WALL_HEIGHT_M`, `DEFAULT_WALL_THICKNESS_M`, `DEFAULT_FLOOR_THICKNESS_M`, `DEFAULT_DOOR_HEIGHT_M`, `DEFAULT_WINDOW_SILL_M`, `DEFAULT_WINDOW_HEAD_M` | 3D assumptions (metres) |
| `CAD_DETECTION_CONFIG`, `CAD_UNITS_OVERRIDE`, `LOCAL_SUPPORTED_FORMATS` | rules file, forced units, accepted extensions |
| `MAX_UPLOAD_SIZE_MB`, `DEBUG_CAD` | upload limit; worker stderr in backend log |
| `APS_CLIENT_ID`, `APS_CLIENT_SECRET`, … | APS mode only; never sent to the frontend; **not required by `local`** (tested) |

## 8. Supported CAD formats (local provider)

| Input | Status |
|---|---|
| 2D **DWG** R11/12 … 2018 (`AC1009`–`AC1032`) | supported via ODA File Converter 27.1 |
| 2D **DXF** | supported directly (conversion skipped) |
| DWG older than R11 / unknown newer signature | rejected: `UNSUPPORTED_DWG_VERSION` |
| 3D DWG (3DSOLID/mesh), IFC, RVT, STEP | not handled by `local` → use `aps` |

Entities read: LINE, LWPOLYLINE, POLYLINE, ARC, CIRCLE, ELLIPSE, SPLINE (flattened), INSERT (expanded ≤ 4 levels, layer-0 inheritance),
TEXT/MTEXT/ATTRIB, HATCH boundaries on wall layers. Reported but unused: DIMENSION, MULTILEADER, REGION, 3DSOLID, ATTDEF, xrefs (warned).

## 9–15. Tested DWG and detection results

`Apartment-413201.dwg` – 91 047 B, AutoCAD 2018 (`AC1032`) → DXF 472 384 B. Model space only, no text, 11 block references.

| | |
|---|---|
| Units | header `$INSUNITS = 4` (millimetres) → **used: metres (inferred)**. Evidence: wall extent 27.36 units, median door swing 0.855 units; as mm the building would be 27 mm long. Shown as a warning; overridable. |
| Plan size | 27.84 × 14.04 m, origin moved from (2944.08, 1898.25) to (0, 0) |
| Entities | LINE 647 · LWPOLYLINE 270 · ARC 265 · CIRCLE 144 · INSERT 11 · ATTDEF 4 · TEXT 0 · HATCH 0 |
| Layers → role | `Muro1` → wall (258 two-vertex polylines) · `Puertas` → door · `WINDOW` → window · `FURNITURE` → furniture · `PUB_DIM`, `DEFPOINTS` → ignored · 9 others unclassified |
| **Walls** | **19** bodies, all 0.24 m thick. Strategy 1 closed polylines: 0 · 2 parallel pairs: 0 (all already explained) · **3 line-network faces: 19** |
| **Rooms** | **20** enclosed (2.3 – 43.0 m², 221.8 m² total); 0 named – the drawing has no text → `Room 1…20`; 4 voids < 1 m² ignored |
| **Doors** | **16**, all from swing arcs on `Puertas`, all in real wall gaps (no wall cut needed); 0 on intact walls |
| **Windows** | **14**, all by the *geometric rule* (≥ 2 non-wall lines spanning a wall gap). The glazing lines are on `FURNITURE`, not on `WINDOW` – layer names alone would have found **none** |
| Open passages | 16 wall gaps 0.9–2.1 m with no symbol (incl. some where the drafter omitted the door) |

This is a floor plate with two mirrored apartments and a stair core, not a detached villa – the file was analysed, not assumed.

Other files run for calibration (all behave honestly, none crashes):

| File | Result |
|---|---|
| `visualization_-_condominium_with_skylight.dwg` | 76 × 3DSOLID, no wall layer → **`no_walls`, job fails with the required message**, diagnostics available, no GLB |
| `architectural_-_annotation_scaling_and_multileaders.dwg` | section/detail sheet (inches honoured from header): 32 "wall" bodies from `Arch_Section_Wall`, **0 rooms** + warning – a section is not a plan |
| `taller 4.dwg` | one sheet with three storeys + elevations + sections: 117 walls / 31 rooms (17 named from Spanish MTEXT, e.g. *Cocina*, *Alcoba*) **+ "separate groups" warning**. Not a usable single model without isolating one plan |

## 16–17. Timings and sizes (tested DWG, this workstation)

| Stage | |
|---|---|
| DWG 89 KB → DXF 461 KB (ODA) | 0.34 s |
| DXF parsing + normalisation (ezdxf) | 0.19 s |
| Geometry detection (Shapely) | 0.10 s |
| 3D generation (trimesh, 2 744 triangles, 181 named nodes) | 0.05 s |
| GLB export | 0.006 s → **135 KB** |
| Backend job, generate phase incl. Python start-up | 0.68 s |

Logged per job as `[metrics] model=… {…}` by the backend and `[metrics] … browserLoadMs=…` by the browser; also shown in both UIs.

## 18. Viewer performance

GLB fetch + parse + first frame **0.40–0.43 s**; **28–35 FPS in headless Chrome on SwiftShader (software rendering, no GPU)** – a lower bound; any real GPU will be far higher for 2.7 k triangles.
Orbit / zoom / pan / reset / fit / fullscreen are the existing viewer's; added **Low walls** (cutaway) and **Top view**, because 3 m walls hide furniture.

## 19. Furniture placement results (driven in Chrome via puppeteer, not just unit-tested)

| Step | Result |
|---|---|
| Select room (chip or click floor) | room floor highlights (per-room mesh + `extras.roomId`) |
| Add Sofa | appears at the room's `center3d`, `y = 0`, scale 1 |
| Drag | moved 1.93 m across the floor plane; orbit controls suspended during the drag |
| Keep inside room | far drag towards another room rejected – stays in Room 17 |
| Rotate | ±15° buttons and `R` / `Shift+R` → 60° |
| Remove | button / `Delete` |
| Save → reload page | 1 item restored; stored as `{assetId, roomId, position{x,0,z}, rotation{0,y,0}, scale{1,1,1}}` |

A first version of this check was wrong (it "found" an item that was merely still selected); it was rewritten to measure a real position delta.

## 20. Assumptions and known limitations

Assumed because a 2D plan cannot contain them: wall height 3.0 m, slab 0.15 m, door head 2.1 m, window sill 0.9 / head 2.1 m, single storey, flat floor, no roof/ceiling/stairs. All are env/config values; wall height and fallback thickness are editable per job.

* **Layer conventions matter.** Walls must be on a layer matching a wall pattern (or be assigned in the review screen). Walls on layer `0` are not guessed.
* **Walls must be drawn as thin closed bodies** (two faces + caps, or closed polylines, or parallel lines). Single-line (centre-line) walls, walls only implied by hatches on non-wall layers, and curved walls thicker than the flattening tolerance are not reconstructed.
* **Wall bodies are as drawn**: one `Wall_nnn` per closed outline, which can be an L/T-shaped group rather than one straight segment.
* **Openings are wall gaps.** Doors/windows drawn over an *unbroken* wall are shown as a visual object on the intact wall (never a guessed boolean cut). Gaps > 2.5 m without a symbol are left open, so such rooms are not enclosed and are **not reported** as rooms.
* The **window geometric rule** can misread other linework crossing a gap (a threshold, a sliding-door track) as a window.
* **Unit inference** is a plausibility heuristic (extent 3–400 m, door 0.55–1.4 m); it is always displayed and overridable.
* **Multi-view sheets** (several storeys/elevations in one model space) are detected and warned about but not separated. Paper-space layouts and xrefs are not read.
* Room names need TEXT/MTEXT inside the room; furniture `allowedRooms` is advisory (warns, does not block). No collision detection.
* ODA File Converter needs an X display on Linux (`xvfb-run` fallback implemented, not exercised on this machine – no xvfb installed).
* Jobs run in the backend process, in memory + JSON file: fine for a POC, not for concurrent production load.

## 21. What worked

Real DWG → DXF locally in 0.3 s · strategy-3 wall detection on real, unclosed linework · geometric opening detection that needs no boolean ops · room sealing incl. doors at room corners (cap-to-face) · honest unit handling · large-coordinate recentring · structured GLB (`Villa/Walls/Wall_001`, `Rooms/Room_*`, `Doors/Door_001/{Leaf,Lintel}`, `Windows/Window_001/{Glass,Sill,Lintel}`, extras on every node) · one coordinate contract across Python/JSON/Three.js · review → correct → regenerate loop · APS and sample providers unaffected (their tests still pass).

## 22. What failed / was found along the way

* `QT_QPA_PLATFORM=offscreen` does not work with ODA's AppImage (xcb only); AppImage needs FUSE → documented the extract route.
* First opening detector missed doors at room corners and mis-paired unequal caps → added cap-to-face rays and rectangularity checks.
* Progress events exposed a **pre-existing race** in `ModelRepository.persist()` (shared `.tmp` file) → writes are now serialised.
* Two legacy backend tests silently depended on the developer's `.env` → pinned.
* Not achieved: separating multi-view sheets; centre-line walls; naming rooms when the drawing has no text.

## 23. Required for production

Client drawing corpus (20–50 files) with expected counts as regression fixtures · CAD layer standard agreed with the client's architects (or a per-client rules file) · storey handling + plan isolation (pick a region/layout in the review UI) · wall graph (centre-lines, segments, junctions) instead of as-drawn bodies · manual correction tools (add/remove wall, mark opening) · roof/ceiling/stairs strategy · durable job queue, worker pool, object storage, auth, upload scanning, per-job resource limits · headless ODA in a container with Xvfb, or a licensed SDK (below) · real furniture catalogue, collision/clearance rules.

## 24. Comparison with the existing APS implementation

| | APS (existing) | Local (new) |
|---|---|---|
| Input | 3D CAD/BIM (DWG 3D, IFC, RVT, STEP) | 2D DWG/DXF plans |
| 2D drawing | **rejected** ("no 3D view") | the purpose |
| Output | faithful tessellation of authored 3D; hierarchy from OBJ groups | reconstructed walls/rooms/openings with semantic node names + room metadata |
| Knows what a "room" is | no | yes |
| Time for the test file | minutes (upload + translate + poll) | < 1 s |
| Runs offline / data leaves premises | no / yes | yes / no |
| Correctness depends on | Autodesk translators | our rules + drawing discipline |

They solve different problems; the provider switch lets both coexist.

---

# PRODUCTION RECOMMENDATION

No winner is selected here: the deciding input – how the **client's actual drawings** behave in the 2D review screen – does not exist yet.

| | **A · APS** | **B · Local ODA + ezdxf + custom geometry** | **C · Hybrid** |
|---|---|---|---|
| Technical control | Low: black-box translation; cannot add architectural semantics | Full: every rule, tolerance and output node is ours | Full where it matters (2D semantics), none needed for 3D |
| Supported CAD types | Broad 3D/BIM; **cannot turn a 2D plan into 3D** | 2D DWG/DXF only | Both: route by content (2D plan → local, 3D/BIM → APS) |
| Conversion quality | High fidelity *for authored 3D* | Proportional to drawing discipline; good on the tested plan, poor on multi-view sheets | Best available per input type |
| Maintenance | API/version changes only | Ongoing rules work per client convention; needs a regression corpus | Both, but each side stays small |
| Licensing | Commercial Autodesk terms, metered (Flex tokens / cloud credits) – confirm current pricing | Python libs are permissive (below). **ODA File Converter's licence must be reviewed by whoever owns legal**: it is a free download, and automated/server/commercial use may require ODA membership (Drawings SDK). Do not assume it is free for production. | Both sets of terms |
| Infrastructure | None beyond the backend; outbound internet | CPU worker with Python + ODA (+ Xvfb on Linux); no GPU | Worker + outbound internet |
| Performance | Minutes per file, network bound | Sub-second to seconds, local | Per route |
| Third-party dependency | Hard runtime dependency on Autodesk cloud; files leave the premises | One local binary (replaceable behind `CadFileConverter`, e.g. by ODA SDK or client-supplied DXF); no runtime cloud | Cloud dependency only for 3D inputs |
| Development complexity | Low (done) | High and open-ended: computational geometry + correction UI | Highest total, but incremental – both halves already exist |
| Commercial scalability | Cost scales with volume; trivially elastic | Near-zero marginal cost; scale = worker processes; engineering cost front-loaded | Pay APS only for 3D uploads |

**What would settle it:** (1) run 20–50 real client DWGs through the review screen and record walls/rooms/doors found vs expected; (2) ask whether the client can supply 3D/BIM for any projects; (3) get a written position on ODA licensing; (4) decide whether drawings may leave the client's infrastructure. If clients only have 2D plans, A alone cannot meet the requirement; whether B alone or C is right depends on (2).

## Licensing of what was added

| Component | Licence (from installed package metadata) | In repo? | Notes |
|---|---|---|---|
| ezdxf 1.4.4 | MIT | dependency only | attribution in distributions |
| Shapely 2.1.2 (GEOS: LGPL-2.1, dynamically linked inside the wheel) | BSD-3-Clause | dependency only | |
| trimesh 5.1.0 | MIT | dependency only | triangulation uses `mapbox-earcut` (ISC); the non-commercial `triangle` engine is **deliberately not used** |
| NumPy 2.x | BSD-3-Clause (+ bundled permissive) | dependency only | |
| ODA File Converter 27.1 | **proprietary** (ODA terms) | **no** – installed per machine, git-ignored | see above; not redistributed |
| Furniture GLBs | generated by our own script | yes | no third-party assets |
| puppeteer-core | Apache-2.0 | no – verification only, in a scratch directory | |

No third-party source code was copied into the repository. This table is an engineering inventory, not legal advice.
