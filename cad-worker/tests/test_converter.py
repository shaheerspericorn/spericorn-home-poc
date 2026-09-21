import os
import pathlib
import stat
import sys

import pytest

from cadworker import errors
from cadworker.converter import OdaFileConverter, sniff_dwg_version
from cadworker.errors import CadWorkerError


def fake_dwg(path, header=b"AC1032"):
    path.write_bytes(header + b"\x00" * 64)
    return str(path)


def fake_converter(tmp_path, body):
    """A stand-in executable that honours the ODA argument order: <in> <out> <ver> <type> <recurse> <audit> <filter>."""
    script = tmp_path / "fake_oda.py"
    script.write_text(f"#!{sys.executable}\nimport sys, pathlib, time\nin_dir, out_dir = map(pathlib.Path, sys.argv[1:3])\n{body}\n")
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return str(script)


@pytest.fixture(autouse=True)
def display(monkeypatch):
    monkeypatch.setenv("DISPLAY", ":0")


def test_missing_input(tmp_path):
    with pytest.raises(CadWorkerError) as caught:
        OdaFileConverter("/bin/true").convert_to_dxf(str(tmp_path / "nope.dwg"), str(tmp_path))
    assert caught.value.code == errors.INPUT_NOT_FOUND


def test_corrupt_file_is_rejected_before_conversion(tmp_path):
    with pytest.raises(CadWorkerError) as caught:
        sniff_dwg_version(pathlib.Path(fake_dwg(tmp_path / "x.dwg", b"PK\x03\x04zz")))
    assert caught.value.code == errors.INPUT_NOT_DWG


def test_unsupported_version(tmp_path):
    with pytest.raises(CadWorkerError) as caught:
        OdaFileConverter("/bin/true").convert_to_dxf(fake_dwg(tmp_path / "old.dwg", b"AC1006"), str(tmp_path / "w"))
    assert caught.value.code == errors.UNSUPPORTED_DWG_VERSION


def test_converter_missing(tmp_path):
    with pytest.raises(CadWorkerError) as caught:
        OdaFileConverter(str(tmp_path / "missing-binary")).convert_to_dxf(fake_dwg(tmp_path / "a.dwg"), str(tmp_path / "w"))
    assert caught.value.code == errors.CONVERTER_NOT_FOUND


def test_converter_failure_without_output(tmp_path):
    exe = fake_converter(tmp_path, "sys.exit(1)")
    with pytest.raises(CadWorkerError) as caught:
        OdaFileConverter(exe).convert_to_dxf(fake_dwg(tmp_path / "a.dwg"), str(tmp_path / "w"))
    assert caught.value.code == errors.CONVERSION_FAILED


def test_timeout(tmp_path):
    exe = fake_converter(tmp_path, "time.sleep(5)")
    with pytest.raises(CadWorkerError) as caught:
        OdaFileConverter(exe, timeout_sec=0.5).convert_to_dxf(fake_dwg(tmp_path / "a.dwg"), str(tmp_path / "w"))
    assert caught.value.code == errors.CONVERSION_TIMEOUT


def test_dxf_generated_with_fixed_names(tmp_path):
    exe = fake_converter(tmp_path, "assert [p.name for p in in_dir.iterdir()] == ['input.dwg']\nassert sys.argv[3:8] == ['ACAD2018', 'DXF', '0', '1', '*.DWG']\n(out_dir / 'input.dxf').write_text('0\\nEOF\\n')")
    result = OdaFileConverter(exe).convert_to_dxf(fake_dwg(tmp_path / "weird name; rm -rf.dwg"), str(tmp_path / "w"))
    assert os.path.isfile(result.dxfPath) and result.dxfPath.endswith("source.dxf")
    assert result.sourceVersion == "AC1032" and result.dxfBytes > 0
    assert sorted(p.name for p in (tmp_path / "w").iterdir()) == ["source.dxf"]  # private job dirs are cleaned up


def test_no_display_is_reported(tmp_path, monkeypatch):
    monkeypatch.delenv("DISPLAY")
    monkeypatch.setattr("cadworker.converter.platform.system", lambda: "Linux")
    monkeypatch.setattr("cadworker.converter.shutil.which", lambda name: None)
    with pytest.raises(CadWorkerError) as caught:
        OdaFileConverter("/bin/true").convert_to_dxf(fake_dwg(tmp_path / "a.dwg"), str(tmp_path / "w"))
    assert caught.value.code == errors.CONVERTER_NO_DISPLAY
