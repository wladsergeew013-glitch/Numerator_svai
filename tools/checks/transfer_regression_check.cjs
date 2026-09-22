/* Execute the real TS store with only the network adapter stubbed. */
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const Module = require('module');
const root = path.resolve(__dirname, '../..');
const ts = require(path.join(root, 'frontend/node_modules/typescript'));
const loaded = new Map();
function load(file) {
  file = path.resolve(file);
  if (loaded.has(file)) return loaded.get(file).exports;
  const mod = new Module(file, module);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  const originalRequire = mod.require.bind(mod);
  mod.require = (name) => {
    if (name.endsWith('/api/client')) return { saveUserConfig: async () => ({}), getUserConfig: async () => ({}) };
    if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name + '.ts'));
    return originalRequire(name);
  };
  loaded.set(file, mod);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  mod._compile(code, file);
  return mod.exports;
}
const { useProjectStore: store, connectedAutoClusters, buildNumberingOrder, buildGroupFlow, suggestedAxisTolerance } = load(path.join(root, 'frontend/src/store/useProjectStore.ts'));
const { newImportPoints } = load(path.join(root, 'frontend/src/utils/importPoints.ts'));
const { createEmptyProject, defaultNumberingSettings } = load(path.join(root, 'frontend/src/types/project.ts'));
const { cadAxisPlacement } = load(path.join(root, 'frontend/src/utils/cadAxes.ts'));
const { projectSaveSignature } = load(path.join(root, 'frontend/src/utils/projectSaveState.ts'));
store.getState().hydrateUserConfig({ viewSettings: { groupOutlineVisible: true } });
assert.equal(store.getState().project.viewSettings.groupOutlineVisible, false, 'Old automatic group outlines must be disabled once');
store.getState().hydrateUserConfig({ viewSettings: { groupOutlineVisible: true, groupOutlineDisplayVersion: 2 } });
assert.equal(store.getState().project.viewSettings.groupOutlineVisible, true, 'Keep an explicit current outline preference');
assert.equal(cadAxisPlacement({x:80,y:80},800,600).atOrigin, true);
const cornerAxes = cadAxisPlacement({x:-20,y:80},800,600);
assert.equal(cornerAxes.atOrigin, false);
assert.equal(cornerAxes.x, 28);
assert.equal(cornerAxes.y, 570);
assert.equal(cadAxisPlacement({x:900,y:80},800,600).atOrigin, false);
const point = (id, x, y, more = {}) => ({ id, x, y, number: null, sourceNumber: null, groupId: null, locked: false, manualNumber: false, syncState: 'added', ...more });
const grid = [[0,10],[10,10],[20,10],[0,0],[10,0],[20,0]].map(([x,y],i)=>point(String(i),x,y));
const axisSettings = {...defaultNumberingSettings(), rowTolerance: 1, columnTolerance: 1};
for (const [method, direction, expected] of [
  ['rows','left_to_right_top_to_bottom','012345'],
  ['rows','right_to_left_top_to_bottom','210543'],
  ['rows','left_to_right_bottom_to_top','345012'],
  ['rows','right_to_left_bottom_to_top','543210'],
  ['rows','snake_rows_left_top','012543'],
  ['rows','snake_rows_right_top','210345'],
  ['columns','snake_columns_top_left','034125'],
  ['columns','snake_columns_bottom_left','301452'],
  ['columns','left_to_right_top_to_bottom','031425'],
]) {
  assert.equal(buildNumberingOrder(grid, {...axisSettings, method, direction}).map(p=>p.id).join(''), expected, direction);
}
const started = buildNumberingOrder(grid, {...axisSettings, method:'columns', direction:'snake_columns_top_left',startPointId:'1'});
assert.equal(started.length, grid.length);
assert.equal(new Set(started.map(p=>p.id)).size, grid.length);
assert.equal(started[0].id, '1');
assert.ok(suggestedAxisTolerance(grid) < 10);
// Global flow is read-only, respects explicit endpoints/order and never crosses pipelines.
const flowProject = createEmptyProject();
flowProject.numberingMode = 'per_group';
const flowPipeline = flowProject.pipelines[0].id;
flowProject.pipelines.push({id:'other',name:'Other',order:2,startNumber:1});
flowProject.groups = ['a','empty','b','c','other'].map((id,i) => ({id,name:id,order:i+1,pipelineId:id==='other'?'other':flowPipeline,color:'#fff',visible:true,locked:false,numbering:{...axisSettings,method:'rows',direction:'left_to_right_top_to_bottom',...(id==='a'?{startPointId:'a2',endPointId:'a1'}:{})}}));
flowProject.points = [point('a1',0,0,{groupId:'a'}),point('a2',10,0,{groupId:'a'}),point('b1',30,0,{groupId:'b'}),point('b2',40,0,{groupId:'b'}),point('c1',60,0,{groupId:'c'}),point('o1',100,0,{groupId:'other'})];
const beforeFlow = JSON.stringify(flowProject);
const flow = buildGroupFlow(flowProject);
assert.equal(JSON.stringify(flowProject), beforeFlow);
store.setState({project: structuredClone(flowProject), history:[], redoStack:[]});
store.getState().updateGroupOrder('c',1);
assert.deepEqual(store.getState().project.groups.filter(g=>g.pipelineId===flowPipeline).sort((a,b)=>a.order-b.order).map(g=>g.id),['c','a','empty','b']);
assert.equal(store.getState().project.groups.find(g=>g.id==='other').order,5);
assert.deepEqual(store.getState().project.points, flowProject.points, 'Reordering must not change point numbers or assignments');
store.getState().undo();
assert.deepEqual(store.getState().project.groups,flowProject.groups);
assert.equal(flow.endpoints.length,4);
assert.deepEqual(flow.links.map(l=>[l.from.id,l.to.id]),[['a1','b1'],['b2','c1']]);
assert.equal(flow.endpoints[0].start.id,'a2');
assert.equal(flow.endpoints[2].start.id, flow.endpoints[2].end.id);
flowProject.groups.find(g=>g.id==='b').visible=false;
assert.equal(buildGroupFlow(flowProject).links.length,0,'Do not bypass a hidden group in the true sequence');
flowProject.groups.find(g=>g.id==='b').visible=true;
flowProject.groups.find(g=>g.id==='c').order=0;
assert.deepEqual(buildGroupFlow(flowProject).links.map(l=>[l.fromGroupId,l.toGroupId]),[['c','a'],['a','b']]);
assert.equal(suggestedAxisTolerance(grid.map(p=>({...p,x:p.x*1000,y:p.y*1000}))), suggestedAxisTolerance(grid)*1000);
const original = point('old', 0, 0, { number: 42, locked: true, manualNumber: true, groupId: 'g' });
store.getState().openProjectFromFile(structuredClone(flowProject), 'saved-field.json');
const cleanSignature = store.getState().savedProjectSignature;
assert.equal(projectSaveSignature(store.getState().project), cleanSignature);
store.getState().updateGroupName('a', 'Changed name');
assert.notEqual(projectSaveSignature(store.getState().project), cleanSignature);
store.getState().undo();
assert.equal(projectSaveSignature(store.getState().project), cleanSignature, 'Undo to saved data clears the dirty state');
store.getState().updateView(2, 100, 200);
assert.equal(projectSaveSignature(store.getState().project), cleanSignature, 'Camera movement is not an unsaved edit');
store.getState().setSelectedGroup('a');
store.getState().setNumberingPreviewMode('full');
store.getState().setSelectedGroup(null);
assert.equal(store.getState().selectedGroupId, null, 'Clearing selection must not automatically reselect the preview group');
assert.equal(store.getState().numberingPreview.visible, false);
store.getState().setNumberingPreviewMode('full');
assert.equal(store.getState().allGroupsOrderVisible, true);
assert.equal(store.getState().selectedGroupId, null);
store.getState().setNumberingPreviewMode('full');
assert.equal(store.getState().allGroupsOrderVisible, false);
store.getState().openGroupDetails('b');
assert.equal(store.getState().groupDetailsId, 'b');
assert.equal(store.getState().selectedGroupId, 'b');
store.getState().closeGroupDetails();
assert.equal(store.getState().groupDetailsId, null);
assert.deepEqual(newImportPoints([original], [point('duplicate', 0, 0), point('new', .9, 0), point('duplicate-new', .9, 0)]).map(p=>p.id), ['new']);
store.setState({ project: { ...createEmptyProject(), points: [original] } });
store.getState().appendImportedPoints('test', [point('dup', 0, 0), point('new', .9, 0)]);
assert.deepEqual(store.getState().project.points[0], original);
assert.equal(store.getState().project.points.length, 2);
store.getState().undo();
assert.deepEqual(store.getState().project.points, [original]);
const link = { cadDocument: 'C:/test.dwg', cadHandle: 'A' };
const linked = point('linked', 0, 0, { meta: link });
assert.equal(newImportPoints([linked], [point('moved', 10, 0, {meta: link})]).length, 0);
assert.equal(newImportPoints([linked], [point('different', 0, 0, {meta: {...link, cadHandle:'B'}})]).length, 1);
store.setState({ project: { ...createEmptyProject(), points: [linked] }, selectedPointIds: ['linked'] });
store.getState().copySelectedPoints(10, 0);
assert.equal(store.getState().project.points[1].meta.cadHandle, undefined);
assert.equal(store.getState().project.points[0].meta.cadHandle, 'A');
const synthetic = Array.from({length:20}, (_,i)=>point(String(i), (i%5)*.9 + (i>=10 ? 100 : 0), Math.floor(i%10/5)*.9));
function partition(points) { return connectedAutoClusters(points).map(c=>c.map(p=>p.id).sort().join(',')).sort(); }
assert.deepEqual(partition(synthetic), partition(synthetic.map(p=>({...p,x:p.x*1000,y:p.y*1000}))));
assert.equal(connectedAutoClusters(synthetic).length, 2);
const locked = point('locked', 1000, 1000, { locked: true, number: 999 });
store.setState({project:{...createEmptyProject(),points:[...synthetic,locked]},selectedPointIds:[]});
store.getState().autoClusterEditablePoints();
assert.deepEqual(store.getState().project.points.find(p=>p.id==='locked'), locked);

