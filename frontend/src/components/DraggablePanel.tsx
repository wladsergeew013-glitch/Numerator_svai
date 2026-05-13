import { CSSProperties, ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { getUserConfig, saveUserConfig } from '../api/client';
import { GroupManagerDock } from '../types/project';

interface Props {
  id: string;
  title: string;
  initialX: number;
  initialY: number;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  onClose?: () => void;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;

  dockable?: boolean;
  dock?: GroupManagerDock;
  onDockChange?: (dock: GroupManagerDock) => void;
  dockOffsetTop?: number;
  dockOffsetBottom?: number;
  /**
   * When false, saved dock state is ignored and the panel always opens as a floating dialog.
   * This is important for command dialogs opened over docked panels: they must not reserve
   * workspace space or appear hidden behind the dock.
   */
  openFloating?: boolean;
}

interface PanelState {
  x: number;
  y: number;
  width: number;
  height: number;
  dock?: GroupManagerDock;
}

type ResizeMode = 'left' | 'right' | 'bottom' | 'corner';
type DockSide = 'left' | 'right';

interface DockRecord {
  id: string;
  dock: DockSide;
}

const DOCK_REGISTRY_KEY = 'pile-numbering:docked-panels:v2';
const MAX_DOCK_WIDTH = 920;
let panelZCounter = 5200;

function nextPanelZIndex() {
  panelZCounter += 1;
  return panelZCounter;
}

function storageKey(id: string) {
  return `pile-numbering:panel:${id}`;
}

const externalPanelSaveTimers = new Map<string, number>();

async function loadExternalPanelState(id: string): Promise<Partial<PanelState> | null> {
  try {
    const config = await getUserConfig();
    const panel = config.panels?.[id];
    if (!panel) return null;
    return {
      x: typeof panel.x === 'number' ? panel.x : undefined,
      y: typeof panel.y === 'number' ? panel.y : undefined,
      width: typeof panel.width === 'number' ? panel.width : undefined,
      height: typeof panel.height === 'number' ? panel.height : undefined,
      dock: panel.dock === 'left' || panel.dock === 'right' || panel.dock === 'floating' ? panel.dock : undefined
    };
  } catch {
    return null;
  }
}

function saveExternalPanelState(id: string, state: PanelState) {
  if (typeof window === 'undefined') return;
  const existingTimer = externalPanelSaveTimers.get(id);
  if (existingTimer) window.clearTimeout(existingTimer);

  const timer = window.setTimeout(() => {
    getUserConfig()
      .then((config) => saveUserConfig({
        ...config,
        panels: {
          ...(config.panels ?? {}),
          [id]: {
            x: state.x,
            y: state.y,
            width: state.width,
            height: state.height,
            dock: state.dock ?? 'floating'
          }
        }
      }))
      .catch(() => {
        // backend config unavailable in browser fallback
      });
  }, 300);
  externalPanelSaveTimers.set(id, timer);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function isDockSide(value: GroupManagerDock | undefined | null): value is DockSide {
  return value === 'left' || value === 'right';
}

function readRegistry(): DockRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(DOCK_REGISTRY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is DockRecord => item && typeof item.id === 'string' && (item.dock === 'left' || item.dock === 'right'));
  } catch {
    return [];
  }
}

function writeRegistry(items: DockRecord[]) {
  if (typeof window === 'undefined') return;
  const deduped: DockRecord[] = [];
  for (const item of items) {
    const existing = deduped.findIndex((x) => x.id === item.id);
    if (existing >= 0) deduped[existing] = item;
    else deduped.push(item);
  }
  window.localStorage.setItem(DOCK_REGISTRY_KEY, JSON.stringify(deduped));
  window.dispatchEvent(new CustomEvent('pile-numbering-dock-layout-changed', { detail: deduped }));
}

function updateRegistry(id: string, dock: GroupManagerDock) {
  const registry = readRegistry().filter((item) => item.id !== id);
  if (isDockSide(dock)) registry.push({ id, dock });
  writeRegistry(registry);
}

