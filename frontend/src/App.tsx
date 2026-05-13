import { useEffect, useRef, useState } from 'react';
import { autosaveProject, getUserConfig, importCsv, type AutosaveSettingsPayload } from './api/client';
import { CadTooltip } from './components/CadTooltip';
import { CanvasView } from './components/CanvasView';
import { EditingPanel } from './components/EditingPanel';
import { GroupManager } from './components/GroupManager';
import { OperationJournal } from './components/OperationJournal';
import { PointInfoPanel } from './components/PointInfoPanel';
import { StatusBar } from './components/StatusBar';
import { Toolbar } from './components/Toolbar';
import { useProjectStore } from './store/useProjectStore';
import './styles.css';

const DEFAULT_TOOLBAR_HEIGHT = 150;
const STATUS_BAR_HEIGHT = 28;
const DOCK_REGISTRY_KEY = 'pile-numbering:docked-panels:v2';
const MAX_DOCK_WIDTH = 920;
const MIN_CANVAS_WIDTH_WHEN_DOCKED = 160;

// Dock registry is runtime-only. Old persisted entries may describe windows
// that are not mounted anymore; if we keep them, the canvas gets a phantom
// reserved stripe after page start. Panel sizes/positions are still persisted
// in their own config keys, but the active dock list is rebuilt by mounted panels.
if (typeof window !== 'undefined') {
  try {
    window.localStorage.removeItem(DOCK_REGISTRY_KEY);
  } catch {
    // ignore storage errors
  }
}

interface DockRecord {
  id: string;
  dock: 'left' | 'right';
}

function loadToolbarHeight() {
  if (typeof window === 'undefined') return DEFAULT_TOOLBAR_HEIGHT;
  try {
    const raw = window.localStorage.getItem('pile-numbering:toolbar-height');
    const value = Number(raw);
    if (!Number.isFinite(value)) return DEFAULT_TOOLBAR_HEIGHT;
    return Math.min(Math.max(value, 118), 280);
  } catch {
    return DEFAULT_TOOLBAR_HEIGHT;
  }
}

function readDockRegistry(): DockRecord[] {
  try {
    const raw = window.localStorage.getItem(DOCK_REGISTRY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is DockRecord => item && typeof item.id === 'string' && (item.dock === 'left' || item.dock === 'right'));
  } catch {
    return [];
  }
}

function loadPanelWidth(id: string, fallback: number) {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(`pile-numbering:panel:${id}`);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as { width?: number };
    return typeof parsed.width === 'number' ? Math.min(Math.max(parsed.width, 180), Math.min(MAX_DOCK_WIDTH, window.innerWidth * 0.68)) : fallback;
  } catch {
    return fallback;
  }
}

function clampDockReserve(raw: { left: number; right: number }) {
  const maxReserve = Math.max(0, window.innerWidth - MIN_CANVAS_WIDTH_WHEN_DOCKED);
  const left = Math.max(0, Math.ceil(raw.left || 0));
  const right = Math.max(0, Math.ceil(raw.right || 0));
  const total = left + right;
  if (total <= maxReserve) return { left, right };
  const scale = maxReserve / Math.max(1, total);
  return { left: Math.floor(left * scale), right: Math.floor(right * scale) };
}

function computeDockReserve() {
  const reserve = { left: 0, right: 0 };
  for (const item of readDockRegistry()) {
    reserve[item.dock] += loadPanelWidth(item.id, item.id === 'group-manager' ? 360 : 380);
  }
  return clampDockReserve(reserve);
}

function normalizeAutosaveSettings(settings?: AutosaveSettingsPayload | null): Required<AutosaveSettingsPayload> {
  const interval = Number(settings?.intervalMinutes);
  return {
    enabled: Boolean(settings?.enabled),
    intervalMinutes: Number.isFinite(interval) ? Math.max(0.25, Math.min(120, interval)) : 5,
    folderPath: settings?.folderPath || null
  };
}

