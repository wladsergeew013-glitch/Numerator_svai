# -*- coding: utf-8 -*-
"""Full locked-state contract check for the Pile Numbering app.

Run from project root:
    python tools/checks/locked_state_contract_check.py
or:
    tools\07_check_locked_state.bat

The script is intentionally mostly static + small backend runtime tests.
It guards the functionality fixed in FUNCTIONALITY_LOCK_RU after v53, without
requiring nanoCAD, a browser, Docker, or a running server.
"""
from __future__ import annotations

import ast
import compileall
import importlib
import json
import re
import sys
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"


def read(rel: str) -> str:
    path = ROOT / rel
    if not path.exists():
        raise AssertionError(f"missing file: {rel}")
    return path.read_text(encoding="utf-8")


def require(text: str, needle: str, where: str) -> None:
    if needle not in text:
        raise AssertionError(f"missing {needle!r} in {where}")


def require_re(text: str, pattern: str, where: str) -> None:
    if not re.search(pattern, text, flags=re.S):
        raise AssertionError(f"pattern not found in {where}: {pattern}")


def check_project_skeleton() -> None:
    required_files = [
        "backend/app/main.py",
        "backend/app/schemas.py",
        "backend/app/io_project.py",
        "backend/app/numbering_rows.py",
        "backend/app/numbering_route.py",
        "backend/app/numbering_vector.py",
        "backend/app/numbering_manual.py",
        "backend/app/clustering_auto.py",
        "backend/app/sync_import.py",
        "backend/requirements.txt",
        "frontend/package.json",
        "frontend/src/App.tsx",
        "frontend/src/api/client.ts",
        "frontend/src/store/useProjectStore.ts",
        "frontend/src/types/project.ts",
        "frontend/src/components/CanvasView.tsx",
        "frontend/src/components/DraggablePanel.tsx",
        "frontend/src/components/GroupManager.tsx",
        "frontend/src/components/Toolbar.tsx",
        "frontend/src/components/WorkspaceSettingsPanel.tsx",
        "frontend/src/styles.css",
        "FUNCTIONALITY_LOCK_RU.md",
        "RULES.md",
        "tools/checks/frontend_contract_check.py",
        "tools/checks/locked_state_contract_check.py",
        "tools/08_create_desktop_shortcut.bat",
        "tools/app_icon.ico",
    ]
    missing = [rel for rel in required_files if not (ROOT / rel).exists()]
    if missing:
        raise AssertionError("missing required project files: " + ", ".join(missing))


def check_backend_py_compile() -> None:
    app_dir = BACKEND / "app"
    if not compileall.compile_dir(str(app_dir), quiet=1, force=True):
        raise AssertionError("backend/app py_compile failed")


def _import_backend_modules():
    backend_path = str(BACKEND)
    if backend_path not in sys.path:
        sys.path.insert(0, backend_path)
    # Ensure imports are resolved from current repo, not from a stale interpreter path.
    for name in list(sys.modules):
        if name == "app" or name.startswith("app."):
            del sys.modules[name]
    return {
        "schemas": importlib.import_module("app.schemas"),
        "io_project": importlib.import_module("app.io_project"),
        "numbering_rows": importlib.import_module("app.numbering_rows"),
        "numbering_route": importlib.import_module("app.numbering_route"),
        "numbering_vector": importlib.import_module("app.numbering_vector"),
        "clustering_auto": importlib.import_module("app.clustering_auto"),
    }