function removeFromRegistry(id: string) {
  writeRegistry(readRegistry().filter((item) => item.id !== id));
}

function loadPanelState(id: string, fallback: PanelState, allowSavedDock: boolean): PanelState {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(storageKey(id));
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PanelState>;
    return {
      x: typeof parsed.x === 'number' ? parsed.x : fallback.x,
      y: typeof parsed.y === 'number' ? parsed.y : fallback.y,
      width: typeof parsed.width === 'number' ? parsed.width : fallback.width,
      height: typeof parsed.height === 'number' ? parsed.height : fallback.height,
      dock: allowSavedDock && (parsed.dock === 'left' || parsed.dock === 'right' || parsed.dock === 'floating') ? parsed.dock : fallback.dock
    };
  } catch {
    return fallback;
  }
}

function readPanelWidth(id: string, fallback = 360) {
  try {
    const raw = window.localStorage.getItem(storageKey(id));
    const parsed = raw ? JSON.parse(raw) as Partial<PanelState> : null;
    const value = typeof parsed?.width === 'number' ? parsed.width : fallback;
    return clamp(value, 260, Math.max(260, Math.min(MAX_DOCK_WIDTH, window.innerWidth * 0.68)));
  } catch {
    return fallback;
  }
}

function getDockOffset(id: string, dock: DockSide) {
  let offset = 0;
  for (const item of readRegistry()) {
    if (item.dock !== dock) continue;
    if (item.id === id) return offset;
    offset += readPanelWidth(item.id);
  }
  return offset;
}

function savePanelState(id: string, state: PanelState) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey(id), JSON.stringify(state));
    saveExternalPanelState(id, state);
    window.dispatchEvent(new CustomEvent('pile-numbering-panel-resized', {
      detail: { id, width: state.width, height: state.height, dock: state.dock ?? 'floating' }
    }));
  } catch {
    // ignore storage errors
  }
}

