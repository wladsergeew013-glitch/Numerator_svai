import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { previewAutoClusters } from '../api/client';
import { connectedAutoClusters, useProjectStore } from '../store/useProjectStore';
import { CLUSTER_METHODS, DEFAULT_CLUSTER_OPTIONS, type ClusterMethod, type ClusterOptions, type ClusterPreview } from '../types/clustering';
import type { PilePoint } from '../types/project';

const COLORS = ['#38bdf8', '#fbbf24', '#4ade80', '#f472b6', '#a78bfa', '#fb923c', '#2dd4bf', '#e879f9', '#93c5fd'];

function PreviewMap({ points, result }: { points: PilePoint[]; result: ClusterPreview | null }) {
  const bounds = useMemo(() => {
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
  }, [points]);
  const byId = new Map<string, number>();
  result?.clusters.forEach((cluster, i) => cluster.forEach(id => byId.set(id, i)));
  const scale = Math.min(732 / Math.max(bounds.maxX - bounds.x, 1e-9), 246 / Math.max(bounds.maxY - bounds.y, 1e-9));
  const offsetX = (800 - (bounds.maxX - bounds.x) * scale) / 2;
  const offsetY = (300 - (bounds.maxY - bounds.y) * scale) / 2;
  return <svg viewBox="0 0 800 300" className="auto-cluster-map" role="img" aria-label="Предпросмотр распределения свай по группам">
    {points.map(p => {
      const cluster = byId.get(p.id);
      const x = offsetX + (p.x - bounds.x) * scale;
      const y = 300 - offsetY - (p.y - bounds.y) * scale;
      const title = `X ${p.x.toFixed(3)}, Y ${p.y.toFixed(3)} · ${cluster == null ? (result ? 'без группы' : 'не рассчитано') : `группа ${cluster + 1}`}`;
      return cluster == null && result
        ? <path key={p.id} d={`M${x - 2} ${y - 2}l4 4m-4 0l4 -4`} stroke="#94a3b8"><title>{title}</title></path>
        : <circle key={p.id} cx={x} cy={y} r={2.3} fill={cluster == null ? '#94a3b8' : COLORS[cluster % COLORS.length]}><title>{title}</title></circle>;
    })}
    <path d="M20 280h25m-5 -4l5 4 -5 4M20 280v-25m-4 5l4 -5 4 5" fill="none" stroke="#cbd5e1" />
    <text x="50" y="284" fill="#cbd5e1">X</text><text x="16" y="248" fill="#cbd5e1">Y</text>
  </svg>;
}

