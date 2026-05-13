# -*- coding: utf-8 -*-
"""Static smoke-check for the Pile Numbering frontend contract.

Run from project root:
    python tools/checks/frontend_contract_check.py
or double-click:
    tools\02_check_frontend_contract.bat

This is a lightweight guard before UI edits. It does not replace e2e tests,
but it catches the exact class of breakages we already hit: deleted commands,
missing hooks/imports, broken group manager anchors, and lost outline color logic.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


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


def reject(text: str, needle: str, where: str, reason: str) -> None:
    if needle in text:
        raise AssertionError(f"forbidden {needle!r} in {where}: {reason}")


def check_toolbar() -> None:
    toolbar = read("frontend/src/components/Toolbar.tsx")
    fixed_labels = [
        "Создать", "Открыть", "Проекты", "Импорт", "Сохранить", "Переим.", "Экспорт",
        "Точка", "Удалить", "Переместить", "Копировать", "Коп.св-ва", "Инфо",
        "Группы", "Назначить", "Весь путь", "Очистить", "Группа", "Все",
        "Всё поле", "Сетка", "Номера", "Пустые", "Проверка", "Настройки", "Отмена", "Повтор", "Журнал",
    ]
    for label in fixed_labels:
        require(toolbar, f'label="{label}"', "Toolbar.tsx")
    require(toolbar, "Мультик", "Toolbar.tsx")
    require(toolbar, "autoAssignSelection", "Toolbar.tsx")
    require(toolbar, "handleAssignCommand", "Toolbar.tsx")
    require(toolbar, "ghost-ribbon-group", "Toolbar.tsx")
    require(toolbar, "ribbonScrollLeftRef", "Toolbar.tsx")
    require(toolbar, "create-project-dialog", "Toolbar.tsx")
    require(toolbar, "import-data-dialog", "Toolbar.tsx")
    require(toolbar, "export-data-dialog", "Toolbar.tsx")
    require(toolbar, "buildCsvPreview", "Toolbar.tsx")
    require(toolbar, "buildExcelPreview", "Toolbar.tsx")
    require(toolbar, "buildImportPreview", "Toolbar.tsx")
    require(toolbar, "makeNormalizedCsvFile", "Toolbar.tsx")
    require(toolbar, "openCreateProjectDialog", "Toolbar.tsx")
    require(toolbar, "rename-project-dialog", "Toolbar.tsx")
    require(toolbar, "openRenameProjectDialog", "Toolbar.tsx")
    require(toolbar, "showSaveFilePicker", "Toolbar.tsx")
    require(toolbar, "saveProjectJson", "Toolbar.tsx")
    require(toolbar, "model-check-dialog", "Toolbar.tsx")
    require(toolbar, "scanNanoCadBlocks", "Toolbar.tsx")
    require(toolbar, "pickNanoCadBlockSample", "Toolbar.tsx")
    require(toolbar, "importNanoCadBlocks", "Toolbar.tsx")
    require(toolbar, "exportNanoCadBlocks", "Toolbar.tsx")
    require(toolbar, "scanNanoCadModelStudioObjects", "Toolbar.tsx")
    require(toolbar, "importNanoCadModelStudioObjects", "Toolbar.tsx")
    require(toolbar, "exportNanoCadModelStudioObjects", "Toolbar.tsx")
    require(toolbar, "setNanoCadTransferStatus", "Toolbar.tsx")
    require(toolbar, "Скан nanoCAD для экспорта", "Toolbar.tsx")
    require(toolbar, "refreshNanoCadBlocks('export')", "Toolbar.tsx")
    require(toolbar, "pickNanoCadSample('export')", "Toolbar.tsx")
    require(toolbar, "refreshNanoCadModelStudioObjects('export')", "Toolbar.tsx")
    require(toolbar, "wizard-step", "Toolbar.tsx")
    require(toolbar, "export-group-list", "Toolbar.tsx")
    require(toolbar, "base-point-card", "Toolbar.tsx")
    if "openFloating" in toolbar:
        raise AssertionError("Toolbar dialogs must be dockable again; remove openFloating from command windows")
    require(toolbar, "buildModelCheck", "Toolbar.tsx")
    require(toolbar, "toggleEmptyPointCheck", "Toolbar.tsx")
    require(toolbar, "aboutOpen", "Toolbar.tsx")
    require(toolbar, "about-project-dialog", "Toolbar.tsx")
    require(toolbar, "APP_VERSION", "Toolbar.tsx")
    require(toolbar, "ABOUT_EMAIL", "Toolbar.tsx")
    require(toolbar, "copyAboutEmail", "Toolbar.tsx")
    require(toolbar, "copyTextFallback", "Toolbar.tsx")
    require(toolbar, "Версия {APP_VERSION}", "Toolbar.tsx")
    require(toolbar, "<h4>Разработчик</h4>", "Toolbar.tsx")
    require(toolbar, "Сергеев Владислав Викторович", "Toolbar.tsx")
    require(toolbar, "vvsergeev@proektirovanie.gazprom.ru", "Toolbar.tsx")
    require(toolbar, "about-email-row", "Toolbar.tsx")
    require(toolbar, "about-copy-button", "Toolbar.tsx")
    require(toolbar, "Скопировано", "Toolbar.tsx")
    for forbidden in ["Разработчик / владелец идеи", "<h4>Назначение</h4>", "зашита в код", "браузерного prompt", "будущий импорт", "будущая запись"]:
        if forbidden in toolbar:
            raise AssertionError(f"Toolbar.tsx contains non-product wording: {forbidden}")


def check_group_manager() -> None:
    gm = read("frontend/src/components/GroupManager.tsx")
    for value in ["rows", "columns", "route", "vector"]:
        require(gm, f"value: '{value}'", "GroupManager.tsx")
    require(gm, "pipelineShortLabel", "GroupManager.tsx")
    require(gm, "pipeline-index-chip", "GroupManager.tsx")
    require(gm, "manager-action-icon", "GroupManager.tsx")
    require(gm, "manager-action-text", "GroupManager.tsx")
    require(gm, "toggleVisibleGroupsCollapsed", "GroupManager.tsx")
    require(gm, "clusterNumbering", "GroupManager.tsx")
    require(gm, "clusterPrefix", "GroupManager.tsx")
    require(gm, "metaBoolean", "GroupManager.tsx")
    require(gm, "metaPositiveNumber", "GroupManager.tsx")
    if "{g.meta?.clusterNumbering &&" in gm:
        raise AssertionError("clusterNumbering from meta must be converted to boolean before JSX rendering")
    require(gm, "askDeleteGroup", "GroupManager.tsx")
    require(gm, "clearManualNumbersForGroup", "GroupManager.tsx")
    require(gm, "startGroupOutlineDrawing", "GroupManager.tsx")
    require(gm, "режим «Редактировать»", "GroupManager.tsx")
    method_block = gm.split("const METHOD_OPTIONS", 1)[1].split("];", 1)[0]
    if re.search(r"value:\s*['\"]manual['\"]", method_block):
        raise AssertionError("METHOD_OPTIONS must not expose manual as a group numbering method")


def check_canvas_outline_and_hooks() -> None:
    canvas = read("frontend/src/components/CanvasView.tsx")
    # Runtime guard: hooks must be imported explicitly. Missing this import made the app render blank.
    require(canvas, "import { useEffect, useMemo, useRef, useState } from 'react';", "CanvasView.tsx")
    require(canvas, "hexToRgba", "CanvasView.tsx")
    require_re(
        canvas,
        r"color:\s*activeNumberingGroup\.color\s*\|\|\s*project\.viewSettings\.groupOutlineStrokeColor",
        "CanvasView.tsx",
    )
    require(canvas, "startNumberingManualLinkEdit", "CanvasView.tsx")
    require(canvas, "manualLinkClearMode", "CanvasView.tsx")
    require(canvas, "previewSegmentsListening", "CanvasView.tsx")
    require(canvas, "numberingPickMode !== 'manual_link_target'", "CanvasView.tsx")
    require(canvas, "groupOutlineDrawMode", "CanvasView.tsx")
    require(canvas, "AXIS_X_COLOR", "CanvasView.tsx")
    require(canvas, "AXIS_Y_COLOR", "CanvasView.tsx")
    require(canvas, "axisX", "CanvasView.tsx")
    require(canvas, "axisY", "CanvasView.tsx")
    require(canvas, "safeMinorStep", "CanvasView.tsx")
    require(canvas, "skipMajorOverlay", "CanvasView.tsx")
    require(canvas, "isOnMajorLine", "CanvasView.tsx")
    require(canvas, "малая сетка", "CanvasView.tsx")
    require(canvas, "project.viewSettings.highlightUnnumbered", "CanvasView.tsx")
    require(canvas, "orthogonalUnionOutlineWorld", "CanvasView.tsx")
    require(canvas, "connectorRects", "CanvasView.tsx")
    require(canvas, "makeGroupOutlineScreenCorridor", "CanvasView.tsx")
    require(canvas, "makeGroupOutlineWorldCadBands", "CanvasView.tsx")
    require(canvas, "estimateNearestSpacingWorld", "CanvasView.tsx")
    require(canvas, "connectOutlineRects", "CanvasView.tsx")
    require(canvas, "мировых координатах", "CanvasView.tsx")
    require(canvas, "горизонтальные полки", "CanvasView.tsx")
    require(canvas, "CAD-полосами", "CanvasView.tsx")
    require(canvas, "splitRuns", "CanvasView.tsx")
    require(canvas, "ось Shift", "CanvasView.tsx")
    require(canvas, "groupOutlineHoverPoint", "CanvasView.tsx")
    require(canvas, "resolveGroupOutlineSnap", "CanvasView.tsx")
    require(canvas, "GroupOutlineSnapKind", "CanvasView.tsx")
    require(canvas, "const finalKind: GroupOutlineSnapKind", "CanvasView.tsx")
    require(canvas, "фантомную точку", "CanvasView.tsx")
    require(canvas, "makeOrthogonalDraftPoint", "CanvasView.tsx")
    require(canvas, "e.evt.shiftKey", "CanvasView.tsx")
    require(canvas, "savedBelongsToPoint", "CanvasView.tsx")
    require(canvas, "pointId", "CanvasView.tsx")
    require(canvas, "project.viewSettings.groupOutlineVisible === false", "CanvasView.tsx")
    require(canvas, "snapGroupOutlinePoint", "CanvasView.tsx")
    require(canvas, "storedPreviewRoutePoints", "CanvasView.tsx")
    require(canvas, "numberedFallbackAutoPoints", "CanvasView.tsx")
    require(canvas, "vectorPathDrawMode", "CanvasView.tsx")
    require(canvas, "vectorPathDraft", "CanvasView.tsx")
    require(canvas, "vectorPathEditMode", "CanvasView.tsx")
    require(canvas, "insertVectorPointFromScreen", "CanvasView.tsx")
    require(canvas, "addVectorPathDraftPoint", "CanvasView.tsx")
    require(canvas, "finishVectorPathDrawing", "CanvasView.tsx")
    require(canvas, "cancelVectorPathDrawing", "CanvasView.tsx")
    require(canvas, "activeVectorPathPoints", "CanvasView.tsx")
    require(canvas, "activeVectorPathScreenPoints", "CanvasView.tsx")
    require(canvas, "findNearestVectorHit", "CanvasView.tsx")
    require(canvas, "pointToSegmentDistancePx", "CanvasView.tsx")
    require(canvas, "showVectorPath", "CanvasView.tsx")
    require(canvas, "active-vector-path-editable-handles", "CanvasView.tsx")
    require(canvas, "updateActiveVectorHandle", "CanvasView.tsx")
    require(canvas, "group_vector_path_point_moved", "CanvasView.tsx")
    require(canvas, "режим «Редактировать»", "CanvasView.tsx")
    require(canvas, "Вектор: ЛКМ — добавить вершину", "CanvasView.tsx")
    require(canvas, "vectorExtendState", "CanvasView.tsx")
    require(canvas, "startVectorExtension", "CanvasView.tsx")
    require(canvas, "finishVectorExtension", "CanvasView.tsx")
    require(canvas, "active-vector-segment-plus", "CanvasView.tsx")
    require(canvas, "+ у концов", "CanvasView.tsx")
    require(canvas, "hitStrokeWidth={34}", "CanvasView.tsx")
    require(canvas, "vectorWorkMode", "CanvasView.tsx")
    require(canvas, "previewSegmentsListening = manualLinkClearMode || (!editPointPickMode && !numberingPickMode && !vectorPathDrawMode && !vectorPathEditMode)", "CanvasView.tsx")
    if "previewSegmentsListening = !numberingPickMode || numberingPickMode === 'manual_link_target'" in canvas:
        raise AssertionError("preview segments must not intercept manual start/end/link target picking")


def check_styles() -> None:
    css = read("frontend/src/styles.css")
    classes = [
        ".pipeline-index-chip", ".pipeline-name-label", ".manager-action-button",
        ".manager-action-icon", ".manager-action-text", ".ghost-ribbon-group",
        ".group-list-view-toggle", ".docked-panel.group-manager-panel",
        ".transfer-dialog-panel", ".csv-preview-table", ".transfer-mode-card",
        ".model-check-panel", ".model-check-summary", ".model-issue-card",
        ".base-point-card", ".nanocad-import-panel", ".nanocad-block-grid",
        ".wizard-step", ".wizard-step-title", ".export-group-list",
        ".nanocad-scan-actions",
        ".about-email-row", ".about-copy-button", ".about-copy-text",
        "v45 import / nanoCAD / dock refinements",
    ]
    for cls in classes:
        require(css, cls, "styles.css")



def check_draggable_panel_contract() -> None:
    panel = read("frontend/src/components/DraggablePanel.tsx")
    for needle in [
        "dockable?: boolean", "dockOffsetTop", "dockOffsetBottom", "updateRegistry",
        "removeFromRegistry", "pile-numbering-dock-layout-changed",
        "Закрепить окно", "dock-anchor-${dockPreview}", "dock-anchor",
    ]:
        require(panel, needle, "DraggablePanel.tsx")

def check_workspace_settings_contract() -> None:
    settings = read("frontend/src/components/WorkspaceSettingsPanel.tsx")
    require(settings, "groupOutlineVisible", "WorkspaceSettingsPanel.tsx")
    require(settings, "Показывать контур активной группы", "WorkspaceSettingsPanel.tsx")
    require(settings, "Показывать векторный маршрут", "WorkspaceSettingsPanel.tsx")
    require(settings, "uploadApplicationIcon", "WorkspaceSettingsPanel.tsx")
    require(settings, r"tools\\06_build_exe.bat", "WorkspaceSettingsPanel.tsx")
    reject(settings, r"tools\06_build_exe.bat", "WorkspaceSettingsPanel.tsx", "TS string must escape Windows backslashes as tools\\06_build_exe.bat")


def check_store_contract() -> None:
    store = read("frontend/src/store/useProjectStore.ts")
    require(store, "groupOutlineVisible", "useProjectStore.ts")
    require(store, "скрываем траекторию, но сохраняем routePointIds", "useProjectStore.ts")
    require(store, "команда «Нумеровать всё» не должна перескакивать", "useProjectStore.ts")
    anchors = [
        "deleteGroup:", "assignSelectionToGroup:", "toggleAutoAssignSelection:",
        "clearManualNumbersForGroup:", "startGroupOutlineDrawing:", "startVectorPathDrawing:",
        "startNumberingManualLinkEdit:", "clearSelectedNumberingManualLinks:",
        "applyRowsNumbering:", "applyRowsNumberingAll:", "clusterPrefixedNumber", "isClusterGroup",
    ]
    for anchor in anchors:
        require(store, anchor, "useProjectStore.ts")
    require(store, "numberingLinkFromId: null", "useProjectStore.ts")
    require(store, "numberingLinkToId: null", "useProjectStore.ts")
    if "groupPipelineId(nextGroup, { ...state.project, groups })" in store:
        raise AssertionError("groupPipelineId must not receive excess object literal with groups")


def check_package_contract() -> None:
    package = read("frontend/package.json")
    require(package, "\"xlsx\"", "package.json")
    client = read("frontend/src/api/client.ts")
    require(client, "uploadApplicationIcon", "client.ts")
    require(client, "createDesktopShortcut", "client.ts")
    settings = read("frontend/src/components/WorkspaceSettingsPanel.tsx")
    require(settings, "Создать ярлык на рабочем столе", "WorkspaceSettingsPanel.tsx")
    require(settings, "createDesktopShortcut", "WorkspaceSettingsPanel.tsx")
    if settings.count("const url = commandIcons[command.id]") > 1:
        raise AssertionError("duplicate const url in WorkspaceSettingsPanel.tsx breaks TypeScript build")



def check_nanocad_backend_contract() -> None:
    main = read("backend/app/main.py")
    require(main, "/api/nanocad/blocks/scan", "backend/app/main.py")
    require(main, "/api/nanocad/blocks/pick", "backend/app/main.py")
    require(main, "/api/nanocad/blocks/import", "backend/app/main.py")
    require(main, "/api/nanocad/blocks/export", "backend/app/main.py")
    require(main, "/api/nanocad/modelstudio/scan", "backend/app/main.py")
    require(main, "/api/system/desktop-shortcut", "backend/app/main.py")
    require(main, "CreateShortcut", "backend/app/main.py")
    require(main, "/api/nanocad/modelstudio/import", "backend/app/main.py")
    require(main, "/api/nanocad/modelstudio/export", "backend/app/main.py")
    require(main, "InsertionPoint", "backend/app/main.py")
    require(main, "_parse_numeric_number", "backend/app/main.py")
    require(main, "/api/config/app-icon", "backend/app/main.py")
    req = read("backend/requirements.txt")
    require(req, "pywin32", "backend/requirements.txt")

def check_tools_layout() -> None:
    required = [
        "tools/01_run_dev.bat",
        "tools/02_check_frontend_contract.bat",
        "tools/03_dump_project_code.bat",
        "tools/04_dump_project_tree.bat",
        "tools/05_docker_build_run.bat",
        "tools/06_build_exe.bat",
        "tools/07_check_locked_state.bat",
        "tools/08_create_desktop_shortcut.bat",
        "tools/app_icon.ico",
        "tools/90_cleanup_legacy_tools.bat",
        "tools/checks/frontend_contract_check.py",
        "tools/checks/locked_state_contract_check.py",
    ]
    for rel in required:
        if not (ROOT / rel).exists():
            raise AssertionError(f"missing organized tool: {rel}")



def check_functionality_lock_contract() -> None:
    lock = read("FUNCTIONALITY_LOCK_RU.md")
    for marker in [
        "Дополнение v45", "Дополнение v48", "Дополнение v50",
        "Дополнение v51", "Дополнение v52", "Дополнение v53",
        "Дополнение v54", "v59", "v60", "07_check_locked_state", "LOCKED_STATE_TEST_PLAN_RU",
    ]:
        require(lock, marker, "FUNCTIONALITY_LOCK_RU.md")


def main() -> int:
    checks = [
        check_toolbar,
        check_group_manager,
        check_canvas_outline_and_hooks,
        check_styles,
        check_draggable_panel_contract,
        check_workspace_settings_contract,
        check_store_contract,
        check_package_contract,
        check_nanocad_backend_contract,
        check_tools_layout,
        check_functionality_lock_contract,
    ]
    errors: list[str] = []
    for check in checks:
        try:
            check()
            print(f"[OK] {check.__name__}")
        except Exception as exc:  # noqa: BLE001 - CLI smoke-check
            errors.append(f"[FAIL] {check.__name__}: {exc}")
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print("\nFRONTEND CONTRACT CHECK PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

