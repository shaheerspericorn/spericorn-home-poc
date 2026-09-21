"""DXF -> NormalizedCadDocument.

This is the only module that touches ezdxf entities. Everything downstream (detection, 3D) works
on plain Python data in *local metres*: drawing coordinates are shifted so the architectural
content is centred on (0, 0) and scaled by the unit decision.
"""
from __future__ import annotations

import fnmatch
import math
from collections import Counter, defaultdict
from dataclasses import dataclass, field

import ezdxf
from ezdxf import path as ezpath
from ezdxf.lldxf.const import DXFError

from . import errors
from .config import LayerPatterns, WorkerConfig
from .errors import CadWorkerError
from .units import UnitDecision, decide_units

ROLES = ("ignore", "wall", "door", "window", "furniture", "roomLabel")
CURVE_TYPES = {"LINE", "LWPOLYLINE", "POLYLINE", "ARC", "CIRCLE", "ELLIPSE", "SPLINE"}
TEXT_TYPES = {"TEXT", "MTEXT", "ATTRIB"}
DXF_VERSION_NAMES = {"AC1009": "R12", "AC1015": "2000", "AC1018": "2004", "AC1021": "2007", "AC1024": "2010", "AC1027": "2013", "AC1032": "2018"}

Point = tuple[float, float]


@dataclass
class NormalizedEntity:
    id: str
    type: str  # source DXF type
    layer: str
    role: str  # wall | door | window | furniture | roomLabel | other
    points: list[Point] = field(default_factory=list)  # flattened path
    closed: bool = False
    arc: dict | None = None  # {"center": (x, y), "radius": r, "startAngle": deg, "endAngle": deg}
    text: str | None = None
    block: str | None = None  # name of the block this primitive was expanded from
    handle: str | None = None


@dataclass
class BlockReference:
    id: str
    name: str
    layer: str
    role: str
    position: Point
    rotation: float
    bounds: tuple[float, float, float, float] | None


@dataclass
class NormalizedCadDocument:
    dxfVersion: str
    units: UnitDecision
    origin: Point  # drawing-unit coordinates that became (0, 0)
    drawingExtents: dict
    modelExtents: dict
    layers: list[dict]
    entityCounts: dict[str, int]
    entities: list[NormalizedEntity]
    blockReferences: list[BlockReference]
    skipped: dict[str, int]
    warnings: list[str]

    def by_role(self, role: str) -> list[NormalizedEntity]:
        return [entity for entity in self.entities if entity.role == role]


def _matches(name: str, patterns: list[str]) -> bool:
    upper = name.upper()
    return any(fnmatch.fnmatchcase(upper, pattern.upper()) for pattern in patterns)


def classify(name: str, patterns: LayerPatterns, overrides: dict[str, str] | None = None) -> str:
    if overrides and name in overrides:
        role = overrides[name]
        return role if role in ROLES else "other"
    for role in ROLES:
        if _matches(name, getattr(patterns, role)):
            return role
    return "other"


def layer_of(entity) -> str:
    """Entity types ezdxf does not model (PLANESURFACE, some proxies) are raw tag storage without a `layer` attribute."""
    try:
        return entity.dxf.get("layer", "0") or "0"
    except Exception:  # noqa: BLE001 - never let one exotic entity fail the drawing
        return "0"


def read_dxf(dxf_path: str):
    try:
        return ezdxf.readfile(dxf_path)
    except (DXFError, OSError, UnicodeDecodeError, ValueError) as first_error:
        # ezdxf's recover mode tolerates structurally damaged DXF files.
        try:
            from ezdxf import recover
            document, _auditor = recover.readfile(dxf_path)
            return document
        except Exception as error:  # noqa: BLE001 - every failure here is a parse failure
            raise CadWorkerError(errors.DXF_PARSE_ERROR, f"The DXF could not be parsed: {first_error}") from error


