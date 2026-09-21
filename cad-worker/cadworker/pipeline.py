"""Job orchestration: source file -> DXF -> normalised document -> detection -> (optional) GLB.

Both commands write `<workdir>/analysis.json`, which is the single artefact the Node backend and
the frontend read. It is written even when detection fails, so a developer can inspect layers and
entity counts and add rules - the pipeline never substitutes placeholder geometry.
"""
from __future__ import annotations

import json
import math
import shutil
import time
from contextlib import contextmanager
from dataclasses import asdict
from pathlib import Path
from typing import Callable

from . import errors
from .config import WorkerConfig
from .converter import CadFileConverter, OdaFileConverter
from .detect_openings import detect_openings
from .detect_rooms import detect_rooms
from .detect_walls import detect_walls, polygon_parts
from .errors import CadWorkerError
from .normalize import normalize_dxf
from .reconstruct import build_scene, export_glb, to_gltf_point

Progress = Callable[[str, int], None]
ANALYSIS_FILE = "analysis.json"
DXF_FILE = "source.dxf"
PREVIEW_ENTITY_LIMIT = 6000
MULTI_VIEW_GAP_M = 3.0
ENTITY_TYPES_3D = {"3DSOLID", "BODY", "REGION", "SURFACE", "PLANESURFACE", "EXTRUDEDSURFACE", "REVOLVEDSURFACE", "LOFTEDSURFACE", "SWEPTSURFACE", "NURBSSURFACE", "MESH", "POLYFACE", "3DFACE"}


class Timings(dict):
    @contextmanager
    def measure(self, key: str):
        started = time.perf_counter()
        try:
            yield
        finally:
            self[key] = int((time.perf_counter() - started) * 1000)


def _ring(polygon) -> list[list[float]]:
    return [[round(x, 4), round(y, 4)] for x, y in polygon.exterior.coords]


def _polygon_json(polygon) -> dict:
    return {"type": "polygon", "coordinates": _ring(polygon), "holes": [[[round(x, 4), round(y, 4)] for x, y in ring.coords] for ring in polygon.interiors]}


def prepare_dxf(input_path: str, workdir: Path, config: WorkerConfig, converter: CadFileConverter | None, timings: Timings) -> dict:
    source = Path(input_path)
    if not source.is_file():
        raise CadWorkerError(errors.INPUT_NOT_FOUND, "The uploaded file no longer exists on the server.")
    extension = source.suffix.lower()
    info = {"fileType": extension.lstrip(".").upper(), "sizeBytes": source.stat().st_size}
    target = workdir / DXF_FILE
    if extension == ".dxf":
        shutil.copyfile(source, target)
        timings["dwgToDxfMs"] = 0
        return {**info, "conversion": {"tool": "none (DXF uploaded)", "status": "skipped", "durationMs": 0}, "dxfBytes": target.stat().st_size}
    if extension != ".dwg":
        raise CadWorkerError(errors.UNSUPPORTED_FORMAT, f"The local CAD pipeline supports 2D .dwg and .dxf files, not '{extension or 'unknown'}'. Use CAD_CONVERSION_PROVIDER=aps for 3D CAD/BIM formats.")
    converter = converter or OdaFileConverter(config.odaPath, config.odaOutputVersion, config.converterTimeoutSec)
    with timings.measure("dwgToDxfMs"):
        result = converter.convert_to_dxf(str(source), str(workdir))
    return {**info, "sourceVersion": result.sourceVersion, "sourceVersionName": f"AutoCAD {result.sourceVersionName}",
            "conversion": {"tool": result.tool, "status": "success", "durationMs": result.durationMs}, "dxfBytes": result.dxfBytes}


def detect(dxf_path: str, config: WorkerConfig, timings: Timings, progress: Progress):
    progress("parsing_dxf", 35)
    with timings.measure("dxfParsingMs"):
        document, inventory = normalize_dxf(dxf_path, config)
    progress("detecting_geometry", 55)
    with timings.measure("geometryDetectionMs"):
        tolerances = config.tolerances
        wall_result = detect_walls(document.by_role("wall"), tolerances)
        openings, opening_warnings = detect_openings(wall_result.solid, document.entities, document.blockReferences, tolerances, config.build.wallThickness)
        rooms, footprint, room_warnings = detect_rooms(wall_result.solid, openings, document.entities, tolerances, config.roomTypeKeywords, config.roomNames)
        sheet_warnings = []
        if wall_result.solid is not None:
            # Wall groups more than a few metres apart are separate drawings (other storeys, elevations, sections).
            clusters = len(polygon_parts(wall_result.solid.buffer(MULTI_VIEW_GAP_M)))
            if clusters > 1:
                sheet_warnings.append(f"The wall geometry forms {clusters} separate groups. The file probably holds several plans or views (storeys, elevations, sections) on one sheet; this POC reconstructs them side by side as a single storey. Isolate one floor plan for a meaningful result.")
    return document, inventory, wall_result, openings, rooms, footprint, [*sheet_warnings, *wall_result.warnings, *opening_warnings, *room_warnings]


