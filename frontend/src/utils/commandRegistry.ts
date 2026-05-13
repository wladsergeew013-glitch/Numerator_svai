export type RibbonCommandId =
  | 'file.new'
  | 'file.open'
  | 'file.projects'
  | 'file.import'
  | 'file.save'
  | 'file.export'
  | 'edit.createPoint'
  | 'edit.delete'
  | 'edit.move'
  | 'edit.copy'
  | 'edit.copyProps'
  | 'edit.info'
  | 'groups.manager'
  | 'groups.assign'
  | 'numbering.fullPath'
  | 'numbering.animation'
  | 'numbering.clearLinks'
  | 'numbering.group'
  | 'numbering.all'
  | 'workspace.zoomExtents'
  | 'workspace.grid'
  | 'workspace.numbers'
  | 'workspace.emptyPoints'
  | 'workspace.settings'
  | 'history.undo'
  | 'history.redo'
  | 'history.journal';

export interface RibbonCommandDefinition {
  id: RibbonCommandId;
  section: 'Файл' | 'Редактирование' | 'Группы' | 'Нумерация' | 'Рабочее поле' | 'История';
  label: string;
  defaultIcon: string;
}

export const RIBBON_COMMANDS: RibbonCommandDefinition[] = [
  { id: 'file.new', section: 'Файл', label: 'Создать', defaultIcon: '✚' },
  { id: 'file.open', section: 'Файл', label: 'Открыть', defaultIcon: '📂' },
  { id: 'file.projects', section: 'Файл', label: 'Проекты', defaultIcon: '🗂' },
  { id: 'file.import', section: 'Файл', label: 'Импорт', defaultIcon: '➕' },
  { id: 'file.save', section: 'Файл', label: 'Сохранить', defaultIcon: '💽' },
  { id: 'file.export', section: 'Файл', label: 'Экспорт', defaultIcon: '📤' },
  { id: 'edit.createPoint', section: 'Редактирование', label: 'Точка', defaultIcon: '＋' },
  { id: 'edit.delete', section: 'Редактирование', label: 'Удалить', defaultIcon: '⌫' },
  { id: 'edit.move', section: 'Редактирование', label: 'Переместить', defaultIcon: '↔' },
  { id: 'edit.copy', section: 'Редактирование', label: 'Копировать', defaultIcon: '⧉' },
  { id: 'edit.copyProps', section: 'Редактирование', label: 'Коп.св-ва', defaultIcon: '🧾' },
  { id: 'edit.info', section: 'Редактирование', label: 'Инфо', defaultIcon: 'ℹ' },
  { id: 'groups.manager', section: 'Группы', label: 'Группы', defaultIcon: '▤' },
  { id: 'groups.assign', section: 'Группы', label: 'Назначить', defaultIcon: '☑' },
  { id: 'numbering.fullPath', section: 'Нумерация', label: 'Весь путь', defaultIcon: '⛓' },
  { id: 'numbering.animation', section: 'Нумерация', label: 'Мультик', defaultIcon: '▶' },
  { id: 'numbering.clearLinks', section: 'Нумерация', label: 'Очистить', defaultIcon: '🧹' },
  { id: 'numbering.group', section: 'Нумерация', label: 'Группа', defaultIcon: '№' },
  { id: 'numbering.all', section: 'Нумерация', label: 'Все', defaultIcon: '№№' },
  { id: 'workspace.zoomExtents', section: 'Рабочее поле', label: 'Всё поле', defaultIcon: '⛶' },
  { id: 'workspace.grid', section: 'Рабочее поле', label: 'Сетка', defaultIcon: '#' },
  { id: 'workspace.numbers', section: 'Рабочее поле', label: 'Номера', defaultIcon: '12' },
  { id: 'workspace.emptyPoints', section: 'Рабочее поле', label: 'Пустые', defaultIcon: '○!' },
  { id: 'workspace.settings', section: 'Рабочее поле', label: 'Настройки', defaultIcon: '⚙' },
  { id: 'history.undo', section: 'История', label: 'Отмена', defaultIcon: '↶' },
  { id: 'history.redo', section: 'История', label: 'Повтор', defaultIcon: '↷' },
  { id: 'history.journal', section: 'История', label: 'Журнал', defaultIcon: '🧾' }
];

export const RIBBON_COMMANDS_BY_ID = Object.fromEntries(
  RIBBON_COMMANDS.map((command) => [command.id, command])
) as Record<RibbonCommandId, RibbonCommandDefinition>;

export function getRibbonCommandDefaultIcon(id: RibbonCommandId) {
  return RIBBON_COMMANDS_BY_ID[id]?.defaultIcon ?? '□';
}
