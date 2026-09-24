from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import time
import traceback
import hashlib
from logging.handlers import RotatingFileHandler
from uuid import uuid4
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ValidationError, Field
from app import cad_operations as cad

from app.io_project import import_points_from_csv
from app.recent_projects import list_recent_projects as read_recent_projects, remember_recent_project
from app.numbering_rows import apply_numbering_rows
from app.clustering_methods import ClusterPreviewRequest, preview_clusters
from app.schemas import (
    CsvImportResponse,
    LocalProjectInfo,
    LocalProjectListResponse,
    LocalProjectSaveResponse,
    NumberingResponse,
    NumberingRowsRequest,
    PileProject,
    PilePoint,
    SyncState,
    UserConfig,
    ValidateProjectResponse,
)

app = FastAPI(title="Pile Numbering API", version="0.3.0")


@app.post('/api/clustering/preview')
def clustering_preview(request: ClusterPreviewRequest):
    try:
        return preview_clusters(request)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

ROOT_DIR = Path(__file__).resolve().parents[2]
PROJECTS_DIR = ROOT_DIR / "projects"
CONFIG_DIR = ROOT_DIR / "config"
AUTOSAVES_DIR = ROOT_DIR / "autosaves"
DATA_DIR = ROOT_DIR / "data"
LOGS_DIR = ROOT_DIR / "logs"
IMAGES_DIR = DATA_DIR / "images"
USER_CONFIG_PATH = CONFIG_DIR / "user_config.json"
APP_ICON_PATH = CONFIG_DIR / "app_icon.ico"

_BACKEND_LOGGER: logging.Logger | None = None
_BACKEND_LOGGER_PATH: Path | None = None
_MODELSTUDIO_SCAN_CACHE: dict[str, dict] = {}
_BLOCK_SCAN_CACHE: dict[str, dict] = {}
_MODELSTUDIO_SCAN_TTL_SECONDS = 600


def _runtime_logs_dir() -> Path:
    """Return the active logs folder for both browser/dev and EXE modes.

    In browser/dev mode ROOT_DIR is the project root, so logs go to <project>/logs.
    In EXE mode tools/exe_launcher.py patches ROOT_DIR to the folder next to
    PileNumbering.exe, so logs go to <dist>/logs next to the executable.
    """
    base = Path(globals().get("ROOT_DIR", ROOT_DIR))
    path = Path(globals().get("LOGS_DIR", base / "logs"))
    try:
        # If launcher changed ROOT_DIR but not LOGS_DIR, keep LOGS_DIR in sync.
        root_logs = base / "logs"
        if path == Path(__file__).resolve().parents[2] / "logs" and base != Path(__file__).resolve().parents[2]:
            path = root_logs
    except Exception:
        path = base / "logs"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _backend_log_file() -> Path:
    return _runtime_logs_dir() / "backend.log"


def _get_backend_logger() -> logging.Logger:
    global _BACKEND_LOGGER, _BACKEND_LOGGER_PATH
    log_path = _backend_log_file()
    if _BACKEND_LOGGER is not None and _BACKEND_LOGGER_PATH == log_path:
        return _BACKEND_LOGGER

    logger = logging.getLogger("pile_numbering.backend")
    logger.setLevel(logging.INFO)
    logger.propagate = False
    for handler in list(logger.handlers):
        logger.removeHandler(handler)
        try:
            handler.close()
        except Exception:
            pass
    handler = RotatingFileHandler(log_path, maxBytes=2_000_000, backupCount=5, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
    logger.addHandler(handler)
    _BACKEND_LOGGER = logger
    _BACKEND_LOGGER_PATH = log_path
    return logger


def _json_safe(value):
    try:
        json.dumps(value, ensure_ascii=False)
        return value
    except Exception:
        if isinstance(value, dict):
            return {str(k): _json_safe(v) for k, v in value.items()}
        if isinstance(value, (list, tuple, set)):
            return [_json_safe(v) for v in value]
        try:
            return str(value)
        except Exception:
            return f"<{type(value).__name__}>"


def _log_backend_error(context: str, exc: Exception | None = None, extra: dict | None = None, level: int = logging.ERROR) -> str:
    log_path = _backend_log_file()
    logger = _get_backend_logger()
    payload = {
        "context": context,
        "extra": _json_safe(extra or {}),
    }
    if exc is not None:
        payload["exceptionType"] = type(exc).__name__
        payload["exception"] = str(exc)
        payload["traceback"] = traceback.format_exception(type(exc), exc, exc.__traceback__)
    if 'operationId' not in (extra or {}):
        cad.record(context, payload, level)
    logger.log(level, json.dumps(payload, ensure_ascii=False, default=str))
    return str(log_path)


def _error_detail(message: str, context: str, exc: Exception | None = None, extra: dict | None = None) -> dict:
    log_file = _log_backend_error(context, exc, extra)
    return {
        "message": message,
        "context": context,
        "logFile": log_file,
    }


@app.exception_handler(HTTPException)
async def _http_exception_handler(request: Request, exc: HTTPException):
    log_file = _log_backend_error(
        "http_exception",
        None,
        {
            "method": request.method,
            "path": request.url.path,
            "statusCode": exc.status_code,
            "detail": exc.detail,
        },
        level=logging.WARNING if exc.status_code < 500 else logging.ERROR,
    )
    detail = exc.detail
    if isinstance(detail, dict):
        detail = {**detail, "logFile": detail.get("logFile") or log_file}
    elif exc.status_code >= 500:
        detail = {"message": str(detail), "logFile": log_file}
    return JSONResponse(status_code=exc.status_code, content={"detail": _json_safe(detail)}, headers=exc.headers)


@app.exception_handler(Exception)
async def _unhandled_exception_handler(request: Request, exc: Exception):
    detail = _error_detail(
        "Внутренняя ошибка backend. Подробности записаны в logs/backend.log.",
        "unhandled_exception",
        exc,
        {"method": request.method, "path": request.url.path},
    )
    return JSONResponse(status_code=500, content={"detail": detail})


def _ensure_projects_dir() -> None:
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)


def _ensure_config_dir() -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)


def _ensure_autosaves_dir() -> None:
    AUTOSAVES_DIR.mkdir(parents=True, exist_ok=True)


def _ensure_data_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)


def _safe_file_name(value: str) -> str:
    name = (value or "project").strip()
    name = re.sub(r"[\\/:*?\"<>|]+", "_", name)
    name = re.sub(r"\s+", "_", name)
    name = name.strip("._ ") or "project"
    if not name.lower().endswith(".pilenum.json"):
        name = f"{name}.pilenum.json"
    return name


def _safe_project_path(file_name: str) -> Path:
    _ensure_projects_dir()
    safe_name = _safe_file_name(Path(file_name).name)
    path = (PROJECTS_DIR / safe_name).resolve()
    root = PROJECTS_DIR.resolve()
    if root not in path.parents and path != root:
        raise HTTPException(status_code=400, detail="Invalid project file name")
    return path


def _safe_autosave_folder(folder_path: str | None) -> Path:
    if not folder_path or not str(folder_path).strip():
        _ensure_autosaves_dir()
        return AUTOSAVES_DIR.resolve()
    raw = Path(str(folder_path).strip()).expanduser()
    try:
        path = raw.resolve()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid autosave folder: {exc}") from exc
    if path.exists() and not path.is_dir():
        raise HTTPException(status_code=400, detail="Autosave path is not a folder")
    path.mkdir(parents=True, exist_ok=True)
    return path


def _autosave_file_name(project: PileProject) -> str:
    base = _safe_file_name(project.project.name).replace('.pilenum.json', '')
    stamp = datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')
    return f"{base}.autosave_{stamp}.pilenum.json"


def _project_summary(path: Path) -> LocalProjectInfo:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        info = payload.get("project", {}) if isinstance(payload, dict) else {}
        points = payload.get("points", []) if isinstance(payload, dict) else []
        groups = payload.get("groups", []) if isinstance(payload, dict) else []
        name = str(info.get("name") or path.stem.replace(".pilenum", ""))
        updated_at = info.get("updatedAt") or datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()
        return LocalProjectInfo(
            fileName=path.name,
            name=name,
            updatedAt=updated_at,
            pointsCount=len(points) if isinstance(points, list) else 0,
            groupsCount=len(groups) if isinstance(groups, list) else 0,
        )
    except Exception:
        return LocalProjectInfo(
            fileName=path.name,
            name=path.stem.replace(".pilenum", ""),
            updatedAt=datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(),
            pointsCount=0,
            groupsCount=0,
        )


class AutosaveProjectRequest(BaseModel):
    project: PileProject
    folderPath: str | None = None


class AutosaveProjectResponse(BaseModel):
    saved: bool
    fileName: str
    path: str


class SelectFolderResponse(BaseModel):
    folderPath: str | None = None


class DesktopShortcutResponse(BaseModel):
    created: bool
    path: str | None = None
    target: str | None = None



