"""Which model does a fresh terminal open on?

The bug this guards: the installer measured the machine, recommended
qwen2.5-coder:7b and pulled it — and `jojo` still opened on gpt-oss:120b,
because the recommendation had nowhere to be written down. These tests pin the
precedence, and the fact that the installer's saver and the TUI's reader agree
on one file.
"""

from __future__ import annotations

import importlib
import json
import runpy
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tui"))


def reload_config(monkeypatch, home: Path, env: dict[str, str] | None = None):
    """Import config.py fresh — the defaults are read at import time."""
    monkeypatch.setenv("JOJO_CONFIG", str(home))
    for k in ("JOJO_MODEL", "JOJO_HOST"):
        monkeypatch.delenv(k, raising=False)
    for k, v in (env or {}).items():
        monkeypatch.setenv(k, v)
    sys.modules.pop("jojocode_ai.config", None)
    return importlib.import_module("jojocode_ai.config")


def test_falls_back_when_nothing_is_configured(monkeypatch, tmp_path):
    cfg = reload_config(monkeypatch, tmp_path / "empty")
    assert cfg.Config().model == cfg.FALLBACK_MODEL


def test_settings_file_beats_the_fallback(monkeypatch, tmp_path):
    home = tmp_path / "cfg"
    home.mkdir()
    (home / "settings.json").write_text(json.dumps({"model": "qwen2.5-coder:7b"}))
    cfg = reload_config(monkeypatch, home)
    assert cfg.Config().model == "qwen2.5-coder:7b"


def test_environment_beats_the_settings_file(monkeypatch, tmp_path):
    home = tmp_path / "cfg"
    home.mkdir()
    (home / "settings.json").write_text(json.dumps({"model": "from-file"}))
    cfg = reload_config(monkeypatch, home, {"JOJO_MODEL": "from-env"})
    assert cfg.Config().model == "from-env"


def test_a_corrupt_settings_file_does_not_stop_startup(monkeypatch, tmp_path):
    home = tmp_path / "cfg"
    home.mkdir()
    (home / "settings.json").write_text("{not json at all")
    cfg = reload_config(monkeypatch, home)
    assert cfg.Config().model == cfg.FALLBACK_MODEL


def test_save_settings_merges_and_can_remove(monkeypatch, tmp_path):
    cfg = reload_config(monkeypatch, tmp_path / "cfg")
    cfg.save_settings(model="a:1", host="http://box:11434")
    cfg.save_settings(model="b:2")
    data = cfg.load_settings()
    assert data == {"model": "b:2", "host": "http://box:11434"}
    cfg.save_settings(model=None)
    assert "model" not in cfg.load_settings()


def test_installer_and_tui_agree_on_the_file(monkeypatch, tmp_path):
    """recommend-model.py is a standalone script served over HTTP — it cannot
    import the TUI, so the two implementations must be checked against each
    other or they will drift apart silently."""
    home = tmp_path / "cfg"
    monkeypatch.setenv("JOJO_CONFIG", str(home))
    rec = runpy.run_path(str(ROOT / "install" / "recommend-model.py"))
    assert rec["main"](["--model", "qwen2.5-coder:7b", "--save"]) == 0

    cfg = reload_config(monkeypatch, home)
    assert cfg.settings_path() == rec["settings_path"]()
    assert cfg.Config().model == "qwen2.5-coder:7b"


def test_installer_save_survives_an_unwritable_home(monkeypatch, tmp_path, capsys):
    """A locked-down machine still gets its model pulled; it just cannot keep
    the preference. That must be a warning, never a crash mid-install."""
    rec = runpy.run_path(str(ROOT / "install" / "recommend-model.py"))
    blocked = tmp_path / "nope"
    blocked.write_text("i am a file, not a directory")
    monkeypatch.setenv("JOJO_CONFIG", str(blocked / "cfg"))
    assert rec["save_model"]("qwen2.5-coder:7b") is None
    assert "could not save" in capsys.readouterr().err
