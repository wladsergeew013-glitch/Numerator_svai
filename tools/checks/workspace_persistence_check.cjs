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
      if (name.startsWith('.')) {
        const base = path.resolve(path.dirname(file), name);
        return load(fs.existsSync(base + '.ts') ? base + '.ts' : base + '.tsx');
      }
      return native(name);
    };
    loaded.set(file, mod);
    const source = fs.readFileSync(file, 'utf8').replaceAll('import.meta.env', '({DEV:false})');
    mod._compile(ts.transpileModule(source, { compilerOptions: { module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022 } }).outputText, file);
    return mod.exports;
  }
  const { mergePatch } = load('frontend/src/utils/configPatch.ts');
  let patchCount = 0, active = 0, maxActive = 0, failNext = false, holdNext;
  const read = () => fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};
  global.fetch = async (url, init = {}) => {
    if (url === '/api/session') return {ok:true, json:async()=>({token:'test-token'})};
    assert.equal(url, '/api/config/user');
    if (init.method === 'PATCH') {
      patchCount++; maxActive = Math.max(maxActive, ++active);
      try {
        if (holdNext) { const wait = holdNext; holdNext = undefined; await wait; }
        if (failNext) { failNext = false; throw new Error('disk unavailable'); }
        fs.writeFileSync(configFile, JSON.stringify(mergePatch(read(), JSON.parse(init.body))));
      } finally { active--; }
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
      assert.equal(client.peekUserConfig().toolbarHeight, 220);
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
