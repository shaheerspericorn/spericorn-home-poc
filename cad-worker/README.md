# CAD worker (Python)

Local 2D pipeline used when `CAD_CONVERSION_PROVIDER=local`:

```
DWG ──ODA File Converter──▶ DXF ──ezdxf──▶ NormalizedCadDocument ──rules (Shapely)──▶ walls / openings / rooms ──trimesh──▶ GLB
```

The Node backend runs it as a child process (`python -m cadworker …`); there is no server, queue or container.

## 1. Python environment

Python ≥ 3.10.

```bash
cd cad-worker
python3 -m venv .venv                     # Debian/Ubuntu without python3-venv: see note below
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m cadworker doctor      # prints versions + the ODA executable it will use
.venv/bin/python -m pytest -q
```

Debian/Ubuntu without `python3-venv`/`pip` and without sudo (how this POC machine was set up):

```bash
python3 -m venv --without-pip .venv
curl -sSL https://bootstrap.pypa.io/get-pip.py | .venv/bin/python
```

The backend looks for `cad-worker/.venv/bin/python` (`Scripts\python.exe` on Windows). Override with `CAD_PYTHON_PATH`.

## 2. ODA File Converter

Download from <https://www.opendesign.com/guestfiles/oda_file_converter> (free download; **read ODA's licence terms before
any commercial or server-side use** – see docs/LOCAL_PIPELINE_REPORT.md §Licensing).

Command line used (documented on the download page; identical on all platforms):

```
ODAFileConverter "<input dir>" "<output dir>" ACAD2018 DXF 0 1 "*.DWG"
                                              │        │   │ └ audit each file
                                              │        │   └ do not recurse
                                              │        └ output type (DWG | DXF | DXB)
                                              └ output version (ACAD9 … ACAD2018)
```

It converts directories, so each job gets private `in/` and `out/` directories holding exactly `input.dwg`.

| OS | Install | Executable (auto-detected) |
|---|---|---|
| Linux, with root | `sudo apt install ./ODAFileConverter_QT6_lnxX64_*.deb` | `/usr/bin/ODAFileConverter` |
| Linux, no root / no FUSE (tested: v27.1) | `mkdir -p ~/.local/share/oda && cd ~/.local/share/oda && chmod +x ODAFileConverter*.AppImage && ./ODAFileConverter*.AppImage --appimage-extract` | `~/.local/share/oda/squashfs-root/AppRun` |
| Windows | run the installer | `C:\Program Files\ODA\ODAFileConverter <ver>\ODAFileConverter.exe` |
| macOS | drag the app to Applications | `/Applications/ODAFileConverter.app/Contents/MacOS/ODAFileConverter` |

Anything else: set `ODA_FILE_CONVERTER_PATH` to the executable.

**Linux display requirement.** ODA File Converter is a Qt GUI binary and ships only the `xcb` platform plugin
(`QT_QPA_PLATFORM=offscreen` does **not** work – verified). It therefore needs an X display even in CLI mode:

* desktop session: works as is (`DISPLAY` is set);
* headless server: `sudo apt install xvfb` – the worker automatically wraps the call in `xvfb-run -a` when `DISPLAY` is unset;
* neither available → the job fails with `CONVERTER_NO_DISPLAY` and this instruction.

## 3. CLI

```bash
.venv/bin/python -m cadworker analyze  --input plan.dwg --workdir /tmp/job1
.venv/bin/python -m cadworker generate --workdir /tmp/job1 --output /tmp/job1/model.glb \
    --options '{"build":{"wallHeight":2.8},"layerRoles":{"LAYER-17":"wall"},"unitsOverride":"meters"}'
```

stdout is JSON lines: `progress` events, then one `result` (exit 0) or `error` (exit 2) with a stable `code`
(`CONVERTER_NOT_FOUND`, `INPUT_NOT_DWG`, `UNSUPPORTED_DWG_VERSION`, `CONVERSION_TIMEOUT`, `DXF_PARSE_ERROR`,
`UNSUPPORTED_UNITS`, `NO_GEOMETRY`, `NO_WALLS`, `INVALID_GEOMETRY`, `GLB_EXPORT_FAILED`, …).
`<workdir>/analysis.json` is the full diagnostic report + normalized document, written even when no walls are found.

## 4. Adding rules for a new drawing convention

1. Upload the drawing; open the **2D review** screen; read the layer table and entity counts.
2. Quick test: set layer roles in the UI and press *Re-analyse*.
3. Make it permanent: copy `config/detection.default.json`, add layer/block globs or adjust tolerances,
   and point `CAD_DETECTION_CONFIG` at the copy. All lengths are metres.

## 5. Module map

| Module | Responsibility |
|---|---|
| `converter.py` | `CadFileConverter` abstraction + `OdaFileConverter` (discovery, display, timeout, errors) |
| `normalize.py` | the only ezdxf-aware code → `NormalizedCadDocument` (local metres, centred) |
| `units.py` | `$INSUNITS` + plausibility check against extents and door radii |
| `detect_walls.py` | strategies 1-3 (closed polylines → parallel pairs → line network faces) |
| `detect_openings.py` | wall gaps (cap-to-cap, cap-to-face) → door / window / opening by evidence |
| `detect_rooms.py` | enclosed voids of walls+openings, names from CAD text |
| `reconstruct.py` | extrusion, named scene graph, GLB export, the coordinate contract |
| `pipeline.py`, `__main__.py` | orchestration, timings, report, CLI protocol |
| `scripts/make_furniture.py` | generates the three sample furniture GLBs |
