"""Door / window detection.

Architectural plans normally draw walls *broken* at doors and windows, each stub closed by a short
end cap. An opening is therefore found geometrically - two facing caps with free space between
them - and only then classified from evidence:

    door    a door-layer/door-block swing arc or symbol sits at the gap
    window  window-layer/window-block geometry crosses the gap, or (geometric rule) at least two
            non-wall lines run parallel to the wall across most of the gap
    opening none of the above (plain passage)

Because the wall is already interrupted in the drawing, no boolean subtraction is ever needed.
Door/window symbols that do NOT coincide with a gap are kept as `hostCut=False`: the 3D stage
places a visual object on the intact wall instead of cutting it.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from shapely import STRtree
from shapely.geometry import LineString, Point, Polygon, box

from .config import Tolerances
from .detect_walls import polygon_parts
from .normalize import BlockReference, NormalizedEntity


@dataclass
class Opening:
    id: str
    kind: str  # door | window | opening
    polygon: Polygon  # footprint across the wall thickness
    center: tuple[float, float]
    width: float  # along the wall
    depth: float  # wall thickness at the opening
    angle: float  # radians, direction of the wall axis
    hostCut: bool  # True: the wall is interrupted here. False: visual object on an intact wall.
    evidence: str
    layers: list[str] = field(default_factory=list)


@dataclass
class _Cap:
    start: tuple[float, float]
    end: tuple[float, float]
    mid: tuple[float, float]
    normal: tuple[float, float]
    length: float


def _caps(solid, tolerances: Tolerances) -> list[_Cap]:
    caps = []
    for polygon in polygon_parts(solid):
        # simplify() merges collinear vertices left behind by unary_union so every straight edge is one edge.
        polygon = polygon.simplify(1e-4, preserve_topology=True)
        for ring in [polygon.exterior, *polygon.interiors]:
            coords = list(ring.coords)
            for start, end in zip(coords, coords[1:]):
                length = math.dist(start, end)
                if not (tolerances.minWallThickness <= length <= tolerances.maxWallThickness):
                    continue
                mid = ((start[0] + end[0]) / 2, (start[1] + end[1]) / 2)
                nx, ny = (end[1] - start[1]) / length, -(end[0] - start[0]) / length
                probe = 1e-3
                if polygon.contains(Point(mid[0] + nx * probe, mid[1] + ny * probe)):
                    nx, ny = -nx, -ny
                caps.append(_Cap(start, end, mid, (nx, ny), length))
    return caps


def _gap(polygon: Polygon, width: float, depth: float, center, normal, source: str) -> dict:
    return {"polygon": polygon, "width": width, "depth": depth, "center": center, "angle": math.atan2(normal[1], normal[0]), "source": source}


def _gaps(solid, tolerances: Tolerances) -> list[dict]:
    """Candidate wall gaps, nearest first. Each cap closes at most one gap.

    cap-to-cap : two facing wall ends (door/window in the run of a wall)
    cap-to-face: a wall end facing the side of another wall (door at a room corner)
    """
    caps = _caps(solid, tolerances)
    candidates = []
    min_facing = math.cos(math.radians(max(tolerances.angularToleranceDeg, 1.0) * 2))
    for i, a in enumerate(caps):
        for j in range(i + 1, len(caps)):
            b = caps[j]
            dx, dy = b.mid[0] - a.mid[0], b.mid[1] - a.mid[1]
            along = dx * a.normal[0] + dy * a.normal[1]
            if not (tolerances.minOpeningWidth <= along <= tolerances.maxOpeningWidth):
                continue
            if -(a.normal[0] * b.normal[0] + a.normal[1] * b.normal[1]) < min_facing:
                continue
            lateral = abs(dx * -a.normal[1] + dy * a.normal[0])
            if lateral > tolerances.openingLateralTolerance or abs(a.length - b.length) > 0.15 * max(a.length, b.length) + 0.01:
                continue
            rectangle = Polygon([a.start, a.end, b.start, b.end]).convex_hull
            expected = along * (a.length + b.length) / 2
            if abs(rectangle.area - expected) > 0.1 * expected or rectangle.intersection(solid).area > 0.05 * rectangle.area:
                continue
            candidates.append((along, i, j, _gap(rectangle, along, (a.length + b.length) / 2, ((a.mid[0] + b.mid[0]) / 2, (a.mid[1] + b.mid[1]) / 2), a.normal, "cap-to-cap")))

    for i, a in enumerate(caps):
        # Cast three rays from the cap; a flat wall face straight ahead is hit at the same distance by all of them.
        hits = []
        for t in (0.1, 0.5, 0.9):
            origin = (a.start[0] + (a.end[0] - a.start[0]) * t + a.normal[0] * 1e-3, a.start[1] + (a.end[1] - a.start[1]) * t + a.normal[1] * 1e-3)
            ray = LineString([origin, (origin[0] + a.normal[0] * tolerances.maxOpeningWidth, origin[1] + a.normal[1] * tolerances.maxOpeningWidth)])
            hit = ray.intersection(solid)
            hits.append(None if hit.is_empty else Point(origin).distance(hit))
        if any(hit is None for hit in hits) or max(hits) - min(hits) > tolerances.openingLateralTolerance:
            continue
        along = sum(hits) / 3 + 1e-3  # rays start 1 mm in front of the cap
        if along < tolerances.minOpeningWidth:
            continue
        far_start = (a.start[0] + a.normal[0] * along, a.start[1] + a.normal[1] * along)
        far_end = (a.end[0] + a.normal[0] * along, a.end[1] + a.normal[1] * along)
        rectangle = Polygon([a.start, a.end, far_end, far_start])
        if rectangle.intersection(solid).area > 0.05 * rectangle.area:
            continue
        center = (a.mid[0] + a.normal[0] * along / 2, a.mid[1] + a.normal[1] * along / 2)
        candidates.append((along, i, -1, _gap(rectangle, along, a.length, center, a.normal, "cap-to-face")))

    used: set[int] = set()
    gaps = []
    # Nearest first; on equal distance a cap-to-cap pair outranks a cap-to-face hit.
    for along, i, j, gap in sorted(candidates, key=lambda item: (round(item[0], 2), item[2] < 0)):
        if i in used or j in used:
            continue
        used.add(i)
        if j >= 0:
            used.add(j)
        gaps.append(gap)
    return gaps


def _door_symbols(entities: list[NormalizedEntity], blocks: list[BlockReference], tolerances: Tolerances) -> list[dict]:
    symbols = []
    for entity in entities:
        if entity.role != "door" or not entity.arc:
            continue
        sweep = (entity.arc["endAngle"] - entity.arc["startAngle"]) % 360
        if 30 <= sweep <= 150 and tolerances.minDoorWidth * 0.8 <= entity.arc["radius"] <= tolerances.maxDoorWidth:
            symbols.append({"point": entity.arc["center"], "radius": entity.arc["radius"], "arc": entity.arc, "layer": entity.layer, "source": "swing arc"})
    for block in blocks:
        if block.role == "door" and block.bounds:
            width = max(block.bounds[2] - block.bounds[0], block.bounds[3] - block.bounds[1])
            center = ((block.bounds[0] + block.bounds[2]) / 2, (block.bounds[1] + block.bounds[3]) / 2)
            symbols.append({"point": center, "radius": width, "arc": None, "layer": block.layer, "source": f"block {block.name}", "rotation": block.rotation})
    return symbols


def _parallel_span_lines(gap: dict, entities: list[NormalizedEntity], tree: STRtree, lines: list[LineString], owners: list[NormalizedEntity]) -> tuple[int, set[str]]:
    """Counts non-wall segments that cross the gap parallel to the wall - the classic window symbol."""
    ux, uy = math.cos(gap["angle"]), math.sin(gap["angle"])
    zone = gap["polygon"].buffer(0.02)
    count, layers = 0, set()
    for index in tree.query(zone):
        line = lines[int(index)]
        (x0, y0), (x1, y1) = line.coords[0], line.coords[-1]
        length = math.hypot(x1 - x0, y1 - y0)
        if length == 0 or abs(((x1 - x0) * uy - (y1 - y0) * ux) / length) > 0.05:
            continue
        inside = line.intersection(zone).length
        if inside >= 0.6 * gap["width"]:
            count += 1
            layers.add(owners[int(index)].layer)
    return count, layers


def detect_openings(solid, entities: list[NormalizedEntity], blocks: list[BlockReference], tolerances: Tolerances, default_thickness: float) -> tuple[list[Opening], list[str]]:
    warnings: list[str] = []
    if solid is None:
        return [], warnings
    gaps = _gaps(solid, tolerances)
    doors = _door_symbols(entities, blocks, tolerances)

    segment_lines, owners = [], []
    for entity in entities:
        if entity.role in {"wall", "door"} or entity.text is not None or entity.arc or entity.closed:
            continue
        for start, end in zip(entity.points, entity.points[1:]):
            if math.dist(start, end) >= tolerances.minOpeningWidth * 0.5:
                segment_lines.append(LineString([start, end]))
                owners.append(entity)
    tree = STRtree(segment_lines) if segment_lines else None

    window_blocks = [block for block in blocks if block.role == "window" and block.bounds]
    results: list[tuple[str, dict, str, set[str]]] = []
    used_doors: set[int] = set()
    rejected = 0
    for gap in gaps:
        reach = gap["polygon"].buffer(tolerances.openingMatchDistance)
        door_hits = [index for index, door in enumerate(doors) if index not in used_doors and reach.contains(Point(door["point"])) and door["radius"] <= gap["width"] * 1.35 + 0.1]
        if door_hits and gap["width"] <= tolerances.maxDoorWidth * 2:
            # Double doors contribute two swing arcs to the same gap.
            used_doors.update(door_hits)
            results.append(("door", gap, doors[door_hits[0]]["source"], {doors[i]["layer"] for i in door_hits}))
            continue
        layers: set[str] = set()
        evidence = ""
        if tree is not None:
            spanning, span_layers = _parallel_span_lines(gap, entities, tree, segment_lines, owners)
            window_layer_hit = any(owners[int(i)].role == "window" and segment_lines[int(i)].intersects(gap["polygon"].buffer(0.02)) for i in tree.query(gap["polygon"].buffer(0.02)))
            if window_layer_hit:
                evidence, layers = "window layer geometry in wall gap", span_layers or {"window"}
            elif spanning >= 2:
                evidence, layers = f"{spanning} lines spanning wall gap (geometric rule)", span_layers
        if not evidence and any(gap["polygon"].buffer(tolerances.openingMatchDistance).intersects(box(*block.bounds)) for block in window_blocks):
            evidence = "window block at wall gap"
        if not evidence:
            # A wide gap, or a wall end that merely faces another wall across a room, is not an opening without proof.
            limit = tolerances.maxDoorWidth if gap["source"] == "cap-to-face" else tolerances.maxUnverifiedOpeningWidth
            if gap["width"] > limit:
                # Only a true gap in a wall run is worth reporting; a wall end facing a far wall is just a wall end.
                rejected += int(gap["source"] == "cap-to-cap")
                continue
        results.append(("window" if evidence else "opening", gap, evidence or "wall gap without door/window symbol", layers))

    # Symbols that did not land on a gap: keep them, but never cut the wall for them.
    for index, door in enumerate(doors):
        if index in used_doors or Point(door["point"]).distance(solid) > tolerances.openingMatchDistance:
            continue
        width = door["radius"]
        if door["arc"]:
            ends = [(door["point"][0] + width * math.cos(math.radians(a)), door["point"][1] + width * math.sin(math.radians(a))) for a in (door["arc"]["startAngle"], door["arc"]["endAngle"])]
            # The closed leaf lies along the wall: pick the arc end that is closer to wall material.
            closed_end = min(ends, key=lambda p: Point(p).distance(solid))
            angle = math.atan2(closed_end[1] - door["point"][1], closed_end[0] - door["point"][0])
            center = ((door["point"][0] + closed_end[0]) / 2, (door["point"][1] + closed_end[1]) / 2)
        else:
            angle, center = math.radians(door.get("rotation", 0.0)), door["point"]
        footprint = LineString([(center[0] - math.cos(angle) * width / 2, center[1] - math.sin(angle) * width / 2), (center[0] + math.cos(angle) * width / 2, center[1] + math.sin(angle) * width / 2)]).buffer(default_thickness / 2, cap_style="flat")
        results.append(("door-visual", {"polygon": footprint, "width": width, "depth": default_thickness, "center": center, "angle": angle}, f"{door['source']} on intact wall", {door["layer"]}))

    for block in window_blocks:
        footprint = box(*block.bounds)
        if any(kind == "window" and gap["polygon"].buffer(tolerances.openingMatchDistance).intersects(footprint) for kind, gap, _, _ in results):
            continue
        if footprint.distance(solid) > tolerances.openingMatchDistance:
            continue
        width, depth = sorted([block.bounds[2] - block.bounds[0], block.bounds[3] - block.bounds[1]], reverse=True)
        angle = 0.0 if (block.bounds[2] - block.bounds[0]) >= (block.bounds[3] - block.bounds[1]) else math.pi / 2
        results.append(("window-visual", {"polygon": footprint, "width": width, "depth": max(depth, default_thickness), "center": (footprint.centroid.x, footprint.centroid.y), "angle": angle}, f"block {block.name} on intact wall", {block.layer}))

    openings: list[Opening] = []
    counters = {"door": 0, "window": 0, "opening": 0}
    for kind, gap, evidence, layers in results:
        base = kind.split("-")[0]
        counters[base] += 1
        openings.append(Opening(
            id=f"{base}-{counters[base]:03d}", kind=base, polygon=gap["polygon"], center=gap["center"], width=round(gap["width"], 4),
            depth=round(gap["depth"], 4), angle=gap["angle"], hostCut=not kind.endswith("-visual"), evidence=evidence, layers=sorted(layers),
        ))
    unmatched = len(doors) - len(used_doors) - sum(1 for kind, *_ in results if kind == "door-visual")
    if rejected:
        warnings.append(f"{rejected} wide wall gap(s) had no door/window evidence and were left open (not treated as openings).")
    if unmatched > 0:
        warnings.append(f"{unmatched} door symbol(s) were not near any detected wall and were ignored.")
    return openings, warnings
