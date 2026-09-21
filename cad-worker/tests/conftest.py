"""Synthetic DXF fixtures built with ezdxf so tests need neither a DWG nor ODA File Converter."""
import sys
from pathlib import Path

import ezdxf
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from cadworker.config import load_config  # noqa: E402


def rect(msp, x0, y0, x1, y1, layer, closed=True):
    msp.add_lwpolyline([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], close=closed, dxfattribs={"layer": layer})


def wall_lines(msp, x0, y0, x1, y1, layer="A-WALL"):
    """A wall body drawn the usual way: four separate lines (two faces + two end caps)."""
    corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    for start, end in zip(corners, corners[1:] + corners[:1]):
        msp.add_line(start, end, dxfattribs={"layer": layer})


def build_plan(path, units=4, scale=1000.0, offset=(0.0, 0.0), labelled=True):
    """One 6 x 4 m room (inner), 0.2 m walls, a 0.9 m door in the south wall, a 1.5 m window in the north wall."""
    doc = ezdxf.new("R2018")
    doc.header["$INSUNITS"] = units
    msp = doc.modelspace()
    ox, oy = offset

    def s(x, y):
        return (ox + x * scale, oy + y * scale)

    def wall(x0, y0, x1, y1):
        wall_lines(msp, *s(x0, y0), *s(x1, y1))

    t = 0.2
    wall(-t, 0, 0, 4)            # west
    wall(6, 0, 6 + t, 4)         # east
    wall(-t, -t, 2.0, 0)         # south, left of door
    wall(2.9, -t, 6 + t, 0)      # south, right of door
    wall(-t, 4, 2.0, 4 + t)      # north, left of window
    wall(3.5, 4, 6 + t, 4 + t)   # north, right of window
    # Door swing: hinge at the left jamb, 0.9 m leaf.
    msp.add_arc(s(2.0, 0), 0.9 * scale, 0, 90, dxfattribs={"layer": "A-DOOR"})
    msp.add_line(s(2.0, 0), s(2.0, 0.9), dxfattribs={"layer": "A-DOOR"})
    # Window: two lines across the gap on a window layer.
    msp.add_line(s(2.0, 4.05), s(3.5, 4.05), dxfattribs={"layer": "A-GLAZ"})
    msp.add_line(s(2.0, 4.15), s(3.5, 4.15), dxfattribs={"layer": "A-GLAZ"})
    if labelled:
        msp.add_text("LIVING ROOM", dxfattribs={"layer": "A-ROOM-NAME", "insert": s(2.5, 2.0), "height": 0.2 * scale})
    msp.add_line(s(-50, -50), s(-49, -50), dxfattribs={"layer": "DEFPOINTS"})
    doc.saveas(path)
    return path


@pytest.fixture
def config():
    return load_config()


@pytest.fixture
def plan_mm(tmp_path):
    return str(build_plan(tmp_path / "plan.dxf", offset=(125483.22, 98221.55)))
