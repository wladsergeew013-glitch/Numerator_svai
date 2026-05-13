import { type SyntheticEvent, useState } from 'react';
import { useProjectStore } from '../store/useProjectStore';
import {
  CAD_BASE_COLORS,
  DIRECTION_DESCRIPTIONS,
  DIRECTION_LABELS,
  NUMBERING_METHOD_DESCRIPTIONS,
  NUMBERING_METHOD_LABELS,
  NumberingMethod,
  NumberingDirection,
  PileGroup
} from '../types/project';
import { DraggablePanel } from './DraggablePanel';

interface Props {
  toolbarHeight: number;
  statusBarHeight: number;
}

function stop(e: SyntheticEvent) {
  e.stopPropagation();
}

interface CadConfirmState {
  title: string;
  message: string;
  details?: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
}

const METHOD_OPTIONS: Array<{ value: Exclude<NumberingMethod, 'manual'>; label: string }> = [
  { value: 'rows', label: 'Ряды' },
  { value: 'columns', label: 'Столбцы' },
  { value: 'route', label: 'Маршрут' },
  { value: 'vector', label: 'Вектор' }
];

const ROW_DIRECTIONS: NumberingDirection[] = [
  'left_to_right_top_to_bottom',
  'right_to_left_top_to_bottom',
  'left_to_right_bottom_to_top',
  'right_to_left_bottom_to_top',
  'snake_rows_left_top',
  'snake_rows_right_top'
];

const COLUMN_DIRECTIONS: NumberingDirection[] = [
  'snake_columns_top_left',
  'snake_columns_bottom_left'
];

function normalizeMethod(method: NumberingMethod): Exclude<NumberingMethod, 'manual'> {
  return method === 'manual' ? 'rows' : method;
}

function methodPatch(nextMethod: Exclude<NumberingMethod, 'manual'>, currentDirection: NumberingDirection): Partial<PileGroup['numbering']> {
  if (nextMethod === 'rows') {
    return {
      method: nextMethod,
      direction: ROW_DIRECTIONS.includes(currentDirection) ? currentDirection : 'left_to_right_top_to_bottom'
    };
  }

  if (nextMethod === 'columns') {
    return {
      method: nextMethod,
      direction: COLUMN_DIRECTIONS.includes(currentDirection) ? currentDirection : 'snake_columns_top_left'
    };
  }

  return { method: nextMethod };
}

function methodSummary(method: Exclude<NumberingMethod, 'manual'>) {
  switch (method) {
    case 'rows':
      return 'Ряды используют допуск по Y и направление обхода рядов.';
    case 'columns':
      return 'Столбцы используют допуск по X и направление обхода колонок.';
    case 'route':
      return 'Маршрут строит порядок по ближайшим точкам. Допуски рядов/колонок здесь не участвуют.';
    case 'vector':
      return 'Вектор идёт ближайшим соседом внутри движущейся волны вдоль нарисованной линии. Допуски рядов/колонок здесь не участвуют.';
    default:
      return '';
  }
}

function pipelineShortLabel(name: string | undefined | null, order: number) {
  const clean = (name ?? '').trim();
  const match = clean.match(/(\d+)\s*$/);
  return `П.${match?.[1] ?? order}`;
}

function metaBoolean(value: unknown) {
  return value === true;
}

function metaPositiveNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function ColorSelector({ group }: { group: PileGroup }) {
  const { updateGroupColor } = useProjectStore();
  const [open, setOpen] = useState(false);

  return (
    <div className="color-selector" onClick={stop} onMouseDown={stop}>
      <button
        className="color-swatch-button tooltip"
        data-tooltip={'Цвет группы\nБыстрый выбор базового CAD-цвета. Если нужного цвета нет — откройте Другой цвет.'}
        style={{ backgroundColor: group.color }}
        onClick={() => setOpen((value) => !value)}
        aria-label="Выбрать цвет группы"
      />
      {open && (
        <div className="color-popover" onClick={stop} onMouseDown={stop}>
          <div className="color-popover-title">Базовые цвета</div>
          <div className="cad-color-grid">
            {CAD_BASE_COLORS.map((color) => (
              <button
                key={color.value}
                className={`cad-color-cell ${group.color.toLowerCase() === color.value.toLowerCase() ? 'selected' : ''}`}
                style={{ backgroundColor: color.value }}
                title={color.name}
                onClick={() => {
                  updateGroupColor(group.id, color.value);
                  setOpen(false);
                }}
              />
            ))}
          </div>
          <label className="custom-color-row">
            Другой цвет...
            <input type="color" value={group.color} onChange={(e) => updateGroupColor(group.id, e.target.value)} />
          </label>
        </div>
      )}
    </div>
  );
}