export default function App() {
  const {
    appendImportedPoints,
    hydrateUserConfig,
    setSelection,
    selectedPointIds,
    cancelNumberingPreview,
    cancelNumberingLinkSelection,
    deleteSelectedNumberingManualLink,
    project,
    groupManagerVisible,
    journalVisible,
    pointInfoVisible,
    editingPanelVisible,
    deleteSelectedPoints,
    undo,
    redo,
    zoomExtents,
    vectorPathDrawMode,
    vectorPathEditMode
  } = useProjectStore();
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [error, setError] = useState<string | null>(null);
  const [toolbarHeight, setToolbarHeight] = useState(loadToolbarHeight);
  const [dockReserve, setDockReserve] = useState(() => ({ left: 0, right: 0 }));
  const [autosaveSettings, setAutosaveSettings] = useState<Required<AutosaveSettingsPayload>>(() => normalizeAutosaveSettings(null));
  const latestProjectRef = useRef(project);
  const autosaveBusyRef = useRef(false);

  useEffect(() => {
    latestProjectRef.current = project;
  }, [project]);



  useEffect(() => {
    let cancelled = false;
    getUserConfig()
      .then((config) => {
        if (cancelled) return;
        hydrateUserConfig(config);
        if (typeof config.toolbarHeight === 'number' && Number.isFinite(config.toolbarHeight)) {
          setToolbarHeight(Math.min(Math.max(config.toolbarHeight, 118), 280));
        }
        setAutosaveSettings(normalizeAutosaveSettings(config.autosaveSettings));
      })
      .catch(() => {
        // Browser-only fallback keeps using localStorage. EXE uses config/user_config.json through backend.
      });
    return () => {
      cancelled = true;
    };
  }, [hydrateUserConfig]);

  useEffect(() => {
    const onSettingsChanged = (event: Event) => {
      const detail = (event as CustomEvent<AutosaveSettingsPayload>).detail;
      setAutosaveSettings(normalizeAutosaveSettings(detail));
    };
    window.addEventListener('pile-numbering:autosave-settings-updated', onSettingsChanged as EventListener);
    return () => window.removeEventListener('pile-numbering:autosave-settings-updated', onSettingsChanged as EventListener);
  }, []);

  useEffect(() => {
    if (!autosaveSettings.enabled) return;
    const intervalMs = Math.max(15_000, autosaveSettings.intervalMinutes * 60_000);
    const tick = async () => {
      if (autosaveBusyRef.current) return;
      const current = latestProjectRef.current;
      if (!current || current.points.length === 0) return;
      autosaveBusyRef.current = true;
      try {
        const result = await autosaveProject(current, autosaveSettings.folderPath);
        window.localStorage.setItem('pile-numbering:last-autosave', JSON.stringify({ at: new Date().toISOString(), fileName: result.fileName, path: result.path }));
      } catch (error) {
        window.localStorage.setItem('pile-numbering:last-autosave-error', String(error instanceof Error ? error.message : error));
      } finally {
        autosaveBusyRef.current = false;
      }
    };
    const timer = window.setInterval(() => void tick(), intervalMs);
    return () => window.clearInterval(timer);
  }, [autosaveSettings.enabled, autosaveSettings.folderPath, autosaveSettings.intervalMinutes]);

  useEffect(() => {
    const isInputTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
    };

    const consume = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (isInputTarget(event.target)) return;
      if (vectorPathDrawMode || vectorPathEditMode) return;

      const key = event.key.toLowerCase();
      const code = event.code;
      const ctrlOrMeta = event.ctrlKey || event.metaKey;
      const isUndoKey = key === 'z' || key === 'я' || code === 'KeyZ';
      const isRedoKey = key === 'y' || key === 'н' || code === 'KeyY';

      if (ctrlOrMeta && isUndoKey) {
        consume(event);
        if (event.shiftKey) redo();
        else undo();
        return;
      }

      if (ctrlOrMeta && isRedoKey) {
        consume(event);
        redo();
        return;
      }

      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (deleteSelectedNumberingManualLink()) {
          consume(event);
          return;
        }
        if (event.key === 'Delete' && selectedPointIds.length > 0) {
          consume(event);
          deleteSelectedPoints();
        }
        return;
      }

      if (event.key !== 'Escape') return;
      consume(event);
      if (cancelNumberingLinkSelection()) return;
      cancelNumberingPreview();
      if (selectedPointIds.length > 0) setSelection([]);
    };

    // Один глобальный обработчик. Раньше обработчик висел и на document, и на window:
    // одно нажатие Delete/Escape обрабатывалось два раза. Из-за этого выбранная связь
    // сначала снималась/удалялась, а вторым проходом удалялись выбранные точки или гас весь путь.
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [cancelNumberingLinkSelection, cancelNumberingPreview, deleteSelectedNumberingManualLink, deleteSelectedPoints, redo, selectedPointIds.length, setSelection, undo, vectorPathDrawMode, vectorPathEditMode]);

  useEffect(() => {
    let rafId = 0;

    const refreshDockReserve = () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        setDockReserve(computeDockReserve());
      });
    };

    const onResize = () => {
      setSize({ w: window.innerWidth, h: window.innerHeight });
      refreshDockReserve();
    };

    window.addEventListener('resize', onResize);
    window.addEventListener('pile-numbering-panel-resized', refreshDockReserve as EventListener);
    window.addEventListener('pile-numbering-dock-layout-changed', refreshDockReserve as EventListener);

    refreshDockReserve();
    window.setTimeout(refreshDockReserve, 0);
    window.setTimeout(refreshDockReserve, 80);
    window.setTimeout(refreshDockReserve, 220);

    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pile-numbering-panel-resized', refreshDockReserve as EventListener);
      window.removeEventListener('pile-numbering-dock-layout-changed', refreshDockReserve as EventListener);
    };
  }, []);

  const workspaceWidth = Math.max(MIN_CANVAS_WIDTH_WHEN_DOCKED, size.w - dockReserve.left - dockReserve.right);
  const canvasWidth = workspaceWidth;
  const canvasHeight = Math.max(300, size.h - toolbarHeight - STATUS_BAR_HEIGHT);

  const handleCsvImport = async (file: File) => {
    try {
      setError(null);
      const points = await importCsv(file);
      appendImportedPoints(file.name, points);
      requestAnimationFrame(() => zoomExtents(canvasWidth, canvasHeight));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка импорта CSV');
    }
  };

  return (
    <div className="app">
      <Toolbar
        onCsvImport={handleCsvImport}
        canvasWidth={canvasWidth}
        canvasHeight={canvasHeight}
        onHeightChange={setToolbarHeight}
      />
      {error && <div className="error-banner">{error}</div>}
      <div
        className="workspace"
        style={{
          position: 'fixed',
          top: toolbarHeight,
          left: dockReserve.left,
          right: dockReserve.right,
          bottom: STATUS_BAR_HEIGHT,
          width: 'auto',
          height: canvasHeight,
          marginLeft: 0,
          marginRight: 0
        }}
      >
        <CanvasView width={canvasWidth} height={canvasHeight} onPointerUpdate={(x, y) => setPointer({ x, y })} />
      </div>
      {groupManagerVisible && <GroupManager toolbarHeight={toolbarHeight} statusBarHeight={STATUS_BAR_HEIGHT} />}
      {editingPanelVisible && <EditingPanel toolbarHeight={toolbarHeight} statusBarHeight={STATUS_BAR_HEIGHT} />}
      {journalVisible && <OperationJournal toolbarHeight={toolbarHeight} statusBarHeight={STATUS_BAR_HEIGHT} />}
      {pointInfoVisible && <PointInfoPanel toolbarHeight={toolbarHeight} statusBarHeight={STATUS_BAR_HEIGHT} />}
      <CadTooltip />
      <StatusBar x={pointer.x} y={pointer.y} zoom={project.viewSettings.zoom} pointsCount={project.points.length} />
    </div>
  );
}

