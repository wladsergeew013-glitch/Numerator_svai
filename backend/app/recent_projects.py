"""Persistent list of projects opened by the desktop app or local API."""
from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from app.project_files import atomic_write_project, project_file_lock

_lock = threading.RLock()
_limit = 20


def _manifest(config_dir: Path) -> Path:
    return config_dir / "recent_projects.json"


def _read(config_dir: Path) -> list[dict[str, str]]:
    try:
        data = json.loads(_manifest(config_dir).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if not isinstance(data, list):
        return []
    return [item for item in data if isinstance(item, dict)
            and isinstance(item.get("path"), str) and isinstance(item.get("openedAt"), str)]


def list_recent_projects(config_dir: Path) -> list[dict[str, str]]:
    with _lock:
        return [item for item in _read(config_dir)
                if Path(item["path"]).is_file() and item["path"].lower().endswith(".json")]


def remember_recent_project(config_dir: Path, project_path: Path) -> None:
    path = project_path.resolve()
    if not path.is_file() or not path.name.lower().endswith(".json"):
        return
    config_dir.mkdir(parents=True, exist_ok=True)
    target = _manifest(config_dir)
    with _lock, project_file_lock(target):
        entries = [item for item in _read(config_dir)
                   if Path(item["path"]) != path and Path(item["path"]).is_file()]
        entries.insert(0, {"path": str(path), "openedAt": datetime.now(timezone.utc).isoformat()})
        atomic_write_project(target, json.dumps(entries[:_limit], ensure_ascii=False, indent=2))
