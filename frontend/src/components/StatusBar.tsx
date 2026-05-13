import { useProjectStore } from '../store/useProjectStore';

interface Props {
  x: number;
  y: number;
  zoom: number;
  pointsCount: number;
}

export function StatusBar({ x, y, zoom, pointsCount }: Props) {
  const { selectedPointIds, selectedGroupId, project, pointInfoVisible, editingTool, editPointPickMode, numberingPickMode, numberingPreview } = useProjectStore();
  const group = project.groups.find((g) => g.id === selectedGroupId);
  const noNumberCount = project.points.filter((p) => p.number == null).length;
  const mode =
    numberingPickMode === 'group_start' ? 'Нумерация: выбрать старт'
    : numberingPickMode === 'group_end' ? 'Нумерация: выбрать финиш'
    : numberingPickMode === 'manual_link_target' ? 'Нумерация: выбрать конец стрелки'
      : numberingPreview.visible ? 'Предпросмотр нумерации'
        : editPointPickMode === 'copy_base' ? 'Копирование: базовая точка'
      : editPointPickMode === 'copy_target' ? 'Копирование: точка вставки'
        : editPointPickMode === 'props_source' ? 'Свойства: исходная точка'
          : editPointPickMode === 'props_target' ? 'Свойства: точка-приёмник'
            : pointInfoVisible ? 'Инфо'
              : editingTool === 'create' ? 'Создать точку'
                : editingTool === 'move' ? 'Переместить'
                  : editingTool === 'copy' ? 'Копировать'
                    : editingTool === 'props' ? 'Копировать свойства'
                      : 'обычный';

  const projectFileState = project.project.fileName
    ? project.project.fileName
    : project.project.sourceFileName
      ? `источник: ${project.project.sourceFileName}`
      : 'новый / не сохранён';

  return (
    <footer className="status-bar">
      <span>Проект: {project.project.name || 'Без имени'} ({projectFileState})</span>
      <span>X: {x.toFixed(2)}</span>
      <span>Y: {y.toFixed(2)}</span>
      <span>Zoom: {(zoom * 100).toFixed(1)}%</span>
      <span>Точек: {pointsCount}</span>
      <span>Без номера: {noNumberCount}</span>
      <span>Выбрано: {selectedPointIds.length}</span>
      <span>Группа: {group?.name ?? 'не выбрана'}</span>
      <span>Режим: {mode}</span>
    </footer>
  );
}