export function AutoClusterDialog({ onClose }: { onClose: () => void }) {
  // Freeze the input. Applying a stale preview is rejected by the store.
  const [snapshot] = useState(() => {
    const state = useProjectStore.getState();
    const locked = new Set(state.project.groups.filter(g => g.locked).map(g => g.id));
    const editable = state.project.points.filter(p => !p.locked && (!p.groupId || !locked.has(p.groupId)));
    const selected = editable.filter(p => state.selectedPointIds.includes(p.id));
    return { points: structuredClone(selected.length >= 2 ? selected : editable),
      selection: selected.length >= 2,
      pipelineId: state.project.pipelines.some(p => p.id === state.selectedPipelineId) ? state.selectedPipelineId : state.project.pipelines[0]?.id ?? null };
  });
  const [options, setOptions] = useState<ClusterOptions>({ ...DEFAULT_CLUSTER_OPTIONS });
  const [result, setResult] = useState<ClusterPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const dialog = useRef<HTMLDivElement>(null);
  const method = CLUSTER_METHODS.find(m => m.value === options.method)!;
  const points = snapshot.points;

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { generation.current++; controller.current?.abort(); before?.focus(); };
  }, []);

  const change = (patch: Partial<ClusterOptions>) => {
    generation.current++;
    controller.current?.abort();
    setBusy(false);
    setResult(null);
    setError('');
    setOptions(current => ({ ...current, ...patch }));
  };
  const chooseMethod = (value: ClusterMethod) => change({ method: value, radiusFactor: value === 'connected' ? 1 : 2.5 });
  const calculate = async () => {
    const ticket = ++generation.current;
    controller.current?.abort();
    controller.current = new AbortController();
    setBusy(true); setError(''); setResult(null);
    try {
      if (options.method === 'connected' && points.length > 5000) {
        throw new Error('Для этого метода выделите не более 5000 точек. Для большого поля используйте серверные методы: ветви, полосы или HDBSCAN.');
      }
      // Let the progress state paint before running the existing local method.
      await new Promise(resolve => window.setTimeout(resolve, 30));
      if (ticket !== generation.current) return;
      const preview: ClusterPreview = options.method === 'connected'
        ? { method: 'connected', clusters: connectedAutoClusters(points, options.radiusFactor).map(c => c.map(p => p.id)),
          unassignedIds: [], warnings: [], pointCount: points.length, options }
        : await previewAutoClusters(points, options, controller.current.signal);
      if (ticket === generation.current) setResult(preview);
    } catch (e) {
      if (ticket === generation.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (ticket === generation.current) setBusy(false);
    }
  };
  const apply = () => {
    if (!result || busy) return;
    try {
      useProjectStore.getState().applyAutoClusterPreview({ result, sourcePoints: points, pipelineId: snapshot.pipelineId });
      onClose();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const numberField = (key: keyof ClusterOptions, label: string, min: number, max: number, step = 1) => <label>
    <span>{label}</span><input type="number" min={min} max={max} step={step} value={typeof options[key] === 'number' && !Number.isFinite(options[key]) ? '' : String(options[key])}
      onChange={e => change({ [key]: e.target.value === '' ? Number.NaN : Number(e.target.value) })} />
  </label>;
  const validNumbers = Object.values(options).every(v => typeof v !== 'number' || Number.isFinite(v));
  const valid = validNumbers && options.radiusFactor >= .1 && options.radiusFactor <= 20
    && options.minClusterSize >= 2 && options.minClusterSize <= 10000 && Number.isInteger(options.minClusterSize)
    && options.minSamples >= 2 && options.minSamples <= 1000 && Number.isInteger(options.minSamples)
    && options.clusterCount >= 1 && options.clusterCount <= 500 && Number.isInteger(options.clusterCount)
    && options.bandTolerance >= .01 && options.bandTolerance <= 5 && options.turnAngle >= 5 && options.turnAngle <= 85
    && options.angle >= -180 && options.angle <= 180
    && options.xi > 0 && options.xi < 1;

  return createPortal(<div className="auto-cluster-backdrop" onMouseDown={e => e.stopPropagation()}>
    <div ref={dialog} className="auto-cluster-dialog" role="dialog" aria-modal="true" aria-labelledby="auto-cluster-title"
      onKeyDown={e => {
        e.stopPropagation();
        if (e.key === 'Escape') onClose();
        if (e.key === 'Tab') {
          const nodes = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary') ?? []);
          const first = nodes[0], last = nodes[nodes.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
      }}>
      <header><div><h2 id="auto-cluster-title">Авторазбивка</h2><span>{snapshot.selection ? 'Выделенные' : 'Все редактируемые'} точки: {points.length}. Заблокированные точки исключены.</span></div><button className="btn small" onClick={onClose} aria-label="Закрыть авторазбивку">×</button></header>
      <div className="auto-cluster-layout">
        <nav aria-label="Метод авторазбивки">{CLUSTER_METHODS.map(item => <button key={item.value} type="button"
          className={`cluster-method-button ${item.value === options.method ? 'active' : ''}`} aria-pressed={item.value === options.method}
          onClick={() => chooseMethod(item.value)}>{item.label}</button>)}
          <div className="cluster-future">Обучаемая модель · заготовка<br /><small>В будущем: обучение на размеченных полях разных размеров и форм. Сейчас модель не обучена.</small></div>
        </nav>
        <main>
          <p className="cluster-method-description">{method.description}</p>
          <div className="cluster-options">
            {['branches', 'bands'].includes(options.method) && <label className="cluster-check"><input type="checkbox" checked={options.compactSites} onChange={e => change({compactSites:e.target.checked})} />Учитывать близкие пары и компактные опоры целиком</label>}
            {['connected', 'branches', 'bands', 'dbscan'].includes(options.method) && numberField('radiusFactor', options.method === 'connected' ? 'Радиус объединения, × базовый' : 'Максимальный разрыв / радиус, × шаг', .1, 20, .1)}
            {options.method === 'branches' && numberField('turnAngle', 'Допустимый поворот ветви, °', 5, 85, 5)}
            {options.method === 'bands' && <>
              {numberField('bandTolerance', 'Ширина полосы, × шаг', .01, 5, .05)}
              <label className="cluster-check"><input type="checkbox" checked={options.autoAngle} onChange={e => change({autoAngle:e.target.checked})} />Подобрать направление</label>
              {!options.autoAngle && numberField('angle', 'Угол от X против часовой стрелки, °', -180, 180, 5)}
            </>}
            {['hdbscan', 'optics'].includes(options.method) && numberField('minClusterSize', 'Минимум точек в группе', 2, 10000)}
            {['hdbscan', 'dbscan', 'optics'].includes(options.method) && numberField('minSamples', 'Соседей для плотной области (включая точку)', 2, 1000)}
            {options.method === 'optics' && numberField('xi', 'Порог изменения плотности', .01, .99, .01)}
            {options.method === 'count' && numberField('clusterCount', 'Число групп', 1, Math.min(500, points.length))}
          </div>
          <div className="cluster-calculate-row"><button className="btn primary" disabled={busy || points.length < 2 || !valid}
            onClick={() => void calculate()}>{busy ? 'Расчёт…' : 'Рассчитать предпросмотр'}</button>
            <span>Расстояния относительно шага свай; единицы файла сохраняются.</span></div>
          {busy && <div role="status" className="cluster-progress"><progress /><span>Анализ геометрии…</span></div>}
          {error && <div className="cluster-error" role="alert">{error}</div>}
          <PreviewMap points={points} result={result} />
          {result ? <div className="cluster-result" aria-live="polite">
            <strong>Предлагается групп: {result.clusters.length} · Без группы: {result.unassignedIds.length}</strong>
            <span>Размеры: {result.clusters.slice(0, 30).map(c => c.length).join(', ')}{result.clusters.length > 30 ? '…' : ''}</span>
            {result.angle != null && <span>Направление полос: {result.angle.toFixed(1)}°</span>}
            {result.step != null && <span>Оценка шага: {Number(result.step.toPrecision(5))} единиц файла</span>}
            {result.warnings.map(w => <span className="cluster-warning" key={w}>{w}</span>)}
            <small>Цвета обозначают группы; серые крестики — точки без группы.</small>
          </div> : !busy && <div className="cluster-result">Выберите метод и рассчитайте предпросмотр.</div>}
        </main>
      </div>
      <footer><p>После применения выбранные редактируемые точки получат новые группы, их номера будут сброшены. Точки вне кластеров останутся без группы. Отмена изменения: Ctrl+Z.</p>
        <div><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" onClick={apply} disabled={!result?.clusters.length || busy}>Применить разбиение</button></div>
      </footer>
    </div>
  </div>, document.body);
}