def check_backend_runtime_csv_and_numbering() -> None:
    modules = _import_backend_modules()
    schemas = modules["schemas"]
    io_project = modules["io_project"]
    numbering_rows = modules["numbering_rows"]
    numbering_route = modules["numbering_route"]
    numbering_vector = modules["numbering_vector"]

    # CSV with headers, semicolon delimiter and comma decimals.
    csv_payload = "X;Y;Number\n0;0;100\n2500,5;1000;101\n".encode("utf-8-sig")
    imported = io_project.import_points_from_csv(csv_payload).points
    assert len(imported) == 2, "CSV import must read two points"
    assert imported[0].sourceNumber == "100", "CSV source number must be preserved"
    assert abs(imported[1].x - 2500.5) < 1e-9, "CSV comma decimal must parse"
    assert imported[0].id != str(imported[0].sourceNumber), "internal id must not equal pile number"

    PilePoint = schemas.PilePoint
    PileGroup = schemas.PileGroup
    NumberingSettings = schemas.NumberingSettings
    NumberingRowsRequest = schemas.NumberingRowsRequest
    NumberingMode = schemas.NumberingMode
    NumberingMethod = schemas.NumberingMethod

    points = [
        PilePoint(id="p1", x=0, y=1000, groupId="g1"),
        PilePoint(id="p2", x=1000, y=1000, groupId="g1"),
        PilePoint(id="p3", x=0, y=0, groupId="g2"),
        PilePoint(id="p4", x=1000, y=0, groupId="g2", manualNumber=True, number=99),
    ]
    g1 = PileGroup(
        id="g1",
        name="Группа 1",
        order=1,
        pipelineId="pipeline-main",
        numbering=NumberingSettings(method=NumberingMethod.rows, startNumber=10, rowTolerance=200, direction="left_to_right_top_to_bottom"),
    )
    g2 = PileGroup(
        id="g2",
        name="Группа 2",
        order=2,
        pipelineId="pipeline-main",
        numbering=NumberingSettings(method=NumberingMethod.rows, startNumber=1, rowTolerance=200, direction="left_to_right_top_to_bottom"),
    )
    req = NumberingRowsRequest(points=points, groups=[g1, g2], settings=g1.numbering, numberingMode=NumberingMode.global_sequential)
    numbered = {p.id: p for p in numbering_rows.apply_numbering_rows(req)}
    assert numbered["p1"].number == 10 and numbered["p2"].number == 11, "row numbering order/start is broken"
    assert numbered["p3"].number == 12, "global sequential numbering between groups is broken"
    assert numbered["p4"].number == 99 and numbered["p4"].manualNumber, "manual number must be preserved"

    route_settings = NumberingSettings(method=NumberingMethod.route, startNumber=1, optimize=False, startPointId="p1", endPointId="p3")
    route = numbering_route.build_route_order(points[:3], route_settings)
    assert route[0].id == "p1" and route[-1].id == "p3", "route start/end preference is broken"

    vector_settings = NumberingSettings(
        method=NumberingMethod.vector,
        startNumber=1,
        vectorPath=[schemas.Point2D(x=0, y=1000), schemas.Point2D(x=1000, y=0)],
        maxDistanceToPath=2000,
    )
    vector_numbered = numbering_vector.apply_numbering_vector(points[:3], vector_settings)
    assert all(p.number is not None for p in vector_numbered), "vector numbering must assign numbers"


def check_backend_static_api_contract() -> None:
    main = read("backend/app/main.py")
    endpoints = [
        "/health",
        "/api/config/user",
        "/api/import/csv",
        "/api/projects/local",
        "/api/projects/local/save",
        "/api/projects/validate",
        "/api/numbering/rows",
        "/api/nanocad/blocks/scan",
        "/api/nanocad/blocks/pick",
        "/api/nanocad/blocks/import",
        "/api/nanocad/blocks/export",
        "/api/nanocad/modelstudio/scan",
        "/api/nanocad/modelstudio/import",
        "/api/nanocad/modelstudio/export",
    ]
    for endpoint in endpoints:
        require(main, endpoint, "backend/app/main.py")
    for needle in [
        "_safe_file_name", "_safe_project_path", "_connect_nanocad", "InsertionPoint",
        "GetAttributes", "_parse_numeric_number", "NanoCadBlockExportRequest",
        "NanoCadModelStudioExportRequest", "Parameters", "baseX", "baseY", "tolerance",
    ]:
        require(main, needle, "backend/app/main.py")
    require(main, "/api/system/desktop-shortcut", "backend/app/main.py")
    require(main, "CreateShortcut", "backend/app/main.py")
    req = read("backend/requirements.txt")
    require(req, "pywin32>=307; sys_platform", "backend/requirements.txt")