export function DraggablePanel({
  id,
  title,
  initialX,
  initialY,
  width = 380,
  height = 420,
  minWidth = 260,
  minHeight = 180,
  onClose,
  actions,
  className,
  children,
  dockable = false,
  dock,
  onDockChange,
  dockOffsetTop = 90,
  dockOffsetBottom = 28,
  openFloating = false
}: Props) {
  const canUseDock = dockable && !openFloating;
  const allowSavedDock = canUseDock;
  const fallback = useMemo(() => ({ x: initialX, y: initialY, width, height, dock: canUseDock ? (dock ?? 'floating' as GroupManagerDock) : 'floating' as GroupManagerDock }), [canUseDock, dock, height, initialX, initialY, width]);
  const [panelState, setPanelState] = useState<PanelState>(() => loadPanelState(id, fallback, allowSavedDock));
  const [internalDock, setInternalDock] = useState<GroupManagerDock>(() => canUseDock ? (panelState.dock ?? 'floating') : 'floating');
  const [panelZIndex, setPanelZIndex] = useState(nextPanelZIndex);
  const [dockPreview, setDockPreview] = useState<DockSide | null>(null);
  const [dockVersion, setDockVersion] = useState(0);
  const dragRef = useRef<{ startX: number; startY: number; panelX: number; panelY: number } | null>(null);
  const resizeRef = useRef<{
    mode: ResizeMode;
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
    startLeft: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadExternalPanelState(id).then((external) => {
      if (cancelled || !external) return;
      setPanelState((prev) => {
        const next = {
          ...prev,
          ...external,
          x: typeof external.x === 'number' ? external.x : prev.x,
          y: typeof external.y === 'number' ? external.y : prev.y,
          width: typeof external.width === 'number' ? external.width : prev.width,
          height: typeof external.height === 'number' ? external.height : prev.height,
          dock: allowSavedDock ? (external.dock ?? prev.dock) : 'floating'
        };
        if (allowSavedDock && !dock && external.dock) setInternalDock(external.dock);
        if (!canUseDock) removeFromRegistry(id);
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [allowSavedDock, canUseDock, dock, id]);

  const effectiveDock = canUseDock ? (dock ?? internalDock) : 'floating';
  const isDocked = canUseDock && (effectiveDock === 'left' || effectiveDock === 'right');
  const dockOffset = isDocked ? getDockOffset(id, effectiveDock) : 0;
  const dockMaxWidth = Math.max(minWidth, Math.min(MAX_DOCK_WIDTH, window.innerWidth * 0.68));

  const bringToFront = () => setPanelZIndex(nextPanelZIndex());

  const setDockValue = (nextDock: GroupManagerDock) => {
    if (!canUseDock) nextDock = 'floating';
    bringToFront();
    setPanelState((prev) => {
      const next = {
        ...prev,
        dock: nextDock,
        width: isDockSide(nextDock) ? clamp(prev.width, minWidth, dockMaxWidth) : prev.width
      };
      savePanelState(id, next);
      return next;
    });

    if (onDockChange) onDockChange(nextDock);
    else setInternalDock(nextDock);

    if (canUseDock) updateRegistry(id, nextDock);
    else removeFromRegistry(id);
    setDockVersion((value) => value + 1);
  };

  useEffect(() => {
    bringToFront();
    if (canUseDock) updateRegistry(id, effectiveDock);
    else removeFromRegistry(id);
    setDockVersion((value) => value + 1);
    return () => removeFromRegistry(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, canUseDock, effectiveDock]);

  useEffect(() => {
    const onLayoutChange = () => setDockVersion((value) => value + 1);
    window.addEventListener('pile-numbering-dock-layout-changed', onLayoutChange);
    return () => window.removeEventListener('pile-numbering-dock-layout-changed', onLayoutChange);
  }, []);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const resize = resizeRef.current;
      if (resize) {
        setPanelState((prev) => {
          let next = { ...prev };
          const maxWidth = isDocked ? dockMaxWidth : window.innerWidth - 20;

          if (resize.mode === 'right' || resize.mode === 'corner') {
            next.width = clamp(resize.startWidth + event.clientX - resize.startX, minWidth, maxWidth);
          }

          if (resize.mode === 'left') {
            const dx = event.clientX - resize.startX;
            const nextWidth = clamp(resize.startWidth - dx, minWidth, maxWidth);
            const widthDelta = nextWidth - resize.startWidth;
            next.width = nextWidth;
            if (!isDocked) next.x = resize.startLeft - widthDelta;
          }

          if (!isDocked && (resize.mode === 'bottom' || resize.mode === 'corner')) {
            next.height = clamp(resize.startHeight + event.clientY - resize.startY, minHeight, window.innerHeight - 40);
          }

          if (isDocked) {
            next.y = dockOffsetTop;
            next.height = Math.max(minHeight, window.innerHeight - dockOffsetTop - dockOffsetBottom);
          }

          next.dock = effectiveDock;
          savePanelState(id, next);
          if (canUseDock) updateRegistry(id, effectiveDock);
          else removeFromRegistry(id);
          setDockVersion((value) => value + 1);
          return next;
        });
        return;
      }

      const drag = dragRef.current;
      if (!drag) return;

      const nextX = clamp(drag.panelX + event.clientX - drag.startX, 6, window.innerWidth - 80);
      const nextY = clamp(drag.panelY + event.clientY - drag.startY, 6, window.innerHeight - 60);

      setPanelState((prev) => {
        const next = { ...prev, x: nextX, y: nextY, dock: effectiveDock };
        savePanelState(id, next);
        return next;
      });

      if (canUseDock) {
        if (event.clientX < 132) setDockPreview('left');
        else if (event.clientX > window.innerWidth - 132) setDockPreview('right');
        else setDockPreview(null);
      }
    };

    const onUp = () => {
      if (dragRef.current && dockPreview) setDockValue(dockPreview);
      dragRef.current = null;
      resizeRef.current = null;
      setDockPreview(null);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canUseDock, dockOffsetBottom, dockOffsetTop, dockPreview, dockMaxWidth, effectiveDock, id, isDocked, minHeight, minWidth]);

  const startDrag = (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest('button,input,select,label,textarea')) return;
    bringToFront();
    if (isDocked) {
      const next = {
        ...panelState,
        dock: 'floating' as GroupManagerDock,
        x: effectiveDock === 'left' ? Math.max(14, dockOffset + 14) : Math.max(14, window.innerWidth - dockOffset - panelState.width - 24),
        y: Math.max(dockOffsetTop + 10, event.clientY - 22),
        height: Math.min(panelState.height, Math.max(minHeight, window.innerHeight - dockOffsetTop - dockOffsetBottom - 28))
      };
      setPanelState(next);
      savePanelState(id, next);
      setDockValue('floating');
      dragRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        panelX: next.x,
        panelY: next.y
      };
    } else {
      dragRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        panelX: panelState.x,
        panelY: panelState.y
      };
    }
    event.preventDefault();
  };

  const startResize = (mode: ResizeMode, event: React.MouseEvent) => {
    bringToFront();
    resizeRef.current = {
      mode,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: panelState.width,
      startHeight: panelState.height,
      startLeft: panelState.x
    };
    event.preventDefault();
    event.stopPropagation();
  };

  const style: CSSProperties = isDocked
    ? {
        left: effectiveDock === 'left' ? dockOffset : undefined,
        right: effectiveDock === 'right' ? dockOffset : undefined,
        top: dockOffsetTop,
        width: clamp(panelState.width, minWidth, dockMaxWidth),
        height: `calc(100vh - ${dockOffsetTop + dockOffsetBottom}px)`,
        minWidth,
        minHeight,
        zIndex: panelZIndex
      }
    : {
        left: panelState.x,
        top: panelState.y,
        width: panelState.width,
        height: panelState.height,
        minWidth,
        minHeight,
        zIndex: panelZIndex
      };

  const showLeftResize = !isDocked || effectiveDock === 'right';
  const showRightResize = !isDocked || effectiveDock === 'left';

  return (
    <>
      {dockPreview && <div className={`dock-anchor dock-anchor-${dockPreview}`}>Закрепить окно {dockPreview === 'left' ? 'слева' : 'справа'}</div>}
      <section
        key={dockVersion}
        className={`floating-panel draggable-panel ${isDocked ? `docked-panel docked-${effectiveDock}` : ''} ${className ?? ''}`.trim()}
        style={style}
        onMouseDown={bringToFront}
      >
        <div className="floating-panel-head drag-handle" onMouseDown={startDrag}>
          <strong>{title}</strong>
          <div className="panel-actions">
            {canUseDock && !isDocked && (
              <>
                <button className="btn small" data-tooltip="Закрепить окно слева" onClick={() => setDockValue('left')}>⇤</button>
                <button className="btn small" data-tooltip="Закрепить окно справа" onClick={() => setDockValue('right')}>⇥</button>
              </>
            )}
            {isDocked && (
              <button className="btn small" data-tooltip="Открепить окно" onClick={() => setDockValue('floating')}>⇱</button>
            )}
            {actions}
            {onClose && (
              <button
                className="btn small"
                onClick={() => {
                  removeFromRegistry(id);
                  onClose();
                }}
              >
                ×
              </button>
            )}
          </div>
        </div>
        <div className="floating-panel-body">{children}</div>

        {showLeftResize && <div className="resize-handle resize-left" onMouseDown={(event) => startResize('left', event)} />}
        {showRightResize && <div className="resize-handle resize-right" onMouseDown={(event) => startResize('right', event)} />}
        {!isDocked && <div className="resize-handle resize-bottom" onMouseDown={(event) => startResize('bottom', event)} />}
        {!isDocked && <div className="resize-handle resize-corner" onMouseDown={(event) => startResize('corner', event)} />}
      </section>
    </>
  );
}

