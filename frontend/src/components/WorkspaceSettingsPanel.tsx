import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { DraggablePanel } from './DraggablePanel';
import { useProjectStore } from '../store/useProjectStore';
import { SELECTION_DRAG_MODE_DESCRIPTIONS, SELECTION_DRAG_MODE_LABELS, SelectionDragMode, WORKSPACE_BACKGROUND_COLORS } from '../types/project';
import { createDesktopShortcut, deleteUserIcon, getUserConfig, listUserIcons, resolveApiAssetUrl, saveUserConfig, selectAutosaveFolder, uploadApplicationIcon, uploadUserIcon, type AutosaveSettingsPayload, UserIconInfo } from '../api/client';
import { RIBBON_COMMANDS, RibbonCommandId, getRibbonCommandDefaultIcon } from '../utils/commandRegistry';
import { makeUiSettingsFile, parseUiSettingsFile } from '../utils/projectFiles';

interface Props {
  onClose: () => void;
  toolbarHeight: number;
  statusBarHeight: number;
}

type SettingsTab = 'view' | 'grid' | 'numbers' | 'markers' | 'selection' | 'autosave' | 'icons';

const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: 'view', label: 'Фон' },
  { id: 'grid', label: 'Сетка' },
  { id: 'numbers', label: 'Номера' },
  { id: 'markers', label: 'Метки' },
  { id: 'selection', label: 'Выделение' },
  { id: 'autosave', label: 'Автосохр.' },
  { id: 'icons', label: 'Иконки' }
];

function clamp(value: number, min: number, max: number, fallback: number) {
  const safe = Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, safe));
}

function normalizeAutosaveSettings(settings?: AutosaveSettingsPayload | null): Required<AutosaveSettingsPayload> {
  const interval = Number(settings?.intervalMinutes);
  return {
    enabled: Boolean(settings?.enabled),
    intervalMinutes: Number.isFinite(interval) ? Math.max(0.25, Math.min(120, interval)) : 5,
    folderPath: settings?.folderPath || null
  };
}

function FontSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="Tahoma, Segoe UI, Arial, sans-serif">Tahoma / Segoe UI</option>
      <option value="Inter, Segoe UI, Arial, sans-serif">Inter / Segoe UI</option>
      <option value="Arial, sans-serif">Arial</option>
      <option value="Tahoma, sans-serif">Tahoma</option>
      <option value="Consolas, monospace">Consolas</option>
      <option value="Times New Roman, serif">Times New Roman</option>
    </select>
  );
}

function toHexColor(value: string | undefined | null, fallback = '#020617') {
  const raw = (value || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw;
  const short = raw.match(/^#([0-9a-fA-F]{3})$/);
  if (short) return `#${short[1].split('').map((c) => c + c).join('')}`;
  const rgb = raw.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgb) {
    const part = (index: number) => Math.max(0, Math.min(255, Number(rgb[index]) || 0)).toString(16).padStart(2, '0');
    return `#${part(1)}${part(2)}${part(3)}`;
  }
  return fallback;
}

function DebouncedColorInput({
  value,
  fallback,
  disabled,
  onChange
}: {
  value?: string | null;
  fallback?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const normalized = toHexColor(value, fallback);
  const [draft, setDraft] = useState(normalized);
  const timerRef = useRef<number | null>(null);
  const lastCommittedRef = useRef(normalized);

  useEffect(() => {
    const next = toHexColor(value, fallback);
    if (next !== lastCommittedRef.current) {
      setDraft(next);
      lastCommittedRef.current = next;
    }
  }, [fallback, value]);

  const commit = (next: string) => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    if (next === lastCommittedRef.current) return;
    lastCommittedRef.current = next;
    onChange(next);
  };

  return (
    <input
      type="color"
      disabled={disabled}
      value={draft}
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        if (timerRef.current != null) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => commit(next), 140);
      }}
      onBlur={() => commit(draft)}
    />
  );
}

