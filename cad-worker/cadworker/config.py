"""All tunables live here. Nothing else in the worker hard-codes a tolerance or a dimension.

Resolution order (later wins): built-in defaults -> detection JSON file -> environment -> per-job options.
All lengths are metres; they are applied after the drawing has been normalised to metres.
"""
from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path

DEFAULT_DETECTION_FILE = Path(__file__).resolve().parent.parent / "config" / "detection.default.json"


@dataclass
class LayerPatterns:
    """Case-insensitive fnmatch globs. A layer's role is the first group that matches, in this order."""

    ignore: list[str] = field(default_factory=list)
    wall: list[str] = field(default_factory=list)
    door: list[str] = field(default_factory=list)
    window: list[str] = field(default_factory=list)
    furniture: list[str] = field(default_factory=list)
    roomLabel: list[str] = field(default_factory=list)


@dataclass
class Tolerances:
    minWallThickness: float = 0.05
    maxWallThickness: float = 0.60
    endpointTolerance: float = 0.01  # endpoints closer than this are the same node
    gapTolerance: float = 0.05  # wall lines are extended by this much to close small drafting gaps
    angularToleranceDeg: float = 2.0
    minWallSegmentLength: float = 0.02
    minParallelOverlap: float = 0.10
    curveFlatteningDistance: float = 0.01
    minOpeningWidth: float = 0.40
    maxOpeningWidth: float = 6.0
    maxUnverifiedOpeningWidth: float = 2.5  # wider gaps need door/window evidence
    openingLateralTolerance: float = 0.06
    openingMatchDistance: float = 0.35  # how far a door/window symbol may sit from a wall gap
    minDoorWidth: float = 0.50
    maxDoorWidth: float = 1.60
    minRoomArea: float = 1.0
    maxBlockDepth: int = 4


@dataclass
class BuildDefaults:
    wallHeight: float = 3.0
    wallThickness: float = 0.20  # used only when thickness cannot be measured from the drawing
    floorThickness: float = 0.15
    doorHeight: float = 2.10
    windowSillHeight: float = 0.90
    windowHeadHeight: float = 2.10


@dataclass
class WorkerConfig:
    layerPatterns: LayerPatterns = field(default_factory=LayerPatterns)
    blockPatterns: LayerPatterns = field(default_factory=LayerPatterns)
    roomTypeKeywords: dict[str, list[str]] = field(default_factory=dict)
    tolerances: Tolerances = field(default_factory=Tolerances)
    build: BuildDefaults = field(default_factory=BuildDefaults)
    # Explicit per-job layer role overrides: {"Muro1": "wall", "XX": "ignore"}
    layerRoles: dict[str, str] = field(default_factory=dict)
    unitsOverride: str | None = None
    roomNames: dict[str, str] = field(default_factory=dict)
    odaPath: str | None = None
    odaOutputVersion: str = "ACAD2018"
    converterTimeoutSec: float = 180.0
    debug: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


def _merge_dataclass(instance, values: dict) -> None:
    known = {f.name for f in fields(instance)}
    for key, value in (values or {}).items():
        if key in known and value is not None:
            setattr(instance, key, value)


def _env_float(name: str) -> float | None:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError as error:
        raise ValueError(f"Environment variable {name} must be a number, got {raw!r}.") from error


def load_config(options: dict | None = None, detection_file: str | None = None) -> WorkerConfig:
    config = WorkerConfig()
    path = Path(detection_file or os.environ.get("CAD_DETECTION_CONFIG") or DEFAULT_DETECTION_FILE)
    data = json.loads(path.read_text(encoding="utf8"))
    _merge_dataclass(config.layerPatterns, data.get("layerPatterns", {}))
    _merge_dataclass(config.blockPatterns, data.get("blockPatterns", {}))
    _merge_dataclass(config.tolerances, data.get("tolerances", {}))
    config.roomTypeKeywords = data.get("roomTypeKeywords", {})

    _merge_dataclass(config.build, {
        "wallHeight": _env_float("DEFAULT_WALL_HEIGHT_M"),
        "wallThickness": _env_float("DEFAULT_WALL_THICKNESS_M"),
        "floorThickness": _env_float("DEFAULT_FLOOR_THICKNESS_M"),
        "doorHeight": _env_float("DEFAULT_DOOR_HEIGHT_M"),
        "windowSillHeight": _env_float("DEFAULT_WINDOW_SILL_M"),
        "windowHeadHeight": _env_float("DEFAULT_WINDOW_HEAD_M"),
    })
    config.odaPath = os.environ.get("ODA_FILE_CONVERTER_PATH") or None
    config.unitsOverride = os.environ.get("CAD_UNITS_OVERRIDE") or None
    timeout = _env_float("CAD_CONVERTER_TIMEOUT_SEC")
    if timeout:
        config.converterTimeoutSec = timeout
    config.debug = os.environ.get("DEBUG_CAD", "").lower() in {"1", "true", "yes"}

    options = options or {}
    _merge_dataclass(config.build, options.get("build", {}))
    _merge_dataclass(config.tolerances, options.get("tolerances", {}))
    if options.get("layerRoles"):
        config.layerRoles = {str(k): str(v) for k, v in options["layerRoles"].items()}
    if options.get("unitsOverride"):
        config.unitsOverride = str(options["unitsOverride"])
    if options.get("roomNames"):
        config.roomNames = {str(k): str(v)[:80] for k, v in options["roomNames"].items()}

    build = config.build
    if not (0.5 <= build.wallHeight <= 20):
        raise ValueError("Wall height must be between 0.5 m and 20 m.")
    if not (0.02 <= build.wallThickness <= 2):
        raise ValueError("Wall thickness must be between 0.02 m and 2 m.")
    return config
