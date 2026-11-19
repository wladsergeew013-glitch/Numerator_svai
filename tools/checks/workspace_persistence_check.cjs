/* Restart in a fresh process/origin with no localStorage; exercise the real
 * client, Zustand store and config writer, without opening user projects. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const ts = require(path.join(root, 'frontend/node_modules/typescript'));

if (!process.argv[2]) {
  const folder = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'pilenum-workspace-'));
  try {
    for (const mode of ['first', 'restart']) {
      const result = spawnSync(process.execPath, [__filename, mode, path.join(folder, 'config.json')], { encoding: 'utf8' });
      assert.equal(result.status, 0, `${mode}: ${result.stdout}\n${result.stderr}`);
    }
    console.log('PASS: first-launch defaults, fresh-process workspace restore, rapid edits, serialized flush and retry.');
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
} else {
  const mode = process.argv[2], configFile = process.argv[3], loaded = new Map();
  let hooks = [], cursor = 0;
  const jsx = (type, props) => ({type, props:props ?? {}});
  const react = {
    useState(initial) {
      const i=cursor++;
      if (!(i in hooks)) hooks[i]=typeof initial==='function'?initial():initial;
      return [hooks[i], next=>{hooks[i]=typeof next==='function'?next(hooks[i]):next;}];
    },
    useRef(initial) { const i=cursor++; return hooks[i] ?? (hooks[i]={current:initial}); },
    useEffect() {}, useMemo:fn=>fn()
  };
  global.window = Object.assign(new EventTarget(), {
    location: { origin: mode === 'first' ? 'http://127.0.0.1:54321' : 'http://127.0.0.1:59876' },
    localStorage: { getItem() { throw new Error('No browser cache'); }, setItem() { throw new Error('No browser cache'); } }
  });
  function load(file) {
    file = path.resolve(root, file);
    if (loaded.has(file)) return loaded.get(file).exports;
    const mod = new Module(file, module); mod.filename = file;
    mod.paths = Module._nodeModulePaths(path.dirname(file));
    const native = mod.require.bind(mod);
    mod.require = name => {
      if (file.endsWith('WorkspaceSettingsPanel.tsx')) {
        if (name === 'react') return react;
        if (name === 'react/jsx-runtime') return {jsx,jsxs:jsx};
        if (name.endsWith('/workspacePreferences')) return {useWorkspaceTab:()=>['autosave',()=>{}]};
        if (name.endsWith('/useProjectStore')) return {useProjectStore:()=>store.getState()};
        if (name === './DraggablePanel') return {DraggablePanel:'panel'};
      }
      if (name.startsWith('.')) {
        const base = path.resolve(path.dirname(file), name);
        if (fs.existsSync(base + '.ts')) return load(base + '.ts');
        if (fs.existsSync(base + '.tsx')) return load(base + '.tsx');
      }
      return native(name);
    };
    loaded.set(file, mod);
    const source = fs.readFileSync(file, 'utf8').replaceAll('import.meta.env', '({DEV:false})');
    mod._compile(ts.transpileModule(source, { compilerOptions: { module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022, jsx:ts.JsxEmit.ReactJSX } }).outputText, file);
    return mod.exports;
  }
  const { mergePatch } = load('frontend/src/utils/configPatch.ts');
  let patchCount = 0, active = 0, maxActive = 0, failNext = false, holdNext, holdRead;
  const read = () => fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};
  global.fetch = async (url, init = {}) => {
    if (url === '/api/session') return {ok:true, json:async()=>({token:'test-token'})};
    assert.equal(url, '/api/config/user');
    if (init.method === 'PATCH') {
      patchCount++; maxActive = Math.max(maxActive, ++active);
      try {
        if (holdNext) { const wait = holdNext; holdNext = undefined; await wait; }
        if (failNext) { failNext = false; throw new Error('disk unavailable'); }
        const saved = mergePatch(read(), JSON.parse(init.body));
        if (saved.commandIcons) saved.commandIcons = Object.fromEntries(Object.entries(saved.commandIcons).filter(([, value])=>value!==null));
        fs.writeFileSync(configFile, JSON.stringify(saved));
      } finally { active--; }
    }
    if (holdRead && !init.method) {
      const snapshot = read(), wait = holdRead; holdRead = undefined; await wait;
      return {ok:true, json:async()=>snapshot};
    }
    return {ok:true, json:async()=>read()};
  };
  const client = load('frontend/src/api/client.ts');
  const { useProjectStore: store } = load('frontend/src/store/useProjectStore.ts');
  const { createEmptyProject } = load('frontend/src/types/project.ts');
  const tick = () => new Promise(resolve => setImmediate(resolve));
  (async () => {
    const config = await client.getUserConfig();
    store.getState().hydrateUserConfig(config);
    assert.equal(patchCount, 0, 'Hydration must not write defaults back');
    if (mode === 'first') {
      assert.equal(store.getState().groupManagerVisible, false);
      assert.equal(store.getState().project.viewSettings.highlightUnnumbered, false);
      store.getState().toggleGroupManager();
      store.getState().toggleJournal();
      store.getState().openEditingTool('move');
      store.getState().updateViewSettings({highlightUnnumbered:true, backgroundColor:'#123456', showVectorPath:false});
      store.getState().updateGridSettings({enabled:false, color:'#abcdef'});
      store.getState().updateWorkspace({ windows:{settings:true, transfer:true}, tabs:{'ribbon-tab':'settings', 'settings-tab':'grid'}, lists:{'ribbon-collapsed':['file'], 'dock-order':['editing-panel','group-manager']} });
      client.queueUserConfigPatch({panels:{'group-manager':{x:45,y:180,width:420,height:580,dock:'left'},'workspace-settings':{x:525,y:200,width:490,height:600,detached:true}},toolbarHeight:190});
      const stop = client.registerConfigDraftFlusher(() => store.getState().updateViewSettings({markerTextColor:'#456789'}));
      await client.flushUserConfig(); stop();
      assert.equal(read().viewSettings.markerTextColor, '#456789', 'Close flush commits input drafts too');
      let release;
      holdNext = new Promise(resolve => { release = resolve; });
      const first = client.saveUserConfig({toolbarHeight:200});
      await tick();
      const second = client.saveUserConfig({toolbarHeight:210, workspace:{tabs:{'ribbon-density':'comfortable'}}});
      release(); await Promise.all([first, second]);
      assert.equal(maxActive, 1, 'Preferences must never interleave writes');
      assert.equal(read().toolbarHeight, 210);
      const mutable = {workspace:{lists:{'ribbon-collapsed':['file','history']}}};
      client.queueUserConfigPatch(mutable); mutable.workspace.lists['ribbon-collapsed'].push('groups');
      failNext = true;
      await assert.rejects(client.flushUserConfig(), /disk unavailable/);
      client.queueUserConfigPatch({toolbarHeight:220});
      await client.flushUserConfig();
      assert.deepEqual(read().workspace.lists['ribbon-collapsed'], ['file','history']);
      // A GET started before an edit must not replace the acknowledged value.
      let finishRead;
      holdRead = new Promise(resolve=>{finishRead=resolve;});
      const lateRead = client.getUserConfig(); await tick();
      await client.saveUserConfig({toolbarHeight:230});
      finishRead(); assert.equal((await lateRead).toolbarHeight,230);
      await client.saveUserConfig({commandIcons:{'file.save':'/api/assets/icons/test.png'}});
      // Backend icon deletion clears bindings without a frontend PATCH.
      const disk = read(); disk.commandIcons = {}; fs.writeFileSync(configFile, JSON.stringify(disk));
      assert.deepEqual((await client.getUserConfig()).commandIcons,{},'Acknowledged intent must not hide later backend changes');
      await client.saveUserConfig({commandIcons:{'file.save':null}});
      assert.deepEqual(client.peekUserConfig().commandIcons,{},'A removed binding never becomes a null icon URL');

      holdRead=new Promise(resolve=>{finishRead=resolve;});
      const earlier=client.getUserConfig();await tick();
      const changed=read();changed.toolbarHeight=240;fs.writeFileSync(configFile,JSON.stringify(changed));
      assert.equal((await client.getUserConfig()).toolbarHeight,240);
      finishRead();assert.equal((await earlier).toolbarHeight,240,'Out-of-order GET without a local write');

      const {WorkspaceSettingsPanel}=load('frontend/src/components/WorkspaceSettingsPanel.tsx');
      const nodes = node => !node || typeof node !== 'object' ? [] : Array.isArray(node)
        ? node.flatMap(nodes) : [node,...nodes(node.props?.children)];
      const render = () => {cursor=0;return nodes(WorkspaceSettingsPanel({onClose(){},toolbarHeight:132,statusBarHeight:28}));};
      const events=[];
      window.addEventListener('pile-numbering:autosave-settings-updated',event=>events.push(event.detail));
      const interval=render().find(node=>node.type==='input'&&node.props.type==='number');
      interval.props.onChange({target:{value:'0.25'}});
      render().find(node=>node.type==='input'&&node.props.type==='number').props.onBlur();
      await tick();
      assert.equal(read().autosaveSettings.intervalMinutes,0.25);
      const folder=render().find(node=>node.type==='input'&&node.props.type==='text');
      folder.props.onChange({target:{value:'alternate/autosaves'}});
      render().find(node=>node.type==='button'&&node.props.children==='Сохранить настройки').props.onClick();
      await tick();
      assert.equal(read().autosaveSettings.folderPath,'alternate/autosaves');
      assert.equal(events.at(-1).intervalMinutes,0.25);
      assert.equal(events.at(-1).folderPath,'alternate/autosaves');
    } else {
      const state = store.getState();
      assert.equal(state.groupManagerVisible, true);
      assert.equal(state.journalVisible, true);
      assert.equal(state.editingPanelVisible, true);
      assert.equal(state.editingTool, 'move');
      assert.equal(state.project.viewSettings.highlightUnnumbered, true, 'Saved choice overrides the fresh default');
      assert.equal(state.project.viewSettings.backgroundColor, '#123456');
      assert.equal(state.project.viewSettings.markerTextColor, '#456789');
      assert.equal(state.project.gridSettings.enabled, false);
      assert.equal(state.workspace.windows.settings, true);
      assert.equal(state.workspace.windows.transfer, true);
      assert.equal(state.workspace.tabs['settings-tab'], 'grid');
      assert.equal(state.workspace.tabs['ribbon-density'], 'comfortable');
      assert.deepEqual(state.workspace.lists['dock-order'], ['editing-panel','group-manager']);
      assert.equal(client.peekUserConfig().panels['workspace-settings'].detached, true);
      assert.equal(client.peekUserConfig().panels['group-manager'].width, 420);
      assert.equal(client.peekUserConfig().toolbarHeight, 240);
      assert.equal(config.autosaveSettings.intervalMinutes,0.25);
      assert.equal(config.autosaveSettings.folderPath,'alternate/autosaves');
      // Opening the chosen project preserves preferences but clears action refs.
      store.setState({editPointPickMode:'copy_base',copyBasePoint:{x:1,y:2},copyBasePointId:'old'});
      store.getState().openProjectFromFile(createEmptyProject(), 'chosen.pilenum.json');
      assert.equal(store.getState().editingTool, 'move');
      assert.equal(store.getState().journalVisible, true);
      assert.equal(store.getState().project.viewSettings.backgroundColor, '#123456');
      assert.equal(store.getState().copyBasePoint, null);
      assert.equal(store.getState().editPointPickMode, null);
      await client.flushUserConfig();
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