def check_frontend_api_and_store_contract() -> None:
    client = read("frontend/src/api/client.ts")
    for needle in [
        "importCsv", "numberRows", "listLocalProjects", "saveLocalProject", "openLocalProject",
        "getUserConfig", "saveUserConfig", "scanNanoCadBlocks", "pickNanoCadBlockSample",
        "importNanoCadBlocks", "exportNanoCadBlocks", "scanNanoCadModelStudioObjects",
        "importNanoCadModelStudioObjects", "exportNanoCadModelStudioObjects",
        "uploadApplicationIcon", "createDesktopShortcut",
    ]:
        require(client, needle, "frontend/src/api/client.ts")

    store = read("frontend/src/store/useProjectStore.ts")
    for needle in [
        "createNewProject", "appendImportedPoints", "createPipeline", "deletePipeline", "updateGroupPipeline",
        "createGroup", "deleteGroup", "assignSelectionToGroup", "autoClusterEditablePoints",
        "applyRowsNumbering", "applyRowsNumberingAll", "buildNumberingPreview", "setNumberingPreviewMode",
        "startNumberingManualLinkEdit", "clearSelectedNumberingManualLinks", "setPointManualNumber",
        "clearManualNumbersForGroup", "startGroupOutlineDrawing", "closeGroupOutlineDrawing",
        "clearGroupManualOutline", "startVectorPathDrawing", "finishVectorPathDrawing", "clusterPrefixedNumber",
        "selectedGroupId: state.selectedGroupId", "groupOutlineVisible",
    ]:
        require(store, needle, "frontend/src/store/useProjectStore.ts")

    project_types = read("frontend/src/types/project.ts")
    for method in ["'rows'", "'columns'", "'route'", "'vector'", "'manual'"]:
        require(project_types, method, "frontend/src/types/project.ts")
    for view_setting in ["highlightUnnumbered", "groupOutlineVisible", "groupOutlineSnapPx", "groupOutlinePadding"]:
        require(project_types, view_setting, "frontend/src/types/project.ts")


def check_toolbar_and_window_contract() -> None:
    app = read("frontend/src/App.tsx")
    require(app, "position: 'fixed'", "frontend/src/App.tsx")
    require(app, "left: dockReserve.left", "frontend/src/App.tsx")
    require(app, "right: dockReserve.right", "frontend/src/App.tsx")
    require(app, "const MAX_DOCK_WIDTH = 920", "frontend/src/App.tsx")
    require(app, "readDockRegistry", "frontend/src/App.tsx")
    require(app, "loadPanelWidth", "frontend/src/App.tsx")
    require(app, "pile-numbering-dock-layout-changed", "frontend/src/App.tsx")
    toolbar = read("frontend/src/components/Toolbar.tsx")
    require(toolbar, "about-project-dialog", "frontend/src/components/Toolbar.tsx")
    require(toolbar, "APP_VERSION", "frontend/src/components/Toolbar.tsx")
    require(toolbar, "Версия {APP_VERSION}", "frontend/src/components/Toolbar.tsx")
    require(toolbar, "<h4>Разработчик</h4>", "frontend/src/components/Toolbar.tsx")
    require(toolbar, "Сергеев Владислав Викторович", "frontend/src/components/Toolbar.tsx")
    require(toolbar, "vvsergeev@proektirovanie.gazprom.ru", "frontend/src/components/Toolbar.tsx")
    for forbidden in ["Разработчик / владелец идеи", "<h4>Назначение</h4>", "зашита в код", "браузерного prompt", "будущий импорт", "будущая запись"]:
        if forbidden in toolbar:
            raise AssertionError(f"About/product UI wording must be release-style, found: {forbidden}")
    for label in [
        "Создать", "Открыть", "Проекты", "Сохранить", "Переименовать", "Переим.", "Импорт", "Экспорт",
        "Проверка", "Скан nanoCAD для экспорта", "CSV / Excel", "nanoCAD", "Блоки", "Model Studio",
    ]:
        require(toolbar, label, "frontend/src/components/Toolbar.tsx")
    for needle in [
        "create-project-dialog", "import-data-dialog", "export-data-dialog", "model-check-dialog",
        "buildCsvPreview", "buildExcelPreview", "xlsx", "buildModelCheck", "toggleEmptyPointCheck",
        "refreshNanoCadBlocks('export')", "pickNanoCadSample('export')", "exportSelectedGroupIds",
        "rename-project-dialog", "openRenameProjectDialog", "renameProjectFromDialog", "showSaveFilePicker", "saveProjectJson",
    ]:
        require(toolbar, needle, "frontend/src/components/Toolbar.tsx")

    panel = read("frontend/src/components/DraggablePanel.tsx")
    for needle in [
        "dockable", "Закрепить окно", "dock-anchor", "pile-numbering-dock-layout-changed",
        "getDockOffset", "readPanelWidth", "onMouseDown", "dockVersion",
    ]:
        require(panel, needle, "frontend/src/components/DraggablePanel.tsx")


