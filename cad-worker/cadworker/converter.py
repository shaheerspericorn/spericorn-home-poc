"""DWG -> DXF conversion behind a small abstraction so the converter can be swapped.

ODA File Converter command line (https://www.opendesign.com/guestfiles/oda_file_converter):

    ODAFileConverter "<input dir>" "<output dir>" <version> <type> <recurse> <audit> ["<filter>"]

    version: ACAD9 ... ACAD2018      type: DWG | DXF | DXB      recurse/audit: 0 | 1

It converts *directories*, so every job gets private input/output directories that contain
exactly one file with a fixed name. The original upload filename never reaches the shell.
"""
from __future__ import annotations

import os
import platform
import shutil
import subprocess
import tempfile
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path

from . import errors
from .errors import CadWorkerError

# https://help.autodesk.com/ -> DWG version strings stored in the first six bytes of every DWG.
DWG_VERSIONS = {
    "AC1009": "R11/R12", "AC1012": "R13", "AC1014": "R14", "AC1015": "2000", "AC1018": "2004",
    "AC1021": "2007", "AC1024": "2010", "AC1027": "2013", "AC1032": "2018",
}
LEGACY_DWG_PREFIXES = ("AC1.", "AC2.", "AC1001", "AC1002", "AC1003", "AC1004", "AC1006")


@dataclass
class DxfConversionResult:
    dxfPath: str
    sourceVersion: str
    sourceVersionName: str
    tool: str
    durationMs: int
    dxfBytes: int
    log: str = ""


class CadFileConverter(ABC):
    """Converts a source CAD file into a DXF that ezdxf can read."""

    name = "abstract"

    @abstractmethod
    def convert_to_dxf(self, input_path: str, output_directory: str) -> DxfConversionResult: ...


def sniff_dwg_version(path: Path) -> str:
    try:
        with open(path, "rb") as handle:
            header = handle.read(6)
    except PermissionError as error:
        raise CadWorkerError(errors.PERMISSION_DENIED, "The uploaded file could not be read (permission denied).") from error
    except FileNotFoundError as error:
        raise CadWorkerError(errors.INPUT_NOT_FOUND, "The uploaded file no longer exists on the server.") from error
    text = header.decode("ascii", errors="replace")
    if len(header) < 6 or not text.startswith("AC"):
        raise CadWorkerError(errors.INPUT_NOT_DWG, "The file is not a valid DWG: the DWG signature is missing. It may be corrupt or a different format renamed to .dwg.")
    return text


