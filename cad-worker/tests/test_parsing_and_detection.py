import ezdxf
import pytest
from conftest import build_plan, rect, wall_lines

from cadworker import errors
from cadworker.config import load_config
from cadworker.detect_openings import detect_openings
from cadworker.detect_rooms import detect_rooms, room_type
from cadworker.detect_walls import detect_walls
from cadworker.errors import CadWorkerError
from cadworker.normalize import classify, normalize_dxf
from cadworker.units import decide_units


def run(path, config):
    document, inventory = normalize_dxf(path, config)
    walls = detect_walls(document.by_role("wall"), config.tolerances)
    openings, _ = detect_openings(walls.solid, document.entities, document.blockReferences, config.tolerances, config.build.wallThickness)
    rooms, footprint, _ = detect_rooms(walls.solid, openings, document.entities, config.tolerances, config.roomTypeKeywords, {})
    return document, inventory, walls, openings, rooms, footprint


# --- layers ---------------------------------------------------------------------------------
@pytest.mark.parametrize("layer,role", [("A-WALL", "wall"), ("Muro1", "wall"), ("arch_walls_ext", "wall"), ("Puertas", "door"), ("A-DOOR-SWING", "door"),
                                        ("WINDOW", "window"), ("vent. adela", "window"), ("A-FURN", "furniture"), ("DEFPOINTS", "ignore"), ("0", "other")])
def test_layer_patterns(config, layer, role):
    assert classify(layer, config.layerPatterns) == role


def test_layer_role_override_wins():
    config = load_config({"layerRoles": {"XYZ-7": "wall", "A-WALL": "ignore"}})
    assert classify("XYZ-7", config.layerPatterns, config.layerRoles) == "wall"
    assert classify("A-WALL", config.layerPatterns, config.layerRoles) == "ignore"


# --- units ----------------------------------------------------------------------------------
@pytest.mark.parametrize("code,scale,expected", [(4, 1000.0, "millimeters"), (5, 100.0, "centimeters"), (6, 1.0, "meters"), (1, 39.3701, "inches"), (2, 3.28084, "feet")])
def test_declared_units_are_honoured(tmp_path, config, code, scale, expected):
    document, *_ = run(str(build_plan(tmp_path / "p.dxf", units=code, scale=scale)), config)
    assert (document.units.used, document.units.source) == (expected, "header")
    width = document.modelExtents["max"][0] - document.modelExtents["min"][0]
    assert width == pytest.approx(6.4, abs=0.05)  # always metres internally


def test_wrong_header_units_are_inferred_and_reported(tmp_path, config):
    document, *_ = run(str(build_plan(tmp_path / "p.dxf", units=4, scale=1.0)), config)  # drawn in metres, header says mm
    assert (document.units.declared, document.units.used, document.units.source) == ("millimeters", "meters", "inferred")
    assert any("implausible" in note for note in document.warnings)


def test_units_override_and_unsupported():
    assert decide_units(4, 1, 28.0, [], "ft").used == "feet"
    with pytest.raises(CadWorkerError) as caught:
        decide_units(19, 1, 28.0, [], None)
    assert caught.value.code == errors.UNSUPPORTED_UNITS


# --- coordinates ----------------------------------------------------------------------------
def test_large_coordinates_are_recentred(plan_mm, config):
    document, *_ = run(plan_mm, config)
    assert document.drawingExtents["min"][0] > 100000
    low, high = document.modelExtents["min"], document.modelExtents["max"]
    wall_points = [p for entity in document.by_role("wall") for p in entity.points]
    assert abs(min(p[0] for p in wall_points) + max(p[0] for p in wall_points)) < 1e-6
    assert max(abs(v) for v in (*low, *high)) < 60


# --- walls ----------------------------------------------------------------------------------
def test_line_network_walls_doors_windows_rooms(plan_mm, config):
    document, inventory, walls, openings, rooms, footprint = run(plan_mm, config)
    assert inventory["lineCount"] >= 24
    assert walls.strategyCounts["line-network"] >= 1 and walls.walls
    assert all(wall.thickness == pytest.approx(0.2, abs=0.01) for wall in walls.walls)
    kinds = sorted((o.kind, round(o.width, 2), o.hostCut) for o in openings)
    assert kinds == [("door", 0.9, True), ("window", 1.5, True)]
    assert len(rooms) == 1
    room = rooms[0]
    assert room.area == pytest.approx(24.0, abs=0.1)
    assert (room.name, room.type, room.labelSource) == ("Living Room", "living-room", "cad-text")
    assert footprint.area == pytest.approx(6.4 * 4.4, abs=0.1)


def test_closed_polyline_walls(tmp_path, config):
    doc = ezdxf.new("R2018"); doc.header["$INSUNITS"] = 6; msp = doc.modelspace()
    rect(msp, 0, 0, 5, 0.2, "WALL"); rect(msp, 0, 3.2, 5, 3.4, "WALL"); rect(msp, 0, 0.2, 0.2, 3.2, "WALL"); rect(msp, 4.8, 0.2, 5, 3.2, "WALL")
    path = tmp_path / "closed.dxf"; doc.saveas(path)
    _, _, walls, _, rooms, _ = run(str(path), config)
    assert walls.strategyCounts["closed-polyline"] == 4 and len(walls.walls) == 4
    assert len(rooms) == 1 and rooms[0].name == "Room 1" and rooms[0].labelSource == "generated"