def check_canvas_visual_contract() -> None:
    canvas = read("frontend/src/components/CanvasView.tsx")
    require(canvas, "safeMinorStep", "frontend/src/components/CanvasView.tsx")
    require(canvas, "skipMajorOverlay", "frontend/src/components/CanvasView.tsx")
    for needle in [
        "makeGroupOutlineWorldCadBands", "estimateNearestSpacingWorld", "connectOutlineRects",
        "horizontal", "vertical", "CAD-полос", "manualOutline", "project.viewSettings.groupOutlineVisible === false",
        "resolveGroupOutlineSnap", "groupOutlineHoverPoint", "GroupOutlineSnapKind", "const finalKind: GroupOutlineSnapKind", "фантом", "makeOrthogonalDraftPoint",
        "storedPreviewRoutePoints", "numberedFallbackAutoPoints", "AXIS_X_COLOR", "AXIS_Y_COLOR",
        "project.viewSettings.highlightUnnumbered", "startNumberingManualLinkEdit", "manualLinkClearMode",
        "previewSegmentsListening", "numberingPickMode !== 'manual_link_target'",
        "vectorPathDrawMode", "vectorPathEditMode", "vectorPathDraft", "addVectorPathDraftPoint", "undoLastVectorPathDraftPoint",
        "finishVectorPathDrawing", "cancelVectorPathDrawing", "Вектор: ЛКМ — добавить вершину",
        "activeVectorPathPoints", "activeVectorPathScreenPoints", "active-vector-path-editable-handles",
        "updateActiveVectorHandle", "insertVectorPointFromScreen", "group_vector_path_point_moved", "режим «Редактировать»",
        "vectorExtendState", "startVectorExtension", "finishVectorExtension", "active-vector-segment-plus", "+ у концов", "vectorWorkMode", "findNearestVectorHit", "showVectorPath",
    ]:
        require(canvas, needle, "frontend/src/components/CanvasView.tsx")
    # Guard against the old laggy algorithm: no per-pile pixel contour should be the only path.
    require_re(canvas, r"manualOutline[\s\S]{0,600}makeGroupOutlineWorldCadBands", "frontend/src/components/CanvasView.tsx")
    require(canvas, "previewSegmentsListening = manualLinkClearMode || (!editPointPickMode && !numberingPickMode && !vectorPathDrawMode && !vectorPathEditMode)", "frontend/src/components/CanvasView.tsx")
    if "previewSegmentsListening = !numberingPickMode || numberingPickMode === 'manual_link_target'" in canvas:
        raise AssertionError("preview lines must not intercept point picking modes")

    store = read("frontend/src/store/useProjectStore.ts")
    require(store, "numberingLinkFromId: null", "frontend/src/store/useProjectStore.ts")
    require(store, "numberingLinkToId: null", "frontend/src/store/useProjectStore.ts")


def check_group_manager_contract() -> None:
    gm = read("frontend/src/components/GroupManager.tsx")
    store = read("frontend/src/store/useProjectStore.ts")
    if "groupPipelineId(nextGroup, { ...state.project, groups })" in store:
        raise AssertionError("groupPipelineId must not receive excess object literal with groups")
    for needle in [
        "pipelineShortLabel", "pipeline-index-chip", "manager-action-icon", "manager-action-text",
        "toggleVisibleGroupsCollapsed", "clusterNumbering", "clusterPrefix", "metaBoolean", "metaPositiveNumber", "startGroupOutlineDrawing",
        "startVectorPathDrawing", "startVectorPathEdit", "clearManualNumbersForGroup", "askDeleteGroup", "режим «Редактировать»",
    ]:
        require(gm, needle, "frontend/src/components/GroupManager.tsx")
    if "{g.meta?.clusterNumbering &&" in gm:
        raise AssertionError("clusterNumbering from meta must be converted to boolean before JSX rendering")
    method_block = gm.split("const METHOD_OPTIONS", 1)[1].split("];", 1)[0]
    if re.search(r"value:\s*['\"]manual['\"]", method_block):
        raise AssertionError("manual must not be exposed as a group numbering method")


