import { useState } from 'react';
import { DraggablePanel } from './DraggablePanel';
import { useProjectStore } from '../store/useProjectStore';

export function PointInfoPanel({ toolbarHeight, statusBarHeight }: { toolbarHeight: number; statusBarHeight: number }) {
  const { project, selectedPointIds, togglePointInfo, setPointManualNumber, clearPointManualNumber, updatePointNumberLabelOffset } = useProjectStore();
  const point = project.points.find((p) => p.id === selectedPointIds[0]);
  const group = point?.groupId ? project.groups.find((g) => g.id === point.groupId) : null;
  const [manualNumberValue, setManualNumberValue] = useState('');

  const locked = Boolean(point?.locked || group?.locked);
  const applyManualNumber = () => {
    if (!point || locked) return;
    const value = Number((manualNumberValue || String(point.number ?? '')).trim().replace(',', '.'));
    if (!Number.isFinite(value)) return;
    setPointManualNumber(point.id, Math.round(value));
  };

  return (
    <DraggablePanel
      id="point-info"
      title="Информация о точке"
      initialX={window.innerWidth - 430}
      initialY={toolbarHeight + 64}
      width={400}
      height={390}
      minWidth={320}
      minHeight={260}
      dockable
      dockOffsetTop={toolbarHeight}
      dockOffsetBottom={statusBarHeight}
      onClose={togglePointInfo}
    >
      {!point ? (
        <div className="empty-message">Выбери точку на поле, чтобы увидеть её параметры. Пока это окно активно, выделение рамкой не назначает точки в группы.</div>
      ) : (
        <>
          <div className="point-info-grid">
            <span>ID</span><code>{point.id}</code>
            <span>Source ID</span><code>{point.sourceId ?? '—'}</code>
            <span>X</span><strong>{point.x.toFixed(3)}</strong>
            <span>Y</span><strong>{point.y.toFixed(3)}</strong>
            <span>Номер исходный</span><strong>{point.sourceNumber ?? '—'}</strong>
            <span>Номер текущий</span><strong>{point.number ?? '—'}</strong>
            <span>Группа</span><strong>{group?.name ?? 'Без группы'}</strong>
            <span>Статус</span><strong>{point.syncState}</strong>
            <span>Locked</span><strong>{locked ? 'Да' : 'Нет'}</strong>
            <span>Manual</span><strong>{point.manualNumber ? 'Да' : 'Нет'}</strong>
          </div>
          {locked ? (
            <div className="field-help warning">Группа или точка заблокирована. Можно смотреть параметры, но редактирование отключено.</div>
          ) : (
            <div className="point-manual-editor">
              <label>
                Ручной номер
                <input
                  value={manualNumberValue}
                  placeholder={point.number != null ? String(point.number) : 'номер'}
                  onChange={(event) => setManualNumberValue(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') applyManualNumber(); }}
                />
              </label>
              <div className="point-info-actions">
                <button className="btn small" onClick={applyManualNumber}>Задать ручной</button>
                <button className="btn small" disabled={!point.manualNumber} onClick={() => clearPointManualNumber(point.id)}>Снять ручной</button>
                <button className="btn small" onClick={() => updatePointNumberLabelOffset(point.id, null)}>Сбросить вынос номера</button>
              </div>
            </div>
          )}
        </>
      )}
    </DraggablePanel>
  );
}
