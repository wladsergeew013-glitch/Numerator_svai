import { useEffect, useState } from 'react';
import { getCadOperationLog, type CadProgress } from '../api/client';
import { copyOperationText, formatDuration, formatOperationLog } from '../utils/operationLog';

export function CadOperationProgress({ progress, summary = '' }: { progress: CadProgress; summary?: string }) {
  const [copyStatus, setCopyStatus] = useState('');
  const [manualLog, setManualLog] = useState('');
  const [copying, setCopying] = useState(false);
  const copyLog = async () => {
    setCopying(true); setCopyStatus(''); setManualLog('');
    let log;
    let unavailable = '';
    try {
      if (progress.id) log = await getCadOperationLog(progress.id);
    } catch (error) { unavailable = String(error); }
    const text = formatOperationLog(progress, summary, log, unavailable);
    try {
      await copyOperationText(text);
      setCopyStatus(unavailable ? 'Статус скопирован; подробный журнал недоступен.' : 'Лог скопирован');
    } catch {
      setManualLog(text);
      setCopyStatus('Не удалось скопировать автоматически. Выделите журнал и нажмите Ctrl+C.');
    } finally { setCopying(false); }
  };
  return <div className={`cad-transfer-progress ${progress.status}`}>
    <div role="status" aria-live="polite">
      <strong>{progress.status === 'running' ? 'Выполняется' : progress.status === 'completed' ? 'Завершено' : 'Ошибка'} · {progress.phase}</strong>
    </div>
    <progress aria-label="Прогресс операции" max={progress.total || 1}
      value={progress.status === 'completed' ? (progress.total || 1) : progress.total ? progress.completed : progress.status === 'failed' ? 0 : undefined} />
    <span>{progress.total != null ? `Обработано ${progress.completed} из ${progress.total} (${Math.round(progress.completed / Math.max(1, progress.total) * 100)}%)` : progress.status === 'running' ? 'Ожидание ответа nanoCAD…' : progress.status === 'failed' ? 'Операция остановлена' : 'Готово'}
      {progress.updated != null ? ` · записано ${progress.updated}` : ''}
      {progress.id ? ` · операция ${progress.id.slice(0, 8)}` : ''}</span>
    <div className="cad-operation-log-actions">
      <OperationElapsed progress={progress} />
      <button type="button" className="btn small" disabled={copying} onClick={() => void copyLog()} title="Копирует время, результат, этапы и ошибки этой операции">{copying ? 'Чтение журнала…' : 'Скопировать лог'}</button>
    </div>
    {copyStatus && <small role="status">{copyStatus}</small>}
    {manualLog && <textarea className="cad-operation-log-text" aria-label="Журнал операции для копирования" value={manualLog} readOnly onFocus={event => event.currentTarget.select()} />}
    {progress.status === 'running' && !progress.kind?.startsWith('file/') && <small>Оставьте исходный чертёж открытым до завершения операции.</small>}
  </div>;
}

// Keep the ticking clock local: it must not re-render the toolbar or drawing.
function OperationElapsed({ progress }: { progress: CadProgress }) {
  const base = progress.clientElapsedSeconds ?? progress.elapsedSeconds ?? 0;
  const [display, setDisplay] = useState(base);
  useEffect(() => {
    setDisplay(base);
    if (progress.status !== 'running') return;
    const start = performance.now();
    const timer = window.setInterval(() => setDisplay(base + (performance.now() - start) / 1000), 250);
    return () => window.clearInterval(timer);
  }, [base, progress.status]);
  return <span className="cad-operation-duration">{progress.status === 'running' ? 'Прошло' : 'Затрачено'}: <b>{formatDuration(progress.status === 'running' ? display : base)}</b></span>;
}
