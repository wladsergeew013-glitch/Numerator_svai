export function workerTask<T>(worker: Worker, payload: unknown, signal?: AbortSignal, deadline = 30000): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, result?: T) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', cancel); worker.terminate();
      if (error) reject(error); else resolve(result as T);
    };
    const cancel = () => finish(new DOMException('Расчёт отменён.', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('Превышено время обработки файла или расчёта.')), deadline);
    worker.onmessage = e => e.data.error ? finish(new Error(e.data.error)) : finish(undefined, e.data.result);
    worker.onerror = e => { e.preventDefault(); finish(new Error(e.message || 'Ошибка рабочего потока.')); };
    if (signal?.aborted) { cancel(); return; }
    signal?.addEventListener('abort', cancel, { once: true });
    try { worker.postMessage(payload); } catch (error) { finish(error as Error); }
  });
}
