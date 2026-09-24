import { useEffect, useState } from 'react';
import { DraggablePanel } from './DraggablePanel';
import { useProjectStore } from '../store/useProjectStore';
import { actOnNanoCadPoint, selectNanoCadObjectByHandle } from '../api/client';

export function PointInfoPanel({ toolbarHeight, statusBarHeight }: { toolbarHeight: number; statusBarHeight: number }) {
  const { project, selectedPointIds, togglePointInfo, setPointManualNumber, clearPointManualNumber, updatePointNumberLabelOffset, syncPointFromModel } = useProjectStore();
  const point = project.points.find((p) => p.id === selectedPointIds[0]);
  const group = point?.groupId ? project.groups.find((g) => g.id === point.groupId) : null;
  useEffect(() => {
    const state = useProjectStore.getState();
    if (group && state.selectedGroupId !== group.id) state.setSelectedGroup(group.id);
    if (group) useProjectStore.setState({ groupManagerVisible: true, groupManagerCollapsed: false,
      collapsedGroupIds: state.collapsedGroupIds.filter(id => id !== group.id) });
  }, [point?.id, group?.id]);
  const [manualNumberValue, setManualNumberValue] = useState('');
  const [parameterChoice, setParameterChoice] = useState('');
  const [cadActionStatus, setCadActionStatus] = useState<{ title: string; message: string; elapsed?: number; error?: boolean } | null>(null);
  const [cadActionBusy, setCadActionBusy] = useState(false);
  useEffect(() => { setCadActionStatus(null); setManualNumberValue(''); setParameterChoice(''); }, [point?.id]);
  const cadHandle = String(point?.meta?.cadHandle ?? '').trim();
  const cadDocument = String(point?.meta?.cadDocument ?? '').trim();
  const objectKind = point?.meta?.source === 'nanocad_block' ? 'block' : 'model_studio';
  const objectName = String(point?.meta?.[objectKind === 'block' ? 'blockName' : 'objectName'] ?? '').trim() || undefined;
  const parameterOptions = point?.meta?.[objectKind === 'block' ? 'attributes' : 'parameters'];
  const availableParameters = parameterOptions && typeof parameterOptions === 'object' && !Array.isArray(parameterOptions)
    ? Object.keys(parameterOptions) : [];
  const storedParameter = String(point?.meta?.numberParameter ?? '').trim();
  const parameterName = parameterChoice || storedParameter || availableParameters.find(name => /номер|number|pile|сва/i.test(name)) || '';
  const locked = Boolean(point?.locked || group?.locked);
  const runCadAction = async (action: 'select' | 'read' | 'write' | 'position') => {
    if (!point || !cadHandle || !cadDocument || cadActionBusy || (locked && action !== 'select')) return;
    const titles = { select: 'Выбор в модели', read: 'Чтение номера', write: 'Запись номера', position: 'Обновление координат' };
    const title = titles[action];
    const started = performance.now();
    setCadActionBusy(true);
    setCadActionStatus({ title, message: 'Выполняется в nanoCAD…' });
    try {
      let message = '';
      if (action === 'select') {
        const result = await selectNanoCadObjectByHandle(cadHandle, cadDocument, objectName);
        message = `Объект ${result.handle} выделен в исходном DWG.`;
      } else {
        const enteredNumber = manualNumberValue.trim();
        const value = action === 'write' ? (enteredNumber || String(point.number ?? '')) : undefined;
        if (action !== 'position' && !parameterName) throw new Error('Выберите параметр номера для этой точки.');
        if (action === 'write' && !/^[+-]?\d+$/.test(value ?? '')) throw new Error('Для записи укажите целый номер точки.');
        const result = await actOnNanoCadPoint({ action, handle: cadHandle, documentPath: cadDocument,
          objectName, objectKind, parameterName, value });
        if (action === 'position') {
          if (!result.position) throw new Error('nanoCAD не вернул координаты объекта.');
          const base = point.meta?.importBasePoint;
          const basePoint = base && typeof base === 'object' ? base as { x?: unknown; y?: unknown } : {};
          const baseX = Number(basePoint.x ?? 0);
          const baseY = Number(basePoint.y ?? 0);
          const projectX = result.position.x - (Number.isFinite(baseX) ? baseX : 0);
          const projectY = result.position.y - (Number.isFinite(baseY) ? baseY : 0);
          syncPointFromModel(point.id, action, { x: projectX, y: projectY, rawPosition: result.position });
          message = `Координаты обновлены: X ${projectX.toFixed(3)}, Y ${projectY.toFixed(3)}.`;
        } else {
          syncPointFromModel(point.id, action, { rawNumber: result.rawNumber, number: result.number,
            parameterName: result.parameterName, manualOverride: action === 'write' && Boolean(enteredNumber) && Number(enteredNumber) !== point.number });
          message = action === 'read'
            ? `Прочитано из ${result.parameterName}: ${result.rawNumber || 'пусто'}${result.number == null ? ' · значение не является целым номером' : ''}.`
            : `Номер ${result.rawNumber} записан в ${result.parameterName} и проверен. Сохраните DWG в nanoCAD.`;
        }
      }
      setCadActionStatus({ title, message, elapsed: (performance.now() - started) / 1000 });
    } catch (error) {
      setCadActionStatus({ title, message: error instanceof Error ? error.message : String(error),
        elapsed: (performance.now() - started) / 1000, error: true });
    } finally { setCadActionBusy(false); }
  };
  const applyManualNumber = () => {
    if (!point || locked) return;
    const text = (manualNumberValue || String(point.number ?? '')).trim();
    if (!/^[+-]?\d+$/.test(text)) {
      setCadActionStatus({ title: 'Номер в проекте', message: 'Введите целый номер точки.', error: true });
      return;
    }
    const value = Number(text);
    if (!Number.isSafeInteger(value)) {
      setCadActionStatus({ title: 'Номер в проекте', message: 'Номер выходит за допустимый диапазон.', error: true });
      return;
    }
    setPointManualNumber(point.id, value);
    setCadActionStatus({ title: 'Номер в проекте', message: `Задан ручной номер ${value}.` });
  };

  return (
    <DraggablePanel
      id="point-info"
      title="Информация о точке"
      className="point-info-panel-modern"
      initialX={window.innerWidth - 430}
      initialY={toolbarHeight + 18}
      width={430}
      height={Math.max(420, Math.min(620, window.innerHeight - toolbarHeight - statusBarHeight - 36))}
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
        <div className="point-info-layout">
          <section className="point-info-section" aria-label="Сведения о точке">
            <h3>Сведения</h3>
            <div className="point-info-grid">
              <span>Группа</span><strong>{group?.name ?? 'Без группы'}</strong>
              <span>Координаты</span><strong>X {point.x.toFixed(3)} · Y {point.y.toFixed(3)}</strong>
              <span>Номер в проекте</span><strong>{point.number ?? '—'}{point.manualNumber ? ' · ручной' : ''}</strong>
              <span>Номер из модели</span><strong>{point.sourceNumber ?? '—'}</strong>
              <span>Тип объекта</span><strong>{objectName ?? '—'}</strong>
              <span>Handle в DWG</span><code>{cadHandle || '—'}</code>
              <span>Статус</span><strong>{locked ? 'Заблокирована' : point.syncState}</strong>
              <span>ID</span><code>{point.id}</code>
            </div>
          </section>
          <section className="point-info-section point-info-command-section" aria-label="Команды для точки">
            <h3>Команды для точки</h3>
            <p>Действия с объектом в исходном открытом DWG по его handle.</p>
            <div className="point-command-grid">
              <button className="btn" disabled={!cadHandle || !cadDocument || cadActionBusy} onClick={() => void runCadAction('select')}>Выбрать в модели</button>
              <button className="btn" disabled={!cadHandle || !cadDocument || cadActionBusy || locked} onClick={() => void runCadAction('position')}>Обновить положение</button>
            </div>
            <label className="point-parameter-field"><span>Параметр номера объекта</span>
              <input list="point-number-parameters" value={parameterName} onChange={event => setParameterChoice(event.target.value)} placeholder="Выберите или введите параметр" disabled={locked || cadActionBusy} />
              <datalist id="point-number-parameters">{availableParameters.map(name => <option key={name} value={name} />)}</datalist>
            </label>
            <div className="point-command-grid">
              <button className="btn" disabled={!cadHandle || !cadDocument || !parameterName || cadActionBusy || locked} onClick={() => void runCadAction('read')}>Считать номер из модели</button>
              <button className="btn primary" disabled={!cadHandle || !cadDocument || !parameterName || (point.number == null && !manualNumberValue.trim()) || cadActionBusy || locked} onClick={() => void runCadAction('write')}>Записать номер в модель</button>
            </div>
            {!cadHandle || !cadDocument ? <small className="field-help warning">Связь с DWG отсутствует. Повторный импорт той же точки прикрепит handle при совпадении координат.</small> : null}
            {cadActionStatus && <div className={`point-command-status ${cadActionStatus.error ? 'failed' : ''}`} role="status">
              <strong>{cadActionStatus.title}{cadActionBusy ? ' · выполняется' : cadActionStatus.error ? ' · ошибка' : ' · готово'}</strong>
              <span>{cadActionStatus.message}</span>
              {cadActionStatus.elapsed != null && <small>Время: {cadActionStatus.elapsed.toFixed(1)} с</small>}
            </div>}
          </section>
          <section className="point-info-section" aria-label="Номер в проекте">
            <h3>Номер в проекте</h3>
            {locked ? <div className="field-help warning">Точка или группа заблокирована. Редактирование отключено.</div> : <div className="point-manual-editor">
              <label>Номер точки<input value={manualNumberValue} placeholder={point.number != null ? String(point.number) : 'Введите номер'}
                onChange={event => setManualNumberValue(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') applyManualNumber(); }} /></label>
              <div className="point-info-actions">
                <button className="btn small" onClick={applyManualNumber}>Задать в проекте</button>
                <button className="btn small" disabled={!point.manualNumber} onClick={() => clearPointManualNumber(point.id)}>Снять ручной</button>
                <button className="btn small" onClick={() => updatePointNumberLabelOffset(point.id, null)}>Сбросить вынос</button>
              </div>
            </div>}
          </section>
        </div>
      )}
    </DraggablePanel>
  );
}
