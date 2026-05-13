# -*- coding: utf-8 -*-
"""Desktop launcher for the Pile Numbering App.

The EXE build packs:
- backend FastAPI app from backend/app;
- built frontend from frontend/dist as PyInstaller add-data `frontend_dist`;
- this launcher as the executable entry point.

At runtime the launcher:
1. redirects project/config/data folders to the folder next to the EXE;
2. mounts the built frontend at `/`;
3. starts uvicorn on a free localhost port;
4. opens a native pywebview window, not a browser tab.
"""
from __future__ import annotations

import ctypes
import logging
import os
import socket
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


def _is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def _exe_dir() -> Path:
    if _is_frozen():
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[1]


def _bundle_dir() -> Path:
    return Path(getattr(sys, "_MEIPASS", _exe_dir())).resolve()


APP_DIR = _exe_dir()
BUNDLE_DIR = _bundle_dir()
LOG_DIR = APP_DIR / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)
LOG_FILE = LOG_DIR / "exe_launcher.log"

logging.basicConfig(
    filename=LOG_FILE,
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    encoding="utf-8",
)


def _message_box(title: str, text: str) -> None:
    logging.error("%s: %s", title, text)
    if sys.platform.startswith("win"):
        try:
            ctypes.windll.user32.MessageBoxW(None, text, title, 0x10)  # MB_ICONERROR
            return
        except Exception:
            pass
    print(f"{title}: {text}", file=sys.stderr)


def _configure_local_proxy_bypass() -> None:
    """Force all localhost traffic to stay local inside the desktop EXE.

    Some corporate environments export HTTP_PROXY/HTTPS_PROXY/ALL_PROXY. Python's
    urllib can then send even http://127.0.0.1 health checks through that proxy,
    which returns HTTP 407 Proxy Authentication Required. The app is fully local,
    so localhost must bypass every proxy both for Python and WebView2.
    """
    for key in (
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ):
        if key in os.environ:
            logging.info("Removing proxy environment variable for local EXE: %s", key)
            os.environ.pop(key, None)

    bypass_hosts = "localhost,127.0.0.1,::1,<local>"
    existing_no_proxy = os.environ.get("NO_PROXY") or os.environ.get("no_proxy") or ""
    merged = existing_no_proxy
    for item in bypass_hosts.split(","):
        if item and item not in merged:
            merged = f"{merged},{item}" if merged else item
    os.environ["NO_PROXY"] = merged
    os.environ["no_proxy"] = merged

    webview_args = os.environ.get("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "")
    required_args = "--proxy-server=direct:// --proxy-bypass-list=<-loopback>;localhost;127.0.0.1;::1"
    if "--proxy-server=direct://" not in webview_args:
        os.environ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = f"{webview_args} {required_args}".strip()
    logging.info("Local proxy bypass configured: NO_PROXY=%s", os.environ.get("NO_PROXY"))


def _open_local_url_no_proxy(url: str, timeout: float = 2.0):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request = urllib.request.Request(url, headers={"Cache-Control": "no-cache"})
    return opener.open(request, timeout=timeout)  # noqa: S310 - localhost only


def _frontend_dist_dir() -> Path:
    candidates = [
        BUNDLE_DIR / "frontend_dist",  # PyInstaller --add-data target
        APP_DIR / "frontend_dist",     # unpacked/debug distribution
        APP_DIR / "frontend" / "dist", # running from source tree
        Path(__file__).resolve().parents[1] / "frontend" / "dist",
    ]
    for candidate in candidates:
        if (candidate / "index.html").exists():
            return candidate
    raise FileNotFoundError(
        "Не найден frontend_dist/index.html. Сначала собери frontend или пересобери EXE через tools\\06_build_exe.bat."
    )


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _patch_backend_runtime_paths(app_main: Any) -> None:
    """Make projects/config/data persistent next to the EXE.

    app.main calculates ROOT_DIR from the bundled source path. In one-file EXE that
    points into PyInstaller's temporary folder, so without this patch saved projects
    and UI config would disappear after restart. The browser/dev mode is untouched.
    """
    projects_dir = APP_DIR / "projects"
    config_dir = APP_DIR / "config"
    data_dir = APP_DIR / "data"
    images_dir = data_dir / "images"
    fields_dir = data_dir / "fields"

    for folder in (projects_dir, config_dir, data_dir, images_dir, fields_dir):
        folder.mkdir(parents=True, exist_ok=True)

    app_main.ROOT_DIR = APP_DIR
    app_main.PROJECTS_DIR = projects_dir
    app_main.CONFIG_DIR = config_dir
    app_main.USER_CONFIG_PATH = config_dir / "user_config.json"
    app_main.LOGS_DIR = LOG_DIR

    # Some builds have optional asset globals. Patch them only if present.
    for name, value in {
        "DATA_DIR": data_dir,
        "IMAGES_DIR": images_dir,
        "FIELDS_DIR": fields_dir,
        "USER_IMAGES_DIR": images_dir,
    }.items():
        if hasattr(app_main, name):
            setattr(app_main, name, value)


def _mount_frontend(app: Any, frontend_dir: Path) -> None:
    from starlette.staticfiles import StaticFiles

    # Avoid double mount when running this module repeatedly in a debug session.
    for route in getattr(app, "routes", []):
        if getattr(route, "path", None) == "":
            return
        if getattr(route, "path", None) == "/" and route.__class__.__name__ == "Mount":
            return

    app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="frontend")


