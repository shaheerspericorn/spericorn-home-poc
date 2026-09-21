"""CLI used by the Node backend.

    python -m cadworker analyze  --input <file.dwg|dxf> --workdir <dir> [--options '<json>']
    python -m cadworker generate --workdir <dir> --output <model.glb>   [--options '<json>']
    python -m cadworker doctor

stdout carries one JSON object per line:
    {"event": "progress", "stage": "parsing_dxf", "progress": 35}
    {"event": "result", ...}                      (exit 0)
    {"event": "error", "code": "...", "message": "...", "details": {...}}   (exit 2)
Anything else (tracebacks, library noise) goes to stderr.
"""
from __future__ import annotations

import argparse
import json
import sys
import traceback

from .config import load_config
from .converter import OdaFileConverter
from .errors import CadWorkerError
from .pipeline import analyze, generate


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def progress(stage: str, percent: int) -> None:
    emit({"event": "progress", "stage": stage, "progress": percent})


def summary(report: dict) -> dict:
    return {
        "event": "result", "status": report["status"], "analysisPath": report["analysisPath"], "units": report["units"],
        "detection": report["detection"], "model3d": report.get("model3d"), "timings": report["timings"], "warnings": report["warnings"],
    }


def doctor() -> dict:
    import ezdxf
    import shapely
    import trimesh

    report = {"event": "result", "python": sys.version.split()[0], "ezdxf": ezdxf.__version__, "shapely": shapely.__version__, "trimesh": trimesh.__version__}
    try:
        report["odaFileConverter"] = OdaFileConverter(load_config().odaPath).resolve_executable()
    except CadWorkerError as error:
        report["odaFileConverter"] = None
        report["odaError"] = error.message
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="cadworker")
    commands = parser.add_subparsers(dest="command", required=True)
    analyze_parser = commands.add_parser("analyze")
    analyze_parser.add_argument("--input", required=True)
    analyze_parser.add_argument("--workdir", required=True)
    analyze_parser.add_argument("--options", default="{}")
    generate_parser = commands.add_parser("generate")
    generate_parser.add_argument("--workdir", required=True)
    generate_parser.add_argument("--output", required=True)
    generate_parser.add_argument("--options", default="{}")
    commands.add_parser("doctor")
    args = parser.parse_args(argv)

    try:
        if args.command == "doctor":
            emit(doctor())
            return 0
        config = load_config(json.loads(args.options))
        if args.command == "analyze":
            emit(summary(analyze(args.input, args.workdir, config, progress)))
        else:
            emit(summary(generate(args.workdir, args.output, config, progress)))
        return 0
    except CadWorkerError as error:
        emit({"event": "error", "code": error.code, "message": error.message, "details": error.details})
        return 2
    except (ValueError, json.JSONDecodeError) as error:
        emit({"event": "error", "code": "INVALID_OPTIONS", "message": str(error), "details": {}})
        return 2
    except Exception as error:  # noqa: BLE001 - last line of defence; the traceback stays server-side
        traceback.print_exc(file=sys.stderr)
        emit({"event": "error", "code": "INTERNAL_ERROR", "message": f"Unexpected CAD worker failure: {type(error).__name__}", "details": {}})
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