class _Collector:
    def __init__(self, config: WorkerConfig, flattening: float):
        self.config = config
        self.flattening = flattening
        self.raw: list[dict] = []
        self.blocks: list[dict] = []
        self.skipped: Counter = Counter()

    def role_of(self, layer: str) -> str:
        return classify(layer, self.config.layerPatterns, self.config.layerRoles)

    def add(self, entity, layer: str, block: str | None, depth: int) -> None:
        kind = entity.dxftype()
        if kind == "INSERT":
            self._insert(entity, layer, depth)
            return
        role = self.role_of(layer)
        if role == "ignore":
            return
        base = {"type": kind, "layer": layer, "role": role, "block": block, "handle": entity.dxf.get("handle")}
        if kind in TEXT_TYPES:
            text = entity.plain_text() if kind == "MTEXT" else entity.dxf.get("text", "")
            insert = entity.dxf.get("insert")
            if text and text.strip() and insert is not None:
                self.raw.append({**base, "points": [(insert.x, insert.y)], "text": " ".join(text.split())[:120]})
            return
        if kind == "HATCH":
            if role != "wall":
                return
            try:
                for boundary in ezpath.from_hatch(entity):
                    points = [(v.x, v.y) for v in boundary.flattening(self.flattening)]
                    if len(points) >= 3:
                        self.raw.append({**base, "points": points, "closed": True})
            except Exception:  # noqa: BLE001 - hatch boundaries are optional evidence
                self.skipped["HATCH(boundary)"] += 1
            return
        if kind not in CURVE_TYPES:
            self.skipped[kind] += 1
            return
        try:
            flattened = [(v.x, v.y) for v in ezpath.make_path(entity).flattening(self.flattening)]
        except Exception:  # noqa: BLE001 - one malformed entity must not fail the drawing
            self.skipped[f"{kind}(invalid)"] += 1
            return
        if len(flattened) < 2:
            return
        record = {**base, "points": flattened, "closed": False}
        if kind in {"LWPOLYLINE", "POLYLINE"}:
            record["closed"] = bool(getattr(entity, "closed", False) or getattr(entity, "is_closed", False))
        elif kind == "CIRCLE":
            record["closed"] = True
        elif kind == "ARC":
            center = entity.dxf.center
            record["arc"] = {"center": (center.x, center.y), "radius": entity.dxf.radius, "startAngle": entity.dxf.start_angle, "endAngle": entity.dxf.end_angle}
        self.raw.append(record)

    def _insert(self, insert, parent_layer: str, depth: int) -> None:
        name = insert.dxf.name
        layer = layer_of(insert) if layer_of(insert) != "0" else parent_layer
        role = classify(name, self.config.blockPatterns)
        if role == "other":
            role = self.role_of(layer)
        position = insert.dxf.insert
        record = {"name": name, "layer": layer, "role": role, "position": (position.x, position.y), "rotation": insert.dxf.get("rotation", 0.0), "pts": []}
        self.blocks.append(record)
        if depth >= self.config.tolerances.maxBlockDepth:
            self.skipped["INSERT(max depth)"] += 1
            return
        before = len(self.raw)
        try:
            for child in insert.virtual_entities():
                # Entities drawn on layer "0" inside a block inherit the layer of the INSERT.
                child_layer = layer_of(child) if layer_of(child) != "0" else layer
                self.add(child, child_layer, name, depth + 1)
        except Exception:  # noqa: BLE001 - non-uniform scaling etc. can make a block unexpandable
            self.skipped["INSERT(unexpandable)"] += 1
        # A block classified as door/window/furniture carries that role into its primitives.
        for child in self.raw[before:]:
            record["pts"].extend(child["points"])
            if role in {"door", "window", "furniture"} and child["role"] in {"other", "wall"}:
                child["role"] = role


def _bounds(points: list[Point]) -> tuple[float, float, float, float] | None:
    if not points:
        return None
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    return (min(xs), min(ys), max(xs), max(ys))


def _robust_bounds(points: list[Point]) -> tuple[float, float, float, float] | None:
    """Percentile-trimmed bounds so one stray entity far from the plan does not decide the origin."""
    if len(points) < 20:
        return _bounds(points)
    xs, ys = sorted(p[0] for p in points), sorted(p[1] for p in points)
    low, high = int(len(xs) * 0.01), int(len(xs) * 0.99) - 1
    return (xs[low], ys[low], xs[high], ys[high])


