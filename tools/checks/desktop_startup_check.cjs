/* Exercise the real close guard's mount effect with pywebview's staged API. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const ts = require(path.join(root, 'frontend/node_modules/typescript'));
const source = fs.readFileSync(path.join(root, 'frontend/src/components/CloseProjectGuard.tsx'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;

function mount(api) {
  const window = new EventTarget();
  let nextFrame = 0;
  const frames = new Map();
  window.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
  window.cancelAnimationFrame = id => frames.delete(id);
  const paint = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); };
  if (api !== undefined) window.pywebview = { api };
  const effects = [];
  const errors = [];
  const states = [];
  const context = {
    exports: {}, window, console: { error: (...args) => errors.push(args) },
    require(name) {
      if (name === 'react') return {
        useEffect: fn => effects.push(fn), useRef: value => ({ current: value }),
        useState: value => [value, next => states.push(next)],
      };
      if (name === 'react/jsx-runtime') return {};
      if (name.endsWith('/useProjectStore')) return { useProjectStore: { getState: () => ({ project: 'saved', savedProjectSignature: 'saved' }) } };
      if (name.endsWith('/projectSaveState')) return { projectSaveSignature: value => value };
      throw new Error(`Unexpected import ${name}`);
    },
  };
  vm.runInNewContext(compiled, context);
  assert.equal(context.exports.CloseProjectGuard(), null);
  const cleanup = effects[0]();
  return { window, errors, states, cleanup, paint };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  const browser = mount(undefined);
  browser.cleanup();
  let readyCalls = 0;
  let closeCalls = 0;
  const api = {};
  const delayed = mount(api); // Previously threw TypeError and unmounted the UI.
  await settle();
  assert.equal(readyCalls, 0);
  api.frontendReady = async () => { readyCalls++; };
  api.closeConfirmed = async () => { closeCalls++; };
  delayed.window.dispatchEvent(new Event('pywebviewready'));
  delayed.window.dispatchEvent(new Event('pywebviewready'));
  await settle();
  assert.equal(readyCalls, 0, 'Keep splash until the interface has painted');
  delayed.paint();
  await settle();
  assert.equal(readyCalls, 0);
  delayed.paint();
  await settle();
  assert.equal(readyCalls, 1, 'Notify readiness only after the method exists');
  delayed.window.dispatchEvent(new Event('pile-numbering:close-requested'));
  await settle();
  assert.equal(closeCalls, 1);
  delayed.cleanup();
  delayed.window.dispatchEvent(new Event('pile-numbering:close-requested'));
  assert.equal(closeCalls, 1, 'Unmount must remove event listeners');

  const early = mount({ frontendReady: async () => { readyCalls++; } });
  early.paint(); early.paint();
  await settle();
  assert.equal(readyCalls, 2, 'Handle bridge ready before React mounts too');
  early.cleanup();
  for (const frontendReady of [() => { throw new Error('sync failure'); }, async () => { throw new Error('async failure'); }]) {
    const failed = mount({ frontendReady });
    failed.paint(); failed.paint();
    await settle();
    assert.equal(failed.errors.length, 1, 'Handshake failures must be caught');
    failed.cleanup();
  }
  const missingClose = mount({});
  missingClose.window.dispatchEvent(new Event('pile-numbering:close-requested'));
  await settle();
  assert.ok(missingClose.states.includes(true), 'Missing close bridge must keep the app open and show an error');
  missingClose.cleanup();
  const unmounted = mount({ frontendReady: async () => { readyCalls++; } });
  unmounted.paint();
  unmounted.cleanup();
  unmounted.paint();
  await settle();
  assert.equal(readyCalls, 2, 'Unmount must cancel pending readiness frames');
  console.log('Desktop startup regression checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