export function GroupManager({ toolbarHeight, statusBarHeight }: Props) {
  const {
    project,
    selectedGroupId,
    selectedPipelineId,
    selectedPointIds,
    autoAssignSelection,
    groupManagerDock,
    groupManagerCollapsed,
    collapsedGroupIds,
    setSelectedGroup,
    setSelectedPipeline,
    setNumberingPickMode,
    createPipeline,
    deletePipeline,
    createGroup,
    deleteGroup,
    assignSelectionToGroup,
    toggleAutoAssignSelection,
    updateGroupName,
    updateGroupMeta,
    updateGroupNumbering,
    updateViewSettings,
    toggleGroupLocked,
    clearManualNumbersForGroup,
    startGroupOutlineDrawing,
    clearGroupManualOutline,
    startVectorPathDrawing,
    startVectorPathEdit,
    cancelVectorPathEdit,
    clearVectorPath,
    vectorPathDrawMode,
    vectorPathEditMode,
    moveGroup,
    setGroupManagerDock,
    toggleGroupManager,
    toggleGroupManagerCollapsed,
    toggleGroupCollapsed,
    collapseAllGroups,
    expandAllGroups,
    autoClusterEditablePoints
  } = useProjectStore();

  const offsetTop = toolbarHeight;
  const offsetBottom = statusBarHeight;
  const pipelines = [...project.pipelines].sort((a, b) => a.order - b.order);
  const activePipelineId = selectedPipelineId ?? pipelines[0]?.id ?? null;
  const visibleGroups = [...project.groups]
    .filter((group) => !activePipelineId || (group.pipelineId ?? pipelines[0]?.id ?? null) === activePipelineId)
    .sort((a, b) => a.order - b.order);
  const activePipeline = pipelines.find((pipeline) => pipeline.id === activePipelineId) ?? pipelines[0] ?? null;
  const firstGroupIdInActivePipeline = visibleGroups[0]?.id ?? null;
  const totalPointsInPipeline = project.points.filter((point) => visibleGroups.some((group) => group.id === point.groupId)).length;
  const selectedPointsCount = selectedPointIds.length;
  const allVisibleGroupsCollapsed = visibleGroups.length > 0 && visibleGroups.every((group) => collapsedGroupIds.includes(group.id));
  const toggleVisibleGroupsCollapsed = () => {
    if (allVisibleGroupsCollapsed) expandAllGroups();
    else collapseAllGroups();
  };
  const [cadConfirm, setCadConfirm] = useState<CadConfirmState | null>(null);
  const [pipelineMenuOpen, setPipelineMenuOpen] = useState(false);

  const askDeleteGroup = (group: PileGroup, pointsCount: number) => {
    setCadConfirm({
      title: 'Удалить группу',
      message: `Удалить группу «${group.name}»?`,
      details: `Точек в группе: ${pointsCount}. Точки останутся в проекте, но станут без группы. Операцию можно откатить через Ctrl+Z.`,
      confirmLabel: 'Удалить',
      danger: true,
      onConfirm: () => deleteGroup(group.id)
    });
  };

  const askAutoCluster = () => {
    const selectedCount = project.points.filter((point) => selectedPointIds.includes(point.id)).length;
    setCadConfirm({
      title: 'Автокластеризация',
      message: selectedCount >= 2
        ? 'Автоматически разбить выделенные точки на группы?'
        : 'Автоматически пересобрать все незаблокированные точки в группы?',
      details: selectedCount >= 2
        ? `Точек в выделении: ${selectedCount}. Старые группы выбранных точек будут пересобраны.`
        : 'Заблокированные группы не будут изменены. Текущие редактируемые группы будут пересобраны. Операцию можно откатить через Ctrl+Z.',
      confirmLabel: 'Авторазбить',
      danger: true,
      onConfirm: autoClusterEditablePoints
    });
  };

  const handleAssignCommand = () => {
    if (selectedPointIds.length > 0) {
      assignSelectionToGroup();
      return;
    }
    toggleAutoAssignSelection();
  };

  if (groupManagerCollapsed) {
    const selected = project.groups.find((g) => g.id === selectedGroupId);
    return (
      <DraggablePanel
        id="group-manager-collapsed"
        title="Группы"
        initialX={12}
        initialY={offsetTop + 10}
        width={130}
        height={160}
        minWidth={120}
        minHeight={130}
        onClose={toggleGroupManager}
        actions={<button className="btn small" onClick={toggleGroupManagerCollapsed}>▣</button>}
      >
        <div className="collapsed-panel-body">
          <div className="collapsed-active-color" style={{ backgroundColor: selected?.color ?? '#475569' }} title={selected?.name ?? 'Группа не выбрана'} />
          <div className="collapsed-caption">{selected?.name ?? 'Нет группы'}</div>
        </div>
      </DraggablePanel>
    );
  }

  return (
    <DraggablePanel
      id="group-manager"
      title="Диспетчер групп"
      initialX={12}
      initialY={offsetTop + 10}
      width={840}
      height={720}
      minWidth={640}
      minHeight={420}
      onClose={toggleGroupManager}
      className="group-manager-panel"
      dockable
      dock={groupManagerDock}
      onDockChange={setGroupManagerDock}
      dockOffsetTop={offsetTop}
      dockOffsetBottom={offsetBottom}
      actions={<button className="btn small" onClick={toggleGroupManagerCollapsed}>_</button>}
    >
      <div className="group-manager-content group-manager-content-v32">
        <div className="group-manager-header-grid">
          <section className="manager-section pipeline-section">
            <div className="manager-section-head">
              <div>
                <strong>Пайплайны</strong>
                <span>Выбери активную цепочку из списка</span>
              </div>
            </div>

            <div className="pipeline-picker-row">
              <div className="pipeline-dropdown-wrap" onClick={stop} onMouseDown={stop}>
                <button
                  className={`pipeline-dropdown-button ${pipelineMenuOpen ? 'open' : ''}`}
                  type="button"
                  onClick={() => setPipelineMenuOpen((value) => !value)}
                  title="Выбрать активный пайплайн"
                >
                  <span className="pipeline-index-chip">{pipelineShortLabel(activePipeline?.name, activePipeline?.order ?? 1)}</span>
                  <span className="pipeline-name-label">{activePipeline?.name ?? 'Пайплайн'}</span>
                  <em>{visibleGroups.length} групп</em>
                  <b>▾</b>
                </button>
                {pipelineMenuOpen && (
                  <div className="pipeline-dropdown-menu">
                    {pipelines.map((pipeline) => {
                      const groupCount = project.groups.filter((group) => (group.pipelineId ?? pipelines[0]?.id ?? null) === pipeline.id).length;
                      const active = pipeline.id === activePipelineId;
                      return (
                        <button
                          key={pipeline.id}
                          className={`pipeline-dropdown-item ${active ? 'active' : ''}`}
                          type="button"
                          onClick={() => {
                            setSelectedPipeline(pipeline.id);
                            setPipelineMenuOpen(false);
                          }}
                        >
                          <span className="pipeline-index-chip">{pipelineShortLabel(pipeline.name, pipeline.order)}</span>
                          <span className="pipeline-name-label">{pipeline.name}</span>
                          <em>{groupCount} групп</em>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <button className="btn small" type="button" onClick={() => { createPipeline(); setPipelineMenuOpen(false); }} title="Добавить пайплайн">＋</button>
              <button className="btn small danger" disabled={!activePipeline || pipelines.length <= 1} onClick={() => { if (activePipeline) deletePipeline(activePipeline.id); setPipelineMenuOpen(false); }}>Удалить</button>
            </div>
          </section>

          <section className="manager-section manager-actions-section">
            <div className="manager-section-head">
              <div>
                <strong>Действия</strong>
                <span>Для активного пайплайна</span>
              </div>
            </div>

            <div className="manager-action-grid">
              <button
                className="btn manager-action-button manager-action-create"
                data-tooltip="Создаёт новую группу в активном пайплайне и назначает ей первый свободный базовый CAD-цвет."
                onClick={createGroup}
              >
                <span className="manager-action-icon">✚</span>
                <span className="manager-action-text">Создать группу</span>
              </button>
              <button
                className={`btn manager-action-button manager-assign-button ${autoAssignSelection ? 'active' : ''}`}
                data-tooltip={selectedPointIds.length > 0
                  ? 'Назначить выделение\nНазначает выбранные точки в активную группу один раз. Состояние автоназначения рамкой не меняет.'
                  : `Назначить рамкой\n${autoAssignSelection ? 'Включено: выделение рамкой автоматически назначается активной группе.' : 'Выключено: нажми, чтобы включить автоназначение рамкой.'}`}
                onClick={handleAssignCommand}
              >
                <span className="manager-action-icon">{autoAssignSelection ? '☑' : '☐'}</span>
                <span className="manager-action-text">Назначить</span>
              </button>
              <button
                className="btn manager-action-button manager-action-auto"
                disabled={project.points.length < 2}
                data-tooltip={'Авторазбить точки\nЕсли есть выделение из 2+ редактируемых точек — разбивает выделение. Если выделения нет — пересобирает все незаблокированные точки. Заблокированные группы не трогаются, откат доступен через Ctrl+Z.'}
                onClick={askAutoCluster}
              >
                <span className="manager-action-icon">✦</span>
                <span className="manager-action-text">Авторазбить</span>
              </button>
            </div>

            <div className="manager-status-grid">
              <span>Групп: <b>{visibleGroups.length}</b></span>
              <span>Точек: <b>{totalPointsInPipeline}</b></span>
              <span>Выбрано: <b>{selectedPointsCount}</b></span>
            </div>
          </section>
        </div>

        <section className="manager-section group-list-section">
          <div className="manager-section-head group-list-head">
            <div>
              <strong>Группы пайплайна</strong>
              <span>{activePipeline?.name ?? 'Пайплайн'} · порядок сверху вниз задаёт цепочку нумерации</span>
            </div>
            <button
              className="btn small group-list-view-toggle"
              disabled={visibleGroups.length === 0}
              data-tooltip={allVisibleGroupsCollapsed ? 'Развернуть карточки групп текущего пайплайна' : 'Свернуть карточки групп текущего пайплайна'}
              onClick={toggleVisibleGroupsCollapsed}
            >
              {allVisibleGroupsCollapsed ? '▾ Развернуть' : '▸ Свернуть'}
            </button>
          </div>

          <div className="group-list-v32">
            {visibleGroups.length === 0 && (
              <div className="empty-message">В этом пайплайне пока нет групп. Создай группу или запусти автокластеризацию.</div>
            )}

            {visibleGroups.map((g, index) => {
              const count = project.points.filter((p) => p.groupId === g.id).length;
              const collapsed = collapsedGroupIds.includes(g.id);
              const active = selectedGroupId === g.id;
              const method = normalizeMethod(g.numbering.method);
              const clusterNumbering = metaBoolean(g.meta?.clusterNumbering);
              const clusterPrefix = metaPositiveNumber(g.meta?.clusterPrefix, index + 1);
              const methodLabel = String(NUMBERING_METHOD_LABELS[method] ?? method);
              return (
                <div key={g.id} className={`group-card group-card-v32 ${active ? 'active' : ''} ${collapsed ? 'collapsed-card' : ''} ${g.locked ? 'locked' : ''}`} onClick={() => setSelectedGroup(g.id)}>
                  <div className="group-card-top group-card-top-v32">
                    <button className="collapse-button" onClick={(e) => { stop(e); toggleGroupCollapsed(g.id); }}>{collapsed ? '▸' : '▾'}</button>
                    <ColorSelector group={g} />
                    <span className="group-order-chip">{index + 1}</span>
                    <div className="group-title-block">
                      <div className="group-name-line">{g.name}</div>
                      <div className="group-meta-line">{methodLabel} · {count} точек</div>
                    </div>
                    <div className="group-order-quick" onClick={stop} onMouseDown={stop}>
                      <button className="btn small" data-tooltip="Поднять группу выше в текущем пайплайне" disabled={index === 0} onClick={() => moveGroup(g.id, -1)}>↑</button>
                      <button className="btn small" data-tooltip="Опустить группу ниже в текущем пайплайне" disabled={index === visibleGroups.length - 1} onClick={() => moveGroup(g.id, 1)}>↓</button>
                    </div>
                    {active && <span className="active-badge">Активная</span>}
                    {clusterNumbering && <span className="active-badge">Кластер {clusterPrefix}</span>}
                    {g.locked && <span className="active-badge warning">Блок</span>}
                    <button className="btn small" data-tooltip={g.locked ? 'Разблокировать группу' : 'Заблокировать группу: точки, связи и нумерация группы не меняются'} onClick={(e) => { stop(e); toggleGroupLocked(g.id); }}>{g.locked ? '🔒' : '🔓'}</button>
                    <button className="btn small danger group-delete-quick" disabled={g.locked} data-tooltip={g.locked ? 'Заблокированную группу удалить нельзя' : 'Удалить группу. Точки останутся в проекте без группы.'} onClick={(e) => { stop(e); askDeleteGroup(g, count); }}>×</button>
                    <span className="badge">{count}</span>
                  </div>

                  {collapsed ? null : (
                    <div className="group-card-body group-card-body-v32" onClick={stop} onMouseDown={stop}>
                      <div className="group-settings-grid">
                        <div className="field-row">
                          <label>Имя</label>
                          <input value={g.name} disabled={g.locked} onChange={(e) => updateGroupName(g.id, e.target.value)} />
                        </div>

                        <label className="auto-assign-row compact cluster-toggle-row tooltip" data-tooltip="Кластерная группа\nНумерация внутри группы начинается с 1, а итоговый номер получает числовой префикс кластера. Например: префикс 2 и локальный номер 13 дают 213.">
                          <input
                            type="checkbox"
                            checked={clusterNumbering}
                            disabled={g.locked}
                            onChange={(e) => updateGroupMeta(g.id, { clusterNumbering: e.target.checked })}
                          />
                          <span>Кластер</span>
                        </label>

                        {clusterNumbering && (
                          <div className="field-row">
                            <label className="tooltip" data-tooltip="Индекс кластера\nЧисловой префикс итоговых номеров. По умолчанию берётся порядок группы в пайплайне.">Индекс кластера</label>
                            <input
                              type="number"
                              min={1}
                              disabled={g.locked}
                              value={clusterPrefix}
                              onChange={(e) => updateGroupMeta(g.id, { clusterPrefix: Number(e.target.value) || index + 1 })}
                            />
                          </div>
                        )}

                        {(project.numberingMode === 'per_group' || g.id === firstGroupIdInActivePipeline || clusterNumbering) ? (
                          <div className="field-row">
                            <label className="tooltip" data-tooltip={project.numberingMode === 'per_group'
                              ? (clusterNumbering ? 'Локальный старт кластера\nДля кластера обычно оставляют 1. Итоговый номер получает префикс кластера.' : 'Начальный номер группы\nВ режиме «по группам» каждая группа может иметь свой старт.')
                              : 'Начальный номер пайплайна\nВ сквозном режиме задаётся только у первой группы текущего пайплайна. Следующие группы продолжают нумерацию автоматически.'
                            }>Начать с №</label>
                            <input
                              type="number"
                              disabled={g.locked}
                              value={g.numbering.startNumber}
                              onChange={(e) => updateGroupNumbering(g.id, { startNumber: Number(e.target.value) })}
                            />
                          </div>
                        ) : (
                          <div className="field-help compact pipeline-start-note">
                            Старт номера берётся автоматически после предыдущей группы пайплайна.
                          </div>
                        )}

                        <div className="field-row">
                          <label className="tooltip" data-tooltip={`Метод нумерации\n${NUMBERING_METHOD_DESCRIPTIONS[method]}`}>Метод</label>
                          <select
                            value={method}
                            disabled={g.locked}
                            onChange={(e) => updateGroupNumbering(g.id, methodPatch(e.target.value as Exclude<NumberingMethod, 'manual'>, g.numbering.direction))}
                          >
                            {METHOD_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                        </div>

                        <div className="field-help compact group-method-note">{methodSummary(method)}</div>

                        {method === 'rows' && (
                          <>
                            <div className="field-row">
                              <label className="tooltip" data-tooltip="Допуск рядов — максимальная разница по Y, при которой точки считаются одним рядом. Для столбцов, маршрута и вектора не используется.">Допуск рядов</label>
                              <input
                                type="number"
                                disabled={g.locked}
                                value={g.numbering.rowTolerance}
                                onChange={(e) => updateGroupNumbering(g.id, { rowTolerance: Number(e.target.value) })}
                              />
                            </div>

                            <div className="field-row wide-field">
                              <label className="tooltip" data-tooltip={`Направление рядов\n${DIRECTION_DESCRIPTIONS[g.numbering.direction]}`}>Направление</label>
                              <select
                                value={ROW_DIRECTIONS.includes(g.numbering.direction) ? g.numbering.direction : 'left_to_right_top_to_bottom'}
                                disabled={g.locked}
                                onChange={(e) => updateGroupNumbering(g.id, { direction: e.target.value as NumberingDirection })}
                              >
                                {ROW_DIRECTIONS.map((value) => (
                                  <option key={value} value={value}>{DIRECTION_LABELS[value]}</option>
                                ))}
                              </select>
                            </div>
                          </>
                        )}

                        {method === 'columns' && (
                          <>
                            <div className="field-row">
                              <label className="tooltip" data-tooltip="Допуск колонок — максимальная разница по X, при которой точки считаются одной колонкой. Для рядов, маршрута и вектора не используется.">Допуск колонок</label>
                              <input
                                type="number"
                                disabled={g.locked}
                                value={g.numbering.columnTolerance}
                                onChange={(e) => updateGroupNumbering(g.id, { columnTolerance: Number(e.target.value) })}
                              />
                            </div>

                            <div className="field-row wide-field">
                              <label className="tooltip" data-tooltip={`Направление колонок\n${DIRECTION_DESCRIPTIONS[g.numbering.direction]}`}>Направление</label>
                              <select
                                value={COLUMN_DIRECTIONS.includes(g.numbering.direction) ? g.numbering.direction : 'snake_columns_top_left'}
                                disabled={g.locked}
                                onChange={(e) => updateGroupNumbering(g.id, { direction: e.target.value as NumberingDirection })}
                              >
                                {COLUMN_DIRECTIONS.map((value) => (
                                  <option key={value} value={value}>{DIRECTION_LABELS[value]}</option>
                                ))}
                              </select>
                            </div>
                          </>
                        )}

                        {method === 'route' && (
                          <label className="auto-assign-row compact route-optimize-row tooltip" data-tooltip="Оптимизация маршрута\nЕсли включено, после первичного обхода маршрут дополнительно улучшается. Старт/финиш всё равно остаются приоритетными.">
                            <input
                              type="checkbox"
                              checked={g.numbering.optimize}
                              disabled={g.locked}
                              onChange={(e) => updateGroupNumbering(g.id, { optimize: e.target.checked })}
                            />
                            Оптимизировать маршрут
                          </label>
                        )}

                        {method === 'vector' && (
                          <>
                            <div className="field-row">
                              <label className="tooltip" data-tooltip="Коридор вокруг нарисованной линии. Сейчас это мягкий допуск: он влияет на приоритет, но не выбрасывает точки и не ломает ближайший маршрут.">Допуск до вектора</label>
                              <input
                                type="number"
                                disabled={g.locked}
                                value={g.numbering.maxDistanceToPath}
                                onChange={(e) => updateGroupNumbering(g.id, { maxDistanceToPath: Number(e.target.value) })}
                              />
                            </div>
                            <div className="outline-tools-box wide-field">
                              <div className="outline-tools-title">Векторный маршрут</div>
                              <div className="outline-tools-actions">
                                <button
                                  className="btn small"
                                  disabled={g.locked || count === 0}
                                  onClick={() => { setSelectedGroup(g.id); startVectorPathDrawing(g.id); }}
                                >
                                  {vectorPathDrawMode && active ? 'Рисуется...' : 'Нарисовать'}
                                </button>
                                <button
                                  className={`btn small ${vectorPathEditMode && active ? 'active' : ''}`}
                                  disabled={g.locked || !(g.numbering.vectorPath?.length >= 2)}
                                  onClick={() => {
                                    setSelectedGroup(g.id);
                                    if (vectorPathEditMode && active) cancelVectorPathEdit();
                                    else startVectorPathEdit(g.id);
                                  }}
                                >
                                  {vectorPathEditMode && active ? 'Редактируется' : 'Редактировать'}
                                </button>
                                <button
                                  className="btn small"
                                  disabled={g.locked || !(g.numbering.vectorPath?.length >= 2)}
                                  onClick={() => clearVectorPath(g.id)}
                                >
                                  Очистить
                                </button>
                                <button
                                  className={`btn small ${project.viewSettings.showVectorPath === false ? '' : 'active'}`}
                                  disabled={!(g.numbering.vectorPath?.length >= 2)}
                                  onClick={() => updateViewSettings({ showVectorPath: project.viewSettings.showVectorPath === false })}
                                >
                                  {project.viewSettings.showVectorPath === false ? 'Показать' : 'Скрыть'}
                                </button>
                              </div>
                              <div className="field-help compact">
                                Вершин в векторе: {g.numbering.vectorPath?.length ?? 0}. ЛКМ добавляет вершину/сегмент, Shift рисует ортогонально, Ctrl+Z отменяет последнюю вершину. Правка работает только через режим «Редактировать». Скрытие вектора не удаляет маршрут.
                              </div>
                            </div>
                          </>
                        )}
                      </div>

                      <div className="group-tools-grid">
                        <div className="numbering-points-box">
                          <div className="numbering-points-title">Начало и финиш группы</div>
                          <div className="numbering-point-row">
                            <span>Старт</span>
                            <strong>{g.numbering.startPointId ? 'Задан вручную' : 'Авто'}</strong>
                            <button className="btn small" disabled={g.locked || count === 0} onClick={() => { setSelectedGroup(g.id); setNumberingPickMode('group_start'); }}>Выбрать</button>
                            <button className="btn small" disabled={g.locked || !g.numbering.startPointId} onClick={() => updateGroupNumbering(g.id, { startPointId: null })}>Авто</button>
                          </div>
                          <div className="numbering-point-row">
                            <span>Финиш</span>
                            <strong>{g.numbering.endPointId ? 'Задан вручную' : 'Авто'}</strong>
                            <button className="btn small" disabled={g.locked || count === 0} onClick={() => { setSelectedGroup(g.id); setNumberingPickMode('group_end'); }}>Выбрать</button>
                            <button className="btn small" disabled={g.locked || !g.numbering.endPointId} onClick={() => updateGroupNumbering(g.id, { endPointId: null })}>Авто</button>
                          </div>
                          <div className="field-help compact">Выбор работает по ближайшей существующей точке активной группы.</div>
                        </div>

                        <div className="outline-tools-box">
                          <div className="outline-tools-title">Контур группы</div>
                          <div className="outline-tools-actions">
                            <button className="btn small" disabled={g.locked || count === 0} onClick={() => { setSelectedGroup(g.id); startGroupOutlineDrawing(g.id); }}>Нарисовать</button>
                            <button className="btn small" disabled={g.locked || !g.meta?.manualOutline} onClick={() => clearGroupManualOutline(g.id)}>Авто-контур</button>
                          </div>
                          <div className="field-help compact">Ручной контур: кликай вершины по полю, Enter — замкнуть, Esc — отменить.</div>
                        </div>
                      </div>

                      <div className="group-actions group-actions-v32">
                        <button className="btn small" disabled={g.locked} onClick={() => clearManualNumbersForGroup(g.id)}>Снять ручные</button>
                        <button className="btn small danger" disabled={g.locked} onClick={() => askDeleteGroup(g, count)}>Удалить</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </div>

      {cadConfirm && (
        <div className="cad-confirm-backdrop" onClick={() => setCadConfirm(null)} onMouseDown={stop}>
          <div className="cad-confirm-dialog" onClick={stop} onMouseDown={stop}>
            <div className="cad-confirm-title">{cadConfirm.title}</div>
            <div className="cad-confirm-message">{cadConfirm.message}</div>
            {cadConfirm.details && <div className="cad-confirm-details">{cadConfirm.details}</div>}
            <div className="cad-confirm-actions">
              <button className="btn small" onClick={() => setCadConfirm(null)}>Отмена</button>
              <button
                className={`btn small ${cadConfirm.danger ? 'danger' : 'primary'}`}
                onClick={() => {
                  const action = cadConfirm.onConfirm;
                  setCadConfirm(null);
                  action();
                }}
              >
                {cadConfirm.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </DraggablePanel>
  );
}