def build_report(source: dict, document, inventory, wall_result, openings, rooms, config: WorkerConfig, warnings: list[str], timings: Timings) -> dict:
    by_kind = {kind: [o for o in openings if o.kind == kind] for kind in ("door", "window", "opening")}
    detected_layers = {role: [layer["name"] for layer in document.layers if layer["role"] == role] for role in ("wall", "door", "window", "furniture", "roomLabel", "ignore")}

    assumptions = [
        f"Wall height {config.build.wallHeight} m (not present in a 2D plan).",
        f"Floor slab thickness {config.build.floorThickness} m.",
        f"Door head {config.build.doorHeight} m; window sill {config.build.windowSillHeight} m, head {config.build.windowHeadHeight} m.",
        "Single storey, flat floor, no roof or ceiling.",
    ]
    if document.units.source != "header":
        assumptions.insert(0, f"Units: {document.units.used} ({document.units.source}); header declared {document.units.declared}.")
    if any("geometric rule" in o.evidence for o in openings):
        assumptions.append("Wall gaps crossed by two or more parallel non-wall lines were classified as windows (geometric rule, not layer based).")

    def opening_json(o):
        return {"id": o.id, "kind": o.kind, "geometry2d": _polygon_json(o.polygon), "center": [round(o.center[0], 4), round(o.center[1], 4)], "center3d": to_gltf_point(*o.center),
                "width": o.width, "wallThickness": o.depth, "angleDeg": round(math.degrees(o.angle), 2), "hostCut": o.hostCut, "evidence": o.evidence, "layers": o.layers}

    preview = [
        {"layer": e.layer, "role": e.role, "points": [[round(x, 3), round(y, 3)] for x, y in e.points]}
        for e in document.entities if e.text is None and e.role not in {"wall"}
    ][:PREVIEW_ENTITY_LIMIT]

    return {
        "schemaVersion": 1,
        "source": source,
        "dxf": {"version": inventory["dxfVersion"], "versionName": inventory["dxfVersionName"], "sizeBytes": source.get("dxfBytes")},
        "units": {"declared": document.units.declared, "declaredCode": document.units.declaredCode, "used": document.units.used, "source": document.units.source, "metersPerUnit": document.units.metersPerUnit},
        "extents": {"drawingUnits": document.drawingExtents, "modelMeters": document.modelExtents, "originDrawingUnits": [document.origin[0], document.origin[1]]},
        "coordinateSystem": {"plan": "local metres, origin at the centre of the wall-layer extents, +x east, +y north", "scene": "glTF Y-up metres", "mapping": "(x, y) -> (x, 0, -y)"},
        "layers": document.layers,
        "entities": dict(sorted(document.entityCounts.items(), key=lambda item: -item[1])),
        "counts": {"lines": inventory["lineCount"], "polylines": inventory["polylineCount"], "blockReferences": inventory["blockReferenceCount"], "texts": inventory["textCount"], "hatches": inventory["hatchCount"]},
        "blocks": inventory["blocks"],
        "detectedLayers": detected_layers,
        "detection": {
            "wallStrategies": wall_result.strategyCounts, "wallSegmentsConsidered": wall_result.segmentCount,
            "candidateWalls": len(wall_result.walls), "candidateDoors": len(by_kind["door"]), "candidateWindows": len(by_kind["window"]),
            "candidateOpenings": len(by_kind["opening"]), "candidateRooms": len(rooms),
            "doorsOnIntactWalls": sum(1 for o in by_kind["door"] if not o.hostCut),
            "namedRooms": sum(1 for room in rooms if room.labelSource == "cad-text"),
        },
        "walls": [{"id": w.id, "sourceEntity": w.sourceEntities, "strategy": w.strategy, "geometry2d": _polygon_json(w.polygon), "height": config.build.wallHeight, "thickness": w.thickness, "layer": w.layer} for w in wall_result.walls],
        "doors": [opening_json(o) for o in by_kind["door"]],
        "windows": [opening_json(o) for o in by_kind["window"]],
        "openings": [opening_json(o) for o in by_kind["opening"]],
        "rooms": [{"id": r.id, "name": r.name, "type": r.type, "labelSource": r.labelSource, "polygon": _ring(r.polygon), "polygon3d": [[x, -y + 0.0] for x, y in _ring(r.polygon)],
                   "area": r.area, "center": [round(r.center[0], 4), round(r.center[1], 4)], "center3d": to_gltf_point(*r.center)} for r in rooms],
        "previewEntities": preview,
        "parameters": {"build": asdict(config.build), "tolerances": asdict(config.tolerances), "layerRoles": config.layerRoles, "unitsOverride": config.unitsOverride},
        "assumptions": assumptions,
        "warnings": [*document.warnings, *warnings],
        "timings": dict(timings),
    }