@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/config/user", response_model=UserConfig)
def get_user_config() -> UserConfig:
    _ensure_config_dir()
    if not USER_CONFIG_PATH.exists():
        return UserConfig()
    try:
        payload = json.loads(USER_CONFIG_PATH.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            return UserConfig()
        return UserConfig.model_validate(payload)
    except Exception:
        return UserConfig()


@app.post("/api/config/user", response_model=UserConfig)
def save_user_config(config: UserConfig) -> UserConfig:
    _ensure_config_dir()
    incoming = config.model_dump(mode="json", exclude_none=True)
    existing: dict = {}
    if USER_CONFIG_PATH.exists():
        try:
            loaded = json.loads(USER_CONFIG_PATH.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                existing = loaded
        except Exception:
            existing = {}

    merged = {**existing, **incoming}
    merged["gridSettings"] = {**existing.get("gridSettings", {}), **incoming.get("gridSettings", {})}
    merged["viewSettings"] = {**existing.get("viewSettings", {}), **incoming.get("viewSettings", {})}
    merged["panels"] = {**existing.get("panels", {}), **incoming.get("panels", {})}
    merged["autosaveSettings"] = {**existing.get("autosaveSettings", {}), **incoming.get("autosaveSettings", {})}

    normalized = UserConfig.model_validate(merged)
    USER_CONFIG_PATH.write_text(
        json.dumps(normalized.model_dump(mode="json"), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return normalized




@app.post("/api/config/app-icon")
async def upload_app_icon(file: UploadFile = File(...)) -> dict[str, object]:
    """Save an .ico that the EXE builder will use on the next build.

    Windows executable icons are compiled into the binary by PyInstaller; they
    cannot be reliably changed from a running browser/EXE without a resource
    editor. Therefore the app stores config/app_icon.ico and 06_build_exe.bat
    applies it during the next EXE build.
    """
    if not file.filename or not file.filename.lower().endswith(".ico"):
        raise HTTPException(status_code=400, detail="Only .ico files are supported for EXE icon")
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty icon file")
    if len(content) > 2_000_000:
        raise HTTPException(status_code=400, detail="Icon file is too large")
    _ensure_config_dir()
    APP_ICON_PATH.write_bytes(content)
    return {"saved": True, "fileName": APP_ICON_PATH.name, "path": str(APP_ICON_PATH)}


@app.post("/api/import/csv", response_model=CsvImportResponse)
async def import_csv(file: UploadFile = File(...)) -> CsvImportResponse:
    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Only CSV files are supported")
    try:
        content = await file.read()
        return import_points_from_csv(content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/projects/local", response_model=LocalProjectListResponse)
def list_local_projects() -> LocalProjectListResponse:
    _ensure_projects_dir()
    files = sorted(PROJECTS_DIR.glob("*.pilenum.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    return LocalProjectListResponse(projects=[_project_summary(path) for path in files])


def _recent_id(path: Path) -> str:
    return hashlib.sha256(str(path).encode('utf-8')).hexdigest()[:20]


@app.get('/api/projects/recent')
def list_recent_project_entries() -> dict:
    entries = []
    for item in read_recent_projects(CONFIG_DIR):
        path = Path(item['path'])
        summary = _project_summary(path).model_dump()
        entries.append({**summary, 'id': _recent_id(path), 'path': str(path), 'openedAt': item['openedAt']})
    return {'projects': entries}


@app.get('/api/projects/recent/{project_id}', response_model=PileProject)
def open_recent_project(project_id: str) -> PileProject:
    match = next((Path(item['path']) for item in read_recent_projects(CONFIG_DIR)
                  if _recent_id(Path(item['path'])) == project_id), None)
    if match is None:
        raise HTTPException(404, 'Недавний проект не найден.')
    try:
        project = PileProject.model_validate_json(match.read_text(encoding='utf-8-sig'))
    except (OSError, ValidationError, ValueError) as exc:
        raise HTTPException(400, f'Не удалось открыть проект: {exc}') from exc
    project.project.fileName = match.name
    project.project.sourceFileName = project.project.sourceFileName or match.name
    remember_recent_project(CONFIG_DIR, match)
    return project


@app.post("/api/projects/local/save", response_model=LocalProjectSaveResponse)
def save_local_project(project: PileProject) -> LocalProjectSaveResponse:
    _ensure_projects_dir()
    project.project.updatedAt = datetime.now(timezone.utc).isoformat()
    file_name = _safe_file_name(project.project.name)
    path = _safe_project_path(file_name)
    if path.exists():
        try:
            saved_id = str(json.loads(path.read_text(encoding='utf-8'))['project']['id'])
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise HTTPException(409, f'Файл {path.name} уже существует и не удалось проверить его владельца. Выберите другое имя проекта.') from exc
        if saved_id != project.project.id or str(project.project.fileName or '').casefold() != path.name.casefold():
            raise HTTPException(409, f'Файл {path.name} уже принадлежит другому проекту. Переименуйте текущий проект перед сохранением.')
    project.project.fileName = path.name
    payload = project.model_dump(mode="json", exclude={"gridSettings", "viewSettings"})
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp_path.replace(path)
    remember_recent_project(CONFIG_DIR, path)
    return LocalProjectSaveResponse(saved=True, fileName=path.name, name=project.project.name)


@app.get('/api/projects/local/location')
def open_local_project_location(fileName: str | None = None) -> dict:
    _ensure_projects_dir()
    target = _safe_project_path(fileName) if fileName else PROJECTS_DIR.resolve()
    if fileName and not target.is_file():
        raise HTTPException(404, 'Файл проекта не найден в папке projects.')
    if os.name != 'nt':
        raise HTTPException(501, f'Открытие папки поддерживается в Windows. Путь: {target}')
    try:
        if fileName:
            subprocess.Popen(['explorer.exe', '/select,', str(target)])
        else:
            os.startfile(str(target))
    except OSError as exc:
        raise HTTPException(503, f'Не удалось открыть расположение проекта: {exc}') from exc
    return {'opened': True, 'path': str(target)}


@app.get("/api/projects/local/{file_name}", response_model=PileProject)
def open_local_project(file_name: str) -> PileProject:
    path = _safe_project_path(file_name)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Project file not found")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        project = PileProject.model_validate(payload)
        project.project.fileName = path.name
        project.project.sourceFileName = project.project.sourceFileName or path.name

        remember_recent_project(CONFIG_DIR, path)
        return project
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Cannot open project: {exc}") from exc


@app.post("/api/projects/validate", response_model=ValidateProjectResponse)
def validate_project(project: PileProject) -> ValidateProjectResponse:
    errors: list[str] = []
    warnings: list[str] = []

    point_ids: set[str] = set()
    for p in project.points:
        if p.id in point_ids:
            errors.append(f"Duplicate point id: {p.id}")
        point_ids.add(p.id)

    group_ids = {g.id for g in project.groups}
    for p in project.points:
        if p.groupId and p.groupId not in group_ids:
            errors.append(f"Point {p.id} has unknown groupId {p.groupId}")
        if p.number is None:
            warnings.append(f"Point {p.id} has no number")

    group_orders = [g.order for g in project.groups]
    if len(group_orders) != len(set(group_orders)):
        warnings.append("Some groups have duplicate order values")

    return ValidateProjectResponse(valid=not errors, errors=errors, warnings=warnings)


@app.post("/api/autosave/project", response_model=AutosaveProjectResponse)
def autosave_project(request: AutosaveProjectRequest) -> AutosaveProjectResponse:
    folder = _safe_autosave_folder(request.folderPath)
    project = request.project
    project.project.updatedAt = datetime.now(timezone.utc).isoformat()
    file_name = _autosave_file_name(project)
    path = folder / file_name
    payload = project.model_dump(mode="json")
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp_path.replace(path)
    return AutosaveProjectResponse(saved=True, fileName=file_name, path=str(path))


@app.get("/api/system/select-folder", response_model=SelectFolderResponse)
def select_folder_dialog() -> SelectFolderResponse:
    # Локальная desktop/browser-dev фича. В Docker этот endpoint может быть недоступен.
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        folder = filedialog.askdirectory(title='Папка автосохранений Pile Numbering')
        root.destroy()
        return SelectFolderResponse(folderPath=folder or None)
    except Exception as exc:
        raise HTTPException(status_code=501, detail=f"Folder dialog is not available: {exc}") from exc


@app.post("/api/system/desktop-shortcut", response_model=DesktopShortcutResponse)
def create_desktop_shortcut() -> DesktopShortcutResponse:
    """Create a Windows desktop shortcut to the built EXE.

    The application icon is embedded only during PyInstaller build. This endpoint
    only creates a normal user shortcut that points to dist/PileNumbering.exe or
    to the running frozen executable. It is intentionally unavailable in Docker/Linux.
    """
    try:
        import sys
        if not sys.platform.startswith("win"):
            raise HTTPException(status_code=501, detail="Desktop shortcut is available only on Windows")

        import win32com.client  # type: ignore

        shell = win32com.client.Dispatch("WScript.Shell")
        desktop = Path(shell.SpecialFolders("Desktop"))
        target = Path(sys.executable).resolve() if getattr(sys, "frozen", False) else (ROOT_DIR / "dist" / "PileNumbering.exe").resolve()
        if not target.exists():
            raise HTTPException(status_code=404, detail=f"EXE not found: {target}. Build it first with tools\\06_build_exe.bat")

        shortcut_path = desktop / "Pile Numbering App.lnk"
        shortcut = shell.CreateShortcut(str(shortcut_path))
        shortcut.TargetPath = str(target)
        shortcut.WorkingDirectory = str(target.parent)
        shortcut.IconLocation = str(target)
        shortcut.Description = "Нумератор свайного поля"
        shortcut.Save()
        return DesktopShortcutResponse(created=True, path=str(shortcut_path), target=str(target))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=501, detail=f"Desktop shortcut is not available: {exc}") from exc


@app.post("/api/numbering/rows", response_model=NumberingResponse)
def numbering_rows(request: NumberingRowsRequest) -> NumberingResponse:
    try:
        updated_points = apply_numbering_rows(request)
        return NumberingResponse(points=updated_points)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

# ============================================================
# nanoCAD / COM integration
# ============================================================

class NanoCadBlockImportRequest(BaseModel):
    scope: str = Field(default='auto', pattern='^(auto|selection|all)$')
    scanId: str | None = None
    blockName: str
    numberAttribute: str | None = None
    baseX: float = 0.0
    baseY: float = 0.0
    tolerance: float = 1.0


class NanoCadExportPoint(BaseModel):
    meta: dict = Field(default_factory=dict)
    id: str | None = None
    x: float
    y: float
    number: str | int | float | None = None
    sourceNumber: str | int | float | None = None
    groupId: str | None = None


class NanoCadBlockExportRequest(BaseModel):
    scope: str = Field(default='auto', pattern='^(auto|selection|all)$')
    scanId: str | None = None
    blockName: str
    numberAttribute: str
    points: list[NanoCadExportPoint]
    baseX: float = 0.0
    baseY: float = 0.0
    tolerance: float = 1.0
    selectedGroupIds: list[str] | None = None


class NanoCadModelStudioImportRequest(BaseModel):
    scope: str = Field(default='auto', pattern='^(auto|selection|all)$')
    scanId: str | None = None
    preserveHandles: bool = True
    objectName: str | None = None
    selectedObjectNames: list[str] | None = None
    selectedObjectParameters: dict[str, str] | None = None
    numberParameter: str | None = None
    baseX: float = 0.0
    baseY: float = 0.0
    tolerance: float = 1.0


class NanoCadModelStudioExportRequest(BaseModel):
    saveDrawing: bool = False
    scope: str = Field(default='auto', pattern='^(auto|selection|all)$')
    scanId: str | None = None
    matchMode: str = Field(default='auto', pattern='^(auto|coordinates|handles)$')
    objectName: str | None = None
    selectedObjectNames: list[str] | None = None
    numberParameter: str = ''
    selectedObjectParameters: dict[str, str] | None = None
    points: list[NanoCadExportPoint]
    baseX: float = 0.0
    baseY: float = 0.0
    tolerance: float = 1.0
    selectedGroupIds: list[str] | None = None


class NanoCadSelectHandleRequest(BaseModel):
    handle: str
    documentPath: str
    objectName: str | None = None


class NanoCadPointActionRequest(BaseModel):
    action: str = Field(pattern='^(read|write|position)$')
    handle: str
    documentPath: str
    objectName: str | None = None
    objectKind: str = Field(default='model_studio', pattern='^(model_studio|block)$')
    parameterName: str | None = None
    value: str | None = None


cad.log_event = _log_backend_error


def _raise_if_cad_disconnected(exc):
    if getattr(exc, 'hresult', None) in (-2147023174, -2147023170, -2147417848):
        raise exc


def _cad_scope(doc, model_space, scope='auto'):
    if scope not in ('auto', 'selection', 'all'):
        raise HTTPException(422, 'Неизвестная область сканирования.')
    if scope == 'all':
        cad.emit('cad_scope', scope='all', count=int(model_space.Count))
        return model_space, 'all'
    try:
        selected = doc.PickfirstSelectionSet
        count = int(selected.Count)
    except Exception as exc:
        _raise_if_cad_disconnected(exc)
        # Do not silently scan/write the whole drawing when selection cannot be read.
        raise HTTPException(409, 'nanoCAD не предоставил текущее выделение. Выберите явно «Весь чертёж» или проверьте выделение в nanoCAD.') from exc
    if count:
        cad.emit('cad_scope', scope='selection', count=count)
        return selected, 'selection'
    if scope == 'selection':
        raise HTTPException(400, 'В nanoCAD ничего не выделено. Выделите объекты или выберите весь чертёж.')
    cad.emit('cad_scope', scope='all', count=int(model_space.Count))
    return model_space, 'all'


def _coerce_float_triplet(value) -> tuple[float, float, float] | None:
    try:
        return float(value[0]), float(value[1]), float(value[2] if len(value) > 2 else 0.0)
    except Exception:
        return None


# BEGIN NANOCAD ACTIVE INSTANCE FIX V71
def _nanocad_progid_candidates() -> list[str]:
    """Return nanoCAD ProgIDs in safe attach order.

    Important: these ProgIDs are used only with GetActiveObject. They must not
    be passed to Dispatch, because Dispatch may start another installed nanoCAD
    version (for example 26 while the user opened 25).
    """
    import os

    result: list[str] = []

    explicit = os.environ.get("PILE_NUMBERING_NANOCAD_PROGID", "").strip()
    if explicit:
        result.append(explicit)

    preferred_version = os.environ.get("PILE_NUMBERING_NANOCAD_VERSION", "25").strip()
    versions: list[str] = []
    for raw in (preferred_version, "25", "24", "23", "22", "26"):
        clean = str(raw or "").strip()
        if not clean:
            continue
        if clean.endswith(".0"):
            clean = clean[:-2]
        if clean and clean not in versions:
            versions.append(clean)

    for version in versions:
        result.extend(
            [
                f"nanoCADx64.Application.{version}.0",
                f"nanoCAD.Application.{version}.0",
                f"nanoCADx64.Application.{version}",
                f"nanoCAD.Application.{version}",
            ]
        )

    # Generic active objects are last. GetActiveObject attaches only to a running
    # object; it does not create a new nanoCAD process.
    result.extend(["nanoCAD.Application", "nanoCADx64.Application"])

    unique: list[str] = []
    for item in result:
        if item and item not in unique:
            unique.append(item)
    return unique


def _try_nanocad_application(app_obj):
    doc = getattr(app_obj, "ActiveDocument", None)
    if not doc:
        raise RuntimeError("nanoCAD has no active document")
    model_space = getattr(doc, "ModelSpace", None)
    if model_space is None:
        raise RuntimeError("nanoCAD active document has no ModelSpace")
    return app_obj, doc, model_space


def _wrap_existing_com_object(win32_client, com_object):
    """Wrap an existing ROT COM object without creating a new application."""
    try:
        return win32_client.Dispatch(com_object)
    except Exception:
        return com_object


def _find_running_nanocad_from_rot(pythoncom, win32_client):
    """Best-effort scan of Windows Running Object Table.

    This is a fallback for cases where versioned GetActiveObject ProgIDs are not
    registered even though nanoCAD is already open.
    """
    last_error: Exception | None = None
    try:
        rot = pythoncom.GetRunningObjectTable()
        bind_ctx = pythoncom.CreateBindCtx(0)
        enum = rot.EnumRunning()
    except Exception as exc:
        return None, exc

    while True:
        monikers = enum.Next(1)
        if not monikers:
            break
        moniker = monikers[0]
        display_name = ""
        try:
            display_name = moniker.GetDisplayName(bind_ctx, None) or ""
        except Exception:
            display_name = ""

        if "nanocad" not in display_name.lower():
            continue

        try:
            raw_obj = rot.GetObject(moniker)
            wrapped = _wrap_existing_com_object(win32_client, raw_obj)
            candidates = [wrapped]
            for attr in ("Application", "Parent"):
                try:
                    candidate = getattr(wrapped, attr)
                    if candidate is not None:
                        candidates.append(candidate)
                except Exception:
                    pass

            for candidate in candidates:
                try:
                    return _try_nanocad_application(candidate), None
                except Exception as exc:
                    last_error = exc
        except Exception as exc:
            last_error = exc

    return None, last_error


def _connect_nanocad():
    """Connect to an already running nanoCAD instance through COM.

    pywin32 is optional and Windows-only. Docker/Linux builds keep working because
    this function imports win32com only when a nanoCAD endpoint is called.

    The function intentionally uses GetActiveObject/ROT and does not call
    Dispatch with a ProgID, so it will not start another installed nanoCAD version.
    """
    try:
        import pythoncom  # type: ignore
        import win32com.client  # type: ignore
    except Exception as exc:
        raise HTTPException(
            status_code=501,
            detail="nanoCAD COM integration requires Windows and pywin32. Run: backend\\.venv\\Scripts\\python.exe -m pip install pywin32",
        ) from exc

    last_error: Exception | None = None

    for progid in _nanocad_progid_candidates():
        try:
            app_obj = win32com.client.GetActiveObject(progid)
            return _try_nanocad_application(app_obj)
        except Exception as exc:
            last_error = exc

    rot_result, rot_error = _find_running_nanocad_from_rot(pythoncom, win32com.client)
    if rot_result is not None:
        return rot_result
    if rot_error is not None:
        last_error = rot_error

    raise HTTPException(
        status_code=503,
        detail=(
            "Could not connect to an already running nanoCAD instance. "
            "Open the required nanoCAD version with an active document first. "
            f"Last error: {last_error}"
        ),
    )
# END NANOCAD ACTIVE INSTANCE FIX V71


def _is_block_reference(entity) -> bool:
    try:
        return str(entity.ObjectName) == 'AcDbBlockReference'
    except Exception:
        return False


def _block_name(entity) -> str:
    for attr in ('EffectiveName', 'Name'):
        try:
            value = getattr(entity, attr)
            if value:
                return str(value)
        except Exception:
            continue
    return 'UNKNOWN_BLOCK'


def _block_attributes(entity) -> dict[str, str]:
    result: dict[str, str] = {}
    try:
        for item in entity.GetAttributes():
            tag = str(getattr(item, 'TagString', '') or '').strip()
            if not tag:
                continue
            result[tag] = str(getattr(item, 'TextString', '') or '')
    except Exception:
        pass
    return result


def _number_attr_score(tag: str, values: list[str]) -> int:
    clean = tag.upper().replace(' ', '').replace('-', '_')
    score = 0
    if 'НОМЕР' in clean or 'NOMER' in clean or 'NUMBER' in clean or clean in {'N', 'NO', 'NUM'}:
        score += 80
    if 'СВА' in clean or 'PILE' in clean or 'POINT' in clean:
        score += 35
    numeric_values = 0
    for value in values[:25]:
        text = str(value).strip().replace(',', '.')
        if text and re.fullmatch(r'[-+]?\d+(?:\.\d+)?', text):
            numeric_values += 1
    score += min(40, numeric_values * 4)
    return score


def _parse_numeric_number(value) -> int | None:
    """Return an integer pile number or None.

    PilePoint.number is an int in the project schema. Some Model Studio
    parameters are numeric strings with decimals (for example marks, heights,
    weights). Older code returned float for such values, and Pydantic could
    raise a validation error when a per-object import parameter contained a
    fractional value. Keep the original sourceNumber text, but only prefill the
    editable number when it is safely an integer.
    """
    if value is None:
        return None
    text = str(value).strip().replace(',', '.')
    if not text:
        return None
    if re.fullmatch(r'[-+]?\d+', text):
        try:
            return int(text)
        except Exception:
            return None
    if re.fullmatch(r'[-+]?\d+\.\d+', text):
        try:
            parsed = float(text)
            return int(parsed) if parsed.is_integer() else None
        except Exception:
            return None
    return None


def _export_number_text(point: NanoCadExportPoint) -> str | None:
    value = point.number if point.number is not None else point.sourceNumber
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _set_block_attribute(entity, attr_name: str, value: str) -> bool:
    try:
        for item in entity.GetAttributes():
            tag = str(getattr(item, 'TagString', '') or '').strip()
            if tag.upper() == attr_name.upper():
                item.TextString = value
                try:
                    item.Update()
                except Exception:
                    pass
                try:
                    entity.Update()
                except Exception:
                    pass
                return True
    except Exception:
        pass
    return False


def _point_match_key(point: NanoCadExportPoint, base_x: float, base_y: float) -> tuple[float, float]:
    return point.x + base_x, point.y + base_y


def _filter_export_points(points: list[NanoCadExportPoint], selected_group_ids: list[str] | None) -> list[NanoCadExportPoint]:
    if not selected_group_ids:
        return points
    allowed = set(selected_group_ids)
    return [p for p in points if p.groupId in allowed]


def _find_nearest_export_point(x: float, y: float, points: list[NanoCadExportPoint], used: set[int], base_x: float, base_y: float, tolerance: float) -> tuple[int, NanoCadExportPoint, float] | None:
    best: tuple[int, NanoCadExportPoint, float] | None = None
    safe_tolerance = max(0.000001, float(tolerance or 1.0))
    for index, point in enumerate(points):
        if index in used:
            continue
        number_text = _export_number_text(point)
        if number_text is None:
            continue
        px, py = _point_match_key(point, base_x, base_y)
        dist = ((x - px) ** 2 + (y - py) ** 2) ** 0.5
        if dist <= safe_tolerance and (best is None or dist < best[2]):
            best = (index, point, dist)
    return best


def _has_modelstudio_element(entity) -> bool:
    try:
        return getattr(entity, 'Element') is not None
    except Exception as exc:
        _raise_if_cad_disconnected(exc)
        return False


def _modelstudio_api_type(entity) -> str:
    """Low-level API/object type, for example linCSParametricSolid.

    This is useful for diagnostics and UI display, but it is not enough for
    grouping piles: several different parametric parts may share the same API
    type. Grouping must use the real Model Studio element/object name.
    """
    for attr in ('Name', 'ObjectName', 'ClassName'):
        try:
            value = getattr(entity, attr)
            if value:
                return str(value).strip()
        except Exception:
            continue
    return 'ModelStudioObject'


def _modelstudio_element_title(entity) -> str:
    """Human/model element name used as the import group key.

    For piles this is usually Element.Name, e.g. "Свая железобетонная СП...".
    Falling back to PART_NAME/PART_TAG prevents different pile types from being
    merged into one linCSParametricSolid bucket.
    """
    try:
        element = getattr(entity, 'Element')
        for attr in ('Name', 'Caption', 'DisplayName', 'TypeName'):
            try:
                value = getattr(element, attr)
                if value:
                    text = str(value).strip()
                    if text:
                        return text
            except Exception:
                continue
    except Exception:
        pass

    params = _iter_modelstudio_parameters(entity)
    part_name = str(params.get('PART_NAME') or params.get('PART_TYPE') or '').strip()
    part_tag = str(params.get('PART_TAG') or params.get('ASSEMBLY_TAG') or '').strip()
    title = ' '.join(bit for bit in (part_name, part_tag) if bit).strip()
    if title:
        return title
    return _modelstudio_api_type(entity)


def _modelstudio_name(entity) -> str:
    return _modelstudio_element_title(entity)

def _modelstudio_candidate_owners(entity) -> list:
    # Model Studio wraps the visible nanoCAD entity into several COM layers.
    # The parametric XML contains local primitive geometry; global placement is
    # usually exposed by the outer Object/AcadObject/NativeObject or by UnitPosition.
    owners = []

    def add(value) -> None:
        if value is not None and all(value is not item for item in owners):
            owners.append(value)

    add(entity)
    queue = [entity]
    seen: set[int] = set()
    nested_attrs = (
        'Object', 'Element', 'BaseObject', 'Geometry', 'Entity', 'SourceObject',
        'AcadObject', 'NativeObject', 'DBObject', 'ModelObject', 'Object3D',
        'Part', 'PartObject', 'Owner', 'Parent', 'BlockReference',
        'CoordinateSystem', 'Placement', 'Transform', 'Transformation', 'Matrix',
    )
    for _depth in range(4):
        next_queue = []
        for owner in queue:
            marker = id(owner)
            if marker in seen:
                continue
            seen.add(marker)
            for attr in nested_attrs:
                try:
                    child = getattr(owner, attr, None)
                except Exception:
                    child = None
                if child is not None and child is not owner:
                    add(child)
                    next_queue.append(child)
        queue = next_queue
    return owners


def _safe_float(value) -> float | None:
    try:
        if value is None:
            return None
        text = str(value).strip().replace(',', '.')
        if not text or text.lower() in {'default', 'none', 'nan'}:
            return None
        return float(text)
    except Exception:
        return None


def _parse_unit_position_text(value) -> tuple[float, float, float] | None:
    # Model Studio pile objects expose world placement here, for example:
    # "{19654.121125259637;4881.321760342556;0}".
    try:
        if not isinstance(value, str):
            return None
        text = value.strip()
        if not text:
            return None
        if text.startswith('{') and text.endswith('}'):
            text = text[1:-1]
        text = text.replace(',', '.')
        delimiter = ';' if ';' in text else ','
        parts = [part.strip() for part in text.split(delimiter) if part.strip()]
        if len(parts) < 2:
            return None
        x = float(parts[0])
        y = float(parts[1])
        z = float(parts[2]) if len(parts) > 2 else 0.0
        return x, y, z
    except Exception:
        return None


def _coerce_float_pair_or_triplet(value) -> tuple[float, float, float] | None:
    unit_position = _parse_unit_position_text(value)
    if unit_position:
        return unit_position

    point = _coerce_float_triplet(value)
    if point:
        return point

    for x_attr, y_attr, z_attr in (('X', 'Y', 'Z'), ('x', 'y', 'z')):
        try:
            x = _safe_float(getattr(value, x_attr))
            y = _safe_float(getattr(value, y_attr))
            z = _safe_float(getattr(value, z_attr, 0.0))
            if x is not None and y is not None:
                return x, y, z if z is not None else 0.0
        except Exception:
            pass

    try:
        x = _safe_float(value[0])
        y = _safe_float(value[1])
        z = _safe_float(value[2]) if len(value) > 2 else 0.0
        if x is not None and y is not None:
            return x, y, z if z is not None else 0.0
    except Exception:
        pass

    return None


def _point_from_scalar_attrs(owner) -> tuple[float, float, float] | None:
    # Never use primitive-local StartPointX/EndPointX from parametric XML here.
    # For piles those are local -150/150 offsets, not model coordinates.
    scalar_groups = (
        ('UnitPositionX', 'UnitPositionY', 'UnitPositionZ'),
        ('X', 'Y', 'Z'),
        ('PositionX', 'PositionY', 'PositionZ'),
        ('LocationX', 'LocationY', 'LocationZ'),
        ('OriginX', 'OriginY', 'OriginZ'),
        ('InsertionX', 'InsertionY', 'InsertionZ'),
        ('InsertionPointX', 'InsertionPointY', 'InsertionPointZ'),
        ('BasePointX', 'BasePointY', 'BasePointZ'),
        ('CenterX', 'CenterY', 'CenterZ'),
    )
    for x_attr, y_attr, z_attr in scalar_groups:
        try:
            x = _safe_float(getattr(owner, x_attr, None))
            y = _safe_float(getattr(owner, y_attr, None))
            z = _safe_float(getattr(owner, z_attr, 0.0))
            if x is not None and y is not None:
                return x, y, z if z is not None else 0.0
        except Exception:
            continue
    return None


def _point_from_matrix_value(value) -> tuple[float, float, float] | None:
    try:
        flat = [float(item) for item in value]
    except Exception:
        return None
    if len(flat) >= 16:
        candidates = ((flat[12], flat[13], flat[14]), (flat[3], flat[7], flat[11]))
        for x, y, z in candidates:
            if abs(x) > 1e-12 or abs(y) > 1e-12 or abs(z) > 1e-12:
                return x, y, z
    if len(flat) >= 12:
        x, y, z = flat[9], flat[10], flat[11]
        if abs(x) > 1e-12 or abs(y) > 1e-12 or abs(z) > 1e-12:
            return x, y, z
    return None


def _bbox_center_from_value(value) -> tuple[float, float, float] | None:
    if value is None:
        return None

    pairs = []
    try:
        if len(value) >= 2:
            pairs.append((value[0], value[1]))
    except Exception:
        pass

    for a_name, b_name in (('MinPoint', 'MaxPoint'), ('MinimumPoint', 'MaximumPoint'), ('Min', 'Max')):
        try:
            pairs.append((getattr(value, a_name), getattr(value, b_name)))
        except Exception:
            pass

    for a, b in pairs:
        pa = _coerce_float_pair_or_triplet(a)
        pb = _coerce_float_pair_or_triplet(b)
        if pa and pb:
            return ((pa[0] + pb[0]) / 2.0, (pa[1] + pb[1]) / 2.0, (pa[2] + pb[2]) / 2.0)
    return None


def _bbox_center_from_com_method(owner, method_name: str) -> tuple[float, float, float] | None:
    try:
        func = getattr(owner, method_name, None)
    except Exception:
        return None
    if not callable(func):
        return None

    try:
        center = _bbox_center_from_value(func())
        if center:
            return center
    except Exception:
        pass

    try:
        import pythoncom  # type: ignore
        import win32com.client  # type: ignore
        min_pt = win32com.client.VARIANT(pythoncom.VT_ARRAY | pythoncom.VT_R8 | pythoncom.VT_BYREF, [0.0, 0.0, 0.0])
        max_pt = win32com.client.VARIANT(pythoncom.VT_ARRAY | pythoncom.VT_R8 | pythoncom.VT_BYREF, [0.0, 0.0, 0.0])
        result = func(min_pt, max_pt)
        center = _bbox_center_from_value((getattr(min_pt, 'value', min_pt), getattr(max_pt, 'value', max_pt)))
        if center:
            return center
        return _bbox_center_from_value(result)
    except Exception:
        pass

    return None


def _short_debug_value(value) -> str:
    try:
        text = str(value)
    except Exception as exc:
        return f'<unreadable:{type(exc).__name__}>'
    text = text.replace('\r', ' ').replace('\n', ' ').strip()
    return text[:180]


def _modelstudio_coordinate_debug(entity) -> dict:
    result: dict[str, object] = {'owners': []}
    interesting_attrs = (
        'Name', 'ObjectName', 'ClassName', 'Handle', 'UnitPosition', 'InsertionPoint', 'Position',
        'Origin', 'Location', 'LocationPoint', 'BasePoint', 'Point', 'Center',
        'X', 'Y', 'Z', 'PositionX', 'PositionY', 'PositionZ', 'LocationX',
        'LocationY', 'LocationZ', 'InsertionPointX', 'InsertionPointY',
        'InsertionPointZ', 'BasePointX', 'BasePointY', 'BasePointZ', 'CenterX',
        'CenterY', 'CenterZ', 'BoundingBox', 'Bounds', 'Extents', 'GeometricExtents',
        'CoordinateSystem', 'Placement', 'Transform', 'Transformation', 'Matrix',
    )
    owners_info = []
    for index, owner in enumerate(_modelstudio_candidate_owners(entity)[:12]):
        info: dict[str, object] = {'index': index, 'pythonType': type(owner).__name__, 'attrs': {}}
        attrs: dict[str, str] = {}
        for attr in interesting_attrs:
            try:
                value = getattr(owner, attr, None)
            except Exception:
                continue
            if value is None or callable(value):
                continue
            attrs[attr] = _short_debug_value(value)
        info['attrs'] = attrs
        owners_info.append(info)
    result['owners'] = owners_info
    return result


def _entity_insertion_point(entity) -> tuple[float, float, float] | None:
    # UnitPosition is the normal global placement for Model Studio objects.
    # Read it before walking the many optional nested COM owners and properties.
    try:
        direct_position = _coerce_float_pair_or_triplet(getattr(entity, 'UnitPosition', None))
        if direct_position is not None:
            return direct_position
    except Exception as exc:
        _raise_if_cad_disconnected(exc)
    owners = _modelstudio_candidate_owners(entity)

    point_attrs = (
        'UnitPosition',
        'InsertionPoint', 'Position', 'Origin', 'Location', 'LocationPoint',
        'BasePoint', 'Point', 'Center'
    )
    for owner in owners:
        scalar_point = _point_from_scalar_attrs(owner)
        if scalar_point:
            return scalar_point
        for attr in point_attrs:
            try:
                value = getattr(owner, attr, None)
                point = _coerce_float_pair_or_triplet(value)
                if point:
                    return point
                matrix_point = _point_from_matrix_value(value)
                if matrix_point:
                    return matrix_point
            except Exception:
                continue

    matrix_attrs = ('CoordinateSystem', 'Placement', 'Transform', 'Transformation', 'Matrix')
    for owner in owners:
        for attr in matrix_attrs:
            try:
                point = _point_from_matrix_value(getattr(owner, attr, None))
                if point:
                    return point
            except Exception:
                continue

    bbox_attrs = ('BoundingBox', 'Bounds', 'Extents', 'GeometricExtents')
    for owner in owners:
        for attr in bbox_attrs:
            try:
                center = _bbox_center_from_value(getattr(owner, attr, None))
                if center:
                    return center
            except Exception:
                continue

    for owner in owners:
        for method in ('GetBoundingBox', 'GetBox', 'GetExtents', 'GetGeometricExtents'):
            center = _bbox_center_from_com_method(owner, method)
            if center:
                return center

    return None



def _parameter_stat_value(parameters: dict[str, dict], names: tuple[str, ...]) -> str:
    upper = {key.upper(): value for key, value in parameters.items()}
    for name in names:
        stat = upper.get(name.upper())
        if not stat:
            continue
        samples = stat.get('sampleValues') or []
        if samples:
            value = str(samples[0]).strip()
            if value:
                return value
    return ''


def _modelstudio_display_name(name: str, parameters: dict[str, dict]) -> str:
    # UI "Имя": only the human part name, without appending the API type.
    part_name = _parameter_stat_value(parameters, ('PART_NAME', 'PART_TYPE'))
    part_tag = _parameter_stat_value(parameters, ('PART_TAG', 'ASSEMBLY_TAG'))
    exp_group = _parameter_stat_value(parameters, ('EXPLICATION_GROUP',))
    display = ' '.join(bit for bit in (part_name, part_tag) if bit).strip()
    return display or exp_group or name

def _modelstudio_allowed_names(single_name: str | None, selected_names: list[str] | None) -> set[str]:
    names: set[str] = set()
    for value in selected_names or []:
        text = str(value or '').strip()
        if text:
            names.add(text)
    single = str(single_name or '').strip()
    if single and not names:
        names.add(single)
    return names


def _cad_select_lisp(handle: str) -> str:
    """Same handent/sssetfirst selection used by our CAD selection tool."""
    clean = str(handle or '').strip().upper()
    if not re.fullmatch(r'[0-9A-F]+', clean):
        raise HTTPException(422, 'Некорректный handle объекта.')
    return f'((lambda (/ pn_ss pn_e) (setq pn_ss (ssadd)) (setq pn_e (handent "{clean}")) (if pn_e (ssadd pn_e pn_ss)) (sssetfirst nil pn_ss) (princ)))\r'


@app.post('/api/nanocad/modelstudio/select')
@cad.serialized
def select_nanocad_object_by_handle(request: NanoCadSelectHandleRequest) -> dict:
    script = _cad_select_lisp(request.handle)
    app_obj, doc, _ms = _connect_nanocad()
    current_document = str(getattr(doc, 'FullName', '') or '').strip()
    source_document = request.documentPath.strip()
    norm = lambda value: value.replace('\\', '/').casefold()
    if not current_document or not source_document or norm(current_document) != norm(source_document):
        raise HTTPException(409, 'Откройте исходный DWG этой точки в nanoCAD. Handle действителен только в своём чертеже.')
    try:
        entity = doc.HandleToObject(request.handle.strip().upper())
        if request.objectName and _has_modelstudio_element(entity) and _modelstudio_name(entity) != request.objectName:
            raise HTTPException(409, 'Объект с этим handle теперь имеет другой тип. Повторите импорт из nanoCAD.')
        doc.SendCommand(script)
        cad.emit('cad_object_selection_sent', handle=request.handle.upper(), document=current_document)
        try:
            import ctypes
            ctypes.windll.user32.SetForegroundWindow(int(app_obj.HWND))
        except Exception:
            pass  # nanoCAD may refuse foreground focus; selection itself was sent.
        return {'selected': True, 'handle': request.handle.upper(), 'documentName': str(getattr(doc, 'Name', '') or '')}
    except HTTPException:
        raise
    except Exception as exc:
        _raise_if_cad_disconnected(exc)
        raise HTTPException(404, f'Объект {request.handle} не найден в исходном DWG. Повторите импорт.') from exc


@app.post('/api/nanocad/point/action')
@cad.serialized
def act_on_nanocad_point(request: NanoCadPointActionRequest) -> dict:
    handle = request.handle.strip().upper()
    if not re.fullmatch(r'[0-9A-F]+', handle):
        raise HTTPException(422, 'Некорректный handle объекта.')
    _app, doc, _ms = _connect_nanocad()
    current_document = str(getattr(doc, 'FullName', '') or '').strip()
    source_document = request.documentPath.strip()
    if not current_document or not source_document or Path(current_document).as_posix().casefold() != Path(source_document).as_posix().casefold():
        raise HTTPException(409, 'Откройте исходный DWG этой точки в nanoCAD. Handle действителен только в своём чертеже.')
    try:
        entity = doc.HandleToObject(handle)
    except Exception as exc:
        _raise_if_cad_disconnected(exc)
        raise HTTPException(404, f'Объект {handle} не найден в исходном DWG.') from exc
    if request.objectKind == 'block':
        if not _is_block_reference(entity):
            raise HTTPException(409, 'По сохранённому handle теперь находится не блок. Повторите импорт.')
        object_name = _block_name(entity)
        insertion = _coerce_float_triplet(getattr(entity, 'InsertionPoint', None))
    else:
        if not _has_modelstudio_element(entity):
            raise HTTPException(409, 'По сохранённому handle теперь находится не объект Model Studio. Повторите импорт.')
        object_name = _modelstudio_name(entity)
        insertion = _entity_insertion_point(entity)
    if request.objectName and object_name != request.objectName:
        raise HTTPException(409, 'Тип объекта изменился после импорта. Повторите сканирование и импорт.')
    result = {'handle': handle, 'documentName': str(getattr(doc, 'Name', '') or ''), 'objectName': object_name}
    if request.action == 'position':
        if insertion is None:
            raise HTTPException(409, 'У объекта не удалось прочитать координаты.')
        result['position'] = {'x': insertion[0], 'y': insertion[1], 'z': insertion[2]}
    else:
        parameter = str(request.parameterName or '').strip()
        if not parameter:
            raise HTTPException(422, 'Укажите параметр номера этой точки.')
        if request.objectKind == 'block':
            attrs = _block_attributes(entity)
            actual = next((key for key in attrs if key.casefold() == parameter.casefold()), None)
            if actual is None:
                raise HTTPException(409, f'У блока нет атрибута {parameter}.')
            if request.action == 'write':
                if request.value is None or not str(request.value).strip():
                    raise HTTPException(422, 'У точки нет номера для записи.')
                if not _set_block_attribute(entity, actual, str(request.value)):
                    raise HTTPException(409, f'Не удалось записать атрибут {actual}.')
                attrs = _block_attributes(entity)
            raw_number = attrs[actual]
        else:
            found, raw_number, actual = _read_modelstudio_parameter(entity, parameter)
            if not found:
                raise HTTPException(409, f'У объекта нет параметра {parameter}.')
            if request.action == 'write':
                if request.value is None or not str(request.value).strip():
                    raise HTTPException(422, 'У точки нет номера для записи.')
                if not _set_modelstudio_parameter(entity, actual, str(request.value)):
                    raise HTTPException(409, f'Не удалось записать параметр {actual}.')
                found, raw_number, _actual = _read_modelstudio_parameter(entity, actual)
                if not found:
                    raise HTTPException(409, f'Параметр {actual} недоступен после записи.')
        result.update({'parameterName': actual, 'rawNumber': raw_number, 'number': _parse_numeric_number(raw_number)})
    cad.emit('point_action_completed', action=request.action, handle=handle, objectName=object_name,
             parameter=result.get('parameterName'), number=result.get('rawNumber'), position=result.get('position'))
    return result


def _iter_modelstudio_parameters(entity) -> dict[str, str]:
    result: dict[str, str] = {}
    try:
        element = getattr(entity, 'Element')
        params = getattr(element, 'Parameters')
    except Exception as exc:
        _raise_if_cad_disconnected(exc)
        return result

    # Model Studio COM collections are not always iterable, so support both styles.
    try:
        count = int(getattr(params, 'Count'))
        try:
            params.Item(0)
            first_index = 0
        except Exception as exc:
            _raise_if_cad_disconnected(exc)
            first_index = 1
        for index in range(first_index, first_index + count):
            for key in (index,):
                try:
                    param = params.Item(key)
                    break
                except Exception as exc:
                    _raise_if_cad_disconnected(exc)
                    param = None
            if param is None:
                continue
            name = str(getattr(param, 'Name', '') or getattr(param, 'Caption', '') or getattr(param, 'DisplayName', '') or '').strip()
            if not name:
                continue
            try:
                value = getattr(param, 'Value')
            except Exception as exc:
                _raise_if_cad_disconnected(exc)
                value = ''
            result[name] = str(value if value is not None else '')
        return result
    except Exception as exc:
        _raise_if_cad_disconnected(exc)
        pass

    try:
        for param in params:
            name = str(getattr(param, 'Name', '') or getattr(param, 'Caption', '') or getattr(param, 'DisplayName', '') or '').strip()
            if not name:
                continue
            try:
                value = getattr(param, 'Value')
            except Exception as exc:
                _raise_if_cad_disconnected(exc)
                value = ''
            result[name] = str(value if value is not None else '')
    except Exception as exc:
        _raise_if_cad_disconnected(exc)
        pass
    return result


def _read_modelstudio_parameter(entity, parameter_name: str) -> tuple[bool, str, str]:
    """Read one named parameter and verify it belongs to this particular entity.

    Some nanoCAD wrappers reject string keys, so numeric lookup remains a
    compatibility fallback. Unlike a full scan, it reads Value only for the
    matching parameter and stops as soon as it finds it.
    """
    name = str(parameter_name or '').strip()
    if not name:
        return False, '', ''
    try:
        params = entity.Element.Parameters
    except Exception as exc:
        _raise_if_cad_disconnected(exc)
        return False, '', ''

    def parameter_value(param) -> tuple[bool, str, str]:
        try:
            actual_name = str(getattr(param, 'Name', '') or getattr(param, 'Caption', '') or getattr(param, 'DisplayName', '') or '').strip()
            if actual_name.casefold() != name.casefold():
                return False, '', ''
            value = getattr(param, 'Value')
            return True, str(value if value is not None else ''), actual_name
        except Exception as exc:
            _raise_if_cad_disconnected(exc)
            return False, '', ''

    try:
        found = parameter_value(params.Item(name))
        if found[0]:
            return found
    except Exception as exc:
        _raise_if_cad_disconnected(exc)

    try:
        count = int(params.Count)
        try:
            params.Item(0)
            first_index = 0
        except Exception as exc:
            _raise_if_cad_disconnected(exc)
            first_index = 1
        for index in range(first_index, first_index + count):
            try:
                found = parameter_value(params.Item(index))
                if found[0]:
                    return found
            except Exception as exc:
                _raise_if_cad_disconnected(exc)
    except Exception as exc:
        _raise_if_cad_disconnected(exc)

    # A few wrappers expose only iteration, not Count/Item.
    try:
        for param in params:
            found = parameter_value(param)
            if found[0]:
                return found
    except Exception as exc:
        _raise_if_cad_disconnected(exc)
    return False, '', ''


def _suggest_modelstudio_number_parameter(parameters: dict[str, str]) -> str:
    candidates = sorted(parameters, key=lambda name: (-_number_attr_score(name, [parameters[name]]), name))
    if candidates and _number_attr_score(candidates[0], [parameters[candidates[0]]]) >= 40:
        return candidates[0]
    return ''


def _modelstudio_scan_document_key(doc) -> str:
    # FullName distinguishes drawings with identical short names. Unsaved drawings
    # cannot be safely reused across requests.
    return str(getattr(doc, 'FullName', '') or '').strip().replace('\\', '/').casefold()


def _modelstudio_cached_scan(scan_id: str, doc, requested_scope: str) -> dict:
    now = time.monotonic()
    for key, snapshot in list(_MODELSTUDIO_SCAN_CACHE.items()):
        if now - snapshot['createdAt'] > _MODELSTUDIO_SCAN_TTL_SECONDS:
            del _MODELSTUDIO_SCAN_CACHE[key]
    snapshot = _MODELSTUDIO_SCAN_CACHE.get(scan_id)
    if snapshot is None:
        raise HTTPException(409, 'Снимок скана недоступен. Повторите сканирование перед импортом.')
    if snapshot['documentKey'] != _modelstudio_scan_document_key(doc) or snapshot['requestedScope'] != requested_scope:
        raise HTTPException(409, 'После скана изменился чертёж или область. Повторите сканирование перед импортом.')
    return snapshot


def _block_cached_scan(scan_id: str, doc, requested_scope: str) -> dict:
    now = time.monotonic()
    for key, snapshot in list(_BLOCK_SCAN_CACHE.items()):
        if now - snapshot['createdAt'] > _MODELSTUDIO_SCAN_TTL_SECONDS:
            del _BLOCK_SCAN_CACHE[key]
    snapshot = _BLOCK_SCAN_CACHE.get(scan_id)
    if snapshot is None:
        raise HTTPException(409, 'Снимок скана блоков недоступен. Повторите сканирование.')
    if snapshot['documentKey'] != _modelstudio_scan_document_key(doc) or snapshot['requestedScope'] != requested_scope:
        raise HTTPException(409, 'После скана изменился чертёж или область. Повторите сканирование.')
    return snapshot


def _modelstudio_import_point(*, name: str, api_type: str, handle: str, insertion: tuple,
                              document_path: str, number_parameter: str, source_number: str | None,
                              params: dict[str, str], request: NanoCadModelStudioImportRequest,
                              ordinal: int) -> PilePoint:
    x, y, z = insertion
    return PilePoint(
        id=f'p-{uuid4().hex[:12]}',
        sourceId=f'nanocad:modelstudio:{name}:{ordinal}',
        x=x - request.baseX, y=y - request.baseY,
        sourceNumber=source_number, number=_parse_numeric_number(source_number),
        groupId=None, locked=False, manualNumber=False, syncState=SyncState.added,
        meta={
            'source': 'nanocad_modelstudio',
            **({'cadHandle': handle, 'cadDocument': document_path} if request.preserveHandles else {}),
            'objectName': name, 'apiType': api_type,
            'numberParameter': number_parameter or None,
            'importBasePoint': {'x': request.baseX, 'y': request.baseY},
            'rawInsertionPoint': {'x': x, 'y': y, 'z': z},
            'parameters': params,
        },
    )


def _set_modelstudio_parameter(entity, parameter_name: str, value: str) -> bool:
    """Write a Model Studio parameter through the documented COM API.

    The Model Studio CS COM reference describes the writable path as:
    object.Element.Parameters.SetParameter(name, value[, caption, comment])
    and MDSParametricEnt.UpdateGraphics() for recalculating parametric graphics.
    Direct param.Value assignment is only a last fallback for older/odd builds.
    """
    clean_name = str(parameter_name or '').strip()
    if not clean_name:
        return False
    clean_value = str(value)

    try:
        element = getattr(entity, 'Element')
        params = getattr(element, 'Parameters')
    except Exception as exc:
        _raise_if_cad_disconnected(exc)
        return False

    def existing_parameter():
        # Parameters.Item supports both string and integer indices according to
        # the COM reference. Prefer lookup by parameter name; enumerate only to
        # preserve caption/comment for the 4-argument SetParameter overload.
        for key in (clean_name, clean_name.upper(), clean_name.lower()):
            try:
                return params.Item(key)
            except Exception as exc:
                _raise_if_cad_disconnected(exc)
                pass
        try:
            count = int(getattr(params, 'Count'))
            try:
                params.Item(0)
                first_index = 0
            except Exception as exc:
                _raise_if_cad_disconnected(exc)
                first_index = 1
            for index in range(first_index, first_index + count):
                param = None
                for key in (index,):
                    try:
                        param = params.Item(key)
                        break
                    except Exception as exc:
                        _raise_if_cad_disconnected(exc)
                        pass
                if param is None:
                    continue
                for attr in ('Name', 'Caption', 'DisplayName'):
                    try:
                        name = str(getattr(param, attr, '') or '').strip()
                        if name.upper() == clean_name.upper():
                            return param
                    except Exception as exc:
                        _raise_if_cad_disconnected(exc)
                        pass
        except Exception as exc:
            _raise_if_cad_disconnected(exc)
            pass
        try:
            for param in params:
                for attr in ('Name', 'Caption', 'DisplayName'):
                    try:
                        name = str(getattr(param, attr, '') or '').strip()
                        if name.upper() == clean_name.upper():
                            return param
                    except Exception as exc:
                        _raise_if_cad_disconnected(exc)
                        pass
        except Exception as exc:
            _raise_if_cad_disconnected(exc)
            pass
        return None

    def refresh_modelstudio() -> None:
        # For IMDSParametricEnt the documented recalculation method is
        # UpdateGraphics. Invoke the first working method only: calling every
        # regeneration variant on each pile makes a large export needlessly slow.
        for owner in (entity, element):
            for method in ('UpdateGraphics', 'Update', 'Evaluate', 'Regen', 'Refresh'):
                try:
                    func = getattr(owner, method, None)
                    if callable(func):
                        try:
                            func()
                        except TypeError:
                            # A few wrappers require a regeneration mode.
                            func(1)
                        return
                except Exception as exc:
                    _raise_if_cad_disconnected(exc)
                    pass

    def read_back_ok() -> bool:
        try:
            param = params.Item(clean_name)
            current = getattr(param, 'Value', '')
            return str(current if current is not None else '') == clean_value
        except Exception as exc:
            _raise_if_cad_disconnected(exc)
            current = next((v for k, v in _iter_modelstudio_parameters(entity).items()
                            if k.casefold() == clean_name.casefold()), None)
            return current is not None and str(current) == clean_value

    existing = existing_parameter()
    if existing is None:
        cad.emit('modelstudio_write_parameter_missing', parameter=clean_name)
        return False
    caption = ''
    comment = ''
    if existing is not None:
        try:
            caption = str(getattr(existing, 'Comment', '') or '')
        except Exception as exc:
            _raise_if_cad_disconnected(exc)
            caption = ''
        try:
            comment = str(getattr(existing, 'ValueComment', '') or '')
        except Exception as exc:
            _raise_if_cad_disconnected(exc)
            comment = ''

    # Correct documented writer: Element.Parameters.SetParameter(...).
    set_parameter = getattr(params, 'SetParameter', None)
    if callable(set_parameter):
        for args in (
            (clean_name, clean_value),
            (clean_name, clean_value, caption, comment),
            (clean_name, clean_value, '', ''),
        ):
            try:
                set_parameter(*args)
                refresh_modelstudio()
                if read_back_ok():
                    return True
                cad.emit('modelstudio_write_readback_mismatch', parameter=clean_name, expected=clean_value)
            except Exception as exc:
                _raise_if_cad_disconnected(exc)
                _log_backend_error('modelstudio_write_attempt_failed', exc, {'parameter': clean_name, 'argumentCount': len(args)}, level=logging.WARNING)
                continue

    # Last fallback only: direct Parameter.Value assignment. This is kept for old
    # objects, but the normal path above is SetParameter on Element.Parameters.
    if existing is not None:
        try:
            setattr(existing, 'Value', clean_value)
            refresh_modelstudio()
            return read_back_ok()
        except Exception as exc:
            _raise_if_cad_disconnected(exc)
            _log_backend_error('modelstudio_write_fallback_failed', exc, {'parameter': clean_name}, level=logging.WARNING)

    return False

def _summarize_blocks(ms, snapshot_objects: list[dict] | None = None) -> list[dict]:
    summaries: dict[str, dict] = {}
    for entity in cad.entities(ms):
        if not _is_block_reference(entity):
            continue
        name = _block_name(entity)
        item = summaries.setdefault(name, {
            'name': name,
            'count': 0,
            'sampleInsertionPoint': None,
            'attributes': {},
        })
        item['count'] += 1
        if item['sampleInsertionPoint'] is None:
            point = _coerce_float_triplet(getattr(entity, 'InsertionPoint', None))
            item['sampleInsertionPoint'] = list(point) if point else None
        attrs = _block_attributes(entity)
        if snapshot_objects is not None:
            snapshot_objects.append({
                'name': name,
                'handle': str(getattr(entity, 'Handle', '') or '').strip().upper(),
                'insertion': _coerce_float_triplet(getattr(entity, 'InsertionPoint', None)),
                'attributes': attrs,
            })
        for tag, value in attrs.items():
            stat = item['attributes'].setdefault(tag, {'tag': tag, 'count': 0, 'sampleValues': []})
            stat['count'] += 1
            if value not in stat['sampleValues'] and len(stat['sampleValues']) < 6:
                stat['sampleValues'].append(value)

    result: list[dict] = []
    for item in summaries.values():
        attrs = list(item['attributes'].values())
        for attr in attrs:
            attr['score'] = _number_attr_score(attr['tag'], attr.get('sampleValues', []))
        attrs.sort(key=lambda a: (-int(a.get('score') or 0), str(a.get('tag') or '')))
        candidates = [a['tag'] for a in attrs if int(a.get('score') or 0) >= 40][:5]
        result.append({
            'name': item['name'],
            'count': item['count'],
            'sampleInsertionPoint': item['sampleInsertionPoint'],
            'attributes': attrs,
            'numberAttributeCandidates': candidates,
        })
    result.sort(key=lambda item: (-int(item['count']), item['name']))
    return result


@app.get('/api/nanocad/blocks/scan')
@cad.serialized
def scan_nanocad_blocks(scope: str = 'auto') -> dict:
    _app, doc, ms = _connect_nanocad()
    ms, resolved_scope = _cad_scope(doc, ms, scope)
    try:
        name = str(getattr(doc, 'Name', '') or '')
    except Exception:
        name = None
    cad.progress('Сканирование блоков', documentName=name or 'Без имени')
    snapshot_objects: list[dict] = []
    blocks = _summarize_blocks(ms, snapshot_objects)
    document_key = _modelstudio_scan_document_key(doc)
    scan_id = None
    if document_key:
        scan_id = uuid4().hex
        _BLOCK_SCAN_CACHE.clear()
        _BLOCK_SCAN_CACHE[scan_id] = {
            'createdAt': time.monotonic(), 'documentKey': document_key,
            'requestedScope': scope, 'resolvedScope': resolved_scope,
            'objects': snapshot_objects,
        }
    cad.emit('block_scan_snapshot', scanId=scan_id, cachedObjects=len(snapshot_objects), document=document_key)
    return {
        'connected': True,
        'scope': resolved_scope,
        'documentName': name,
        'scanId': scan_id,
        'blocks': blocks,
    }


@app.post('/api/nanocad/blocks/pick')
@cad.serialized
def pick_nanocad_block() -> dict:
    _app, doc, _ms = _connect_nanocad()
    try:
        utility = doc.Utility
        utility.Prompt('Выберите блок сваи в nanoCAD и нажмите Enter...\n')
        selected = utility.GetEntity()
        entity = selected[0]
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f'Выбор объекта отменён или не удался: {exc}') from exc
    if not _is_block_reference(entity):
        raise HTTPException(status_code=400, detail='Выбранный объект не является блоком AcDbBlockReference')
    attrs = _block_attributes(entity)
    attr_values: dict[str, list[str]] = {tag: [value] for tag, value in attrs.items()}
    candidates = sorted(attrs.keys(), key=lambda tag: -_number_attr_score(tag, attr_values.get(tag, [])))[:5]
    point = _coerce_float_triplet(getattr(entity, 'InsertionPoint', None))
    return {
        'blockName': _block_name(entity),
        'objectName': str(getattr(entity, 'ObjectName', '') or ''),
        'insertionPoint': list(point) if point else None,
        'attributes': attrs,
        'numberAttributeCandidates': [tag for tag in candidates if _number_attr_score(tag, attr_values.get(tag, [])) >= 40],
    }


@app.post('/api/nanocad/blocks/import')
@cad.serialized
def import_nanocad_blocks(request: NanoCadBlockImportRequest) -> dict:
    _app, _doc, ms = _connect_nanocad()
    snapshot = _block_cached_scan(request.scanId, _doc, request.scope) if request.scanId else None
    if snapshot:
        resolved_scope = snapshot['resolvedScope']
    else:
        ms, resolved_scope = _cad_scope(_doc, ms, request.scope)
    block_name = request.blockName.strip()
    document_path = str(getattr(_doc, 'FullName', '') or '')
    if not block_name:
        raise HTTPException(status_code=400, detail='Не задано имя блока')
    points: list[PilePoint] = []
    for entity in (snapshot['objects'] if snapshot else cad.entities(ms)):
        cad.check_cancelled()
        if snapshot:
            name = entity['name']
            insertion = entity['insertion']
            attrs = entity['attributes']
            handle = entity['handle']
        else:
            if not _is_block_reference(entity):
                continue
            name = _block_name(entity)
            insertion = _coerce_float_triplet(getattr(entity, 'InsertionPoint', None))
            handle = str(getattr(entity, 'Handle', '') or '').strip().upper()
        if name != block_name:
            continue
        if insertion is None:
            continue
        if not snapshot:
            attrs = _block_attributes(entity)
        source_number = None
        if request.numberAttribute:
            for tag, value in attrs.items():
                if tag.upper() == request.numberAttribute.upper():
                    source_number = str(value).strip() or None
                    break
        x, y, _z = insertion
        points.append(PilePoint(
            id=f'p-{uuid4().hex[:12]}',
            sourceId=f'nanocad:{block_name}:{len(points) + 1}',
            x=x - request.baseX,
            y=y - request.baseY,
            sourceNumber=source_number,
            number=_parse_numeric_number(source_number),
            groupId=None,
            locked=False,
            manualNumber=False,
            syncState=SyncState.added,
            meta={
                'source': 'nanocad_block',
                'cadHandle': handle,
                'cadDocument': document_path,
                'blockName': block_name,
                'numberParameter': request.numberAttribute or None,
                'importBasePoint': {'x': request.baseX, 'y': request.baseY},
                'rawInsertionPoint': {'x': x, 'y': y, 'z': insertion[2]},
                'attributes': attrs,
            },
        ))
    cad.emit('block_import_summary', imported=len(points), reusedScan=bool(snapshot), scanId=request.scanId)
    return {'count': len(points), 'points': [p.model_dump(mode='json') for p in points], 'reusedScan': bool(snapshot)}



@app.post('/api/nanocad/blocks/export')
@cad.serialized
def export_nanocad_blocks(request: NanoCadBlockExportRequest) -> dict:
    _app, _doc, ms = _connect_nanocad()
    snapshot = _block_cached_scan(request.scanId, _doc, request.scope) if request.scanId else None
    if snapshot:
        resolved_scope = snapshot['resolvedScope']
    else:
        ms, resolved_scope = _cad_scope(_doc, ms, request.scope)
    block_name = request.blockName.strip()
    attr_name = request.numberAttribute.strip()
    if not block_name:
        raise HTTPException(status_code=400, detail='Не задано имя блока')
    if not attr_name:
        raise HTTPException(status_code=400, detail='Не задан атрибут номера')

    source_points = _filter_export_points(request.points, request.selectedGroupIds)
    used: set[int] = set()
    updated = 0
    matched = 0
    missing_attribute = 0
    scanned = 0
    unmatched_blocks: list[dict] = []

    for entity in (snapshot['objects'] if snapshot else cad.entities(ms)):
        cad.check_cancelled()
        if snapshot:
            name = entity['name']
            insertion = entity['insertion']
        else:
            if not _is_block_reference(entity):
                continue
            name = _block_name(entity)
            insertion = _coerce_float_triplet(getattr(entity, 'InsertionPoint', None))
        if name != block_name:
            continue
        if insertion is None:
            continue
        scanned += 1
        x, y, _z = insertion
        found = _find_nearest_export_point(x, y, source_points, used, request.baseX, request.baseY, request.tolerance)
        if found is None:
            if len(unmatched_blocks) < 20:
                unmatched_blocks.append({'x': x, 'y': y})
            continue
        index, point, dist = found
        used.add(index)
        matched += 1
        value = _export_number_text(point)
        if value is None:
            continue
        if snapshot:
            record_handle = entity['handle']
            try:
                entity = _doc.HandleToObject(record_handle)
                if not _is_block_reference(entity) or _block_name(entity) != block_name:
                    raise ValueError('Тип блока изменился после скана')
            except Exception as exc:
                _raise_if_cad_disconnected(exc)
                missing_attribute += 1
                cad.emit('block_snapshot_handle_not_found', handle=record_handle, error=str(exc))
                continue
        if _set_block_attribute(entity, attr_name, value):
            updated += 1
        else:
            missing_attribute += 1

    if updated and request.scanId:
        _BLOCK_SCAN_CACHE.pop(request.scanId, None)

    return {
        'updated': updated,
        'matched': matched,
        'scanned': scanned,
        'points': len(source_points),
        'unmatchedBlocks': unmatched_blocks,
        'unusedPoints': max(0, len(source_points) - len(used)),
        'missingAttribute': missing_attribute,
        'tolerance': request.tolerance,
        'reusedScan': bool(snapshot),
    }


@app.get('/api/nanocad/modelstudio/scan')
@cad.serialized
def scan_modelstudio_objects(scope: str = 'auto') -> dict:
    _app, doc, ms = _connect_nanocad()
    ms, resolved_scope = _cad_scope(doc, ms, scope)
    cad.progress('Сканирование Model Studio', documentName=str(getattr(doc, 'Name', '') or 'Без имени'))
    snapshot_objects: list[dict] = []
    summaries: dict[str, dict] = {}
    skipped_errors = 0
    sampled_schemas = 0
    direct_parameter_reads = 0
    schema_variants = 0
    first_error: str | None = None
    for entity_index, entity in enumerate(cad.entities(ms)):
        try:
            if not _has_modelstudio_element(entity):
                continue
            name = _modelstudio_name(entity)
            api_type = _modelstudio_api_type(entity)
            item = summaries.get(name)
            if item is None:
                item = {
                'name': name,
                'technicalName': api_type,
                'apiType': api_type,
                'displayName': name,
                'count': 0,
                'coordinateCount': 0,
                'sampleInsertionPoint': None,
                'parameters': {},
                '_numberParameter': '',
                '_heterogeneous': False,
                'missingNumberParameter': 0,
                }
                summaries[name] = item
            item['count'] += 1
            if api_type and api_type not in str(item.get('technicalName') or ''):
                item['technicalName'] = f"{item['technicalName']} / {api_type}"
                item['apiType'] = item['technicalName']
            insertion = _entity_insertion_point(entity)
            if insertion is not None:
                item['coordinateCount'] += 1
                if item['sampleInsertionPoint'] is None:
                    item['sampleInsertionPoint'] = list(insertion)
            candidate = item['_numberParameter']
            params = None
            if candidate and not item['_heterogeneous']:
                found, value, _actual_name = _read_modelstudio_parameter(entity, candidate)
                direct_parameter_reads += 1
                if found:
                    params = {candidate: value}
                else:
                    item['missingNumberParameter'] += 1
                    item['_heterogeneous'] = True
                    schema_variants += 1
                    cad.emit('modelstudio_parameter_missing', entityIndex=entity_index, objectName=name, parameter=candidate)
            full_parameters = params is None
            if full_parameters:
                params = _iter_modelstudio_parameters(entity)
                sampled_schemas += 1
            handle = str(getattr(entity, 'Handle', '') or '').strip().upper()
            snapshot_objects.append({
                'name': name, 'apiType': api_type, 'handle': handle,
                'insertion': insertion, 'parameters': params,
                'fullParameters': full_parameters,
            })
            for param_name, value in params.items():
                stat = item['parameters'].setdefault(param_name, {'name': param_name, 'count': 0, 'sampleValues': []})
                stat['count'] += 1
                if value not in stat['sampleValues'] and len(stat['sampleValues']) < 6:
                    stat['sampleValues'].append(value)
            if not item['_numberParameter']:
                item['_numberParameter'] = _suggest_modelstudio_number_parameter(params)
        except Exception as exc:
            _raise_if_cad_disconnected(exc)
            skipped_errors += 1
            if first_error is None:
                first_error = f'{type(exc).__name__}: {exc}'
            _log_backend_error('modelstudio_scan_entity_error', exc, {'entityIndex': entity_index}, level=logging.WARNING)
            continue
    result = []
    for item in summaries.values():
        params = list(item['parameters'].values())
        for param in params:
            param['score'] = _number_attr_score(param['name'], param.get('sampleValues', []))
        params.sort(key=lambda p: (-int(p.get('score') or 0), str(p.get('name') or '')))
        candidates = [p['name'] for p in params if int(p.get('score') or 0) >= 40]
        display_name = _modelstudio_display_name(str(item['name']), item['parameters'])
        result.append({
            'name': item['name'],
            'technicalName': item['technicalName'],
            'apiType': item['apiType'],
            'displayName': display_name,
            'count': item['count'],
            'coordinateCount': item['coordinateCount'],
            'sampleInsertionPoint': item['sampleInsertionPoint'],
            'parameters': params,
            'numberParameterCandidates': candidates,
            'verifiedNumberParameter': item['_numberParameter'] or None,
            'missingNumberParameter': item['missingNumberParameter'],
        })
    result.sort(key=lambda item: (str(item.get('displayName') or item['name']), str(item.get('technicalName') or '')))
    cad.emit('modelstudio_scan_summary', types=len(result), objects=sum(item['count'] for item in result),
             skippedErrors=skipped_errors, schemaSamples=sampled_schemas,
             directParameterReads=direct_parameter_reads, schemaVariants=schema_variants, scope=resolved_scope)
    document_key = _modelstudio_scan_document_key(doc)
    scan_id = None
    if document_key:
        scan_id = uuid4().hex
        _MODELSTUDIO_SCAN_CACHE.clear()  # Only the latest scan is used by the open transfer dialog.
        _MODELSTUDIO_SCAN_CACHE[scan_id] = {
            'createdAt': time.monotonic(), 'documentKey': document_key,
            'requestedScope': scope, 'resolvedScope': resolved_scope,
            'objects': snapshot_objects,
        }
    cad.emit('modelstudio_scan_snapshot', scanId=scan_id, cachedObjects=len(snapshot_objects), document=document_key)
    response = {'connected': True, 'scope': resolved_scope, 'documentName': str(getattr(doc, 'Name', '') or ''), 'objects': result, 'scanId': scan_id}
    if skipped_errors:
        response['diagnostics'] = {'skippedErrors': skipped_errors, 'firstError': first_error, 'logFile': str(_backend_log_file()), 'scope': resolved_scope}
    return response

@app.post('/api/nanocad/modelstudio/import')
@cad.serialized
def import_modelstudio_objects(request: NanoCadModelStudioImportRequest) -> dict:
    _app, _doc, ms = _connect_nanocad()
    snapshot = _modelstudio_cached_scan(request.scanId, _doc, request.scope) if request.scanId else None
    if snapshot:
        resolved_scope = snapshot['resolvedScope']
    else:
        ms, resolved_scope = _cad_scope(_doc, ms, request.scope)
    document_path = str(getattr(_doc, 'FullName', '') or '')
    cad.emit('modelstudio_import_document', document=document_path, preserveHandles=request.preserveHandles)
    points: list[PilePoint] = []
    allowed_names = _modelstudio_allowed_names(request.objectName, request.selectedObjectNames)
    per_object_params = request.selectedObjectParameters or {}
    number_parameters_by_name: dict[str, str] = {}
    full_parameter_reads = 0
    direct_parameter_reads = 0
    missing_number_parameter = 0
    scanned = 0
    matched_by_name = 0
    skipped_no_coordinates = 0
    skipped_empty_parameters = 0
    skipped_errors = 0
    first_coordinate_debug: dict | None = None
    first_error: str | None = None

    source = enumerate(snapshot['objects']) if snapshot else enumerate(cad.entities(ms))
    for entity_index, entity in source:
        cad.check_cancelled()
        try:
            if snapshot:
                name = entity['name']
                api_type = entity['apiType']
                insertion = entity['insertion']
                handle = entity['handle']
            else:
                if not _has_modelstudio_element(entity):
                    continue
                name = _modelstudio_name(entity)
                api_type = _modelstudio_api_type(entity)
                insertion = _entity_insertion_point(entity)
                handle = str(getattr(entity, 'Handle', '') or '').strip().upper()
            scanned += 1
            if allowed_names and name not in allowed_names:
                continue
            matched_by_name += 1
            if insertion is None:
                skipped_no_coordinates += 1
                if first_coordinate_debug is None and not snapshot:
                    first_coordinate_debug = _modelstudio_coordinate_debug(entity)
                continue
            first_of_type = name not in number_parameters_by_name
            if first_of_type:
                params = entity['parameters'].copy() if snapshot else _iter_modelstudio_parameters(entity)
                if not snapshot:
                    full_parameter_reads += 1
                if not params:
                    skipped_empty_parameters += 1
                explicit_parameter = per_object_params[name] if name in per_object_params else request.numberParameter
                number_parameter = str(explicit_parameter or '').strip()
                if explicit_parameter is None:
                    number_parameter = _suggest_modelstudio_number_parameter(params)
                number_parameters_by_name[name] = number_parameter
            else:
                number_parameter = number_parameters_by_name[name]
                params = entity['parameters'].copy() if snapshot else {}
            source_number = None
            if number_parameter:
                if snapshot:
                    value = next((value for param_name, value in params.items() if param_name.casefold() == number_parameter.casefold()), None)
                    found = value is not None
                    if not found and not entity['fullParameters']:
                        if not handle:
                            raise HTTPException(409, 'У объекта без handle выбранный параметр отсутствует в снимке скана. Повторите импорт без скана.')
                        live_entity = _doc.HandleToObject(handle)
                        if not _has_modelstudio_element(live_entity) or _modelstudio_name(live_entity) != name:
                            raise HTTPException(409, 'Объект из скана изменился в nanoCAD. Повторите сканирование перед импортом.')
                        found, value, actual_name = _read_modelstudio_parameter(live_entity, number_parameter)
                        direct_parameter_reads += 1
                        if found:
                            params[actual_name] = value
                elif first_of_type:
                    value = next((value for param_name, value in params.items() if param_name.casefold() == number_parameter.casefold()), None)
                    found = value is not None
                else:
                    found, value, actual_name = _read_modelstudio_parameter(entity, number_parameter)
                    direct_parameter_reads += 1
                    if found:
                        params = {actual_name: value}
                if found:
                    source_number = str(value).strip() or None
                else:
                    missing_number_parameter += 1
            points.append(_modelstudio_import_point(
                name=name, api_type=api_type, handle=handle, insertion=insertion,
                document_path=document_path, number_parameter=number_parameter,
                source_number=source_number, params=params, request=request, ordinal=len(points) + 1,
            ))
        except HTTPException:
            raise
        except Exception as exc:
            _raise_if_cad_disconnected(exc)
            skipped_errors += 1
            if first_error is None:
                first_error = f'{type(exc).__name__}: {exc}'
            _log_backend_error(
                'modelstudio_import_entity_error',
                exc,
                {
                    'entityIndex': entity_index,
                    'allowedNames': sorted(allowed_names),
                    'selectedObjectParameters': per_object_params,
                    'numberParameter': request.numberParameter,
                },
                level=logging.WARNING,
            )
            continue

    if scanned > 0 and matched_by_name > 0 and not points and skipped_no_coordinates > 0:
        raise HTTPException(
            status_code=400,
            detail={
                'message': 'Model Studio objects were found, but global coordinates were not available through known COM fields. UnitPosition is supported; if this still fails, send coordinateDiagnostics.',
                'scanned': scanned,
                'matched': matched_by_name,
                'noCoordinates': skipped_no_coordinates,
                'skippedErrors': skipped_errors,
                'firstError': first_error,
                'objectName': request.objectName,
                'selectedObjectNames': sorted(allowed_names),
                'numberParameter': request.numberParameter,
                'selectedObjectParameters': per_object_params,
                'coordinateDiagnostics': first_coordinate_debug,
            },
        )

    if scanned > 0 and matched_by_name > 0 and not points and skipped_errors > 0:
        raise HTTPException(
            status_code=400,
            detail={
                'message': 'Model Studio objects were found, but import failed on COM/object conversion. Details are written to logs/backend.log.',
                'scanned': scanned,
                'matched': matched_by_name,
                'skippedErrors': skipped_errors,
                'firstError': first_error,
                'objectName': request.objectName,
                'selectedObjectNames': sorted(allowed_names),
                'numberParameter': request.numberParameter,
                'selectedObjectParameters': per_object_params,
            },
        )

    cad.emit('modelstudio_import_parameter_summary', objectTypes=len(number_parameters_by_name),
             fullReads=full_parameter_reads, directReads=direct_parameter_reads,
             missingNumberParameter=missing_number_parameter, reusedScan=bool(snapshot), scanId=request.scanId)

    return {
        'count': len(points),
        'points': [p.model_dump(mode='json') for p in points],
        'diagnostics': {
            'scanned': scanned,
            'matchedByName': matched_by_name,
            'skippedNoCoordinates': skipped_no_coordinates,
            'skippedEmptyParameters': skipped_empty_parameters,
            'missingNumberParameter': missing_number_parameter,
            'fullParameterReads': full_parameter_reads,
            'directParameterReads': direct_parameter_reads,
            'reusedScan': bool(snapshot),
            'skippedErrors': skipped_errors,
            'firstError': first_error,
            'objectName': request.objectName,
            'selectedObjectNames': sorted(allowed_names),
            'numberParameter': request.numberParameter,
            'selectedObjectParameters': per_object_params,
            'logFile': str(_backend_log_file()) if skipped_errors else None,
        },
    }

@app.post('/api/nanocad/modelstudio/export')
@cad.serialized
def export_modelstudio_objects(request: NanoCadModelStudioExportRequest) -> dict:
    if not request.numberParameter.strip() and not any((request.selectedObjectParameters or {}).values()) and not any(
            str(point.meta.get('numberParameter') or '').strip() for point in request.points):
        raise HTTPException(422, 'Укажите параметр записи для типов объектов или используйте сохранённые параметры точек.')
    if request.tolerance <= 0:
        raise HTTPException(422, 'Допуск должен быть положительным.')
    _app, doc, ms = _connect_nanocad()
    snapshot = _modelstudio_cached_scan(request.scanId, doc, request.scope) if request.scanId else None
    if snapshot:
        resolved_scope = snapshot['resolvedScope']
    else:
        ms, resolved_scope = _cad_scope(doc, ms, request.scope)
    source_points = _filter_export_points(request.points, request.selectedGroupIds)
    allowed_names = _modelstudio_allowed_names(request.objectName, request.selectedObjectNames)
    document_path = str(getattr(doc, 'FullName', '') or '')
    cad.emit('modelstudio_export_document', document=document_path, mode=request.matchMode,
             parameter=request.numberParameter, parametersByObject=request.selectedObjectParameters or {},
             points=len(source_points), allowedNames=sorted(allowed_names))
    used: set[int] = set()
    updated = matched = scanned = failed = skipped_no_coordinates = unresolved = 0
    failures = []
    unmatched_objects = []

    if request.matchMode == 'auto':
        keys = [str(p.meta.get('cadDocument', '')).casefold() + ':' + str(p.meta['cadHandle']).upper()
                for p in source_points if p.meta.get('cadHandle') and p.meta.get('cadDocument')]
        if len(keys) != len(set(keys)):
            raise HTTPException(409, 'Несколько точек связаны с одним handle. Проверьте копии перед экспортом.')

    if request.matchMode == 'handles':
        # A handle only identifies an entity inside its original drawing.
        # Validate the entire input before the first write, never silently fall back.
        identities = set()
        for point in source_points:
            handle = str(point.meta.get('cadHandle') or '').strip().upper()
            source_doc = str(point.meta.get('cadDocument') or '')
            if not handle or not source_doc or not document_path or Path(source_doc).as_posix().casefold() != Path(document_path).as_posix().casefold():
                raise HTTPException(409, 'Экспорт по handle требует исходный сохранённый чертёж и связь каждой точки. Откройте исходный DWG или выберите поиск по координатам.')
            if handle in identities:
                raise HTTPException(409, f'Повторяющийся handle {handle}. Проверьте копии точек перед экспортом.')
            identities.add(handle)

    selected_handles = None
    if resolved_scope == 'selection':
        selected_handles = ({item['handle'] for item in snapshot['objects']} if snapshot else
                            {str(entity.Handle).upper() for entity in cad.entities(ms)})
    direct_handles = set()

    def targets():
        nonlocal unresolved
        if request.matchMode in ('auto', 'handles'):
            cad.emit('modelstudio_handle_scan_started', points=len(source_points))
            for index, point in enumerate(source_points):
                cad.progress('Проверка сохранённых handle и запись номеров', index, len(source_points), updated=updated, failed=failed)
                handle = str(point.meta.get('cadHandle') or '').upper()
                source_doc = str(point.meta.get('cadDocument') or '')
                if not handle or not source_doc or not document_path or Path(source_doc).as_posix().casefold() != Path(document_path).as_posix().casefold():
                    continue
                if handle in direct_handles:
                    raise HTTPException(409, f'Повторяющийся handle {handle}. Проверьте копии точек.')
                if selected_handles is not None and handle not in selected_handles:
                    continue
                try:
                    entity = doc.HandleToObject(handle)
                    if not _has_modelstudio_element(entity):
                        unresolved += 1
                        continue
                    expected_name = str(point.meta.get('objectName') or '')
                    if expected_name and _modelstudio_name(entity) != expected_name:
                        unresolved += 1
                        continue
                except Exception as exc:
                    _raise_if_cad_disconnected(exc)
                    unresolved += 1
                    cad.emit('modelstudio_handle_not_found', pointId=point.id, handle=handle, error=str(exc))
                    continue
                direct_handles.add(handle)
                yield entity, (index, point, 0)
            cad.progress('Проверка сохранённых handle и запись номеров', len(source_points), len(source_points), updated=updated, failed=failed)
        if request.matchMode == 'coordinates' or (request.matchMode == 'auto' and len(used) < len(source_points)):
            cad.emit('modelstudio_coordinate_scan_started', remainingPoints=len(source_points) - len(used))
            candidates = snapshot['objects'] if snapshot else cad.entities(ms)
            for entity in candidates:
                handle = entity['handle'] if snapshot else str(getattr(entity, 'Handle', '') or '').upper()
                if handle in direct_handles:
                    continue
                yield entity, None

    for entity, direct in targets():
        cad.check_cancelled()
        cached_record = entity if snapshot and direct is None else None
        if cached_record:
            name = cached_record['name']
        else:
            if not _has_modelstudio_element(entity):
                continue
            name = _modelstudio_name(entity)
        if allowed_names and name not in allowed_names:
            continue
        scanned += 1
        if direct is not None:
            found = direct
            expected_name = str(direct[1].meta.get('objectName') or '')
            if expected_name and expected_name != name:
                unresolved += 1
                continue
        else:
            insertion = cached_record['insertion'] if cached_record else _entity_insertion_point(entity)
            if insertion is None:
                skipped_no_coordinates += 1
                continue
            x, y, _z = insertion
            # A coordinate coincidence must not bind a pile to a different MS type.
            excluded = used | {i for i, p in enumerate(source_points)
                               if p.meta.get('objectName') and str(p.meta['objectName']) != name}
            found = _find_nearest_export_point(x, y, source_points, excluded, request.baseX, request.baseY, request.tolerance)
            if found is None:
                if len(unmatched_objects) < 20:
                    unmatched_objects.append({'objectName': name, 'x': x, 'y': y})
                continue
        index, point, _dist = found
        used.add(index)
        matched += 1
        value = _export_number_text(point)
        if value is None:
            continue
        stored_parameter = (str(point.meta.get('numberParameter') or '').strip()
                            if str(point.meta.get('objectName') or '') == name else '')
        parameter_name = (stored_parameter or str((request.selectedObjectParameters or {}).get(name) or '').strip()
                          or request.numberParameter.strip())
        if not parameter_name:
            failed += 1
            if len(failures) < 20:
                failures.append({'pointId': point.id, 'objectName': name, 'error': 'Не задан параметр номера'})
            cad.emit('modelstudio_write_parameter_missing', pointId=point.id, objectName=name)
            continue
        if cached_record:
            handle = cached_record['handle']
            if not handle:
                failed += 1
                continue
            try:
                entity = doc.HandleToObject(handle)
                if not _has_modelstudio_element(entity) or _modelstudio_name(entity) != name:
                    raise ValueError('Тип объекта изменился после сканирования')
            except Exception as exc:
                _raise_if_cad_disconnected(exc)
                failed += 1
                cad.emit('modelstudio_snapshot_handle_not_found', handle=handle, error=str(exc))
                continue
        handle = str(getattr(entity, 'Handle', '') or '')
        try:
            success = _set_modelstudio_parameter(entity, parameter_name, value)
        except Exception as exc:
            _raise_if_cad_disconnected(exc)
            success = False
            _log_backend_error('modelstudio_export_entity_error', exc, {'pointId': point.id, 'handle': handle})
        if success:
            updated += 1
        else:
            failed += 1
            if len(failures) < 20:
                failures.append({'pointId': point.id, 'handle': handle, 'parameter': parameter_name})
        cad.emit('modelstudio_write_result', pointId=point.id, handle=handle, parameter=parameter_name, value=value, verified=success)
    saved = False
    save_error = None
    if updated:
        if request.scanId:
            _MODELSTUDIO_SCAN_CACHE.pop(request.scanId, None)
        try:
            doc.Regen(1)
        except Exception as exc:
            _log_backend_error('modelstudio_regen_failed', exc, level=logging.WARNING)
        if request.saveDrawing and not failed:
            cad.check_cancelled()
            try:
                if not document_path or not Path(document_path).is_absolute():
                    raise ValueError('Сначала сохраните исходный чертёж в nanoCAD.')
                cad.progress('Сохранение DWG')
                doc.Save()
                saved = True
                cad.emit('modelstudio_drawing_saved', document=document_path)
            except Exception as exc:
                save_error = str(exc)
                _log_backend_error('modelstudio_drawing_save_failed', exc, {'document': document_path, 'updated': updated})
    return {'updated': updated, 'matched': matched, 'scanned': scanned, 'points': len(source_points),
            'unusedPoints': len(source_points) - len(used), 'missingParameter': failed, 'failedWrites': failed,
            'unresolvedHandles': unresolved, 'failures': failures, 'tolerance': request.tolerance,
            'selectedObjectNames': sorted(allowed_names), 'skippedNoCoordinates': skipped_no_coordinates,
            'unmatchedObjects': unmatched_objects, 'documentName': document_path, 'saved': saved, 'saveError': save_error,
            'logFile': str(_backend_log_file()), 'scope': resolved_scope, 'reusedScan': bool(snapshot)}


class CadJobRequest(BaseModel):
    kind: str
    payload: dict = Field(default_factory=dict)


@app.post('/api/nanocad/operations')
def start_cad_operation(request: CadJobRequest):
    routes = {
        'blocks/scan': (scan_nanocad_blocks, None),
        'blocks/pick': (pick_nanocad_block, None),
        'blocks/import': (import_nanocad_blocks, NanoCadBlockImportRequest),
        'blocks/export': (export_nanocad_blocks, NanoCadBlockExportRequest),
        'modelstudio/scan': (scan_modelstudio_objects, None),
        'modelstudio/import': (import_modelstudio_objects, NanoCadModelStudioImportRequest),
        'modelstudio/export': (export_modelstudio_objects, NanoCadModelStudioExportRequest),
    }
    if request.kind not in routes:
        raise HTTPException(422, 'Неизвестная операция nanoCAD.')
    func, schema = routes[request.kind]
    try:
        args = (schema.model_validate(request.payload),) if schema else ((str(request.payload.get('scope', 'auto')), ) if request.kind.endswith('/scan') else ())
    except ValidationError as exc:
        raise HTTPException(422, str(exc)) from exc
    return cad.start(request.kind, func, *args)


@app.get('/api/nanocad/operations/{operation_id}')
def get_cad_operation(operation_id: str):
    return cad.status(operation_id)


@app.post('/api/nanocad/operations/{operation_id}/cancel')
def cancel_cad_operation(operation_id: str):
    result = cad.cancel(operation_id)
    if result['cancelRequested'] and cad.status(operation_id)['kind'].endswith('/export'):
        _BLOCK_SCAN_CACHE.clear()
        _MODELSTUDIO_SCAN_CACHE.clear()
    return result


@app.get('/api/nanocad/operations/{operation_id}/logs')
def get_cad_operation_logs(operation_id: str):
    return cad.logs(operation_id)
