import { useMemo, useState } from 'react';
import { useProjectStore } from '../store/useProjectStore';
import { DraggablePanel } from './DraggablePanel';

interface Props {
  toolbarHeight: number;
  statusBarHeight: number;
}

type Axis = 'x' | 'y';

function num(value: string) {
  const normalized = value.trim().replace(',', '.');
  if (!normalized) return NaN;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function formatCoord(value: number | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : '—';
}

function AxisDistanceForm({
  title,
  actionLabel,
  selectedCount,
  onApply
}: {
  title: string;
  actionLabel: string;
  selectedCount: number;
  onApply: (dx: number, dy: number) => void;
}) {
  const [axis, setAxis] = useState<Axis>('x');
  const [direction, setDirection] = useState<1 | -1>(1);
  const [distance, setDistance] = useState('1000');

  const parsedDistance = num(distance);
  const dx = axis === 'x' ? direction * parsedDistance : 0;
  const dy = axis === 'y' ? direction * parsedDistance : 0;
  const disabled = selectedCount === 0 || !Number.isFinite(parsedDistance) || Math.abs(parsedDistance) <= 1e-12;

  return (
    <div className="edit-command-card">
      <div className="edit-card-title">{title}</div>
      <div className="edit-selected-line">Выбрано точек: <b>{selectedCount}</b></div>

      <div className="edit-axis-grid">
        <button className={`axis-button ${axis === 'x' ? 'active' : ''}`} onClick={() => setAxis('x')}>Ось X</button>
        <button className={`axis-button ${axis === 'y' ? 'active' : ''}`} onClick={() => setAxis('y')}>Ось Y</button>
      </div>

      <div className="edit-axis-grid">
        <button className={`axis-button ${direction === 1 ? 'active' : ''}`} onClick={() => setDirection(1)}>+</button>
        <button className={`axis-button ${direction === -1 ? 'active' : ''}`} onClick={() => setDirection(-1)}>−</button>
      </div>

      <label className="settings-grid-row">
        <span>Расстояние</span>
        <input value={distance} onChange={(e) => setDistance(e.target.value)} />
      </label>

      <div className="settings-help">
        Итоговое смещение: ΔX = {Number.isFinite(dx) ? dx.toFixed(3) : '—'}, ΔY = {Number.isFinite(dy) ? dy.toFixed(3) : '—'}.
      </div>

      <button className="btn full-width primary" disabled={disabled} onClick={() => onApply(dx, dy)}>
        {actionLabel}
      </button>
    </div>
  );
}

export function EditingPanel({ toolbarHeight, statusBarHeight }: Props) {
  const {
    project,
    selectedPointIds,
    selectedGroupId,
    editingTool,
    editPointPickMode,
    copyBasePoint,
    copyBasePointId,
    propertySourcePointId,
    closeEditingPanel,
    createPointAt,
    moveSelectedPoints,
    copySelectedPoints,
    copyGroupPropertyToTargets,
    setEditPointPickMode,
    setCopyBasePoint,
    setPropertySourcePointId
  } = useProjectStore();

  const [x, setX] = useState('0');
  const [y, setY] = useState('0');
  const [copyMode, setCopyMode] = useState<'offset' | 'base'>('offset');

  const selectedGroup = selectedGroupId ? project.groups.find((g) => g.id === selectedGroupId) : null;
  const propertySourcePoint = propertySourcePointId ? project.points.find((p) => p.id === propertySourcePointId) : null;
  const propertySourceGroup = propertySourcePoint?.groupId ? project.groups.find((g) => g.id === propertySourcePoint.groupId) : null;
  const propertyTargetIds = selectedPointIds.filter((id) => id !== propertySourcePointId);
  const title = useMemo(() => {
    if (editingTool === 'create') return 'Создать точку';
    if (editingTool === 'move') return 'Переместить';
    if (editingTool === 'copy') return 'Копировать';
    if (editingTool === 'props') return 'Копировать свойства';
    return 'Редактирование';
  }, [editingTool]);

  const handleCreate = () => {
    const px = num(x);
    const py = num(y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return;
    createPointAt(px, py);
  };

  const createDisabled = !Number.isFinite(num(x)) || !Number.isFinite(num(y));

  return (
    <DraggablePanel
      id="editing-panel"
      title={title}
      initialX={Math.max(20, window.innerWidth - 470)}
      initialY={toolbarHeight + 14}
      width={430}
      height={editingTool === 'copy' ? 600 : 430}
      minWidth={360}
      minHeight={280}
      dockable
      dockOffsetTop={toolbarHeight}
      dockOffsetBottom={statusBarHeight}
      onClose={closeEditingPanel}
    >
      <div className="editing-panel">
        {editingTool === 'create' && (
          <div className="edit-command-card">
            <div className="edit-card-title">Новая точка по координатам</div>
            <label className="settings-grid-row">
              <span>X</span>
              <input value={x} onChange={(e) => setX(e.target.value)} />
            </label>
            <label className="settings-grid-row">
              <span>Y</span>
              <input value={y} onChange={(e) => setY(e.target.value)} />
            </label>
            <div className="point-pick-status property-status">
              <span>Группа новой точки: <b>{selectedGroup?.name ?? project.groups[0]?.name ?? 'Без группы'}</b></span>
            </div>
            <div className="settings-help">
              Точка создаётся в координатах проекта и автоматически попадает в активную группу. Если активная группа не выбрана, берётся первая группа из списка.
            </div>
            <button className="btn full-width primary" disabled={createDisabled} onClick={handleCreate}>
              Создать точку
            </button>
          </div>
        )}

        {editingTool === 'move' && (
          <AxisDistanceForm
            title="Перемещение по оси"
            actionLabel="Переместить выбранные"
            selectedCount={selectedPointIds.length}
            onApply={moveSelectedPoints}
          />
        )}

        {editingTool === 'copy' && (
          <>
            <div className="edit-mode-switch">
              <button className={`axis-button ${copyMode === 'offset' ? 'active' : ''}`} onClick={() => {
                setCopyMode('offset');
                setEditPointPickMode(null);
                setCopyBasePoint(null, null);
              }}>
                Смещение
              </button>
              <button className={`axis-button ${copyMode === 'base' ? 'active' : ''}`} onClick={() => {
                setCopyMode('base');
                setCopyBasePoint(null, null);
                if (selectedPointIds.length > 0) setEditPointPickMode('copy_base');
              }}>
                Базовая точка
              </button>
            </div>

            {copyMode === 'offset' ? (
              <AxisDistanceForm
                title="Копирование по заданному смещению"
                actionLabel="Скопировать выбранные"
                selectedCount={selectedPointIds.length}
                onApply={copySelectedPoints}
              />
            ) : (
              <div className="edit-command-card">
                <div className="edit-card-title">Копирование как в AutoCAD: базовая точка → точка вставки</div>
                <div className="edit-selected-line">Выбрано точек: <b>{selectedPointIds.length}</b></div>

                <div className="copy-step-list">
                  <button
                    className={`copy-step ${editPointPickMode === 'copy_base' ? 'active' : ''}`}
                    disabled={selectedPointIds.length === 0}
                    onClick={() => {
                      setCopyBasePoint(null, null);
                      setEditPointPickMode('copy_base');
                    }}
                  >
                    1. Выбрать базовую из существующих точек
                  </button>

                  <button
                    className={`copy-step ${editPointPickMode === 'copy_target' ? 'active' : ''}`}
                    disabled={selectedPointIds.length === 0 || !copyBasePoint}
                    onClick={() => setEditPointPickMode('copy_target')}
                  >
                    2. Выбрать точку вставки из существующих точек
                  </button>
                </div>

                <div className="point-pick-status">
                  <span>База: <b>{copyBasePointId ?? 'не выбрана'}</b></span>
                  <span>Базовая X: <b>{formatCoord(copyBasePoint?.x)}</b></span>
                  <span>Базовая Y: <b>{formatCoord(copyBasePoint?.y)}</b></span>
                </div>

                <div className="settings-help">
                  Выбор ограничен существующими точками: так базовая точка и точка вставки не промахиваются мимо свай. Копии сохраняют группу исходных точек.
                </div>

                {editPointPickMode === 'copy_base' && (
                  <div className="edit-pick-banner">Кликни по существующей точке: выбираем базовую точку.</div>
                )}
                {editPointPickMode === 'copy_target' && (
                  <div className="edit-pick-banner">Кликни по существующей точке: выбираем точку вставки. Команда останется активной, можно сделать несколько копий от той же базы.</div>
                )}
              </div>
            )}
          </>
        )}

        {editingTool === 'props' && (
          <div className="edit-command-card">
            <div className="edit-card-title">Копировать свойства точки</div>
            <div className="settings-help">
              Сейчас копируется только группа. Сначала зафиксируй исходную точку, потом кликай по приёмникам — окно остаётся открытым, источник не сбрасывается.
            </div>

            <div className="copy-step-list">
              <button
                className={`copy-step ${editPointPickMode === 'props_source' ? 'active' : ''}`}
                onClick={() => {
                  setPropertySourcePointId(null);
                  setEditPointPickMode('props_source');
                }}
              >
                1. Зафиксировать исходную точку
              </button>

              <button
                className={`copy-step ${editPointPickMode === 'props_target' ? 'active' : ''}`}
                disabled={!propertySourcePoint}
                onClick={() => setEditPointPickMode('props_target')}
              >
                2. Назначать приёмникам
              </button>
            </div>

            <div className="point-pick-status property-status">
              <span>Источник: <b>{propertySourcePoint?.id ?? 'не выбран'}</b></span>
              <span>Группа источника: <b>{propertySourceGroup?.name ?? (propertySourcePoint ? 'Без группы' : '—')}</b></span>
              <span>Выбрано приёмников: <b>{propertyTargetIds.length}</b></span>
            </div>

            <div className="settings-help">
              Источник подсвечивается на поле зелёным кольцом. В режиме приёмника обычный клик сразу копирует группу источника на эту точку. Ctrl/Shift-кликом можно набрать несколько приёмников, затем нажать кнопку ниже.
            </div>

            <button
              className="btn full-width primary"
              disabled={!propertySourcePoint || propertyTargetIds.length === 0}
              onClick={() => propertySourcePoint && copyGroupPropertyToTargets(propertySourcePoint.id, propertyTargetIds)}
            >
              Применить к выбранным приёмникам
            </button>

            {editPointPickMode === 'props_source' && (
              <div className="edit-pick-banner">Кликни по существующей точке: фиксируем источник свойств.</div>
            )}
            {editPointPickMode === 'props_target' && (
              <div className="edit-pick-banner">Кликни по точке-приёмнику. Источник останется закреплённым до закрытия окна.</div>
            )}
          </div>
        )}

        {!editingTool && (
          <div className="empty-message">Выбери команду в верхней вкладке «Редактирование».</div>
        )}
      </div>
    </DraggablePanel>
  );
}