// Applying a preview must preserve its exact partition and retain noise and other groups.
const draft = createEmptyProject();
const group = (id, more={}) => ({id,name:id,order:1,pipelineId:draft.pipelines[0].id,color:'#f00',visible:true,locked:false,numbering:defaultNumberingSettings(),...more});
draft.groups = [group('old-group'), group('frozen',{locked:true}), group('empty')];
draft.points = [point('a',0,0,{groupId:'old-group',number:17}), point('b',1,0,{groupId:'old-group'}),
  point('noise',20,0,{groupId:'old-group'}), point('outside',30,0,{groupId:'old-group'}), point('frozen',40,0,{groupId:'frozen',number:22})];
store.setState({project:draft,selectedPipelineId:draft.pipelines[0].id});
const previewInput=structuredClone(draft.points.slice(0,3));
const previewResult={method:'dbscan',clusters:[['a','b']],unassignedIds:['noise'],warnings:[],pointCount:3,options:{method:'dbscan'}};
const applyPreview = result => store.getState().applyAutoClusterPreview({sourcePoints:previewInput,pipelineId:draft.pipelines[0].id,result});
assert.throws(()=>applyPreview({...previewResult,clusters:[['a','a']],unassignedIds:['noise']}),/Некорректный/);
assert.deepEqual(store.getState().project,draft);
applyPreview(previewResult);
let applied=store.getState().project;
assert.equal(applied.points.find(p=>p.id==='a').groupId,applied.points.find(p=>p.id==='b').groupId);
assert.equal(applied.points.find(p=>p.id==='noise').groupId,null);
assert.deepEqual(applied.points.find(p=>p.id==='outside'),draft.points[3]);
assert.deepEqual(applied.points.find(p=>p.id==='frozen'),draft.points[4]);
assert.ok(applied.groups.some(g=>g.id==='empty'));
assert.equal(applied.points.length,draft.points.length);
store.getState().undo();
assert.deepEqual(store.getState().project.points,draft.points);
store.setState({project:{...draft,points:draft.points.map(p=>p.id==='a'?{...p,number:99}:p)}});
assert.throws(()=>applyPreview(previewResult),/изменились/);
store.setState({project:{...draft,groups:draft.groups.map(g=>g.id==='old-group'?{...g,locked:true}:g)}});
assert.throws(()=>applyPreview(previewResult),/изменились/);
const file = process.argv[2];
if (file) {
  const project = JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  const before = JSON.stringify(project.points);
  const clusters = connectedAutoClusters(project.points);
  assert.equal(clusters.flat().length, project.points.length);
  assert.equal(new Set(clusters.flat().map(p=>p.id)).size, project.points.length);
  assert.equal(JSON.stringify(project.points), before);
  assert.deepEqual(partition(project.points), partition([...project.points].reverse()));
  assert.deepEqual(partition(project.points), partition(project.points.map(p=>({...p,x:p.x*1000,y:p.y*1000}))));
  assert.ok(clusters.length > 1 && clusters.length < 30);
  console.log(`User fixture: ${project.points.length} points, ${clusters.length} clusters: ${clusters.map(c=>c.length).join(', ')}`);
}
console.log('PASS: additive import, duplicates, undo, handle copies, locked points, scale-invariant clustering.');

