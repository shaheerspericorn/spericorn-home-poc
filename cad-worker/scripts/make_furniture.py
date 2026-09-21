"""Generates the three sample furniture GLBs used by the POC (frontend/public/furniture).

The assets are procedural boxes authored here, so there is no third-party model licence to track.
Convention (must match frontend/lib/furniture-catalog.ts):
  * metres, glTF Y-up, origin at the centre of the footprint ON THE FLOOR (min Y = 0)
  * width along X, depth along Z, front faces +Z
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import trimesh
from trimesh.visual.material import PBRMaterial


def part(name, size, center, color):
    """size = (x, y, z) extents, center = (x, y, z) of the box centre, in glTF axes."""
    mesh = trimesh.creation.box(extents=size)
    mesh.apply_translation(center)
    mesh.visual = trimesh.visual.TextureVisuals(material=PBRMaterial(name=name, baseColorFactor=[*color, 255], metallicFactor=0.0, roughnessFactor=0.9))
    return name, mesh


def legs(prefix, width, depth, height, inset, thickness, color):
    return [part(f"{prefix}_Leg_{i + 1}", (thickness, height, thickness), (sx * (width / 2 - inset), height / 2, sz * (depth / 2 - inset)), color)
            for i, (sx, sz) in enumerate([(-1, -1), (1, -1), (1, 1), (-1, 1)])]


def sofa():
    w, d, h = 2.2, 0.9, 0.8
    fabric, dark = (92, 110, 128), (60, 66, 74)
    return "Sofa", (w, d, h), [
        *legs("Sofa", w, d, 0.10, 0.08, 0.06, dark),
        part("Sofa_Base", (w, 0.30, d), (0, 0.25, 0), fabric),
        part("Sofa_Back", (w, 0.40, 0.20), (0, 0.60, -d / 2 + 0.10), fabric),
        part("Sofa_Arm_L", (0.18, 0.25, d - 0.20), (-w / 2 + 0.09, 0.525, 0.10), fabric),
        part("Sofa_Arm_R", (0.18, 0.25, d - 0.20), (w / 2 - 0.09, 0.525, 0.10), fabric),
        part("Sofa_Cushion_L", ((w - 0.40) / 2 - 0.01, 0.10, d - 0.24), (-(w - 0.40) / 4, 0.45, 0.10), (120, 138, 156)),
        part("Sofa_Cushion_R", ((w - 0.40) / 2 - 0.01, 0.10, d - 0.24), ((w - 0.40) / 4, 0.45, 0.10), (120, 138, 156)),
    ]


def bed():
    w, d, h = 1.6, 2.1, 1.0
    wood, linen = (120, 86, 58), (236, 232, 224)
    return "Bed", (w, d, h), [
        part("Bed_Frame", (w, 0.30, d), (0, 0.15, 0), wood),
        part("Bed_Headboard", (w, h, 0.08), (0, h / 2, -d / 2 + 0.04), wood),
        part("Bed_Mattress", (w - 0.08, 0.20, d - 0.16), (0, 0.40, 0.04), linen),
        part("Bed_Pillow_L", (0.60, 0.10, 0.38), (-0.36, 0.55, -d / 2 + 0.36), (250, 250, 250)),
        part("Bed_Pillow_R", (0.60, 0.10, 0.38), (0.36, 0.55, -d / 2 + 0.36), (250, 250, 250)),
        part("Bed_Blanket", (w - 0.06, 0.04, d * 0.55), (0, 0.52, d * 0.20), (150, 170, 160)),
    ]


def dining_table():
    w, d, h = 1.6, 0.9, 0.75
    wood = (150, 108, 70)
    return "DiningTable", (w, d, h), [
        part("DiningTable_Top", (w, 0.05, d), (0, h - 0.025, 0), wood),
        *legs("DiningTable", w, d, h - 0.05, 0.08, 0.07, (96, 68, 44)),
    ]


def main(out_dir: str) -> None:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    for file_name, builder in [("sofa.glb", sofa), ("bed.glb", bed), ("dining-table.glb", dining_table)]:
        root, (w, d, h), parts = builder()
        scene = trimesh.Scene(base_frame="world")
        scene.graph.update(frame_to=root, frame_from="world", matrix=np.eye(4))
        for name, mesh in parts:
            scene.add_geometry(mesh, node_name=name, geom_name=name, parent_node_name=root)
        low, high = scene.bounds
        assert abs(low[1]) < 1e-9 and np.allclose(high - low, (w, h, d), atol=1e-6), (file_name, low, high)
        (out / file_name).write_bytes(scene.export(file_type="glb"))
        print(f"{file_name}: {w} x {d} x {h} m (w x d x h), {(out / file_name).stat().st_size} bytes")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else str(Path(__file__).resolve().parents[2] / "frontend" / "public" / "furniture"))
