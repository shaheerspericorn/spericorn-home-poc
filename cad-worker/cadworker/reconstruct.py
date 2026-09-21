"""2D detection result -> structured 3D scene -> GLB.

COORDINATE CONTRACT (shared with the frontend, see docs/COORDINATES.md)

    CAD / analysis (local metres)      glTF / Three.js (metres, Y up)
    ------------------------------     ------------------------------
    x  (east)                     ->   +X
    y  (north)                    ->   -Z
    z  (up)                       ->   +Y

    (x, y) on the plan  ==  (x, 0, -y) in the 3D scene.  Finished floor level is Y = 0.

Geometry is built in CAD axes (Z up, extrusion along +Z) and converted once by CAD_TO_GLTF.
Every logical element is its own named node; nothing is merged into a single mesh.
"""
from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass

import numpy as np
import trimesh
from shapely.geometry import Polygon
from trimesh.visual.material import PBRMaterial

from . import errors
from .config import BuildDefaults
from .detect_walls import polygon_parts
from .errors import CadWorkerError

CAD_TO_GLTF = np.array([[1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0], [0, 0, 0, 1]], dtype=float)

ROOM_FINISH = 0.005  # room floor finish sits on the slab so each room stays an individually pickable mesh
LEAF_THICKNESS = 0.04
GLASS_THICKNESS = 0.03
VISUAL_PROUD = 0.02  # symbols on intact walls stand this far proud of each wall face so they are visible

COLORS = {
    "slab": (0.42, 0.43, 0.44, 1.0), "wall": (0.70, 0.68, 0.64, 1.0), "lintel": (0.64, 0.62, 0.58, 1.0),
    "door": (0.55, 0.36, 0.20, 1.0), "glass": (0.55, 0.78, 0.92, 0.45), "frame": (0.30, 0.32, 0.35, 1.0),
}
ROOM_PALETTE = [(0.62, 0.50, 0.36), (0.46, 0.58, 0.46), (0.46, 0.52, 0.68), (0.68, 0.48, 0.44), (0.58, 0.60, 0.42), (0.54, 0.46, 0.64)]


@dataclass
class BuildSummary:
    wallsGenerated: int
    floorsGenerated: int
    doorsGenerated: int
    windowsGenerated: int
    openingsGenerated: int
    nodeNames: list[str]
    triangleCount: int
    boundsM: dict


def node_safe(text: str) -> str:
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    words = re.findall(r"[A-Za-z0-9]+", ascii_text)
    return "".join(word[:1].upper() + word[1:] for word in words) or "Unnamed"


def to_gltf_point(x: float, y: float, z: float = 0.0) -> dict:
    """The one place a plan coordinate becomes a scene coordinate for JSON consumers."""
    return {"x": round(x, 4), "y": round(z, 4), "z": round(-y, 4) + 0.0}


def _material(name: str, rgba) -> PBRMaterial:
    return PBRMaterial(name=name, baseColorFactor=[int(c * 255) for c in rgba], metallicFactor=0.0, roughnessFactor=0.85 if rgba[3] == 1.0 else 0.1, alphaMode="BLEND" if rgba[3] < 1.0 else "OPAQUE", doubleSided=rgba[3] < 1.0)


def _extrude(polygon: Polygon, z0: float, z1: float, material: PBRMaterial) -> trimesh.Trimesh | None:
    if z1 - z0 <= 1e-6 or polygon.is_empty or polygon.area <= 1e-8:
        return None
    try:
        mesh = trimesh.creation.extrude_polygon(polygon, height=z1 - z0, engine="earcut")
    except Exception as error:  # noqa: BLE001 - triangulation of a degenerate polygon
        raise CadWorkerError(errors.INVALID_GEOMETRY, f"A polygon could not be triangulated for extrusion: {error}") from error
    mesh.apply_translation([0, 0, z0])
    mesh.apply_transform(CAD_TO_GLTF)
    mesh.visual = trimesh.visual.TextureVisuals(material=material)
    return mesh


def _oriented_rect(center, angle: float, length: float, depth: float) -> Polygon:
    ux, uy = math.cos(angle), math.sin(angle)
    hx, hy = ux * length / 2, uy * length / 2
    dx, dy = -uy * depth / 2, ux * depth / 2
    cx, cy = center
    return Polygon([(cx - hx - dx, cy - hy - dy), (cx + hx - dx, cy + hy - dy), (cx + hx + dx, cy + hy + dy), (cx - hx + dx, cy - hy + dy)])


class _SceneBuilder:
    def __init__(self):
        # trimesh does not export its base frame as a node, so "Villa" is an explicit child of it.
        self.scene = trimesh.Scene(base_frame="world")
        self.names: list[str] = []
        self.scene.graph.update(frame_to="Villa", frame_from="world", matrix=np.eye(4))
        self.triangles = 0

    def group(self, name: str, parent: str = "Villa", extras: dict | None = None) -> str:
        self.scene.graph.update(frame_to=name, frame_from=parent, matrix=np.eye(4), metadata=extras or {})
        self.names.append(name)
        return name

    def mesh(self, name: str, parent: str, mesh: trimesh.Trimesh | None, extras: dict | None = None) -> bool:
        if mesh is None:
            return False
        mesh.metadata.update(extras or {})
        self.scene.add_geometry(mesh, node_name=name, geom_name=name, parent_node_name=parent, metadata=extras or {})
        self.names.append(name)
        self.triangles += len(mesh.faces)
        return True


