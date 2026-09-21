"""Wall detection. Input: wall-role entities in local metres. Output: non-overlapping wall polygons.

Strategies run in a fixed order and each one only adds area the previous ones did not explain:

  1. closed polylines / hatch boundaries on wall layers        -> polygon as drawn
  2. pairs of approximately parallel wall lines                 -> rectangle over their overlap
  3. wall-line network (snap, extend, node, polygonize)         -> thin faces are wall bodies

Strategy 3 is attempted on the full line network even when 1 and 2 found walls, because it is the
only one that understands corners and junctions; pieces already covered are discarded.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from shapely import STRtree
from shapely.geometry import LineString, MultiPolygon, Polygon
from shapely.ops import polygonize, unary_union
from shapely.validation import make_valid

from .config import Tolerances
from .normalize import NormalizedEntity

COVERED_RATIO = 0.80  # a candidate is redundant when this much of it is already wall


@dataclass
class Wall:
    id: str
    polygon: Polygon
    strategy: str  # closed-polyline | parallel-pair | line-network
    layer: str
    thickness: float
    sourceEntities: list[str] = field(default_factory=list)


@dataclass
class WallDetection:
    walls: list[Wall]
    solid: Polygon | MultiPolygon | None
    strategyCounts: dict[str, int]
    segmentCount: int
    invalidPolygonsRepaired: int
    warnings: list[str]


def polygon_parts(geometry) -> list[Polygon]:
    if geometry is None or geometry.is_empty:
        return []
    if isinstance(geometry, Polygon):
        return [geometry]
    return [part for part in getattr(geometry, "geoms", []) for part in polygon_parts(part)]


def clean_polygon(polygon: Polygon) -> tuple[list[Polygon], bool]:
    """Self-intersecting input is repaired with make_valid (never silently dropped)."""
    if polygon.is_valid:
        return [polygon], False
    return [part for part in polygon_parts(make_valid(polygon)) if part.area > 0], True


def measured_thickness(polygon: Polygon) -> float:
    """Width of a long thin shape: exact for rectangles, a good estimate for L/T shaped wall bodies."""
    perimeter = polygon.length
    if perimeter <= 0:
        return 0.0
    # Solve area = t * L and perimeter = 2 * (t + L) for the smaller root t.
    half = perimeter / 2
    discriminant = half * half - 4 * polygon.area
    if discriminant < 0:
        return math.sqrt(polygon.area)
    return (half - math.sqrt(discriminant)) / 2


def is_thin(polygon: Polygon, max_thickness: float) -> bool:
    """True when no circle wider than max_thickness fits inside, i.e. the face is a wall body, not a room."""
    return polygon.buffer(-(max_thickness / 2 + 1e-6)).is_empty


def _segments(entities: list[NormalizedEntity], tolerances: Tolerances) -> list[tuple[tuple[float, float], tuple[float, float], NormalizedEntity]]:
    result = []
    for entity in entities:
        if entity.text is not None or len(entity.points) < 2:
            continue
        points = entity.points + ([entity.points[0]] if entity.closed and entity.points[0] != entity.points[-1] else [])
        for start, end in zip(points, points[1:]):
            if math.dist(start, end) >= tolerances.minWallSegmentLength:
                result.append((start, end, entity))
    return result


def _snap_endpoints(segments, tolerance: float):
    """Cluster endpoints closer than `tolerance` onto one representative so faces close exactly."""
    from shapely.geometry import Point

    points = [p for start, end, _ in segments for p in (start, end)]
    if not points:
        return segments
    tree = STRtree([Point(p) for p in points])
    parent = list(range(len(points)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for index, point in enumerate(points):
        for other in tree.query(Point(point).buffer(tolerance)):
            if other != index and math.dist(point, points[other]) <= tolerance:
                parent[find(index)] = find(int(other))
    snapped = [points[find(i)] for i in range(len(points))]
    return [(snapped[2 * i], snapped[2 * i + 1], entity) for i, (_, _, entity) in enumerate(segments) if snapped[2 * i] != snapped[2 * i + 1]]


def _closed_polyline_walls(entities: list[NormalizedEntity], tolerances: Tolerances):
    polygons, repaired = [], 0
    for entity in entities:
        if not entity.closed or len(entity.points) < 3 or entity.text is not None:
            continue
        parts, was_invalid = clean_polygon(Polygon(entity.points))
        repaired += int(was_invalid)
        for part in parts:
            # A closed loop on a wall layer is a wall body only if it is thin; a large loop is a room/building outline.
            if part.area > tolerances.minWallThickness ** 2 and is_thin(part, tolerances.maxWallThickness):
                polygons.append((part, entity))
    return polygons, repaired


def _parallel_pair_walls(segments, tolerances: Tolerances):
    lines = [LineString([start, end]) for start, end, _ in segments]
    if not lines:
        return []
    tree = STRtree(lines)
    max_angle = math.radians(tolerances.angularToleranceDeg)
    rectangles = []
    for i, (a_start, a_end, entity) in enumerate(segments):
        ax, ay = a_end[0] - a_start[0], a_end[1] - a_start[1]
        a_len = math.hypot(ax, ay)
        ux, uy = ax / a_len, ay / a_len
        for j in tree.query(lines[i].buffer(tolerances.maxWallThickness)):
            j = int(j)
            if j <= i:
                continue
            b_start, b_end, _ = segments[j]
            bx, by = b_end[0] - b_start[0], b_end[1] - b_start[1]
            b_len = math.hypot(bx, by)
            sine = abs(ux * by - uy * bx) / b_len
            if sine > math.sin(max_angle):
                continue
            # Signed perpendicular offset of B from A, and the overlap of both segments projected on A.
            offset = (b_start[0] - a_start[0]) * -uy + (b_start[1] - a_start[1]) * ux
            distance = abs(offset)
            if not (tolerances.minWallThickness <= distance <= tolerances.maxWallThickness):
                continue
            t0 = (b_start[0] - a_start[0]) * ux + (b_start[1] - a_start[1]) * uy
            t1 = (b_end[0] - a_start[0]) * ux + (b_end[1] - a_start[1]) * uy
            low, high = max(0.0, min(t0, t1)), min(a_len, max(t0, t1))
            overlap = high - low
            # overlap >= distance rejects the two end caps of a doorway, which are parallel but not a wall.
            if overlap < max(tolerances.minParallelOverlap, distance):
                continue
            p0 = (a_start[0] + ux * low, a_start[1] + uy * low)
            p1 = (a_start[0] + ux * high, a_start[1] + uy * high)
            nx, ny = -uy * offset, ux * offset
            rectangles.append((Polygon([p0, p1, (p1[0] + nx, p1[1] + ny), (p0[0] + nx, p0[1] + ny)]), entity))
    return rectangles


def _network_walls(segments, tolerances: Tolerances):
    extension = tolerances.gapTolerance
    lines = []
    for start, end, _ in segments:
        length = math.dist(start, end)
        ux, uy = (end[0] - start[0]) / length, (end[1] - start[1]) / length
        # Overshooting both ends closes small drafting gaps; the leftover dangles are ignored by polygonize.
        lines.append(LineString([(start[0] - ux * extension, start[1] - uy * extension), (end[0] + ux * extension, end[1] + uy * extension)]))
    if not lines:
        return []
    faces = polygonize(unary_union(lines))
    minimum_area = tolerances.minWallThickness ** 2
    return [face for face in faces if face.area >= minimum_area and is_thin(face, tolerances.maxWallThickness)]


def detect_walls(entities: list[NormalizedEntity], tolerances: Tolerances) -> WallDetection:
    warnings: list[str] = []
    layer_of = entities[0].layer if entities else ""
    accepted: list[tuple[Polygon, str, NormalizedEntity | None]] = []
    solid = None

    def add(polygon: Polygon, strategy: str, entity: NormalizedEntity | None) -> bool:
        nonlocal solid
        if solid is not None and polygon.intersection(solid).area >= COVERED_RATIO * polygon.area:
            return False
        remainder = polygon if solid is None else polygon.difference(solid)
        added = False
        for part in polygon_parts(remainder):
            if part.area >= tolerances.minWallThickness ** 2:
                accepted.append((part, strategy, entity))
                added = True
        if added:
            solid = polygon if solid is None else unary_union([solid, polygon])
        return added

    counts = {"closed-polyline": 0, "parallel-pair": 0, "line-network": 0}
    closed, repaired = _closed_polyline_walls(entities, tolerances)
    for polygon, entity in closed:
        counts["closed-polyline"] += int(add(polygon, "closed-polyline", entity))

    # Closed loops take part in the network too: a large loop on a wall layer is usually one face of a wall.
    linear = [entity for entity in entities if entity.type != "CIRCLE"]
    segments = _snap_endpoints(_segments(linear, tolerances), tolerances.endpointTolerance)

    # The network strategy is evaluated before pairs are committed so that corner-aware faces win over
    # plain rectangles, but pairs are still reported as strategy 2 for whatever the network misses.
    network = _network_walls(segments, tolerances)
    network_solid = unary_union(network) if network else None
    for polygon, entity in _parallel_pair_walls(segments, tolerances):
        if network_solid is not None and polygon.intersection(network_solid).area >= COVERED_RATIO * polygon.area:
            continue
        counts["parallel-pair"] += int(add(polygon, "parallel-pair", entity))
    for face in network:
        counts["line-network"] += int(add(face, "line-network", None))

    if repaired:
        warnings.append(f"{repaired} self-intersecting wall polygon(s) were repaired with make_valid.")

    walls = []
    for index, (polygon, strategy, entity) in enumerate(accepted, start=1):
        walls.append(Wall(
            id=f"wall-{index:03d}", polygon=polygon, strategy=strategy, layer=entity.layer if entity else layer_of,
            thickness=round(measured_thickness(polygon), 4), sourceEntities=[entity.id] if entity else [],
        ))
    return WallDetection(walls, solid, counts, len(segments), repaired, warnings)
