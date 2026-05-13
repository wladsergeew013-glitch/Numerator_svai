import { DraggablePanel } from './DraggablePanel';
import { useProjectStore } from '../store/useProjectStore';
import { OperationRecord } from '../types/project';

const OP_LABELS: Record<string, string> = {
  project_opened: 'Открыт проект',
  project_created: 'Создан проект',
  csv_imported: 'Импорт CSV',
  csv_appended: 'Добавлен импорт CSV',
  group_created: 'Создана группа',
  group_deleted: 'Удалена группа',
  group_order_changed: 'Изменён порядок групп',
  points_assigned_to_group: 'Точки назначены в группу',
  grid_toggled: 'Переключена сетка',
  group_numbered: 'Пронумерована группа',
  all_groups_numbered: 'Пронумерованы все группы',
  local_project_saved: 'Проект сохранён в папку projects',
  point_created: 'Создана точка',
  points_deleted: 'Удалены точки',
  points_moved: 'Перемещены точки',
  points_copied: 'Скопированы точки',
  point_group_property_copied: 'Скопированы свойства точки',
  point_group_properties_copied: 'Скопированы свойства точек',
  numbering_manual_link_set: 'Задана ручная связь нумерации',
  numbering_manual_link_deleted: 'Удалена ручная связь нумерации',
  numbering_manual_links_cleared: 'Очищены ручные связи нумерации',
  group_locked: 'Группа заблокирована',
  group_unlocked: 'Группа разблокирована',
  point_manual_number_set: 'Задан ручной номер точки',
  point_manual_number_cleared: 'Снят ручной номер точки',
  group_manual_numbers_cleared: 'Сняты ручные номера группы',
  number_label_moved: 'Сдвинута подпись номера',
  group_manual_outline_set: 'Задан ручной контур группы',
  group_manual_outline_cleared: 'Сброшен ручной контур группы',
  group_vector_path_set: 'Нарисован вектор группы',
  group_vector_path_cleared: 'Сброшен вектор группы',
  pipeline_created: 'Создан пайплайн',
  pipeline_deleted: 'Удалён пайплайн',
  group_pipeline_changed: 'Группа перенесена в пайплайн',
  groups_auto_clustered: 'Автокластеризация'
};

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function describeOperation(op: OperationRecord): string {
  const p = op.payload ?? {};
  switch (op.type) {
    case 'project_opened':
      return `Открыт проект «${p.name ?? 'Без имени'}»: точек ${p.points ?? 0}, групп ${p.groups ?? 0}.`;
    case 'project_created':
      return `Создан пустой проект «${p.name ?? 'Без имени'}».`;
    case 'csv_appended':
      return `В текущий проект добавлен CSV: ${p.sourceFileName ?? ''}. Точек добавлено: ${p.points ?? 0}.`;
    case 'csv_imported':
      return `Импортировано точек: ${p.points ?? 0}.`;
    case 'group_created':
      return `Создана группа «${p.name ?? p.groupId ?? 'Без имени'}».`;
    case 'group_deleted':
      return `Удалена группа «${p.name ?? p.groupId ?? 'Без имени'}». Точки группы переведены в состояние “без группы”.`;
    case 'group_order_changed':
      return `Изменён порядок группы. Направление перемещения: ${p.direction === -1 ? 'выше' : 'ниже'}.`;
    case 'points_assigned_to_group':
      return `Назначено точек в активную группу: ${p.points ?? 0}.`;
    case 'grid_toggled':
      return `Сетка ${p.enabled ? 'включена' : 'выключена'}.`;
    case 'group_numbered':
      return `Пронумерована группа «${p.groupName ?? p.groupId ?? 'Без имени'}». Метод: ${p.method ?? 'rows'}.`;
    case 'all_groups_numbered':
      return `Пронумерованы все группы по порядку диспетчера. Групп: ${p.groups ?? 0}. Режим: ${p.mode ?? 'global_sequential'}.`;
    case 'local_project_saved':
      return `Проект сохранён в папку projects: ${p.fileName ?? ''}.`;
    case 'point_created':
      return `Создана точка: X=${Number(p.x ?? 0).toFixed(3)}, Y=${Number(p.y ?? 0).toFixed(3)}.`;
    case 'points_deleted':
      return `Удалено точек: ${p.points ?? 0}.`;
    case 'points_moved':
      return `Перемещено точек: ${p.points ?? 0}. ΔX=${Number(p.dx ?? 0).toFixed(3)}, ΔY=${Number(p.dy ?? 0).toFixed(3)}.`;
    case 'points_copied':
      return `Скопировано точек: ${p.points ?? 0}. ΔX=${Number(p.dx ?? 0).toFixed(3)}, ΔY=${Number(p.dy ?? 0).toFixed(3)}.`;
    case 'point_group_property_copied':
      return `Скопирована группа с исходной точки на точку-приёмник.`;
    case 'point_group_properties_copied':
      return `Скопирована группа с исходной точки на приёмники. Приёмников: ${p.targets ?? 0}.`;
    case 'numbering_manual_link_set':
      return `Ручная связь нумерации: ${p.fromId ?? '—'} → ${p.toId ?? '—'}.`;
    case 'numbering_manual_links_cleared':
      return `Очищены ручные связи активной группы. Удалено: ${p.removed ?? 0}.`;
    case 'numbering_manual_link_deleted':
      return `Удалена ручная связь: ${p.fromId ?? '—'} → ${p.toId ?? '—'}.`;
    case 'group_locked':
      return `Группа «${p.groupName ?? p.groupId ?? 'Без имени'}» заблокирована от редактирования.`;
    case 'group_unlocked':
      return `Группа «${p.groupName ?? p.groupId ?? 'Без имени'}» разблокирована.`;
    case 'point_manual_number_set':
      return `Точке задан ручной номер: ${p.number ?? '—'}.`;
    case 'point_manual_number_cleared':
      return `С точки снят ручной номер.`;
    case 'group_manual_numbers_cleared':
      return `В группе снята ручная фиксация номеров. Точек: ${p.points ?? 0}.`;
    case 'number_label_moved':
      return `Сдвинута выноска номера точки.`;
    case 'group_manual_outline_set':
      return `Для группы нарисован ручной контур. Вершин: ${p.vertices ?? 0}.`;
    case 'group_manual_outline_cleared':
      return `Ручной контур группы сброшен, снова используется авто-контур.`;
    case 'group_vector_path_set':
      return `Для группы «${p.groupName ?? p.groupId ?? 'Без имени'}» нарисован векторный маршрут. Точек линии: ${p.points ?? 0}.`;
    case 'group_vector_path_cleared':
      return `Векторный маршрут группы «${p.groupName ?? p.groupId ?? 'Без имени'}» сброшен.`;
    case 'pipeline_created':
      return `Создан пайплайн «${p.name ?? p.pipelineId ?? 'Без имени'}».`;
    case 'pipeline_deleted':
      return `Удалён пайплайн «${p.name ?? p.pipelineId ?? 'Без имени'}». Его группы перенесены в другой пайплайн.`;
    case 'group_pipeline_changed':
      return `Группа «${p.groupName ?? p.groupId ?? 'Без имени'}» перенесена в другой пайплайн.`;
    case 'groups_auto_clustered':
      return `Автоматически создано групп: ${p.clusters ?? 0}. Обработано точек: ${p.points ?? 0}. Область: ${p.scope === 'selection' ? 'выделение' : 'все незаблокированные точки'}.`;
    default:
      return 'Операция выполнена.';
  }
}

