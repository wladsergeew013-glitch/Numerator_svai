import { useEffect, useRef, useState } from 'react';
import { useProjectStore } from '../store/useProjectStore';
import { projectSaveSignature } from '../utils/projectSaveState';
import { assertProjectJsonSize } from '../utils/projectLimits';
import { captureProjectContext, isProjectSession, type ProjectTransitionRequest } from '../utils/projectSession';
import { hasPendingProjectSaves, queueProjectSave, waitForProjectSaves } from '../utils/projectSaves';
import { flushUserConfig, saveLocalProject } from '../api/client';

interface DesktopBridge {
  frontendReady: () => Promise<void>;
  prepareClose: () => Promise<void>;
  cancelClose: () => Promise<void>;
  closeConfirmed: () => Promise<void>;
  saveProjectJson: (name: string, content: string) => Promise<{ saved?: boolean; canceled?: boolean; error?: string }>;
}
// pywebview creates api = {} before it installs the exposed Python methods.
const bridge = () => (window as unknown as { pywebview?: { api?: Partial<DesktopBridge> } }).pywebview?.api;
const isDirty = () => {
  const state = useProjectStore.getState();
  return projectSaveSignature(state.project) !== state.savedProjectSignature;
};

export function CloseProjectGuard() {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [transitioning, setTransitioning] = useState(false);
  const pendingTransition = useRef<ProjectTransitionRequest | null>(null);
  const closing = useRef(false);
  const busy = useRef(false);
  const cancel = () => {
    pendingTransition.current?.respond(false);
    pendingTransition.current = null;
    setOpen(false);
  };
  const proceed = async (discard: boolean) => {
    if (pendingTransition.current) {
      pendingTransition.current.respond(true);
      pendingTransition.current = null;
      setOpen(false);
    } else await finish(discard);
  };
  const finish = async (discard = false) => {
    const api = bridge();
    if (typeof api?.closeConfirmed !== 'function') {
      setError('Связь с окном программы ещё не готова. Повторите закрытие.');
      setOpen(true);
      return;
    }
    const context = captureProjectContext();
    const projectId = useProjectStore.getState().project.project.id;
    const canClose = () => isProjectSession(context) && (discard
      ? captureProjectContext().signature === context.signature : !isDirty());
    const showChangedProject = () => setError('Проект изменился во время закрытия. Сохраните актуальное состояние или подтвердите выход без сохранения.');
    busy.current = true;
    setSaving(true); setError('Сохраняю настройки и завершаю активный обмен с CAD…'); setOpen(true);
    let preparing = false;
    try {
      await flushUserConfig();
      while (hasPendingProjectSaves(projectId)) await waitForProjectSaves(projectId);
      if (!canClose()) { showChangedProject(); return; }
      if (api.prepareClose) {
        preparing = true;
        await api.prepareClose();
        await flushUserConfig();
        while (hasPendingProjectSaves(projectId)) await waitForProjectSaves(projectId);
        if (!canClose()) { showChangedProject(); return; }
      }
      closing.current = true;
      window.dispatchEvent(new Event('pile-numbering:shutdown-prepared'));
      await api.closeConfirmed();
      preparing = false;
    }
    catch (e) {
      window.dispatchEvent(new Event('pile-numbering:shutdown-canceled'));
      closing.current = false; setError(`Не удалось завершить работу: ${String(e)}`); setOpen(true);
    }
    finally {
      if (preparing) {
        try { await api.cancelClose?.(); } catch (e) { console.error('Could not cancel desktop shutdown', e); }
      }
      busy.current = false;
      setSaving(false);
    }
  };
  useEffect(() => {
    let readySent = false;
    let disposed = false;
    let paintFrame = 0;
    const ready = () => {
      const api = bridge();
      if (readySent || typeof api?.frontendReady !== 'function') return;
      readySent = true;
      // Two frames allow the committed interface to paint before hiding splash.
      paintFrame = window.requestAnimationFrame(() => {
        paintFrame = window.requestAnimationFrame(() => {
          if (disposed) return;
          // A bridge failure must not tear down the mounted React application.
          void Promise.resolve().then(() => api.frontendReady!()).catch((e) => {
            readySent = false;
            console.error('Desktop startup handshake failed', e);
          });
        });
      });
    };
    const requestClose = () => {
      if (busy.current || closing.current) return;
      pendingTransition.current?.respond(false);
      pendingTransition.current = null;
      setTransitioning(false);
      if (!isDirty()) { void finish(); }
      else { setError(''); setOpen(true); }
    };
    const requestTransition = (event: Event) => {
      const request = (event as CustomEvent<ProjectTransitionRequest>).detail;
      request.handled = true;
      if (busy.current || closing.current) { request.respond(false); return; }
      pendingTransition.current?.respond(false);
      pendingTransition.current = request;
      setTransitioning(true);
      setError('');
      setOpen(true);
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!closing.current && (isDirty() || hasPendingProjectSaves(useProjectStore.getState().project.project.id))) {
        event.preventDefault(); event.returnValue = '';
      }
    };
    window.addEventListener('pywebviewready', ready);
    window.addEventListener('pile-numbering:close-requested', requestClose);
    window.addEventListener('pile-numbering:project-transition-requested', requestTransition);
    window.addEventListener('beforeunload', beforeUnload);
    ready();
    return () => {
      disposed = true;
      window.cancelAnimationFrame(paintFrame);
      window.removeEventListener('pywebviewready', ready);
      window.removeEventListener('pile-numbering:close-requested', requestClose);
      window.removeEventListener('pile-numbering:project-transition-requested', requestTransition);
      pendingTransition.current?.respond(false);
      pendingTransition.current = null;
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, []);
  const saveAndClose = async () => {
    if (busy.current) return;
    const api = bridge();
    busy.current = true;
    setSaving(true); setError('');
    const project = useProjectStore.getState().project;
    const context = captureProjectContext();
    try {
      const name = (project.project.name || 'Проект').replace(/[<>:"/\\|?*]/g, '_');
      let markedSaved = false;
      const acknowledge = () => { markedSaved = useProjectStore.getState().markProjectSaved(project, context.sessionId); };
      let result: { saved?: boolean; canceled?: boolean; error?: string };
      if (typeof api?.saveProjectJson === 'function') {
        const snapshot = JSON.stringify(project);
        assertProjectJsonSize(snapshot);
        result = await queueProjectSave(project.project.id, async () => {
          const saved = await api.saveProjectJson!(`${name}.pilenum.json`, snapshot);
          if (saved.saved) acknowledge();
          return saved;
        });
      } else {
        result = await saveLocalProject(project, acknowledge);
      }
      if (result.canceled) return;
      if (!result.saved) throw new Error(result.error || 'Не удалось сохранить проект.');
      if (!markedSaved || !isProjectSession(context)) {
        setError('Текущий проект сменился. Результат сохранения относится к прежнему проекту.'); return;
      }
      if (isDirty()) { setError('Проект изменился во время сохранения. Сохраните актуальное состояние ещё раз.'); return; }
      await proceed(false);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { busy.current = false; setSaving(false); }
  };
  if (!open) return null;
  return <div className="close-project-backdrop">
    <section className="close-project-dialog" role="dialog" aria-modal="true" aria-labelledby="close-project-title">
      <h2 id="close-project-title">{transitioning ? 'Сохранить изменения перед сменой проекта?' : 'Сохранить изменения проекта?'}</h2>
      <p>{transitioning ? 'Сохраните текущий проект или подтвердите переход без сохранения.' : 'В проекте есть несохранённые изменения. Выберите, как завершить работу.'}</p>
      {error && <p role="alert">{error}</p>}
      <div className="dialog-actions-row">
        <button className="btn" disabled={saving} onClick={cancel}>Отмена</button>
        <button className="btn" disabled={saving} onClick={() => { if (!busy.current) void proceed(true); }}>Не сохранять</button>
        <button className="btn primary" disabled={saving} autoFocus onClick={() => void saveAndClose()}>{saving ? 'Сохранение…' : 'Сохранить'}</button>
      </div>
    </section>
  </div>;
}
