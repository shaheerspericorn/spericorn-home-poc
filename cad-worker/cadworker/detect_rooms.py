"""Room detection: rooms are the enclosed voids of (walls + openings).

Closing every door/window gap with its opening footprint turns the wall network into a sealed
solid; each interior ring of that solid is a room candidate. Spaces that are not fully enclosed
by detected walls (open terraces, plans with missing wall lines) are NOT reported as rooms.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from shapely.geometry import Point, Polygon
from shapely.ops import unary_union

from .config import Tolerances
from .detect_walls import polygon_parts
from .normalize import NormalizedEntity

SEAL = 2e-3  # metres; fuses walls and openings that only touch along an edge


@dataclass
class Room:
    id: str
    name: str
    type: str  # living-room | bedroom | ... | unknown
    polygon: Polygon
    area: float
    center: tuple[float, float]
    labelSource: str  # "cad-text" | "generated" | "user"


def _normalise_label(text: str) -> str:
    stripped = "".join(ch for ch in unicodedata.normalize("NFKD", text) if not unicodedata.combining(ch))
    return stripped.upper()


def room_type(label: str, keywords: dict[str, list[str]]) -> str:
    normalised = _normalise_label(label)
    tokens = set(re.findall(r"[A-Z]+", normalised))
    for kind, words in keywords.items():
        for word in words:
            word = _normalise_label(word)
            if word in tokens or (len(word) >= 5 and word in normalised):
                return kind
    return "unknown"


def _is_label(text: str) -> bool:
    text = text.strip()
    if not (2 <= len(text) <= 40) or not re.search(r"[A-Za-zÀ-ÿ]{2,}", text):
        return False
    # Scale notes, section markers and dimensions are not room names.
    return not re.search(r"(?i)\b(esc|scale|escala)\b|\d+\s*[:=]\s*\d+|^\d+([.,]\d+)?\s*(m|mm|cm|m2|m²)?$", text)


def detect_rooms(solid, openings: list, entities: list[NormalizedEntity], tolerances: Tolerances, keywords: dict[str, list[str]], names: dict[str, str]) -> tuple[list[Room], Polygon | None, list[str]]:
    warnings: list[str] = []
    if solid is None:
        return [], None, warnings
    sealed = unary_union([solid.buffer(SEAL, join_style="mitre"), *[opening.polygon.buffer(SEAL, join_style="mitre") for opening in openings if opening.hostCut]])

    voids: list[Polygon] = []
    shells: list[Polygon] = []
    for part in polygon_parts(sealed):
        shells.append(Polygon(part.exterior))
        voids.extend(Polygon(ring) for ring in part.interiors)
    footprint = unary_union(shells) if shells else None
    footprint = max(polygon_parts(footprint), key=lambda p: p.area) if footprint is not None and not footprint.is_empty else None

    labels = [(entity, Point(entity.points[0])) for entity in entities if entity.text and entity.points and _is_label(entity.text)]
    # Labels on dedicated text layers outrank stray text (e.g. furniture attributes) inside the same room.
    labels.sort(key=lambda item: 0 if item[0].role == "roomLabel" else 1)

    rooms: list[Room] = []
    dropped = 0
    for polygon in sorted(voids, key=lambda p: (-round(p.centroid.y, 1), round(p.centroid.x, 1))):
        polygon = polygon.buffer(SEAL, join_style="mitre")  # undo the sealing offset
        if polygon.area < tolerances.minRoomArea:
            dropped += 1
            continue
        index = len(rooms) + 1
        room_id = f"room-{index:03d}"
        anchor = polygon.representative_point()
        label = next((entity.text for entity, point in labels if polygon.contains(point)), None)
        if room_id in names:
            name, source = names[room_id], "user"
        elif label:
            name, source = label.title() if label.isupper() else label, "cad-text"
        else:
            name, source = f"Room {index}", "generated"
        centroid = polygon.centroid
        center = centroid if polygon.contains(centroid) else anchor
        rooms.append(Room(room_id, name, room_type(name, keywords), polygon, round(polygon.area, 3), (center.x, center.y), source))

    if dropped:
        warnings.append(f"{dropped} enclosed void(s) smaller than {tolerances.minRoomArea} m² were ignored (shafts, wall cavities).")
    if not rooms:
        warnings.append("No enclosed rooms were found: the detected walls and openings do not form a closed boundary.")
    return rooms, footprint, warnings
