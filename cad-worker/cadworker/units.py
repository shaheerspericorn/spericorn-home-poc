"""Drawing units -> metres.

$INSUNITS is advisory metadata and is frequently wrong in real drawings (e.g. a plan drawn in
metres saved from a millimetre template). We therefore read the header first, then sanity-check
it against measurable evidence (building extent, door swing radii). Any deviation from the header
is reported as a warning - never applied silently.
"""
from __future__ import annotations

import statistics
from dataclasses import dataclass, field

from . import errors
from .errors import CadWorkerError

# DXF $INSUNITS codes (ezdxf docs: "DXF Units") restricted to what the POC supports.
INSUNITS = {1: "inches", 2: "feet", 4: "millimeters", 5: "centimeters", 6: "meters"}
INSUNITS_UNSUPPORTED = {
    3: "miles", 7: "kilometers", 8: "microinches", 9: "mils", 10: "yards", 11: "angstroms", 12: "nanometers",
    13: "microns", 14: "decimeters", 15: "decameters", 16: "hectometers", 17: "gigameters",
    18: "astronomical units", 19: "light years", 20: "parsecs",
}
METERS_PER_UNIT = {"millimeters": 0.001, "centimeters": 0.01, "meters": 1.0, "inches": 0.0254, "feet": 0.3048}
ALIASES = {
    "mm": "millimeters", "millimeter": "millimeters", "millimetres": "millimeters",
    "cm": "centimeters", "centimeter": "centimeters", "m": "meters", "meter": "meters", "metres": "meters",
    "in": "inches", "inch": "inches", "ft": "feet", "foot": "feet",
}

# A single-building plan is expected to measure between these bounds along its longest side.
PLAUSIBLE_EXTENT_M = (3.0, 400.0)
PLAUSIBLE_DOOR_M = (0.55, 1.40)


@dataclass
class UnitDecision:
    declaredCode: int
    declared: str
    used: str
    metersPerUnit: float
    source: str  # "header" | "inferred" | "override" | "measurement-flag"
    notes: list[str] = field(default_factory=list)


def canonical_unit(name: str) -> str:
    key = name.strip().lower()
    key = ALIASES.get(key, key)
    if key not in METERS_PER_UNIT:
        raise CadWorkerError(errors.UNSUPPORTED_UNITS, f"Unsupported unit '{name}'. Supported: {', '.join(METERS_PER_UNIT)}.")
    return key


def _plausibility(unit: str, extent: float, door_radii: list[float]) -> int:
    scale = METERS_PER_UNIT[unit]
    score = 0
    if PLAUSIBLE_EXTENT_M[0] <= extent * scale <= PLAUSIBLE_EXTENT_M[1]:
        score += 1
    if door_radii:
        if PLAUSIBLE_DOOR_M[0] <= statistics.median(door_radii) * scale <= PLAUSIBLE_DOOR_M[1]:
            score += 2
    return score


def decide_units(insunits: int, measurement: int | None, extent: float, door_radii: list[float], override: str | None) -> UnitDecision:
    """`extent` and `door_radii` are in raw drawing units."""
    declared = INSUNITS.get(insunits) or INSUNITS_UNSUPPORTED.get(insunits) or "unitless"
    if override:
        unit = canonical_unit(override)
        return UnitDecision(insunits, declared, unit, METERS_PER_UNIT[unit], "override", [f"Units forced to {unit} by configuration (header declares {declared})."])

    if insunits in INSUNITS_UNSUPPORTED:
        raise CadWorkerError(errors.UNSUPPORTED_UNITS, f"The drawing declares its units as {declared}, which this POC does not support. Supported: {', '.join(METERS_PER_UNIT)}. Set a units override to proceed.")

    best_score = 3 if door_radii else 1
    evidence = f"longest wall-layer extent = {extent:.2f} drawing units" + (f", median door swing radius = {statistics.median(door_radii):.3f} drawing units" if door_radii else "")

    if insunits in INSUNITS:
        if extent <= 0 or _plausibility(declared, extent, door_radii) == best_score:
            return UnitDecision(insunits, declared, declared, METERS_PER_UNIT[declared], "header")
        ranked = sorted(METERS_PER_UNIT, key=lambda unit: -_plausibility(unit, extent, door_radii))
        winner = ranked[0]
        if _plausibility(winner, extent, door_radii) > _plausibility(declared, extent, door_radii):
            return UnitDecision(insunits, declared, winner, METERS_PER_UNIT[winner], "inferred", [
                f"Header declares {declared}, but that is implausible for a building ({evidence}; as {declared} the plan would be {extent * METERS_PER_UNIT[declared]:.3f} m long). "
                f"Using {winner} instead ({extent * METERS_PER_UNIT[winner]:.2f} m). Override the units if this is wrong.",
            ])
        return UnitDecision(insunits, declared, declared, METERS_PER_UNIT[declared], "header", [f"Declared units {declared} look implausible ({evidence}) but no better candidate was found."])

    # Unitless drawing: infer, falling back to the $MEASUREMENT flag (0 = imperial, 1 = metric).
    preference = ["millimeters", "meters", "centimeters", "inches", "feet"] if measurement != 0 else ["inches", "feet", "millimeters", "meters", "centimeters"]
    ranked = sorted(preference, key=lambda unit: -_plausibility(unit, extent, door_radii))
    winner = ranked[0]
    if extent > 0 and _plausibility(winner, extent, door_radii) > 0:
        return UnitDecision(insunits, declared, winner, METERS_PER_UNIT[winner], "inferred", [f"The drawing does not declare units. Inferred {winner} from geometry ({evidence})."])
    fallback = preference[0]
    return UnitDecision(insunits, declared, fallback, METERS_PER_UNIT[fallback], "measurement-flag", [f"The drawing does not declare units and geometry gave no evidence. Assumed {fallback} from $MEASUREMENT={measurement}."])