def check_styles_contract() -> None:
    css = read("frontend/src/styles.css")
    for cls in [
        ".ribbon", ".ribbon-section", ".ghost-ribbon-group", ".toolbar-resize-handle",
        ".manager-action-button", ".manager-action-icon", ".manager-action-text",
        ".pipeline-index-chip", ".transfer-dialog-panel", ".wizard-step", ".export-group-list",
        ".model-check-panel", ".base-point-card", ".nanocad-scan-actions",
    ]:
        require(css, cls, "frontend/src/styles.css")


def check_package_and_tools_contract() -> None:
    package = json.loads(read("frontend/package.json"))
    deps = {**package.get("dependencies", {}), **package.get("devDependencies", {})}
    for dep in ["react", "react-dom", "react-konva", "konva", "zustand", "xlsx", "typescript", "vite"]:
        if dep not in deps:
            raise AssertionError(f"missing frontend dependency: {dep}")
    scripts = package.get("scripts", {})
    for script in ["dev", "build", "preview"]:
        if script not in scripts:
            raise AssertionError(f"missing package script: {script}")

    for rel in [
        "tools/01_run_dev.bat",
        "tools/02_check_frontend_contract.bat",
        "tools/03_dump_project_code.bat",
        "tools/04_dump_project_tree.bat",
        "tools/05_docker_build_run.bat",
        "tools/06_build_exe.bat",
        "tools/exe_launcher.py",
        "tools/07_check_locked_state.bat",
        "tools/08_create_desktop_shortcut.bat",
        "tools/app_icon.ico",
        "tools/90_cleanup_legacy_tools.bat",
    ]:
        if not (ROOT / rel).exists():
            raise AssertionError(f"missing numbered tool: {rel}")

    locked_bat = read("tools/07_check_locked_state.bat")
    if 'PY_RUN=\\"' in locked_bat or '\\"%ROOT%' in locked_bat:
        raise AssertionError("07_check_locked_state.bat must not store escaped quotes in Python command")
    require(locked_bat, "call :run_python", "tools/07_check_locked_state.bat")

    shortcut = read("tools/08_create_desktop_shortcut.bat")
    require(shortcut, "APPLY EXE ICON", "tools/08_create_desktop_shortcut.bat")
    require(shortcut, "06_build_exe.bat", "tools/08_create_desktop_shortcut.bat")
    require(shortcut, "config\\app_icon.ico", "tools/08_create_desktop_shortcut.bat")
    require(shortcut, "This helper does NOT create desktop shortcuts", "tools/08_create_desktop_shortcut.bat")


def check_exe_launcher_contract() -> None:
    launcher = read("tools/exe_launcher.py")
    for needle in [
        "frontend_dist", "pywebview", "webview.create_window", "uvicorn.Server",
        "StaticFiles", "_patch_backend_runtime_paths", "PROJECTS_DIR", "CONFIG_DIR",
        "USER_CONFIG_PATH", "data", "images", "127.0.0.1", "_find_free_port",
        "exe_launcher.log", "BackendThread", "loop=\"asyncio\"", "http=\"h11\"",
        "lifespan=\"off\"", "thread.error", "timeout_seconds: float = 90.0",
        "_configure_local_proxy_bypass", "NO_PROXY", "no_proxy",
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--proxy-server=direct://",
        "ProxyHandler({})", "_open_local_url_no_proxy",
    ]:
        require(launcher, needle, "tools/exe_launcher.py")

    build = read("tools/06_build_exe.bat")
    for needle in [
        "tools\\exe_launcher.py", "--add-data", "frontend\\dist;frontend_dist",
        "--collect-all webview", "--collect-submodules fastapi", "--collect-submodules starlette",
        "--hidden-import win32com.client", "--hidden-import pythoncom", "--hidden-import pywintypes",
        "--hidden-import h11", "--hidden-import anyio", "--hidden-import starlette.staticfiles",
        "Checking backend venv portability", "VENV_BROKEN", "pyvenv.cfg",
        "Existing backend\\.venv is broken or copied from another PC",
    ]:
        require(build, needle, "tools/06_build_exe.bat")

    run_dev = read("tools/01_run_dev.bat")
    for needle in [
        "Checking backend venv portability", "VENV_BROKEN", "pyvenv.cfg",
        "Existing backend\\.venv is broken or copied from another PC",
    ]:
        require(run_dev, needle, "tools/01_run_dev.bat")

    docker = read("tools/05_docker_build_run.bat")
    require(docker, "Docker daemon is not running", "tools/05_docker_build_run.bat")
    require(docker, "tools\\01_run_dev.bat", "tools/05_docker_build_run.bat")
    require(docker, "tools\\06_build_exe.bat", "tools/05_docker_build_run.bat")