export function WorkspaceSettingsPanel({ onClose, toolbarHeight, statusBarHeight }: Props) {
  const { project, setBackground, updateGridSettings, updateViewSettings, setSettingsHoverTarget } = useProjectStore();
  const [tab, setTab] = useState<SettingsTab>('numbers');
  const [userIcons, setUserIcons] = useState<UserIconInfo[]>([]);
  const [commandIcons, setCommandIcons] = useState<Record<string, string>>({});
  const [iconStatus, setIconStatus] = useState('');
  const [autosaveSettings, setAutosaveSettings] = useState<Required<AutosaveSettingsPayload>>(() => normalizeAutosaveSettings(null));
  const [autosaveStatus, setAutosaveStatus] = useState('');
  const commandsBySection = useMemo(() => {
    const groups = new Map<string, typeof RIBBON_COMMANDS>();
    for (const command of RIBBON_COMMANDS) {
      const list = groups.get(command.section) ?? [];
      list.push(command);
      groups.set(command.section, list);
    }
    return Array.from(groups.entries());
  }, []);
  const hover = (target: string) => ({
    onMouseEnter: () => setSettingsHoverTarget(target),
    onMouseLeave: () => setSettingsHoverTarget(null)
  });

  const refreshUserIcons = async () => {
    try {
      const icons = await listUserIcons();
      setUserIcons(icons);
    } catch {
      setUserIcons([]);
    }
  };

  const saveCommandIconMap = async (next: Record<string, string>, status: string) => {
    setCommandIcons(next);
    window.dispatchEvent(new CustomEvent('pile-numbering:command-icons-updated', { detail: next }));
    try {
      const config = await getUserConfig();
      await saveUserConfig({ ...config, commandIcons: next });
      setIconStatus(status);
    } catch (error) {
      setIconStatus(error instanceof Error ? error.message : 'Не удалось сохранить настройки иконок');
    }
  };

  const setCommandIcon = async (commandId: RibbonCommandId, url: string) => {
    await saveCommandIconMap({ ...commandIcons, [commandId]: url }, 'Иконка команды обновлена.');
  };

  const resetCommandIcon = async (commandId: RibbonCommandId) => {
    const next = { ...commandIcons };
    delete next[commandId];
    await saveCommandIconMap(next, 'Иконка команды сброшена на стандартную.');
  };

  const uploadCommandIcon = async (commandId: RibbonCommandId, event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    try {
      setIconStatus('Загружаю иконку...');
      const icon = await uploadUserIcon(file);
      await refreshUserIcons();
      await setCommandIcon(commandId, icon.url);
    } catch (error) {
      setIconStatus(error instanceof Error ? error.message : 'Не удалось загрузить иконку');
    }
  };

  const uploadAppIcon = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    try {
      setIconStatus('Сохраняю иконку приложения...');
      await uploadApplicationIcon(file);
      setIconStatus('Иконка приложения сохранена в config/app_icon.ico. Применится после пересборки EXE через tools\\06_build_exe.bat.');
    } catch (error) {
      setIconStatus(error instanceof Error ? error.message : 'Не удалось сохранить иконку приложения');
    }
  };

  const makeDesktopShortcut = async () => {
    try {
      setIconStatus('Создаю ярлык на рабочем столе...');
      const result = await createDesktopShortcut();
      setIconStatus(result.path ? `Ярлык создан: ${result.path}` : 'Ярлык создан на рабочем столе.');
    } catch (error) {
      setIconStatus(error instanceof Error ? error.message : 'Не удалось создать ярлык на рабочем столе');
    }
  };

  const removeUploadedIcon = async (icon: UserIconInfo) => {
    try {
      await deleteUserIcon(icon.fileName);
      const next = Object.fromEntries(Object.entries(commandIcons).filter(([, url]) => url !== icon.url));
      await saveCommandIconMap(next, 'Файл иконки удалён.');
      await refreshUserIcons();
    } catch (error) {
      setIconStatus(error instanceof Error ? error.message : 'Не удалось удалить иконку');
    }
  };

  useEffect(() => {
    let cancelled = false;
    getUserConfig()
      .then((config) => {
        if (cancelled) return;
        setCommandIcons(config.commandIcons ?? {});
        setAutosaveSettings(normalizeAutosaveSettings(config.autosaveSettings));
      })
      .catch(() => setCommandIcons({}));
    void refreshUserIcons();
    return () => {
      cancelled = true;
    };
  }, []);

  const exportUiSettings = () => {
    const payload = makeUiSettingsFile(project);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'pile_numbering_ui_settings.pilenum-ui.json';
    link.click();
    URL.revokeObjectURL(url);
  };

  const importUiSettings = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const next = parseUiSettingsFile(parsed);
      updateGridSettings(next.gridSettings);
      updateViewSettings(next.viewSettings);
      const config = await getUserConfig();
      await saveUserConfig({
        ...config,
        gridSettings: { ...(config.gridSettings ?? {}), ...next.gridSettings },
        viewSettings: { ...(config.viewSettings ?? {}), ...next.viewSettings }
      });
      setIconStatus(`UI-настройки загружены: ${file.name}`);
    } catch (error) {
      setIconStatus(error instanceof Error ? error.message : 'Не удалось загрузить UI-настройки');
    }
  };


  const saveAutosaveSettingsToConfig = async (next: Required<AutosaveSettingsPayload>) => {
    setAutosaveSettings(next);
    try {
      const config = await getUserConfig();
      await saveUserConfig({ ...config, autosaveSettings: next });
      window.dispatchEvent(new CustomEvent('pile-numbering:autosave-settings-updated', { detail: next }));
      setAutosaveStatus('Настройки автосохранения сохранены.');
    } catch (error) {
      setAutosaveStatus(error instanceof Error ? error.message : 'Не удалось сохранить автосохранение');
    }
  };

  const chooseAutosaveFolder = async () => {
    try {
      setAutosaveStatus('Открываю выбор папки...');
      const folderPath = await selectAutosaveFolder();
      if (!folderPath) {
        setAutosaveStatus('Выбор папки отменён.');
        return;
      }
      await saveAutosaveSettingsToConfig({ ...autosaveSettings, folderPath });
    } catch (error) {
      setAutosaveStatus(error instanceof Error ? error.message : 'Не удалось выбрать папку');
    }
  };

  return (
    <DraggablePanel
      id="workspace-settings"
      title="Настройки рабочего поля"
      initialX={26}
      initialY={toolbarHeight + 14}
      width={430}
      height={600}
      minWidth={360}
      minHeight={380}
      dockable
      dockOffsetTop={toolbarHeight}
      dockOffsetBottom={statusBarHeight}
      onClose={onClose}
    >
      <div className="workspace-settings-panel">
        <div className="settings-file-actions">
          <button className="btn small" onClick={exportUiSettings}>Выгрузить UI</button>
          <label className="btn small">
            Загрузить UI
            <input type="file" accept=".json,.pilenum-ui.json" hidden onChange={(event) => void importUiSettings(event)} />
          </label>
        </div>
        <div className="settings-tabs-row">
          {SETTINGS_TABS.map((item) => (
            <button key={item.id} className={`settings-tab-button ${tab === item.id ? 'active' : ''}`} onClick={() => setTab(item.id)}>
              {item.label}
            </button>
          ))}
        </div>

        {tab === 'view' && (
          <div className="settings-tab-page">
            <div className="popover-subtitle">Фон рабочего поля</div>
            <div className="background-color-grid">
              {WORKSPACE_BACKGROUND_COLORS.map((color) => (
                <button
                  key={color.value}
                  className={`background-color-cell ${project.viewSettings.backgroundColor.toLowerCase() === color.value.toLowerCase() ? 'selected' : ''}`}
                  style={{ backgroundColor: color.value }}
                  title={color.name}
                  onClick={() => setBackground(color.value)}
                />
              ))}
            </div>
            <label className="settings-grid-row">
              <span>Другой фон</span>
              <DebouncedColorInput value={project.viewSettings.backgroundColor} fallback="#111827" onChange={(value) => setBackground(value)} />
            </label>
          </div>
        )}

        {tab === 'grid' && (
          <div className="settings-tab-page">
            <div className="popover-subtitle">Сетка</div>
            <label className="settings-grid-row" {...hover('grid')} data-tooltip={'Шаг основной сетки\nРасстояние между крупными линиями сетки в координатах проекта.'}>
              <span>Шаг сетки</span>
              <input type="number" min="1" value={project.gridSettings.majorStep} onChange={(e) => updateGridSettings({ majorStep: Math.max(1, Number(e.target.value) || 1) })} />
            </label>
            <label className="settings-grid-row" {...hover('grid')} data-tooltip={'Шаг малой сетки\nРасстояние между тонкими вспомогательными линиями.'}>
              <span>Малая сетка</span>
              <input type="number" min="1" value={project.gridSettings.minorStep} onChange={(e) => updateGridSettings({ minorStep: Math.max(1, Number(e.target.value) || 1) })} />
            </label>
            <label className="settings-grid-row">
              <span>Цвет крупной</span>
              <DebouncedColorInput value={project.gridSettings.color} fallback="#334155" onChange={(value) => updateGridSettings({ color: value })} />
            </label>
            <label className="settings-grid-row">
              <span>Цвет малой</span>
              <DebouncedColorInput value={project.gridSettings.minorColor} fallback="#1f2937" onChange={(value) => updateGridSettings({ minorColor: value })} />
            </label>
            <label className="settings-grid-row">
              <span>Цвет осей</span>
              <DebouncedColorInput value={project.gridSettings.axisColor} fallback="#94a3b8" onChange={(value) => updateGridSettings({ axisColor: value })} />
            </label>
            <label className="checkbox-line">
              <input type="checkbox" checked={project.gridSettings.axesEnabled} onChange={(e) => updateGridSettings({ axesEnabled: e.target.checked })} />
              <span>Показывать оси X/Y</span>
            </label>
          </div>
        )}

        {tab === 'numbers' && (
          <div className="settings-tab-page">
            <div className="popover-subtitle">Текст нумерации</div>
            <label className="checkbox-line" data-tooltip="Авто-контраст номера\nЦвет номера подбирается под фон рабочего поля." {...hover('number_text')}>
              <input
                type="checkbox"
                checked={project.viewSettings.numberTextMode === 'auto'}
                onChange={(e) => updateViewSettings({ numberTextMode: e.target.checked ? 'auto' : 'manual' })}
              />
              <span>Авто-контраст текста под фон</span>
            </label>
            <label className="settings-grid-row" data-tooltip="Размер основного номера сваи\nВлияет на большой номер рядом с точкой." {...hover('number_text')}>
              <span>Размер</span>
              <input
                type="number"
                min="7"
                max="48"
                value={project.viewSettings.numberTextFontSize ?? 13}
                onChange={(e) => updateViewSettings({ numberTextFontSize: clamp(Number(e.target.value), 7, 48, 13) })}
              />
            </label>
            <label className="settings-grid-row wide-setting" data-tooltip="Шрифт основного номера сваи" {...hover('number_text')}>
              <span>Шрифт</span>
              <FontSelect value={project.viewSettings.numberTextFontFamily ?? 'Inter, Segoe UI, Arial, sans-serif'} onChange={(value) => updateViewSettings({ numberTextFontFamily: value })} />
            </label>
            <label className="settings-grid-row">
              <span>Яркость</span>
              <input
                type="number"
                min="0.35"
                max="2.5"
                step="0.05"
                value={project.viewSettings.numberTextBrightness ?? 1}
                onChange={(e) => updateViewSettings({ numberTextBrightness: clamp(Number(e.target.value), 0.35, 2.5, 1) })}
              />
            </label>
            <label className="settings-grid-row">
              <span>Цвет текста</span>
              <DebouncedColorInput
                disabled={project.viewSettings.numberTextMode === 'auto'}
                value={project.viewSettings.numberTextColor}
                fallback="#ffffff"
                onChange={(value) => updateViewSettings({ numberTextColor: value, numberTextMode: 'manual' })}
              />
            </label>
            <label className="checkbox-line">
              <input
                type="checkbox"
                checked={project.viewSettings.numberTextStrokeEnabled !== false}
                onChange={(e) => updateViewSettings({ numberTextStrokeEnabled: e.target.checked })}
              />
              <span>Обводка текста</span>
            </label>
            <label className="settings-grid-row">
              <span>Цвет обводки</span>
              <DebouncedColorInput
                disabled={project.viewSettings.numberTextStrokeEnabled === false}
                value={project.viewSettings.numberTextStrokeColor}
                fallback="#020617"
                onChange={(value) => updateViewSettings({ numberTextStrokeColor: value })}
              />
            </label>
            <label className="settings-grid-row">
              <span>Толщина</span>
              <input
                type="number"
                min="0"
                max="5"
                step="0.1"
                disabled={project.viewSettings.numberTextStrokeEnabled === false}
                value={project.viewSettings.numberTextStrokeWidth ?? 0.8}
                onChange={(e) => updateViewSettings({ numberTextStrokeWidth: clamp(Number(e.target.value), 0, 5, 0.8) })}
              />
            </label>
            <label className="checkbox-line" data-tooltip="Подложка основного номера
Затемняет или подсвечивает область за номером сваи." {...hover('number_text')}>
              <input
                type="checkbox"
                checked={project.viewSettings.numberTextBubbleEnabled !== false}
                onChange={(e) => updateViewSettings({ numberTextBubbleEnabled: e.target.checked })}
              />
              <span>Подложка под номером</span>
            </label>
            <label className="settings-grid-row" data-tooltip="Цвет подложки основного номера" {...hover('number_text')}>
              <span>Цвет подложки</span>
              <DebouncedColorInput
                value={project.viewSettings.numberTextBubbleColor}
                fallback="#020617"
                onChange={(value) => updateViewSettings({ numberTextBubbleColor: value })}
              />
            </label>
            <label className="settings-grid-row" data-tooltip="Цвет рамки подложки основного номера" {...hover('number_text')}>
              <span>Рамка подложки</span>
              <DebouncedColorInput
                value={project.viewSettings.numberTextBubbleStrokeColor}
                fallback="#020617"
                onChange={(value) => updateViewSettings({ numberTextBubbleStrokeColor: value })}
              />
            </label>
            <div className="settings-help">Для повышения читаемости увеличьте размер, яркость или включите обводку текста. Параметры применяются сразу и сохраняются в настройках интерфейса.</div>
          </div>
        )}

        {tab === 'markers' && (
          <div className="settings-tab-page">
            <div className="popover-subtitle">Подписи Старт / Финиш / База / Источник</div>
            <label className="checkbox-line" data-tooltip="Служебные подписи Старт/Финиш/База/Источник" {...hover('markers')}>
              <input
                type="checkbox"
                checked={project.viewSettings.showMarkerLabels !== false}
                onChange={(e) => updateViewSettings({ showMarkerLabels: e.target.checked })}
              />
              <span>Показывать подписи маркеров</span>
            </label>
            <label className="settings-grid-row">
              <span>Размер</span>
              <input
                type="number"
                min="8"
                max="42"
                value={project.viewSettings.markerTextFontSize ?? 12}
                onChange={(e) => updateViewSettings({ markerTextFontSize: clamp(Number(e.target.value), 8, 42, 12) })}
              />
            </label>
            <label className="settings-grid-row wide-setting">
              <span>Шрифт</span>
              <FontSelect value={project.viewSettings.markerTextFontFamily ?? 'Tahoma, Segoe UI, Arial, sans-serif'} onChange={(value) => updateViewSettings({ markerTextFontFamily: value })} />
            </label>
            <label className="settings-grid-row" data-tooltip="Цвет текста служебных подписей" {...hover('markers')}>
              <span>Цвет</span>
              <DebouncedColorInput value={project.viewSettings.markerTextColor} fallback="#bfdbfe" onChange={(value) => updateViewSettings({ markerTextColor: value })} />
            </label>
            <label className="settings-grid-row">
              <span>Яркость</span>
              <input
                type="number"
                min="0.35"
                max="2.5"
                step="0.05"
                value={project.viewSettings.markerTextBrightness ?? 1}
                onChange={(e) => updateViewSettings({ markerTextBrightness: clamp(Number(e.target.value), 0.35, 2.5, 1) })}
              />
            </label>
            <label className="checkbox-line">
              <input
                type="checkbox"
                checked={project.viewSettings.markerTextStrokeEnabled !== false}
                onChange={(e) => updateViewSettings({ markerTextStrokeEnabled: e.target.checked })}
              />
              <span>Обводка подписи</span>
            </label>
            <label className="settings-grid-row">
              <span>Цвет обводки</span>
              <DebouncedColorInput
                disabled={project.viewSettings.markerTextStrokeEnabled === false}
                value={project.viewSettings.markerTextStrokeColor}
                fallback="#020617"
                onChange={(value) => updateViewSettings({ markerTextStrokeColor: value })}
              />
            </label>
            <label className="settings-grid-row" data-tooltip="Толщина обводки служебных подписей" {...hover('markers')}>
              <span>Толщина</span>
              <input
                type="number"
                min="0"
                max="5"
                step="0.1"
                disabled={project.viewSettings.markerTextStrokeEnabled === false}
                value={project.viewSettings.markerTextStrokeWidth ?? 0.9}
                onChange={(e) => updateViewSettings({ markerTextStrokeWidth: clamp(Number(e.target.value), 0, 5, 0.9) })}
              />
            </label>
            <label className="settings-grid-row" data-tooltip="Фон выносок группы и маркеров" {...hover('markers')}>
              <span>Фон выноски</span>
              <DebouncedColorInput
                value={project.viewSettings.markerCalloutBackgroundColor}
                fallback="#020617"
                onChange={(value) => updateViewSettings({ markerCalloutBackgroundColor: value })}
              />
            </label>
            <label className="settings-grid-row" data-tooltip="Рамка выноски группы и маркеров" {...hover('markers')}>
              <span>Рамка выноски</span>
              <DebouncedColorInput value={project.viewSettings.markerCalloutBorderColor} fallback="#64748b" onChange={(value) => updateViewSettings({ markerCalloutBorderColor: value })} />
            </label>
            <label className="settings-grid-row" data-tooltip="Пунктирная линия от выноски к объекту" {...hover('markers')}>
              <span>Линия выноски</span>
              <DebouncedColorInput value={project.viewSettings.markerLeaderLineColor} fallback="#64748b" onChange={(value) => updateViewSettings({ markerLeaderLineColor: value })} />
            </label>
            <label className="checkbox-line">
              <input
                type="checkbox"
                checked={project.viewSettings.showNumberingPreview !== false}
                onChange={(e) => updateViewSettings({ showNumberingPreview: e.target.checked })}
              />
              <span>Показывать стрелки предпросмотра нумерации</span>
            </label>
            <label className="checkbox-line" data-tooltip="Показывать сохранённый векторный маршрут\nМожно скрыть линию вектора, не удаляя маршрут из группы. В режиме редактирования маршрут отображается для корректировки.">
              <input
                type="checkbox"
                checked={project.viewSettings.showVectorPath !== false}
                onChange={(e) => updateViewSettings({ showVectorPath: e.target.checked })}
              />
              <span>Показывать векторный маршрут</span>
            </label>
            <div className="popover-subtitle">Контур активной группы</div>
            <label className="checkbox-line" data-tooltip="Показывать контур активной группы\nМожно выключить для сложных участков свайного поля или при работе с ручным контуром." {...hover('group_outline')}>
              <input
                type="checkbox"
                checked={project.viewSettings.groupOutlineVisible !== false}
                onChange={(e) => updateViewSettings({ groupOutlineVisible: e.target.checked })}
              />
              <span>Показывать контур активной группы</span>
            </label>
            <label className="settings-grid-row" data-tooltip="Контур активной группы\nПо умолчанию контур берёт цвет группы. Этот цвет используется только как резервный, если у группы цвет не задан." {...hover('group_outline')}>
              <span>Резервный цвет</span>
              <DebouncedColorInput value={project.viewSettings.groupOutlineStrokeColor} fallback="#64748b" onChange={(value) => updateViewSettings({ groupOutlineStrokeColor: value })} />
            </label>
            <label className="settings-grid-row" data-tooltip="Толщина линии контура активной группы" {...hover('group_outline')}>
              <span>Толщина</span>
              <input type="number" min="0.5" max="8" step="0.1" value={project.viewSettings.groupOutlineStrokeWidth ?? 1.7} onChange={(e) => updateViewSettings({ groupOutlineStrokeWidth: clamp(Number(e.target.value), 0.5, 8, 1.7) })} />
            </label>
            <label className="settings-grid-row" data-tooltip="Длина штриха пунктирного контура группы" {...hover('group_outline')}>
              <span>Пунктир</span>
              <input type="number" min="1" max="40" step="1" value={project.viewSettings.groupOutlineDashSize ?? 10} onChange={(e) => updateViewSettings({ groupOutlineDashSize: clamp(Number(e.target.value), 1, 40, 10) })} />
            </label>
            <label className="settings-grid-row" data-tooltip="Отступ контура от крайних точек группы в пикселях экрана" {...hover('group_outline')}>
              <span>Отступ</span>
              <input type="number" min="8" max="120" step="1" value={project.viewSettings.groupOutlinePadding ?? 28} onChange={(e) => updateViewSettings({ groupOutlinePadding: clamp(Number(e.target.value), 8, 120, 28) })} />
            </label>
            <label className="settings-grid-row" data-tooltip="Прямоугольность контура
Чем больше значение, тем активнее мелкие зубцы и близкие уступы объединяются в общий прямоугольный контур." {...hover('group_outline')}>
              <span>Прямоугольность</span>
              <input type="number" min="0" max="260" step="1" value={project.viewSettings.groupOutlineSnapPx ?? 54} onChange={(e) => updateViewSettings({ groupOutlineSnapPx: clamp(Number(e.target.value), 0, 260, 54) })} />
            </label>
            <label className="settings-grid-row" data-tooltip="Упрощение мелких сегментов контура
Скрывает короткие визуальные зигзаги, не меняя сами точки группы." {...hover('group_outline')}>
              <span>Упрощение</span>
              <input type="number" min="0" max="120" step="1" value={project.viewSettings.groupOutlineSimplifyPx ?? 16} onChange={(e) => updateViewSettings({ groupOutlineSimplifyPx: clamp(Number(e.target.value), 0, 120, 16) })} />
            </label>

            <div className="popover-subtitle">Стрелки предпросмотра</div>
            <label className="settings-grid-row" data-tooltip="Настройка отображения стрелок предпросмотра маршрута" {...hover('preview_lines')}>
              <span>Авто-линия</span>
              <DebouncedColorInput value={project.viewSettings.previewAutoLineColor} fallback="#38bdf8" onChange={(value) => updateViewSettings({ previewAutoLineColor: value })} />
            </label>
            <label className="settings-grid-row" data-tooltip="Настройка отображения стрелок предпросмотра маршрута" {...hover('preview_lines')}>
              <span>Авто-стрелка</span>
              <DebouncedColorInput value={project.viewSettings.previewAutoArrowColor} fallback="#67e8f9" onChange={(value) => updateViewSettings({ previewAutoArrowColor: value })} />
            </label>
            <label className="settings-grid-row" data-tooltip="Настройка отображения стрелок предпросмотра маршрута" {...hover('preview_lines')}>
              <span>Ручная линия</span>
              <DebouncedColorInput value={project.viewSettings.previewManualLineColor} fallback="#f59e0b" onChange={(value) => updateViewSettings({ previewManualLineColor: value })} />
            </label>
            <label className="settings-grid-row" data-tooltip="Настройка отображения стрелок предпросмотра маршрута" {...hover('preview_lines')}>
              <span>Ручная стрелка</span>
              <DebouncedColorInput value={project.viewSettings.previewManualArrowColor} fallback="#facc15" onChange={(value) => updateViewSettings({ previewManualArrowColor: value })} />
            </label>
            <label className="settings-grid-row" data-tooltip="Настройка отображения стрелок предпросмотра маршрута" {...hover('preview_lines')}>
              <span>Выбранная связь</span>
              <DebouncedColorInput value={project.viewSettings.previewSelectedLineColor} fallback="#22d3ee" onChange={(value) => updateViewSettings({ previewSelectedLineColor: value })} />
            </label>
            <label className="settings-grid-row" data-tooltip="Настройка отображения стрелок предпросмотра маршрута" {...hover('preview_lines')}>
              <span>Стрелка выбранной</span>
              <DebouncedColorInput value={project.viewSettings.previewSelectedArrowColor} fallback="#67e8f9" onChange={(value) => updateViewSettings({ previewSelectedArrowColor: value })} />
            </label>
            <label className="settings-grid-row" data-tooltip="Настройка отображения стрелок предпросмотра маршрута" {...hover('preview_lines')}>
              <span>Запрет связи</span>
              <DebouncedColorInput value={project.viewSettings.previewInvalidLinkColor} fallback="#ef4444" onChange={(value) => updateViewSettings({ previewInvalidLinkColor: value })} />
            </label>
            <label className="settings-grid-row" data-tooltip="Настройка отображения стрелок предпросмотра маршрута" {...hover('preview_lines')}>
              <span>Толщина авто</span>
              <input type="number" min="0.5" max="10" step="0.1" value={project.viewSettings.previewLineWidth ?? 2} onChange={(e) => updateViewSettings({ previewLineWidth: clamp(Number(e.target.value), 0.5, 10, 2) })} />
            </label>
            <label className="settings-grid-row" data-tooltip="Настройка отображения стрелок предпросмотра маршрута" {...hover('preview_lines')}>
              <span>Толщина ручн.</span>
              <input type="number" min="0.5" max="12" step="0.1" value={project.viewSettings.previewManualLineWidth ?? 4} onChange={(e) => updateViewSettings({ previewManualLineWidth: clamp(Number(e.target.value), 0.5, 12, 4) })} />
            </label>
            <label className="settings-grid-row" data-tooltip="Настройка отображения стрелок предпросмотра маршрута" {...hover('preview_lines')}>
              <span>Толщина выбранной</span>
              <input type="number" min="0.5" max="12" step="0.1" value={project.viewSettings.previewSelectedLineWidth ?? 4.5} onChange={(e) => updateViewSettings({ previewSelectedLineWidth: clamp(Number(e.target.value), 0.5, 12, 4.5) })} />
            </label>
            <div className="popover-subtitle">Цифры порядка пути</div>
            <label className="settings-grid-row" data-tooltip="Маленький номер порядка в предпросмотре пути
Это не основной номер сваи, а номер шага маршрута." {...hover('path_numbers')}>
              <span>Цвет цифр пути</span>
              <DebouncedColorInput value={project.viewSettings.previewPointLabelColor} fallback="#ffffff" onChange={(value) => updateViewSettings({ previewPointLabelColor: value })} />
            </label>
            <label className="settings-grid-row" data-tooltip="Обводка маленьких цифр порядка пути" {...hover('path_numbers')}>
              <span>Обводка цифр</span>
              <DebouncedColorInput value={project.viewSettings.previewPointLabelStrokeColor} fallback="#020617" onChange={(value) => updateViewSettings({ previewPointLabelStrokeColor: value })} />
            </label>
            <label className="settings-grid-row" data-tooltip="Размер маленьких цифр порядка пути" {...hover('path_numbers')}>
              <span>Размер цифр</span>
              <input type="number" min="7" max="42" step="1" value={project.viewSettings.previewPointLabelFontSize ?? 12} onChange={(e) => updateViewSettings({ previewPointLabelFontSize: clamp(Number(e.target.value), 7, 42, 12) })} />
            </label>
            <label className="settings-grid-row" data-tooltip="Толщина обводки маленьких цифр пути" {...hover('path_numbers')}>
              <span>Толщина обводки</span>
              <input type="number" min="0" max="5" step="0.1" value={project.viewSettings.previewPointLabelStrokeWidth ?? 1} onChange={(e) => updateViewSettings({ previewPointLabelStrokeWidth: clamp(Number(e.target.value), 0, 5, 1) })} />
            </label>
            <label className="settings-grid-row" data-tooltip="Яркость маленьких цифр порядка пути" {...hover('path_numbers')}>
              <span>Яркость цифр</span>
              <input type="number" min="0.35" max="2.5" step="0.05" value={project.viewSettings.previewPointLabelBrightness ?? 1} onChange={(e) => updateViewSettings({ previewPointLabelBrightness: clamp(Number(e.target.value), 0.35, 2.5, 1) })} />
            </label>
            <label className="checkbox-line" data-tooltip="Подложка под маленькими цифрами порядка пути" {...hover('path_numbers')}>
              <input type="checkbox" checked={project.viewSettings.previewPointLabelBubbleEnabled !== false} onChange={(e) => updateViewSettings({ previewPointLabelBubbleEnabled: e.target.checked })} />
              <span>Подложка цифр пути</span>
            </label>
            <label className="settings-grid-row" data-tooltip="Цвет подложки под маленькими цифрами пути" {...hover('path_numbers')}>
              <span>Цвет подложки</span>
              <DebouncedColorInput value={project.viewSettings.previewPointLabelBubbleColor} fallback="#020617" onChange={(value) => updateViewSettings({ previewPointLabelBubbleColor: value })} />
            </label>
            <div className="settings-help">Наведи курсор на настройку — соответствующий элемент подсветится на поле. Все эти параметры лежат в viewSettings проекта и в config/user_config.json.</div>
          </div>
        )}

        {tab === 'autosave' && (
          <div className="settings-tab-page">
            <div className="popover-subtitle">Автосохранения проекта</div>
            <label className="checkbox-line">
              <input
                type="checkbox"
                checked={autosaveSettings.enabled}
                onChange={(event) => void saveAutosaveSettingsToConfig({ ...autosaveSettings, enabled: event.target.checked })}
              />
              <span>Включить автосохранение</span>
            </label>
            <label className="settings-grid-row wide-setting">
              <span>Папка</span>
              <input
                type="text"
                value={autosaveSettings.folderPath ?? ''}
                placeholder="Пусто = папка autosaves рядом с приложением"
                onChange={(event) => setAutosaveSettings({ ...autosaveSettings, folderPath: event.target.value || null })}
                onBlur={() => void saveAutosaveSettingsToConfig(autosaveSettings)}
              />
            </label>
            <div className="outline-tools-actions autosave-actions-row">
              <button className="btn small" onClick={() => void chooseAutosaveFolder()}>Выбрать папку</button>
              <button className="btn small primary" onClick={() => void saveAutosaveSettingsToConfig(autosaveSettings)}>Сохранить настройки</button>
            </div>
            <label className="settings-grid-row">
              <span>Интервал, мин</span>
              <input
                type="number"
                min="0.25"
                max="120"
                step="0.25"
                value={autosaveSettings.intervalMinutes}
                onChange={(event) => setAutosaveSettings({ ...autosaveSettings, intervalMinutes: clamp(Number(event.target.value), 0.25, 120, 5) })}
                onBlur={() => void saveAutosaveSettingsToConfig(autosaveSettings)}
              />
            </label>
            <div className="settings-help">
              Автосохранение пишет отдельные файлы <b>*.autosave_дата.pilenum.json</b> и не перетирает основной проект. Для EXE и локального запуска папку выбирает backend, поэтому можно указать обычный путь Windows.
            </div>
            {autosaveStatus && <div className="settings-help">{autosaveStatus}</div>}
          </div>
        )}

        {tab === 'icons' && (
          <div className="settings-tab-page">
            <div className="popover-subtitle">Иконка приложения</div>
            <div className="settings-help">
              Для иконки самого <b>dist\PileNumbering.exe</b> нужен файл <b>.ico</b>. Программа сохранит его как <b>config/app_icon.ico</b>, а следующий запуск сборки <b>tools\\06_build_exe.bat</b> подхватит его в EXE.
            </div>
            <div className="settings-inline-actions">
              <label className="btn small command-icon-upload">
                Выбрать .ico для EXE
                <input type="file" accept=".ico,image/x-icon" hidden onChange={(event) => void uploadAppIcon(event)} />
              </label>
              <button className="btn small" onClick={() => void makeDesktopShortcut()}>Создать ярлык на рабочем столе</button>
            </div>
            <div className="settings-help">
              Ярлык создаётся программой через локальный backend и указывает на текущий <b>dist\PileNumbering.exe</b>. Батник для ярлыков больше не нужен.
            </div>
            <div className="popover-subtitle">Иконки команд</div>
            <div className="settings-help">
              Пользовательские иконки сохраняются в папку <b>data/images</b>, а привязки команд — в <b>config/user_config.json</b>. Проектный .pilenum.json от этого не меняется.
            </div>
            <div className="command-icons-list">
              {commandsBySection.map(([section, commands]) => (
                <div className="command-icon-section" key={section}>
                  <div className="command-icon-section-title">{section}</div>
                  {commands.map((command) => {
                    const url = commandIcons[command.id];
                    return (
                      <div className="command-icon-row" key={command.id}>
                        <div className="command-icon-preview">
                          {url ? <img src={resolveApiAssetUrl(url)} alt="" /> : <span>{getRibbonCommandDefaultIcon(command.id)}</span>}
                        </div>
                        <div className="command-icon-info">
                          <strong>{command.label}</strong>
                          <small>{command.id}</small>
                        </div>
                        <select
                          value={url ?? ''}
                          onChange={(event) => {
                            const next = event.target.value;
                            if (next) void setCommandIcon(command.id, next);
                            else void resetCommandIcon(command.id);
                          }}
                        >
                          <option value="">Стандартная</option>
                          {userIcons.map((icon) => (
                            <option key={`${command.id}-${icon.fileName}`} value={icon.url}>{icon.fileName}</option>
                          ))}
                        </select>
                        <label className="btn small command-icon-upload">
                          Загрузить
                          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" hidden onChange={(event) => void uploadCommandIcon(command.id, event)} />
                        </label>
                        {url && <button className="btn small" onClick={() => void resetCommandIcon(command.id)}>Сброс</button>}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            {userIcons.length > 0 && (
              <div className="uploaded-icons-block">
                <div className="popover-subtitle">Файлы в data/images</div>
                <div className="uploaded-icons-grid">
                  {userIcons.map((icon) => (
                    <div className="uploaded-icon-card" key={icon.fileName}>
                      <img src={resolveApiAssetUrl(icon.url)} alt="" />
                      <span title={icon.fileName}>{icon.fileName}</span>
                      <button className="btn small danger" onClick={() => void removeUploadedIcon(icon)}>Удалить</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {iconStatus && <div className="settings-help">{iconStatus}</div>}
          </div>
        )}

        {tab === 'selection' && (
          <div className="settings-tab-page">
            <div className="popover-subtitle">Выделение рамкой</div>
            <label className="settings-grid-row wide-setting" data-tooltip={`Режим выделения\n${SELECTION_DRAG_MODE_DESCRIPTIONS[project.viewSettings.selectionDragMode]}`}>
              <span>Режим</span>
              <select
                value={project.viewSettings.selectionDragMode}
                onChange={(e) => updateViewSettings({ selectionDragMode: e.target.value as SelectionDragMode })}
              >
                {Object.entries(SELECTION_DRAG_MODE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <div className="settings-help">{SELECTION_DRAG_MODE_DESCRIPTIONS[project.viewSettings.selectionDragMode]}</div>
          </div>
        )}
      </div>
    </DraggablePanel>
  );
}