def build_scene(walls, openings, rooms, footprint, build: BuildDefaults) -> tuple[trimesh.Scene, BuildSummary, dict[str, str]]:
    """Returns the scene, a summary, and {elementId: nodeName} so the frontend can address nodes."""
    builder = _SceneBuilder()
    materials = {key: _material(key.title(), rgba) for key, rgba in COLORS.items()}
    height = build.wallHeight
    door_head = min(build.doorHeight, height)
    sill, window_head = min(build.windowSillHeight, height), min(build.windowHeadHeight, height)
    node_of: dict[str, str] = {}

    # Floor slab under the whole footprint; its top is just below finished floor level.
    floors = 0
    slab_parts = polygon_parts(footprint)
    for index, part in enumerate(slab_parts, start=1):
        name = "Villa_Floor" if len(slab_parts) == 1 else f"Villa_Floor_{index:02d}"
        floors += int(builder.mesh(name, "Villa", _extrude(part, -build.floorThickness, -ROOM_FINISH, materials["slab"]), {"kind": "floor"}))

    builder.group("Rooms")
    # Room_LivingRoom when the name is unique, Room_Bedroom_01 / _02 when it repeats.
    bases = [f"Room_{index:02d}" if room.labelSource == "generated" else f"Room_{node_safe(room.name)}" for index, room in enumerate(rooms, start=1)]
    seen: dict[str, int] = {}
    for index, (room, base) in enumerate(zip(rooms, bases)):
        seen[base] = seen.get(base, 0) + 1
        name = base if bases.count(base) == 1 else f"{base}_{seen[base]:02d}"
        color = (*ROOM_PALETTE[index % len(ROOM_PALETTE)], 1.0)
        if builder.mesh(name, "Rooms", _extrude(room.polygon, -ROOM_FINISH, 0.0, _material(name, color)), {"kind": "room", "roomId": room.id, "roomName": room.name, "roomType": room.type, "areaM2": room.area}):
            node_of[room.id] = name
            floors += 1

    builder.group("Walls")
    wall_count = 0
    for index, wall in enumerate(walls, start=1):
        name = f"Wall_{index:03d}"
        if builder.mesh(name, "Walls", _extrude(wall.polygon, 0.0, height, materials["wall"]), {"kind": "wall", "wallId": wall.id, "thicknessM": wall.thickness, "heightM": height, "layer": wall.layer}):
            node_of[wall.id] = name
            wall_count += 1

    builder.group("Doors")
    builder.group("Windows")
    builder.group("Openings")
    counts = {"door": 0, "window": 0, "opening": 0}
    for opening in openings:
        counts[opening.kind] += 1
        number = counts[opening.kind]
        extras = {"kind": opening.kind, "elementId": opening.id, "widthM": opening.width, "hostCut": opening.hostCut, "evidence": opening.evidence}
        depth = opening.depth if opening.hostCut else opening.depth + 2 * VISUAL_PROUD
        if opening.kind == "door":
            name = builder.group(f"Door_{number:03d}", "Doors", extras)
            builder.mesh(f"{name}_Leaf", name, _extrude(_oriented_rect(opening.center, opening.angle, opening.width * 0.98, LEAF_THICKNESS if opening.hostCut else depth), 0.0, door_head, materials["door"]), extras)
            if opening.hostCut:
                builder.mesh(f"{name}_Lintel", name, _extrude(opening.polygon, door_head, height, materials["lintel"]), extras)
        elif opening.kind == "window":
            name = builder.group(f"Window_{number:03d}", "Windows", extras)
            builder.mesh(f"{name}_Glass", name, _extrude(_oriented_rect(opening.center, opening.angle, opening.width, GLASS_THICKNESS if opening.hostCut else depth), sill, window_head, materials["glass"]), extras)
            if opening.hostCut:
                builder.mesh(f"{name}_Sill", name, _extrude(opening.polygon, 0.0, sill, materials["wall"]), extras)
                builder.mesh(f"{name}_Lintel", name, _extrude(opening.polygon, window_head, height, materials["lintel"]), extras)
        else:
            name = builder.group(f"Opening_{number:03d}", "Openings", extras)
            builder.mesh(f"{name}_Lintel", name, _extrude(opening.polygon, door_head, height, materials["lintel"]), extras)
        node_of[opening.id] = name

    if wall_count == 0:
        raise CadWorkerError(errors.NO_WALLS, errors.NO_WALLS_MESSAGE)

    bounds = builder.scene.bounds
    summary = BuildSummary(
        wallsGenerated=wall_count, floorsGenerated=floors, doorsGenerated=counts["door"], windowsGenerated=counts["window"],
        openingsGenerated=counts["opening"], nodeNames=builder.names, triangleCount=builder.triangles,
        boundsM={"min": [round(float(v), 4) for v in bounds[0]], "max": [round(float(v), 4) for v in bounds[1]]},
    )
    return builder.scene, summary, node_of


def export_glb(scene: trimesh.Scene, output_path: str) -> int:
    try:
        data = scene.export(file_type="glb")
        if not isinstance(data, (bytes, bytearray)) or data[:4] != b"glTF":
            raise ValueError("exporter returned a non-GLB payload")
        with open(output_path, "wb") as handle:
            handle.write(data)
        return len(data)
    except CadWorkerError:
        raise
    except Exception as error:  # noqa: BLE001
        raise CadWorkerError(errors.GLB_EXPORT_FAILED, f"The 3D scene could not be exported as GLB: {error}") from error