def test_parallel_pair_walls_when_ends_are_not_closed(tmp_path, config):
    doc = ezdxf.new("R2018"); doc.header["$INSUNITS"] = 6; msp = doc.modelspace()
    msp.add_line((0, 0), (5, 0), dxfattribs={"layer": "WALL"}); msp.add_line((0, 0.25), (5, 0.25), dxfattribs={"layer": "WALL"})
    path = tmp_path / "pair.dxf"; doc.saveas(path)
    _, _, walls, *_ = run(str(path), config)
    assert walls.strategyCounts["parallel-pair"] == 1
    assert walls.walls[0].thickness == pytest.approx(0.25, abs=0.005) and walls.walls[0].polygon.area == pytest.approx(1.25, abs=0.01)


def test_self_intersecting_wall_polygon_is_repaired(tmp_path, config):
    doc = ezdxf.new("R2018"); doc.header["$INSUNITS"] = 6; msp = doc.modelspace()
    msp.add_lwpolyline([(0, 0), (4, 0.2), (4, 0), (0, 0.2)], close=True, dxfattribs={"layer": "WALL"})  # bow-tie
    path = tmp_path / "bowtie.dxf"; doc.saveas(path)
    _, _, walls, *_ = run(str(path), config)
    assert walls.invalidPolygonsRepaired == 1 and all(wall.polygon.is_valid for wall in walls.walls)


def test_small_gaps_are_closed_within_tolerance(tmp_path, config):
    doc = ezdxf.new("R2018"); doc.header["$INSUNITS"] = 6; msp = doc.modelspace()
    for start, end in [((0, 0), (5, 0)), ((5.004, 0.003), (5, 0.2)), ((5, 0.2), (0.03, 0.2)), ((0, 0.2), (0, 0))]:
        msp.add_line(start, end, dxfattribs={"layer": "WALL"})
    path = tmp_path / "gappy.dxf"; doc.saveas(path)
    _, _, walls, *_ = run(str(path), config)
    assert walls.strategyCounts["line-network"] == 1


def test_no_wall_layers_yields_no_walls_not_fake_geometry(tmp_path, config):
    doc = ezdxf.new("R2018"); msp = doc.modelspace()
    wall_lines(msp, 0, 0, 5000, 200, layer="LAYER-17")
    path = tmp_path / "unknown.dxf"; doc.saveas(path)
    _, _, walls, openings, rooms, footprint = run(str(path), config)
    assert (walls.walls, openings, rooms, footprint) == ([], [], [], None)


def test_door_on_intact_wall_is_kept_as_visual_only(tmp_path, config):
    doc = ezdxf.new("R2018"); doc.header["$INSUNITS"] = 6; msp = doc.modelspace()
    wall_lines(msp, 0, 0, 6, 0.2, layer="WALL")
    msp.add_arc((2, 0.2), 0.9, 0, 90, dxfattribs={"layer": "DOOR"})
    path = tmp_path / "intact.dxf"; doc.saveas(path)
    _, _, walls, openings, *_ = run(str(path), config)
    assert [(o.kind, o.hostCut) for o in openings] == [("door", False)]
    assert walls.solid.area == pytest.approx(1.2, abs=0.01)  # the wall was not cut


def test_room_type_keywords(config):
    assert room_type("ALCOBA P/PAL", config.roomTypeKeywords) == "bedroom"
    assert room_type("Cocina", config.roomTypeKeywords) == "kitchen"
    assert room_type("Room 3", config.roomTypeKeywords) == "unknown"


def test_empty_and_broken_dxf(tmp_path, config):
    empty = tmp_path / "empty.dxf"; ezdxf.new("R2018").saveas(empty)
    with pytest.raises(CadWorkerError) as caught:
        normalize_dxf(str(empty), config)
    assert caught.value.code == errors.NO_GEOMETRY
    broken = tmp_path / "broken.dxf"; broken.write_text("this is not a dxf")
    with pytest.raises(CadWorkerError) as caught:
        normalize_dxf(str(broken), config)
    assert caught.value.code == errors.DXF_PARSE_ERROR


def test_entities_without_a_layer_attribute_do_not_crash(tmp_path, config):
    """Regression: ezdxf keeps unmodelled types (PLANESURFACE in a real 3D DWG) as raw tags with no `layer` attribute."""
    path = build_plan(tmp_path / "plan.dxf")
    text = open(path, encoding="utf8").read()
    marker = "  0\nENDSEC\n  0\nSECTION\n  2\nOBJECTS"
    assert marker in text
    exotic = "  0\nPLANESURFACE\n  5\nFFF1\n330\n1F\n100\nAcDbEntity\n100\nAcDbModelerGeometry\n"
    open(path, "w", encoding="utf8").write(text.replace(marker, exotic + marker, 1))
    document, inventory, walls, *_ = run(str(path), config)
    assert document.entityCounts.get("PLANESURFACE") == 1 and walls.walls