class OdaFileConverter(CadFileConverter):
    name = "ODA File Converter"

    def __init__(self, executable: str | None = None, output_version: str = "ACAD2018", timeout_sec: float = 180.0):
        self._configured = executable
        self.output_version = output_version
        self.timeout_sec = timeout_sec

    # -- executable discovery -------------------------------------------------
    @staticmethod
    def candidate_paths() -> list[str]:
        system = platform.system()
        home = Path.home()
        if system == "Windows":
            roots = [Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "ODA"]
            found = [str(exe) for root in roots if root.exists() for exe in sorted(root.glob("ODAFileConverter*/ODAFileConverter.exe"), reverse=True)]
            return found
        if system == "Darwin":
            return ["/Applications/ODAFileConverter.app/Contents/MacOS/ODAFileConverter"]
        return [
            "/usr/bin/ODAFileConverter",
            "/usr/local/bin/ODAFileConverter",
            str(home / ".local/share/oda/squashfs-root/AppRun"),  # extracted AppImage (no FUSE / no root needed)
            str(home / ".local/share/oda/ODAFileConverter.AppImage"),
        ]

    def resolve_executable(self) -> str:
        if self._configured:
            if Path(self._configured).is_file() and os.access(self._configured, os.X_OK):
                return self._configured
            raise CadWorkerError(errors.CONVERTER_NOT_FOUND, f"ODA_FILE_CONVERTER_PATH points to '{self._configured}', which is not an executable file.")
        on_path = shutil.which("ODAFileConverter")
        if on_path:
            return on_path
        for candidate in self.candidate_paths():
            if Path(candidate).is_file() and os.access(candidate, os.X_OK):
                return candidate
        raise CadWorkerError(
            errors.CONVERTER_NOT_FOUND,
            "ODA File Converter was not found. Install it from https://www.opendesign.com/guestfiles/oda_file_converter and set ODA_FILE_CONVERTER_PATH (see cad-worker/README.md).",
        )

    def _command_prefix(self) -> tuple[list[str], dict[str, str]]:
        """ODA File Converter is a Qt GUI binary; on Linux it needs an X display even in CLI mode."""
        env = dict(os.environ)
        if platform.system() != "Linux" or env.get("DISPLAY"):
            return [], env
        xvfb = shutil.which("xvfb-run")
        if xvfb:
            return [xvfb, "-a"], env
        raise CadWorkerError(
            errors.CONVERTER_NO_DISPLAY,
            "ODA File Converter needs an X display on Linux. Install xvfb (`sudo apt install xvfb`) so it can run headlessly, or run the backend inside a desktop session.",
        )

    # -- conversion -----------------------------------------------------------
    def convert_to_dxf(self, input_path: str, output_directory: str) -> DxfConversionResult:
        source = Path(input_path)
        if not source.is_file():
            raise CadWorkerError(errors.INPUT_NOT_FOUND, "The uploaded file no longer exists on the server.")
        version = sniff_dwg_version(source)
        if version.startswith(LEGACY_DWG_PREFIXES):
            raise CadWorkerError(errors.UNSUPPORTED_DWG_VERSION, f"DWG version {version} predates AutoCAD R11 and is not supported. Re-save the drawing as DWG 2000 or newer.")
        if version not in DWG_VERSIONS:
            raise CadWorkerError(errors.UNSUPPORTED_DWG_VERSION, f"DWG version {version} is not recognised by this converter. Re-save the drawing as DWG 2018 or older.")

        executable = self.resolve_executable()
        prefix, env = self._command_prefix()
        output_root = Path(output_directory)
        try:
            output_root.mkdir(parents=True, exist_ok=True)
            job_dir = Path(tempfile.mkdtemp(prefix="oda-", dir=output_root))
            in_dir, out_dir = job_dir / "in", job_dir / "out"
            in_dir.mkdir()
            out_dir.mkdir()
            shutil.copyfile(source, in_dir / "input.dwg")
        except PermissionError as error:
            raise CadWorkerError(errors.PERMISSION_DENIED, f"The CAD work directory is not writable: {output_root}") from error

        command = [*prefix, executable, str(in_dir), str(out_dir), self.output_version, "DXF", "0", "1", "*.DWG"]
        started = time.perf_counter()
        try:
            completed = subprocess.run(command, capture_output=True, text=True, timeout=self.timeout_sec, env=env, cwd=job_dir, check=False)
        except subprocess.TimeoutExpired as error:
            shutil.rmtree(job_dir, ignore_errors=True)
            raise CadWorkerError(errors.CONVERSION_TIMEOUT, f"DWG to DXF conversion did not finish within {self.timeout_sec:.0f} seconds.") from error
        except PermissionError as error:
            raise CadWorkerError(errors.PERMISSION_DENIED, f"ODA File Converter could not be executed: {executable}") from error
        except OSError as error:
            raise CadWorkerError(errors.CONVERTER_NOT_FOUND, f"ODA File Converter could not be started: {error}") from error
        duration_ms = int((time.perf_counter() - started) * 1000)
        log = ((completed.stdout or "") + (completed.stderr or ""))[-2000:]

        produced = out_dir / "input.dxf"
        if not produced.is_file() or produced.stat().st_size == 0:
            shutil.rmtree(job_dir, ignore_errors=True)
            raise CadWorkerError(
                errors.CONVERSION_FAILED,
                "ODA File Converter did not produce a DXF. The DWG may be corrupt, password protected, or use an unsupported version.",
                {"exitCode": completed.returncode, "log": log},
            )
        final_path = output_root / "source.dxf"
        shutil.move(str(produced), final_path)
        shutil.rmtree(job_dir, ignore_errors=True)
        return DxfConversionResult(
            dxfPath=str(final_path), sourceVersion=version, sourceVersionName=DWG_VERSIONS[version],
            tool=self.name, durationMs=duration_ms, dxfBytes=final_path.stat().st_size, log=log,
        )
