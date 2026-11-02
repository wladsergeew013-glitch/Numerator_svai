import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DraggablePanel } from '../../frontend/src/components/DraggablePanel';
import { CloseProjectGuard } from '../../frontend/src/components/CloseProjectGuard';
import { GroupManager } from '../../frontend/src/components/GroupManager';
import { PanelOverlay } from '../../frontend/src/components/PanelOverlay';
import { useProjectStore } from '../../frontend/src/store/useProjectStore';
import '../../frontend/src/styles.css';

const api = () => (window as any).pywebview.api;
const errors: string[] = [];
window.addEventListener('error', e => errors.push(String(e.error || e.message)));
window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)));
function Editor() {
  const [text, setText] = useState('черновик');
  const token = useRef(crypto.randomUUID());
  const [overlay, setOverlay] = useState(false);
  const state = useProjectStore();
  return <>
    <input id="draft" value={text} onChange={e => setText(e.target.value)} />
    <output id="draft-state">{text}</output><output id="mount-token">{token.current}</output>
    <button id="rename" onClick={() => state.updateGroupName(state.project.groups[0].id, 'Из отдельного окна')}>Переименовать</button>
    <button id="undo" onClick={state.undo}>Отменить</button>
    <button id="overlay" onClick={() => setOverlay(true)}>Диалог</button>
    {overlay && <PanelOverlay><div id="owned-overlay">Диалог своего окна<button onClick={() => setOverlay(false)}>OK</button></div></PanelOverlay>}
  </>;
}
function Fixture() {
  const state = useProjectStore();
  const [visible, setVisible] = useState(true);
  const [dock, setDock] = useState<'left' | 'right' | 'floating'>('left');
  return <>
    <div id="main-name">{state.project.groups[0]?.name}</div>
    {visible && <DraggablePanel id="runtime-probe" title="Проверка панели" initialX={20} initialY={90} width={420} height={420} dockable dock={dock} onDockChange={setDock} onClose={() => setVisible(false)}><Editor /></DraggablePanel>}
    <GroupManager toolbarHeight={60} statusBarHeight={28} />
    <CloseProjectGuard />
  </>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Fixture /></React.StrictMode>);

const wait = async (condition: () => unknown, label: string) => {
  const deadline = performance.now() + 12000;
  while (performance.now() < deadline) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw Error(`Timeout: ${label}`);
};
const click = (element: HTMLElement) => {
  const view = element.ownerDocument.defaultView!;
  element.dispatchEvent(new view.MouseEvent('mousedown', { bubbles: true }));
  element.click();
};
const type = (input: HTMLInputElement, value: string) => {
  const view = input.ownerDocument.defaultView!;
  Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new view.Event('input', { bubbles: true }));
};
const assert = (condition: unknown, message: string) => { if (!condition) throw Error(message); };

async function run() {
  await wait(() => (window as any).pileNativePanelsReady, 'native host');
  useProjectStore.getState().createGroup();
  await wait(() => document.getElementById('draft'), 'fixture');
  const section = document.querySelector<HTMLElement>('[data-panel-id="runtime-probe"]')!;
  const input = document.getElementById('draft') as HTMLInputElement;
  const token = document.getElementById('mount-token')!.textContent;
  type(input, 'Несохранённый ввод');
  await wait(() => document.getElementById('draft-state')?.textContent === 'Несохранённый ввод', 'controlled input before detach');
  click(section.querySelector<HTMLElement>('[aria-label="В отдельное окно"]')!);
  await wait(() => section.ownerDocument !== document, 'native adoption');
  let child = section.ownerDocument;
  assert(child.getElementById('draft') === input, 'Input element was recreated');
  assert(child.getElementById('mount-token')!.textContent === token, 'React component remounted');
  assert(input.value === 'Несохранённый ввод', 'Draft was lost');
  assert(!document.querySelector('[data-panel-id="runtime-probe"]'), 'Detached panel still occupies the main document');
  type(input, 'Ввод снаружи');
  await wait(() => child.getElementById('draft-state')?.textContent === 'Ввод снаружи', 'cross-window React input');
  click(child.getElementById('rename')!);
  await wait(() => document.getElementById('main-name')?.textContent === 'Из отдельного окна', 'shared project');
  click(child.getElementById('undo')!);
  await wait(() => document.getElementById('main-name')?.textContent === 'Группа 1', 'single undo history');
  click(child.getElementById('overlay')!);
  await wait(() => child.getElementById('owned-overlay'), 'dialog in the detached owner');
  await api().drop('runtime-probe', 350, 250);
  await wait(() => section.ownerDocument === document, 'drag back into workspace');
  assert(document.getElementById('draft') === input && input.value === 'Ввод снаружи', 'Returning lost the live input');
  assert(document.getElementById('owned-overlay'), 'Returning lost the open dialog');
  assert(document.getElementById('mount-token')!.textContent === token, 'Returning remounted the component');
  await wait(() => section.querySelector('[aria-label="В отдельное окно"]'), 'return commit');
  click(section.querySelector<HTMLElement>('[aria-label="В отдельное окно"]')!);
  await wait(() => section.ownerDocument !== document, 'second detach');
  await api().closeNativePanel('runtime-probe');
  await wait(() => !section.isConnected, 'one native X closes the panel');
  await wait(() => api(), 'bridge');
  assert(!(await api().openPanels()).includes('runtime-probe'), 'Native window remained after one close');
  const manager = document.querySelector<HTMLElement>('[data-panel-id="group-manager"]')!;
  click(manager.querySelector<HTMLElement>('[aria-label="В отдельное окно"]')!);
  await wait(() => manager.ownerDocument !== document, 'real group manager detach');
  const managerDoc = manager.ownerDocument;
  await api().requestMainClose();
  await wait(() => document.querySelector('.close-project-dialog'), 'unsaved guard');
  assert((await api().openPanels()).includes('group-manager'), 'Canceled main close destroyed a panel');
  click([...document.querySelectorAll<HTMLElement>('.close-project-dialog button')].find(e => e.textContent === 'Отмена')!);
  await wait(() => !document.querySelector('.close-project-dialog'), 'cancel close');
  await api().closeNativePanel('group-manager');
  await wait(() => !manager.isConnected, 'real manager closes once');
  assert(managerDoc !== document, 'Manager never entered a native document');
  useProjectStore.getState().toggleGroupManager();
  await wait(() => document.querySelector('[data-panel-id="group-manager"]'), 'reopen manager');
  const finalManager = document.querySelector<HTMLElement>('[data-panel-id="group-manager"]')!;
  click(finalManager.querySelector<HTMLElement>('[aria-label="В отдельное окно"]')!);
  await wait(() => finalManager.ownerDocument !== document, 'remaining window at shutdown');
  assert(errors.length === 0, `Runtime errors: ${errors.join('; ')}`);
  await api().report({ passed: true, liveWebView2: true, inputAndComponentIdentityPreserved: true,
    crossWindowInput: true, sharedProjectAndUndo: true, ownedDialogsMoveWithPanel: true,
    dragBack: true, oneNativeClose: true, mainCloseCancelKeepsPanels: true });
}
setTimeout(() => run().catch(async error => { await api().report({ passed: false, error: String(error), errors }); }), 300);
