import type { CadOperationLog, CadProgress } from '../api/client';

export function formatDuration(seconds: number): string {
  const value = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  if (value < 60) return `${value.toFixed(1).replace('.', ',')} с`;
  const total = Math.floor(value);
  const minutes = Math.floor(total / 60);
  return minutes < 60 ? `${minutes} мин ${total % 60} с` : `${Math.floor(minutes / 60)} ч ${minutes % 60} мин ${total % 60} с`;
}

export function formatOperationLog(progress: CadProgress, summary: string, log?: CadOperationLog, unavailable?: string): string {
  const lines = [
    `Операция: ${progress.kind || log?.kind || 'nanoCAD'}`,
    `ID: ${progress.id || (progress.kind?.startsWith('file/') ? 'файловая операция' : 'не получен — операция не подтверждена сервером')}`,
    `Статус: ${progress.status} · ${progress.phase}`,
    `Время: ${formatDuration(progress.clientElapsedSeconds ?? progress.elapsedSeconds ?? 0)}`,
    ...(progress.elapsedSeconds != null ? [`Выполнение на сервере: ${formatDuration(progress.elapsedSeconds)}`] : []),
    `Обработано: ${progress.completed} / ${progress.total ?? 'неизвестно'}`,
    summary, '', ...(progress.clientLog ?? []), '',
  ];
  if (log?.droppedEntries) lines.push(`Пропущено ранних записей: ${log.droppedEntries}. Полный журнал: logs/backend.log.`);
  if (unavailable) lines.push(`Подробный журнал недоступен: ${unavailable}`);
  for (const entry of log?.entries ?? []) {
    lines.push(`${new Date(entry.timestamp * 1000).toISOString()} [+${formatDuration(entry.elapsedSeconds)}] ${entry.level} ${entry.event} ${entry.details}`);
  }
  return lines.join('\n');
}

export async function runFileOperation<T>(kind: string, task: () => Promise<T>, publish: (progress: CadProgress) => void): Promise<T> {
  const start = performance.now();
  const initial: CadProgress = { kind: `file/${kind}`, status: 'running', phase: kind === 'import' ? 'Импорт файла' : 'Сохранение JSON', completed: 0, total: null, startedAt: Date.now() / 1000, clientElapsedSeconds: 0 };
  const clientLog = [`${new Date().toISOString()} ${initial.phase}`];
  publish({ ...initial, clientLog: [...clientLog] });
  try {
    const result = await task();
    clientLog.push(`${new Date().toISOString()} ${typeof result === 'string' ? result : 'Операция завершена'}`);
    publish({ ...initial, status: 'completed', phase: typeof result === 'string' ? result : 'Готово', clientElapsedSeconds: (performance.now() - start) / 1000, clientLog });
    return result;
  } catch (error) {
    clientLog.push(`${new Date().toISOString()} ${String(error)}`);
    publish({ ...initial, status: 'failed', phase: String(error), clientElapsedSeconds: (performance.now() - start) / 1000, clientLog });
    throw error;
  }
}

export async function copyOperationText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; }
  } catch { /* WebView may deny Clipboard API; try its native copy command. */ }
  const focused = document.activeElement as HTMLElement | null;
  const input = document.createElement('textarea');
  input.value = text;
  input.style.cssText = 'position:fixed;left:-9999px;top:0';
  document.body.appendChild(input);
  try {
    input.focus(); input.select();
    if (!document.execCommand('copy')) throw new Error('Выделите журнал ниже и нажмите Ctrl+C.');
  } finally { input.remove(); focused?.focus(); }
}