def check_nanocad_active_instance_contract() -> None:
    main = read("backend/app/main.py")
    for needle in [
        "GetActiveObject",
        "_find_running_nanocad_from_rot",
        "EnumRunning",
        "_nanocad_progid_candidates",
        "PILE_NUMBERING_NANOCAD_VERSION",
    ]:
        require(main, needle, "backend/app/main.py")
    match = re.search(
        r"# BEGIN NANOCAD ACTIVE INSTANCE FIX V71(?P<body>.*?)# END NANOCAD ACTIVE INSTANCE FIX V71",
        main,
        flags=re.S,
    )
    if not match:
        raise AssertionError("nanoCAD active-instance v71 block is missing in backend/app/main.py")
    body = match.group("body")
    if "Dispatch(progid)" in body or "Dispatch(prog_id)" in body:
        raise AssertionError("nanoCAD connector must not call Dispatch(progid), because it can start another installed nanoCAD version")

def check_functionality_lock_and_rules() -> None:
    lock = read("FUNCTIONALITY_LOCK_RU.md")
    for marker in [
        "## 1. Верхняя лента", "## 2. Файл / проект", "## 3. Редактирование точек",
        "## 4. Диспетчер групп", "## 5. Методы нумерации группы", "## 11. Журнал и отмена",
        "Дополнение v45", "Дополнение v48", "Дополнение v50", "Дополнение v51", "Дополнение v52", "Дополнение v53", "Дополнение v54", "Дополнение v55", "Дополнение v57",
    ]:
        require(lock, marker, "FUNCTIONALITY_LOCK_RU.md")
    for marker in ["07_check_locked_state", "frontend_contract_check", "locked_state_contract_check", "LOCKED_STATE_TEST_PLAN_RU", "exe_launcher.py", "06_build_exe"]:
        require(lock, marker, "FUNCTIONALITY_LOCK_RU.md")

    # RULES.md is intentionally not overwritten by this patch: projects may keep
    # local rules there. Its existence is checked by check_project_skeleton; the
    # exact v54 lock text is stored in FUNCTIONALITY_LOCK_RU.md and this test plan.


def check_no_obvious_frontend_backend_api_drift() -> None:
    client = read("frontend/src/api/client.ts")
    main = read("backend/app/main.py")
    frontend_urls = sorted(set(re.findall(r"request<[^>]*>\(['\"]([^'\"]+)", client)))
    missing: list[str] = []
    for url in frontend_urls:
        if url.startswith("/api/assets/icons"):
            # Assets may be served by static mount in some builds; exact dynamic route is optional.
            continue
        base = re.sub(r"/\$\{[^}]+\}", "/", url)
        if base.rstrip("/") and base.rstrip("/") not in main:
            missing.append(url)
    if missing:
        raise AssertionError("frontend API URLs not found in backend main.py: " + ", ".join(missing))


def main() -> int:
    checks: list[Callable[[], None]] = [
        check_project_skeleton,
        check_backend_py_compile,
        check_backend_runtime_csv_and_numbering,
        check_backend_static_api_contract,
        check_frontend_api_and_store_contract,
        check_toolbar_and_window_contract,
        check_canvas_visual_contract,
        check_group_manager_contract,
        check_styles_contract,
        check_package_and_tools_contract,
        check_exe_launcher_contract,
        check_nanocad_active_instance_contract,
        check_functionality_lock_and_rules,
        check_no_obvious_frontend_backend_api_drift,
    ]
    errors: list[str] = []
    for check in checks:
        try:
            check()
            print(f"[OK] {check.__name__}")
        except Exception as exc:  # noqa: BLE001 - command line contract runner
            errors.append(f"[FAIL] {check.__name__}: {exc}")
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print("\nLOCKED STATE CONTRACT CHECK PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

