import json
import struct

import pytest
import trimesh
from conftest import build_plan, wall_lines

import ezdxf
from cadworker import errors
from cadworker.__main__ import main
from cadworker.config import load_config
from cadworker.errors import CadWorkerError
from cadworker.pipeline import analyze, generate


def gltf_json(path):
    data = open(path, "rb").read()
    assert data[:4] == b"glTF" and struct.unpack("<I", data[4:8])[0] == 2
    length = struct.unpack("<I", data[12:16])[0]
    return json.loads(data[20:20 + length])


@pytest.fixture
def generated(tmp_path):
    plan = build_plan(tmp_path / "plan.dxf", offset=(125483.22, 98221.55))
    config = load_config({"build": {"wallHeight": 2.8}})
    work, glb = tmp_path / "work", tmp_path / "out" / "model.glb"
    stages = []
    analyze(str(plan), str(work), config, lambda stage, pct: stages.append(stage))
    report = generate(str(work), str(glb), config, lambda stage, pct: stages.append(stage))
    return report, glb, stages


def test_valid_glb_with_expected_nodes(generated):
    report, glb, stages = generated
    assert glb.is_file() and glb.stat().st_size == report["model3d"]["glbBytes"] > 1000
    names = {node.get("name") for node in gltf_json(glb)["nodes"]}
    assert {"Villa", "Villa_Floor", "Walls", "Wall_001", "Rooms", "Room_LivingRoom", "Doors", "Door_001", "Door_001_Leaf", "Door_001_Lintel",
            "Windows", "Window_001", "Window_001_Glass", "Window_001_Sill", "Window_001_Lintel"} <= names
    assert stages == ["converting_dwg", "parsing_dxf", "detecting_geometry", "generating_3d", "generating_3d", "exporting_glb"]


def test_scene_is_not_one_merged_mesh_and_carries_metadata(generated):
    report, glb, _ = generated
    document = gltf_json(glb)
    assert len(document["meshes"]) >= report["model3d"]["wallsGenerated"] + 2
    room = next(node for node in document["nodes"] if node.get("name") == "Room_LivingRoom")
    assert room["extras"]["roomId"] == "room-001" and room["extras"]["kind"] == "room"
    assert report["rooms"][0]["node"] == "Room_LivingRoom"


def test_wall_extrusion_floor_and_axes(generated):
    report, glb, _ = generated
    scene = trimesh.load(glb)
    low, high = scene.bounds
    # Y is up: walls rise from finished floor (0) to the configured height; slab hangs below.
    assert high[1] == pytest.approx(2.8, abs=1e-6) and low[1] == pytest.approx(-0.15, abs=1e-6)
    # Centred near the origin despite six-digit CAD coordinates; footprint 6.4 x 4.4 m.
    assert abs(low[0] + high[0]) < 0.01 and abs(low[2] + high[2]) < 0.01
    assert (high[0] - low[0], high[2] - low[2]) == pytest.approx((6.4, 4.4), abs=0.01)
    floor = scene.geometry["Room_LivingRoom"]
    assert floor.bounds[1][1] == pytest.approx(0.0, abs=1e-6)  # furniture stands on Y = 0


def test_plan_to_scene_mapping_is_x_0_minus_y(generated):
    report, _, _ = generated
    room = report["rooms"][0]
    assert room["center3d"] == {"x": room["center"][0], "y": 0.0, "z": -room["center"][1]}
    door = report["doors"][0]
    assert door["center"][1] < 0 < door["center3d"]["z"]  # south wall (negative y) is at positive z


def test_timings_and_sizes_are_reported(generated):
    report, _, _ = generated
    assert {"dwgToDxfMs", "dxfParsingMs", "geometryDetectionMs", "generation3dMs", "glbExportMs"} <= set(report["timings"])
    assert report["source"]["sizeBytes"] > 0 and report["dxf"]["sizeBytes"] > 0


def test_no_walls_fails_generation_but_keeps_diagnostics(tmp_path):
    doc = ezdxf.new("R2018"); wall_lines(doc.modelspace(), 0, 0, 5000, 200, layer="LAYER-17")
    path = tmp_path / "unknown.dxf"; doc.saveas(path)
    config = load_config()
    report = analyze(str(path), str(tmp_path / "w"), config, lambda *_: None)
    assert report["status"] == "no_walls" and report["layers"] and report["entities"]["LINE"] == 4
    with pytest.raises(CadWorkerError) as caught:
        generate(str(tmp_path / "w"), str(tmp_path / "m.glb"), config, lambda *_: None)
    assert caught.value.code == errors.NO_WALLS and not (tmp_path / "m.glb").exists()
    # The developer assigns the layer manually and the same drawing now converts.
    fixed = load_config({"layerRoles": {"LAYER-17": "wall"}})
    assert generate(str(tmp_path / "w"), str(tmp_path / "m.glb"), fixed, lambda *_: None)["model3d"]["wallsGenerated"] == 1


def test_cli_protocol(tmp_path, capsys):
    plan = build_plan(tmp_path / "plan.dxf")
    assert main(["analyze", "--input", str(plan), "--workdir", str(tmp_path / "w")]) == 0
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert lines[0] == {"event": "progress", "stage": "converting_dwg", "progress": 15} and lines[-1]["event"] == "result"
    assert main(["analyze", "--input", str(tmp_path / "x.ifc"), "--workdir", str(tmp_path / "w2")]) == 2
    assert json.loads(capsys.readouterr().out.splitlines()[-1])["code"] == errors.INPUT_NOT_FOUND