// React clears currentTarget after dispatch; file reads complete asynchronously.
async function checkAsyncFileInputs() {
  const source = ts.createSourceFile('Toolbar.tsx', fs.readFileSync(path.join(root, 'frontend/src/components/Toolbar.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const handlers = new Map();
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.initializer) handlers.set(node.name.getText(source), node.initializer.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  let opened = 0, imported = 0, previewed = 0;
  const deps = {
    openProjectFromFile: () => { opened++; }, onCsvImport: async () => { imported++; },
    buildImportPreview: async () => ({columns:['X','Y'], rows:[]}), guessColumnIndex: () => 0,
    setImportPreview: () => { previewed++; }, setImportXColumn: () => {}, setImportYColumn: () => {},
    setImportNumberColumn: () => {}, setImportStatus: () => {}, setProjectStatus: () => {}, setFileImportProgress: () => {}
  };
  for (const name of ['openProjectFile', 'importCsvIntoCurrentProject', 'selectImportFile']) {
    assert.ok(handlers.has(name));
    const code = ts.transpileModule(`module.exports = ${handlers.get(name)};`, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
    const isolated = {exports:null};
    new Function('module', ...Object.keys(deps), code)(isolated, ...Object.values(deps));
    const input = {value:'test', files:[{name:'test.json', text:async () => '{}'}]};
    const event = {target:input, currentTarget:input};
    const pending = isolated.exports(event);
    event.currentTarget = null;
    await pending;
    assert.equal(input.value, '', `${name} resets the captured input after async reading`);
  }
  assert.equal(opened, 1); assert.equal(imported, 1); assert.equal(previewed, 1);
  console.log('PASS: project, CSV and Excel input cleanup after asynchronous reading.');
}
checkAsyncFileInputs().catch(error => { console.error(error); process.exitCode = 1; });