def _write(workdir: Path, report: dict) -> str:
    path = workdir / ANALYSIS_FILE
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(report, ensure_ascii=False), encoding="utf8")
    temporary.replace(path)
    return str(path)


def _run_detection(workdir: Path, source: dict, config: WorkerConfig, timings: Timings, progress: Progress):
    detection = detect(str(workdir / DXF_FILE), config, timings, progress)
    document, inventory, wall_result, openings, rooms, footprint, warnings = detection
    report = build_report(source, document, inventory, wall_result, openings, rooms, config, warnings, timings)
    report["status"] = "analyzed" if wall_result.walls else "no_walls"
    if not wall_result.walls:
        hint = "No layer matched the wall patterns." if not report["detectedLayers"]["wall"] else f"Wall layer(s) {report['detectedLayers']['wall']} contained no thin closed wall bodies."
        solids = sum(count for kind, count in report["entities"].items() if kind in ENTITY_TYPES_3D)
        if solids:
            report["warnings"].insert(0, f"This file is a 3D model, not a 2D plan: it contains {solids} 3D entit{'y' if solids == 1 else 'ies'} (3DSOLID / SURFACE / MESH ...). The local pipeline reconstructs 3D from 2D linework only. Use CAD_CONVERSION_PROVIDER=aps for authored 3D models, or upload the 2D floor plan of this space.")
        report["warnings"].insert(0, f"No reliable wall geometry was detected. {hint} Assign the wall layer manually or extend config/detection.default.json.")
    return report, detection


def analyze(input_path: str, workdir: str, config: WorkerConfig, progress: Progress, converter: CadFileConverter | None = None) -> dict:
    work = Path(workdir)
    work.mkdir(parents=True, exist_ok=True)
    timings = Timings()
    progress("converting_dwg", 15)
    source = prepare_dxf(input_path, work, config, converter, timings)
    report, _ = _run_detection(work, source, config, timings, progress)
    report["analysisPath"] = _write(work, report)
    return report


def generate(workdir: str, output_path: str, config: WorkerConfig, progress: Progress) -> dict:
    work = Path(workdir)
    previous_path = work / ANALYSIS_FILE
    if not (work / DXF_FILE).is_file() or not previous_path.is_file():
        raise CadWorkerError(errors.INPUT_NOT_FOUND, "This model has not been analysed yet, so there is no DXF to build from.")
    previous = json.loads(previous_path.read_text(encoding="utf8"))
    timings = Timings({key: value for key, value in previous.get("timings", {}).items() if key == "dwgToDxfMs"})

    # Detection is re-run (sub-second) so reviewed options apply; it reports under the 3D stage so progress never moves backwards.
    progress("generating_3d", 70)
    report, detection = _run_detection(work, previous["source"], config, timings, lambda *_: None)
    _document, _inventory, wall_result, openings, rooms, footprint, _warnings = detection
    if not wall_result.walls:
        report["analysisPath"] = _write(work, report)
        raise CadWorkerError(errors.NO_WALLS, errors.NO_WALLS_MESSAGE, {"analysisPath": report["analysisPath"]})

    progress("generating_3d", 75)
    with timings.measure("generation3dMs"):
        scene, summary, node_of = build_scene(wall_result.walls, openings, rooms, footprint, config.build)
    progress("exporting_glb", 90)
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with timings.measure("glbExportMs"):
        glb_bytes = export_glb(scene, output_path)

    for collection in ("walls", "doors", "windows", "openings", "rooms"):
        for item in report[collection]:
            item["node"] = node_of.get(item["id"])
    report["model3d"] = {**asdict(summary), "glbBytes": glb_bytes}
    report["timings"] = dict(timings)
    report["status"] = "generated"
    report["analysisPath"] = _write(work, report)
    return report
