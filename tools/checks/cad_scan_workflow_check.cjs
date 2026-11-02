/* Execute Toolbar handlers and real scan-selection helpers without a CAD host. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '../..');
const ts = require(path.join(root, 'frontend/node_modules/typescript'));
const loaded = new Map();
let hooks = [], cursor = 0;
const react = {
  useState(initial) {
    const index = cursor++;
    if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
    return [hooks[index], next => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next; }];
  },
  useRef(initial) {
    const index = cursor++;
    return hooks[index] ?? (hooks[index] = {current: initial});
  },
  useMemo: fn => fn(), useEffect() {}, useLayoutEffect() {},
};
const jsx = (type, props) => ({type, props: props || {}});
const item = name => ({name, count: 2, coordinateCount: 2, parameters: [{name:'GPP_PILE_NUMBER'}], numberParameterCandidates:['GPP_PILE_NUMBER']});
const requests = [];
const api = {
  CadOperationCancelled: class extends Error {},
  scanNanoCadModelStudioObjects: async scope => ({scanId:`scan-${scope}`, scope:scope === 'selection' ? scope : 'all', objects:scope === 'selection' ? [item('Pile-A')] : [item('Pile-A'), item('Pile-B')]}),
  importNanoCadModelStudioObjects: async params => { requests.push(params); return {points:[]}; },
  getUserConfig: async () => ({}), saveUserConfig: async () => ({}),
};
let store;
function load(file) {
  file = path.resolve(file);
  if (loaded.has(file)) return loaded.get(file).exports;
  const mod = new Module(file, module); mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  const original = mod.require.bind(mod);
  mod.require = name => {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return {jsx, jsxs:jsx, Fragment:Symbol.for('fragment')};
    if (name.endsWith('/api/client')) return api;
    if (name.endsWith('/store/useProjectStore')) return {useProjectStore:() => store};
    if (name.startsWith('./') && file.endsWith('Toolbar.tsx')) return new Proxy({}, {get:(_, key) => key === '__esModule' ? true : () => null});
    if (name.startsWith('.')) {
      const base = path.resolve(path.dirname(file), name);
      return load(fs.existsSync(base + '.ts') ? base + '.ts' : base + '.tsx');
    }
    return original(name);
  };
  loaded.set(file, mod);
  mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022, jsx:ts.JsxEmit.ReactJSX}}).outputText, file);
  return mod.exports;
}
global.window = {innerWidth:1500, innerHeight:950, localStorage:{getItem:() => null, setItem() {}}, setTimeout, clearTimeout};
global.requestAnimationFrame = fn => fn();
const {createEmptyProject} = load(path.join(root,'frontend/src/types/project.ts'));
store = new Proxy({project:createEmptyProject(), selectedPointIds:[], manualLinkClearSelection:[],
  numberingPreview:{visible:false}, syncCadImportedPoints:() => ({added:[], moved:[], linked:[], renumbered:[], unchanged:0})},
  {get:(target,key) => key in target ? target[key] : () => {}});
const {Toolbar} = load(path.join(root,'frontend/src/components/Toolbar.tsx'));
const helpers = load(path.join(root,'frontend/src/utils/cadScanState.ts'));
let tree;
function render() { cursor = 0; tree = Toolbar({canvasWidth:1000, canvasHeight:700, onHeightChange() {}, onCsvImport() {}}); }
function nodes(node) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(child => nodes(child));
  return [node, ...nodes(node.props?.children)];
}
function text(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return node && typeof node === 'object' ? text(node.props?.children) : '';
}
function one(predicate) {
  const found = nodes(tree).filter(predicate);
  assert.equal(found.length, 1, 'Expected one matching Toolbar control');
  return found[0];
}
const button = label => one(node => node.type === 'button' && text(node) === label);
const settle = () => new Promise(resolve => setImmediate(resolve));
async function act(fn) { await fn(); await settle(); render(); }
async function scope(value) {
  const select = one(node => node.type === 'select' && nodes(node.props.children).some(child => child.type === 'option' && child.props.value === 'selection'));
  await act(() => select.props.onChange({target:{value}}));
}
(async () => {
  render();
  await act(() => one(node => node.props.label === 'Импорт').props.onClick());
  assert.equal(button('Скан').props.className, 'active', 'Import opens the scan when none exists');
  await act(() => one(node => node.type === 'button' && text(node).startsWith('Model Studio')).props.onClick());
  await scope('selection');
  assert.equal(button('К импорту').props.disabled, true);
  await act(() => button('Сканировать Model Studio').props.onClick());
  assert.equal(button('К импорту').props.disabled, false);
  await act(() => button('К импорту').props.onClick());
  await act(() => button('Импортировать Model Studio').props.onClick());
  assert.equal(requests[0].scanId, 'scan-selection');
  assert.deepEqual(requests[0].selectedObjectNames, ['Pile-A']);
  await act(() => button('Открыть скан').props.onClick());
  await scope('all');
  assert.equal(button('К импорту').props.disabled, true, 'Old selection scan cannot be imported as the whole model');
  await act(() => button('Сканировать Model Studio').props.onClick());
  assert.equal(button('К импорту').props.disabled, false, 'A new whole-model scan enables import');
  await act(() => button('К импорту').props.onClick());
  await act(() => button('Импортировать Model Studio').props.onClick());
  assert.equal(requests[1].scanId, 'scan-all');
  assert.equal(requests[1].scope, 'all');
  assert.deepEqual(requests[1].selectedObjectNames, ['Pile-A','Pile-B']);
  await act(() => one(node => node.props.label === 'Импорт').props.onClick());
  assert.equal(button('Импорт').props.className, 'active', 'A valid scan goes directly to import');
  assert.ok(button('Импортировать Model Studio'), 'Reopening import keeps the CAD source rather than resetting to CSV');
  assert.deepEqual(helpers.blockScanSelection([{name:'New',attributes:[{tag:'NUM'}],numberAttributeCandidates:['NUM']}], 'Old', 'OLD'), {name:'New',attribute:'NUM'});
  assert.equal(helpers.cadScanReady('old',1,'selection','all',2,100), false);
  assert.equal(helpers.cadScanReady('expired',1,'all','all',2,600002), false);
  console.log('PASS: real Toolbar scan/import flow, selection-to-all rescan, fresh type choices, and scan-first default.');
})().catch(error => { console.error(error); process.exitCode = 1; });