export function OperationJournal({ toolbarHeight, statusBarHeight }: { toolbarHeight: number; statusBarHeight: number }) {
  const { project, journalSnapshots, restoreFromJournal, toggleJournal, clearJournal } = useProjectStore();
  const operations = [...project.operations].reverse();

  return (
    <DraggablePanel
      id="operation-journal"
      title="Журнал изменений"
      initialX={window.innerWidth - 450}
      initialY={toolbarHeight + 14}
      width={420}
      height={520}
      minWidth={340}
      minHeight={260}
      dockable
      dockOffsetTop={toolbarHeight}
      dockOffsetBottom={statusBarHeight}
      onClose={toggleJournal}
      actions={<button className="btn small" onClick={clearJournal}>Очистить</button>}
    >
      <div className="journal-hint">Клик по записи восстанавливает состояние после операции. Сюда теперь попадают ручные связи, контуры, выноски, ручные номера, блокировки и операции с пайплайнами. Старые записи из файла могут быть только для просмотра.</div>
      <div className="journal-list">
        {operations.length === 0 ? (
          <div className="empty-message">Пока нет записей.</div>
        ) : operations.map((op) => {
          const canRestore = Boolean(journalSnapshots[op.id]);
          return (
            <button
              key={op.id}
              className={`journal-item ${canRestore ? 'restorable' : 'not-restorable'}`}
              type="button"
              disabled={!canRestore}
              onClick={() => restoreFromJournal(op.id)}
              title={canRestore ? 'Вернуться к состоянию после этой операции' : 'Для этой старой записи нет снимка состояния'}
            >
              <div className="journal-item-top">
                <span>{OP_LABELS[op.type] ?? op.type}</span>
                <time>{formatTime(op.timestamp)}</time>
              </div>
              <div className="journal-description">{describeOperation(op)}</div>
              <div className="journal-action-hint">{canRestore ? 'Нажми, чтобы вернуться к этому состоянию' : 'Снимок состояния недоступен'}</div>
            </button>
          );
        })}
      </div>
    </DraggablePanel>
  );
}