def _prepare_app() -> Any:
    backend_path = APP_DIR / "backend"
    if backend_path.exists() and str(backend_path) not in sys.path:
        sys.path.insert(0, str(backend_path))

    import app.main as app_main

    _patch_backend_runtime_paths(app_main)
    frontend_dir = _frontend_dist_dir()
    _mount_frontend(app_main.app, frontend_dir)
    logging.info("Frontend dist: %s", frontend_dir)
    logging.info("Persistent app dir: %s", APP_DIR)
    return app_main.app


class BackendThread(threading.Thread):
    def __init__(self, app: Any, host: str, port: int) -> None:
        super().__init__(name="uvicorn-backend", daemon=True)
        self.app = app
        self.host = host
        self.port = port
        self.error: BaseException | None = None

    def run(self) -> None:
        try:
            import asyncio
            import uvicorn

            # In frozen/windowed EXE use explicit stable protocols.
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            config = uvicorn.Config(
                self.app,
                host=self.host,
                port=self.port,
                log_level="info",
                access_log=False,
                log_config=None,
                loop="asyncio",
                http="h11",
                lifespan="off",
            )
            server = uvicorn.Server(config)
            logging.info("Starting embedded backend on http://%s:%s", self.host, self.port)
            loop.run_until_complete(server.serve())
        except BaseException as exc:  # noqa: BLE001 - backend startup diagnostics
            self.error = exc
            logging.exception("Embedded backend thread failed")


def _start_backend(app: Any, host: str, port: int) -> BackendThread:
    thread = BackendThread(app, host, port)
    thread.start()
    return thread


def _wait_for_backend(url: str, thread: BackendThread, timeout_seconds: float = 90.0) -> None:
    deadline = time.time() + timeout_seconds
    last_error: Exception | None = None
    attempt = 0
    while time.time() < deadline:
        attempt += 1
        if thread.error is not None:
            raise RuntimeError(f"Backend thread failed: {thread.error}")
        if not thread.is_alive():
            raise RuntimeError("Backend thread stopped before /health became available")
        try:
            with _open_local_url_no_proxy(url, timeout=2.0) as response:
                body = response.read(256).decode("utf-8", errors="replace")
                logging.info("Backend health OK after %s attempts: HTTP %s %s", attempt, response.status, body)
                if response.status == 200:
                    return
        except urllib.error.HTTPError as exc:
            last_error = exc
            logging.warning("Backend health returned HTTP %s on attempt %s", exc.code, attempt)
        except Exception as exc:  # noqa: BLE001 - startup polling
            last_error = exc
            if attempt == 1 or attempt % 10 == 0:
                logging.info("Waiting for backend /health, attempt %s: %r", attempt, exc)
        time.sleep(0.35)

    diagnostics = f"Backend did not start in {timeout_seconds:.0f}s: {last_error!r}"
    if thread.error is not None:
        diagnostics += "\nBackend thread traceback:\n" + "".join(traceback.format_exception(thread.error))
    raise RuntimeError(diagnostics)


class DesktopApi:
    def saveProjectJson(self, file_name: str, content: str) -> dict[str, Any]:  # noqa: N802 - pywebview JS API name
        try:
            import webview

            safe_name = Path(str(file_name or "project.pilenum.json")).name
            if not safe_name.lower().endswith((".pilenum.json", ".json")):
                safe_name = f"{safe_name}.pilenum.json"

            window = webview.windows[0] if webview.windows else None
            if window is None:
                fallback = APP_DIR / safe_name
                fallback.write_text(str(content), encoding="utf-8")
                return {"saved": True, "path": str(fallback)}

            result = window.create_file_dialog(
                webview.SAVE_DIALOG,
                save_filename=safe_name,
                file_types=("Pile Numbering project (*.pilenum.json)", "JSON files (*.json)", "All files (*.*)"),
            )
            if not result:
                return {"saved": False, "canceled": True}

            raw_path = result[0] if isinstance(result, (list, tuple)) else result
            path = Path(str(raw_path))
            if not path.suffix:
                path = path.with_suffix(".pilenum.json")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(str(content), encoding="utf-8")
            logging.info("JSON project exported through desktop dialog: %s", path)
            return {"saved": True, "path": str(path)}
        except Exception as exc:  # noqa: BLE001 - diagnostics returned to frontend
            logging.exception("Desktop JSON export failed")
            return {"saved": False, "error": str(exc)}


def main() -> int:
    try:
        os.chdir(APP_DIR)
        _configure_local_proxy_bypass()
        app = _prepare_app()
        port = _find_free_port()
        host = "127.0.0.1"
        base_url = f"http://{host}:{port}"
        backend_thread = _start_backend(app, host, port)
        _wait_for_backend(f"{base_url}/health", backend_thread)
        logging.info("Backend started: %s", base_url)

        import webview

        window = webview.create_window(
            "Нумератор свайного поля",
            base_url,
            width=1500,
            height=950,
            min_size=(1100, 700),
            js_api=DesktopApi(),
        )
        try:
            window.maximize()
        except Exception:
            pass
        webview.start(debug=False)
        logging.info("Application closed")
        return 0
    except Exception as exc:  # noqa: BLE001 - top-level launcher guard
        logging.exception("Fatal launcher error")
        _message_box(
            "Pile Numbering App — ошибка запуска",
            f"{exc}\n\nПодробности: {LOG_FILE}",
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