def normalize_dxf(dxf_path: str, config: WorkerConfig) -> tuple[NormalizedCadDocument, dict]:
    """Returns the normalised document plus the raw inventory used by the diagnostic report."""
    document = read_dxf(dxf_path)
    modelspace = document.modelspace()
    insunits = int(document.header.get("$INSUNITS", 0) or 0)
    measurement = document.header.get("$MEASUREMENT")

    def collect(flattening: float) -> _Collector:
        collector = _Collector(config, flattening)
        for entity in modelspace:
            collector.add(entity, layer_of(entity), None, 0)
        return collector

    entity_counts: Counter = Counter()
    layer_types: dict[str, Counter] = defaultdict(Counter)
    for entity in modelspace:
        kind = entity.dxftype()
        entity_counts[kind] += 1
        layer_types[layer_of(entity)][kind] += 1

    if sum(entity_counts.values()) == 0:
        raise CadWorkerError(errors.NO_GEOMETRY, "The drawing's model space is empty. If the plan lives in a paper-space layout or an external reference (xref), bind it into model space and upload again.")

    # Pass 1 (coarse): units are unknown, so curve flattening cannot be expressed in metres yet.
    # Extents and arc radii do not depend on flattening quality, and they are what decides the units.
    raw = collect(1e9).raw
    wall_points = [p for item in raw if item["role"] == "wall" and "text" not in item for p in item["points"]]
    all_points = [p for item in raw if "text" not in item for p in item["points"]]
    focus = _robust_bounds(wall_points) or _robust_bounds(all_points)
    if focus is None:
        raise CadWorkerError(errors.NO_GEOMETRY, "The drawing contains no line, polyline, arc or block geometry that could be analysed.")
    extent = max(focus[2] - focus[0], focus[3] - focus[1])

    door_radii = [
        item["arc"]["radius"] for item in raw
        if item.get("arc") and item["role"] == "door" and 60 <= (item["arc"]["endAngle"] - item["arc"]["startAngle"]) % 360 <= 120
    ]
    units = decide_units(insunits, measurement, extent, door_radii, config.unitsOverride)
    scale = units.metersPerUnit
    # Pass 2: flatten curves with the configured tolerance, now expressible in drawing units.
    collector = collect(config.tolerances.curveFlatteningDistance / scale)
    raw = collector.raw
    all_points = [p for item in raw if "text" not in item for p in item["points"]]
    origin = ((focus[0] + focus[2]) / 2, (focus[1] + focus[3]) / 2)

    def local(point: Point) -> Point:
        return ((point[0] - origin[0]) * scale, (point[1] - origin[1]) * scale)

    entities: list[NormalizedEntity] = []
    for index, item in enumerate(raw, start=1):
        arc = item.get("arc")
        entities.append(NormalizedEntity(
            id=f"ent-{index:05d}", type=item["type"], layer=item["layer"], role=item["role"],
            points=[local(p) for p in item["points"]], closed=item.get("closed", False),
            arc={**arc, "center": local(arc["center"]), "radius": arc["radius"] * scale} if arc else None,
            text=item.get("text"), block=item.get("block"), handle=item.get("handle"),
        ))

    block_refs = []
    for index, block in enumerate(collector.blocks, start=1):
        bounds = _bounds([local(p) for p in block["pts"]])
        block_refs.append(BlockReference(f"blk-{index:04d}", block["name"], block["layer"], block["role"], local(block["position"]), block["rotation"], bounds))

    layers = []
    for layer in document.layers:
        name = layer.dxf.name
        types = layer_types.get(name, Counter())
        layers.append({"name": name, "role": collector.role_of(name), "entityCount": sum(types.values()), "types": dict(types), "frozen": layer.is_frozen(), "off": layer.is_off()})
    known = {layer["name"] for layer in layers}
    for name, types in layer_types.items():  # layers referenced by entities but missing from the table
        if name not in known:
            layers.append({"name": name, "role": collector.role_of(name), "entityCount": sum(types.values()), "types": dict(types), "frozen": False, "off": False})
    layers.sort(key=lambda item: -item["entityCount"])

    drawing_bounds = _bounds(all_points)
    model_bounds = _bounds([p for entity in entities if entity.text is None for p in entity.points])
    warnings = list(units.notes)
    if any(math.isfinite(v) is False for v in drawing_bounds):
        raise CadWorkerError(errors.INVALID_GEOMETRY, "The drawing contains non-finite coordinates.")
    if collector.skipped:
        warnings.append("Entity types not used for reconstruction: " + ", ".join(f"{kind} x{count}" for kind, count in sorted(collector.skipped.items())))
    if any(getattr(block.block, "is_xref", False) for block in document.blocks if block.block is not None):
        warnings.append("The drawing references external files (xrefs). Their content is not available to the converter.")

    normalized = NormalizedCadDocument(
        dxfVersion=document.dxfversion, units=units, origin=origin,
        drawingExtents={"min": [drawing_bounds[0], drawing_bounds[1]], "max": [drawing_bounds[2], drawing_bounds[3]]},
        modelExtents={"min": [model_bounds[0], model_bounds[1]], "max": [model_bounds[2], model_bounds[3]]},
        layers=layers, entityCounts=dict(entity_counts), entities=entities, blockReferences=block_refs,
        skipped=dict(collector.skipped), warnings=warnings,
    )
    inventory = {
        "dxfVersion": document.dxfversion,
        "dxfVersionName": DXF_VERSION_NAMES.get(document.dxfversion, document.dxfversion),
        "lineCount": entity_counts.get("LINE", 0),
        "polylineCount": entity_counts.get("LWPOLYLINE", 0) + entity_counts.get("POLYLINE", 0),
        "blockReferenceCount": entity_counts.get("INSERT", 0),
        "textCount": entity_counts.get("TEXT", 0) + entity_counts.get("MTEXT", 0),
        "hatchCount": entity_counts.get("HATCH", 0),
        "blocks": [{"name": name, "count": count} for name, count in Counter(b["name"] for b in collector.blocks).most_common(40)],
    }
    return normalized, inventory
