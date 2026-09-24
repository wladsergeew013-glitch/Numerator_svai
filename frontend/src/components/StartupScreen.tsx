import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { listLocalProjects, listRecentProjects, openLocalProject, openLocalProjectLocation, openRecentProject } from '../api/client';
import { useProjectStore } from '../store/useProjectStore';
import type { LocalProjectInfo, PileProject, RecentProjectInfo } from '../types/project';

interface DesktopProjectBridge {
  openProjectJson?: () => Promise<{ opened?: boolean; canceled?: boolean; fileName?: string; content?: string; error?: string }>;
}

function desktopBridge(): DesktopProjectBridge | undefined {
  return (window as unknown as { pywebview?: { api?: DesktopProjectBridge } }).pywebview?.api;
}

function displayDate(value?: string | null): string {
  if (!value) return 'Дата неизвестна';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Дата неизвестна' : new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  }).format(date);
}

function countLabel(count: number, one: string, few: string, many: string): string {
  const lastTwo = count % 100;
  const last = count % 10;
  return `${count} ${lastTwo >= 11 && lastTwo <= 14 ? many : last === 1 ? one : last >= 2 && last <= 4 ? few : many}`;
}

export function StartupScreen({ onReady }: { onReady: () => void }) {
  const [projects, setProjects] = useState<LocalProjectInfo[]>([]);
  const [recent, setRecent] = useState<RecentProjectInfo[]>([]);
  const [loadingLocal, setLoadingLocal] = useState(true);
  const [loadingRecent, setLoadingRecent] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [newName, setNewName] = useState('Новый проект');
  const [creating, setCreating] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const openProjectFromFile = useProjectStore(state => state.openProjectFromFile);
  const createNewProject = useProjectStore(state => state.createNewProject);

  const refresh = async () => {
    setLoadingLocal(true);
    setLoadingRecent(true);
    const [localResult, recentResult] = await Promise.allSettled([
      listLocalProjects().then(items => { setProjects(items); setLoadingLocal(false); return items; }),
      listRecentProjects().then(items => { setRecent(items); setLoadingRecent(false); return items; })
    ]);
    setLoadingLocal(false);
    setLoadingRecent(false);
    if (localResult.status === 'rejected' || recentResult.status === 'rejected') {
      setError('Не удалось загрузить список проектов. Проверьте связь с локальным сервером и нажмите «Обновить».');
    } else setError('');
  };

  useEffect(() => { void refresh(); }, []);

  const runOpen = async (key: string, load: () => Promise<PileProject>, fileName: string) => {
    setBusy(key);
    setError('');
    try {
      const project = await load();
      openProjectFromFile(project, fileName);
      onReady();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось открыть проект.');
    } finally { setBusy(''); }
  };

  const openFile = async () => {
    const bridge = desktopBridge();
    if (!bridge?.openProjectJson) { fileInput.current?.click(); return; }
    setError('');
    setBusy('file');
    try {
      const result = await bridge.openProjectJson();
      if (result.canceled) return;
      if (!result.opened || !result.fileName || !result.content) throw new Error(result.error || 'Не удалось открыть файл проекта.');
      openProjectFromFile(JSON.parse(result.content) as PileProject, result.fileName);
      onReady();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось открыть файл проекта.');
    } finally { setBusy(''); }
  };

  const openBrowserFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    try {
      openProjectFromFile(JSON.parse(await file.text()) as PileProject, file.name);
      onReady();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось открыть файл проекта.');
    } finally { event.currentTarget.value = ''; }
  };

  const create = (event: FormEvent) => {
    event.preventDefault();
    const name = newName.trim();
    if (!name) { setError('Укажите имя нового проекта.'); return; }
    createNewProject(name);
    onReady();
  };

  const filteredProjects = projects.filter(item =>
    `${item.name} ${item.fileName}`.toLocaleLowerCase('ru').includes(search.trim().toLocaleLowerCase('ru')));

  return <main className="startup-screen">
    <div className="startup-shell">
      <header className="startup-header">
        <div className="startup-brand-mark" aria-hidden="true"><span>＋</span><span>＋</span><span>＋</span><span>＋</span></div>
        <div>
          <p className="startup-eyebrow">PILE NUMBERING · 0.3.0</p>
          <h1>Нумератор свайного поля</h1>
          <p className="startup-subtitle">Выберите проект для работы или создайте новый.</p>
        </div>
      </header>

      <div className="startup-layout">
        <section className="startup-card startup-actions" aria-labelledby="startup-start-title">
          <h2 id="startup-start-title">Начать работу</h2>
          <button className="startup-primary" onClick={() => setCreating(value => !value)}>＋ <span>Новый проект</span></button>
          {creating && <form className="startup-new-project" onSubmit={create}>
            <label htmlFor="startup-project-name">Название проекта</label>
            <input id="startup-project-name" autoFocus value={newName} onChange={event => setNewName(event.target.value)} maxLength={120} />
            <div className="startup-inline-actions"><button type="submit" className="startup-primary">Создать</button><button type="button" onClick={() => setCreating(false)}>Отмена</button></div>
          </form>}
          <button className="startup-action" onClick={() => void openFile()} disabled={Boolean(busy)}>▤ <span>Открыть файл проекта</span></button>
          <button className="startup-action" onClick={() => void openLocalProjectLocation().catch(e => setError(String(e)))}>▣ <span>Открыть папку проектов</span></button>
          <input ref={fileInput} type="file" accept=".json,.pilenum.json" hidden onChange={event => void openBrowserFile(event)} />
          <p className="startup-folder-note">Сохранённые проекты находятся в папке <strong>projects</strong> рядом с программой.</p>
        </section>

        <div className="startup-project-columns">
          <section className="startup-card startup-list-card" aria-labelledby="startup-recent-title">
            <div className="startup-section-heading"><div><h2 id="startup-recent-title">Недавние</h2><p>Проекты, которые вы открывали последними</p></div></div>
            <div className="startup-project-list">
              {loadingRecent ? <p className="startup-empty">Загрузка проектов…</p> : recent.length === 0 ? <p className="startup-empty">Недавно открытых проектов пока нет.</p> : recent.map(item => <button key={item.id} className="startup-project-row" disabled={Boolean(busy)} onClick={() => void runOpen(item.id, () => openRecentProject(item.id), item.fileName)} title={item.path}>
                <span className="startup-project-glyph" aria-hidden="true">▦</span><span className="startup-project-copy"><strong>{item.name}</strong><small>{item.path}</small></span><span className="startup-project-meta">{displayDate(item.openedAt)}</span>
              </button>)}
            </div>
          </section>

          <section className="startup-card startup-list-card" aria-labelledby="startup-all-title">
            <div className="startup-section-heading"><div><h2 id="startup-all-title">Все проекты</h2><p>Папка projects · {countLabel(projects.length, 'проект', 'проекта', 'проектов')}</p></div><button className="startup-refresh" onClick={() => void refresh()} disabled={loadingLocal || loadingRecent} title="Обновить список проектов">↻ Обновить</button></div>
            <input className="startup-search" type="search" placeholder="Найти по названию или файлу" aria-label="Поиск проекта" value={search} onChange={event => setSearch(event.target.value)} />
            <div className="startup-project-list">
              {loadingLocal ? <p className="startup-empty">Загрузка проектов…</p> : filteredProjects.length === 0 ? <p className="startup-empty">{search ? 'По вашему запросу проектов нет.' : 'В папке projects пока нет проектов.'}</p> : filteredProjects.map(item => <button key={item.fileName} className="startup-project-row" disabled={Boolean(busy)} onClick={() => void runOpen(item.fileName, () => openLocalProject(item.fileName), item.fileName)}>
                <span className="startup-project-glyph" aria-hidden="true">▦</span><span className="startup-project-copy"><strong>{item.name}</strong><small>{item.fileName}</small></span><span className="startup-project-meta">{countLabel(item.pointsCount, 'точка', 'точки', 'точек')} · {countLabel(item.groupsCount, 'группа', 'группы', 'групп')}<br />{displayDate(item.updatedAt)}</span>
              </button>)}
            </div>
          </section>
        </div>
      </div>
      {error && <div className="startup-error" role="alert">{error}</div>}
    </div>
  </main>;
}
