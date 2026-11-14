/* Observable counterexamples from PN-019..056, using actual store and handlers. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '../..');
const ts = require(path.join(root, 'frontend/node_modules/typescript'));
const cache = new Map();
const api = { getUserConfig: async()=>({}), saveUserConfig: async()=>({}) };
let hooks=[], cursor=0, effects=[];
const react = {
  useState(initial) { const i=cursor++; if (!(i in hooks)) hooks[i]=typeof initial==='function'?initial():initial; return [hooks[i], value=>{hooks[i]=typeof value==='function'?value(hooks[i]):value;}]; },
  useEffect(fn) { const i=cursor++; if (!(i in hooks)) { hooks[i]=true; effects.push(fn); } },
};
const jsx=(type,props)=>({type,props:props||{}});
function load(relative) {
  const file=path.resolve(root,relative);
  if(cache.has(file))return cache.get(file).exports;
  const mod=new Module(file,module);mod.filename=file;mod.paths=Module._nodeModulePaths(path.dirname(file));
  const native=mod.require.bind(mod);
  mod.require=name=>{
    if(name==='react')return react;
    if(name==='react/jsx-runtime')return {jsx,jsxs:jsx};
    if(name.endsWith('/api/client'))return api;
    if(name.startsWith('.')) { const base=path.resolve(path.dirname(file),name); return load(fs.existsSync(base+'.ts')?base+'.ts':base+'.tsx'); }
    return native(name);
  };
  cache.set(file,mod);
  let source = fs.readFileSync(file,'utf8').replaceAll('import.meta.env', '({ DEV: false })');
  source = source.replace('export function buildPreviewOrderForGroup(project: PileProject, targetGroup: PileGroup) {',
    'export function buildPreviewOrderForGroup(project: PileProject, targetGroup: PileGroup) { (globalThis as any).__routeBuilds = ((globalThis as any).__routeBuilds || 0) + 1;');
  mod._compile(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,file);
  return mod.exports;
}
const storage=new Map();
global.window=Object.assign(new EventTarget(),{innerWidth:1000,innerHeight:600,localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},dispatchEvent:EventTarget.prototype.dispatchEvent});
if(!global.CustomEvent)global.CustomEvent=class extends Event {constructor(type,options){super(type);this.detail=options.detail;}};
const {useProjectStore:store}=load('frontend/src/store/useProjectStore.ts');
const {createEmptyProject,defaultNumberingSettings}=load('frontend/src/types/project.ts');
const validation=load('frontend/src/utils/validation.ts');
const {parseUiSettingsFile}=load('frontend/src/utils/projectFiles.ts');
const {reconcileCadImport}=load('frontend/src/utils/importPoints.ts');
const tables=load('frontend/src/utils/tabularImport.ts');
const {pointVisibility}=load('frontend/src/utils/pointVisibility.ts');
const patch=load('frontend/src/utils/configPatch.ts');
const point=(id,x=0,y=0,more={})=>({id,x,y,locked:false,manualNumber:false,number:null,syncState:'added',groupId:null,...more});
function fixture(){const p=createEmptyProject();p.groups=['a','b'].map((id,i)=>({id,name:id,order:i+1,pipelineId:p.pipelines[0].id,color:'#fff',visible:true,locked:false,numbering:defaultNumberingSettings()}));p.points=[point('a1',0,0,{groupId:'a'}),point('b1',10,6,{groupId:'b'})];return p;}
function ast(file){return ts.createSourceFile(file,fs.readFileSync(path.join(root,file),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);}
function handler(file,name,deps) {
  const source=ast(file), found=[];
  function visit(n){if(ts.isVariableDeclaration(n)&&n.name.getText(source)===name)found.push(n.initializer.getText(source));ts.forEachChild(n,visit);}visit(source);
  assert.equal(found.length,1,`One ${name} implementation`);
  return new Function(...Object.keys(deps),ts.transpileModule(`return (${found[0]});`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText)(...Object.values(deps));
}
function pureFunctions(file,names){const source=ast(file);const text=source.statements.filter(n=>(ts.isFunctionDeclaration(n)&&!['CanvasView','DraggablePanel'].includes(n.name?.text))||ts.isVariableStatement(n)).map(n=>n.getText(source)).join('\n');return new Function(ts.transpileModule(text+`\nreturn {${names.join(',')}};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText)();}
function declarations(file,names,deps={}) {
  const source=ast(file), text=source.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.includes(n.name?.text)).map(n=>n.getText(source)).join('\n');
  return new Function('exports',...Object.keys(deps),ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText+`\nreturn {${names.join(',')}};`)({},...Object.values(deps));
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};

(async()=>{
  for(const value of ['', ' ', '1.6','1e3','9007199254740993','Infinity'])assert.throws(()=>validation.parseSafeInteger(value));
  assert.equal(validation.parseSafeInteger('-13'),-13);
  store.getState().setProject(fixture());const before=JSON.stringify(store.getState().project);
  for(const payload of [ {startNumber:1.5}, {startNumber:Number.MAX_SAFE_INTEGER+1}, {rowTolerance:0}, {columnTolerance:NaN}, {step:0} ])assert.throws(()=>store.getState().updateGroupNumbering('a',payload));
  assert.equal(JSON.stringify(store.getState().project),before);
  store.getState().updateGroupNumbering('a',{startNumber:-3});assert.equal(store.getState().project.groups[0].numbering.startNumber,-3);
  console.log('PASS PN-019/051: shared strict integers and positive finite tolerances, no rejected-input mutations.');

  const incoming=[point('new1',0,0,{meta:{cadDocument:'C:/a.dwg',cadHandle:'1'}}),point('new2',0,0,{meta:{cadDocument:'C:/a.dwg',cadHandle:'2'}})];
  const old=point('old');const reconciled=reconcileCadImport([old],incoming);
  assert.equal(reconciled.linked.length,1);assert.equal(reconciled.added.length,1);
  const again=reconcileCadImport([...reconciled.linked,...reconciled.added],incoming);assert.equal(again.added.length,0);assert.equal(again.linked.length,0);
  const migrated=reconcileCadImport([incoming[0]],[{...incoming[0],meta:{...incoming[0].meta,cadDocumentGuid:'guid'}}]);assert.equal(migrated.linked[0].id,incoming[0].id);
  console.log('PASS PN-021/034: one-to-one import at equal XY, idempotence and explicit GUID rebinding.');

  for(const text of ['100;200;P-001\n110;220;P-002','1e3;2e3;P-001\n110;220;P-002']) {
    const parsed=tables.parseCsvRecords(text);assert.equal(tables.guessTableHeader(parsed.rows),false);assert.equal(tables.tableWithHeader(parsed.rows,false).rows.length,2);
  }
  const parsed=tables.parseCsvRecords('X;Y;Number\r\n1;2;"P\n001"\r\n3;4;"P""2"');
  assert.equal(tables.guessTableHeader(parsed.rows),true);assert.deepEqual(tables.tableWithHeader(parsed.rows,true).rows.map(r=>r[2]),['P\n001','P"2']);
  assert.equal(tables.tableWithHeader(parsed.rows,false).rows.length,3);assert.throws(()=>tables.parseCsvRecords('1;2;"broken'));
  console.log('PASS PN-024/027: headers are explicit, quoted newlines/quotes and exponential coordinates preserved.');

  for(const mutate of [p=>p.points[0].x='1',p=>p.viewSettings.backgroundColor=42,p=>p.points.push({...p.points[0]}),p=>p.points[0].groupId='missing',p=>p.groups[0].numbering.vectorPath='bad']) {
    const damaged=fixture();mutate(damaged);const before=JSON.stringify(store.getState().project);assert.throws(()=>store.getState().openProjectFromFile(damaged,'bad.json'));assert.equal(JSON.stringify(store.getState().project),before);
  }
  assert.throws(()=>parseUiSettingsFile({gridSettings:{},viewSettings:{backgroundColor:42}}));
  console.log('PASS PN-026: malformed runtime data/settings rejected atomically.');

  const canvas='frontend/src/components/CanvasView.tsx';
  const pure=pureFunctions(canvas,['makeGroupOutlineWorldCadBands','makeOrthogonalDraftPoint']);
  const geometry=[...Array.from({length:6},(_,i)=>({x:0,y:i*1000})),...Array.from({length:6},(_,i)=>({x:4140,y:9000+i*1000}))];
  const outline=pure.makeGroupOutlineWorldCadBands(geometry,28);
  function inside(p,polygon){let hit=false;for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){const a=polygon[i],b=polygon[j];if(((a.y>p.y)!==(b.y>p.y))&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)hit=!hit;}return hit;}
  assert.ok(geometry.every(p=>inside(p,outline)),JSON.stringify(outline));
  console.log('PASS PN-028: automatic contour encloses both distant bands.');

  for(const mode of ['outline','vector']) {
    store.getState().setProject(fixture());store.getState().setSelectedGroup('a');
    if(mode==='outline'){store.getState().startGroupOutlineDrawing('a');for(const p of [{x:0,y:0},{x:10,y:0},{x:10,y:10}])store.getState().addGroupOutlineDraftPoint(p);}
    else {store.getState().startVectorPathDrawing('a');store.getState().addVectorPathDraftPoint({x:0,y:0});store.getState().addVectorPathDraftPoint({x:10,y:10});}
    store.getState().setSelectedGroup('b');const before=JSON.stringify(store.getState().project);
    if(mode==='outline')store.getState().closeGroupOutlineDrawing();else store.getState().finishVectorPathDrawing();
    assert.equal(JSON.stringify(store.getState().project),before);
  }
  store.getState().setProject(fixture());store.setState({project:{...store.getState().project,points:[{...store.getState().project.points[0],locked:true},store.getState().project.points[1]]},selectedPointIds:['a1']});
  for(const mutate of [()=>store.getState().moveSelectedPoints(5,5),()=>store.getState().deleteSelectedPoints(),()=>store.getState().assignPointIdsToGroup(['a1'],'b'),()=>store.getState().copyGroupPropertyToTargets('b1',['a1'])]) {const before=JSON.stringify(store.getState().project.points[0]);mutate();assert.equal(JSON.stringify(store.getState().project.points[0]),before);}
  console.log('PASS PN-042/043: draft ownership and locked manual mutations.');

  const prefs={settingsVersion:2,groupOutlineDisplayVersion:2,numberTextFontFamily:'Inter',numberTextBubbleColor:'#000000',numberTextBubbleEnabled:true,numberTextStrokeEnabled:true,numberTextStrokeWidth:.5};
  store.getState().hydrateUserConfig({viewSettings:prefs});store.getState().setProject(fixture());
  for(const [key,value] of Object.entries(prefs))assert.equal(store.getState().project.viewSettings[key],value);
  assert.deepEqual(patch.changedFields({viewSettings:{zoom:1,color:'a'}},{viewSettings:{zoom:1,color:'b'}}),{viewSettings:{color:'a'}});
  const docks=pureFunctions('frontend/src/components/DraggablePanel.tsx',['updateRegistry','readRegistry']);docks.updateRegistry('A','left');docks.updateRegistry('B','left');docks.updateRegistry('A','left');assert.deepEqual(docks.readRegistry().map(x=>x.id),['A','B']);
  const style=handler('frontend/src/components/DraggablePanel.tsx','style',{detached:false,isDocked:false,panelState:{x:0,y:900,width:350,height:400},viewportWidth:984,dockOffsetTop:90,minWidth:280,minHeight:200,panelZIndex:1,clamp:(v,min,max)=>Math.min(Math.max(v,min),max)});
  assert.equal(style.top,560);
  console.log('PASS PN-044/045/046/053: field patches, persistent preferences, stable dock order and reachable header.');

  const p=fixture();p.groups[1].visible=false;
  const rect=handler(canvas,'getIdsInRect',{project:p,isPointPickable:pointVisibility(p.groups),rectContains:()=>true,worldToScreen:(x,y)=>({x,y})});assert.deepEqual(rect({}),['a1']);
  p.groups[1].visible=true;p.points[0].x=10;p.points[1].x=1;
  const nearest=handler(canvas,'findNearestPoint',{project:p,isPointPickable:pointVisibility(p.groups),numberingPickMode:'group_start',selectedGroupId:'a',worldToScreen:(x,y)=>({x,y}),distance2:(a,b)=>(a.x-b.x)**2+(a.y-b.y)**2});assert.equal(nearest({x:0,y:0}).id,'a1');
  let added=[],applied=0,selected=[];
  p.points[1].x=10;
  const base={project:p,editPointPickMode:null,numberingPickMode:null,vectorPathDrawMode:true,groupOutlineDrawMode:false,setManualLinkDraft(){},addVectorPathDraftPoint:q=>added.push(q),setVectorHoverPoint(){},worldToScreen:(x,y)=>({x,y}),resolveVectorDraftPoint:q=>({point:pure.makeOrthogonalDraftPoint({x:0,y:0},q)}),handleCanvasEditPoint:()=>applied++,handleNumberingPickPoint(){},togglePointSelection:id=>selected.push(id)};
  let pick=handler(canvas,'onPointMouseDown',base);const right={evt:{button:2},cancelBubble:false};pick(right,'b1');assert.equal(added.length,0);assert.equal(right.cancelBubble,false);
  pick({evt:{button:0,shiftKey:true}},'b1');assert.equal(added[0].y,0);
  pick=handler(canvas,'onPointMouseDown',{...base,vectorPathDrawMode:false,editPointPickMode:'props_target'});pick({evt:{button:0,ctrlKey:true}},'b1');assert.deepEqual(selected,['b1']);assert.equal(applied,0);
  console.log('PASS PN-047/048/049/050: visible/eligible picks, mouse ownership, modifier selection and orthogonal snaps.');

  store.getState().setProject(fixture());for(let i=0;i<330;i++)store.getState().recordOperation('probe',{i});
  assert.equal(store.getState().project.operations.length,300);assert.ok(Object.keys(store.getState().journalSnapshots).length<=80);
  const ids=new Set(store.getState().project.operations.map(o=>o.id));assert.ok(Object.keys(store.getState().journalSnapshots).every(id=>ids.has(id)));
  console.log('PASS PN-056: 330 operations leave at most 80 reachable snapshots.');

  const numbering = load('frontend/src/store/useProjectStore.ts');
  for(const method of ['rows','columns','route','vector']) {
    const p=fixture();p.numberingMode='per_group';p.groups=p.groups.slice(0,1);
    p.groups[0].numbering={...defaultNumberingSettings(method),rowTolerance:1,columnTolerance:1,vectorPath:[{x:0,y:0},{x:100,y:0}]};
    p.points=[['a',0],['b',10],['d',90],['c',100]].map(([id,x])=>point(id,x,0,{groupId:'a'}));
    store.getState().setProject(p);store.getState().setSelectedGroup('a');
    for(const [from,to] of [['b','d'],['a','c']]) {
      const state=store.getState(), group=state.project.groups[0];
      assert.equal(numbering.isManualLinkTargetAllowed(state.project,group,from,to),true,method);
      store.getState().startNumberingManualLinkEdit(from);store.getState().handleNumberingPickPoint(to);
    }
    const group=store.getState().project.groups[0], route=numbering.buildNumberingOrder(store.getState().project.points,group.numbering).map(p=>p.id);
    for(const link of group.numbering.manualLinks)assert.equal(route.indexOf(link.toId),route.indexOf(link.fromId)+1,method);
    assert.equal(group.numbering.manualLinks.length,2);
    const before=JSON.stringify(store.getState().project);
    assert.equal(numbering.isManualLinkTargetAllowed(store.getState().project,group,'d','c'),false);
    store.getState().startNumberingManualLinkEdit('d');store.getState().handleNumberingPickPoint('c');
    assert.equal(JSON.stringify(store.getState().project),before);
    const pinned={...group,numbering:{...group.numbering,endPointId:'c',manualLinks:[]}};
    assert.equal(numbering.isManualLinkTargetAllowed({...p,groups:[pinned]},pinned,'a','c'),false);
    const canvasAllowed=handler('frontend/src/components/CanvasView.tsx','isManualTargetAllowedOnCanvas',{project:{...p,groups:[pinned]},activeNumberingGroup:pinned,isManualLinkTargetAllowed:numbering.isManualLinkTargetAllowed});
    assert.equal(canvasAllowed('a','c'),false);
  }
  console.log('PASS PN-012/069: all four methods preserve every manual edge; conflicting insertion and premature end are rejected before mutation; Canvas uses the same validator.');

  let mixed=fixture();mixed.pipelines.push({id:'P2',name:'second',order:2});mixed.groups[1].pipelineId='P2';
  store.getState().setProject(mixed);store.setState({selectedPointIds:['a1','b1'],selectedGroupId:'a',selectedPipelineId:'P2'});
  store.getState().copySelectedPoints(100,0);
  assert.equal(store.getState().selectedPipelineId,mixed.pipelines[0].id);assert.equal(store.getState().selectedGroupId,'a');
  await store.getState().applyRowsNumbering();assert.equal(store.getState().project.points.find(p=>p.id==='b1').number,null);
  store.getState().setPointManualNumber('b1',55);assert.equal(store.getState().selectedPipelineId,'P2');
  store.setState({selectedGroupId:'a',selectedPipelineId:'P2'});await store.getState().applyRowsNumbering();
  assert.equal(store.getState().project.points.find(p=>p.id==='b1').number,55);
  console.log('PASS PN-018: mixed selection/copy/manual number keep group and pipeline aligned; explicit group wins over stale pipeline.');

  const spaces=load('frontend/src/utils/numberingSpace.ts');
  const checks=declarations('frontend/src/components/Toolbar.tsx',['isPointUnnumbered','pointDisplayName','groupDisplayName','pushIssue','buildModelCheck'],{numberingSpace:spaces.numberingSpace});
  mixed=fixture();mixed.pipelines.push({id:'P2',name:'second',order:2});mixed.groups[1].pipelineId='P2';mixed.points.forEach(p=>{p.number=1;p.manualNumber=true;});
  assert.equal(checks.buildModelCheck(mixed).duplicateNumbersGlobal,0);assert.equal(checks.buildModelCheck(mixed).duplicateManualNumbers,0);
  mixed.groups[1].pipelineId=mixed.pipelines[0].id;assert.equal(checks.buildModelCheck(mixed).duplicateNumbersGlobal,1);
  mixed.points[1].manualNumber=false;assert.equal(checks.buildModelCheck(mixed).duplicateNumbersGlobal,1);
  mixed.numberingMode='per_group';assert.equal(checks.buildModelCheck(mixed).duplicateNumbersGlobal,0);
  mixed.points.push({...mixed.points[1],id:'actual-duplicate'});assert.equal(checks.buildModelCheck(mixed).duplicateNumbersGlobal,1);
  mixed.groups[0].meta={clusterNumbering:true};assert.equal(spaces.canEditStartNumber(mixed,mixed.groups[0],'a'),false);
  mixed.numberingMode='global_sequential';assert.equal(spaces.canEditStartNumber(mixed,mixed.groups[0],'a'),true);
  mixed.groups[1].meta={clusterNumbering:true};assert.equal(spaces.canEditStartNumber(mixed,mixed.groups[1],'a'),false);
  console.log('PASS PN-070/074: diagnostics share numbering namespaces, real mixed duplicates remain errors; only meaningful cluster/pipeline start controls are offered.');

  const performanceProject=fixture();performanceProject.groups=performanceProject.groups.slice(0,1);performanceProject.groups[0].numbering={...defaultNumberingSettings('vector'),vectorPath:[{x:0,y:0},{x:1000,y:0}]};
  performanceProject.points=Array.from({length:200},(_,i)=>point('perf-'+i,i*5,i%5,{groupId:'a'}));
  store.getState().setProject(performanceProject);store.getState().buildNumberingPreview();store.getState().toggleNumberingPreview();
  const calls=global.__routeBuilds;
  store.getState().updateGroupName('a','cosmetic');store.getState().updateGroupColor('a','#123456');
  store.getState().updatePointNumberLabelOffset('perf-0',{x:2,y:3});store.getState().updateGroupMeta('a',{groupNumberLabelOffset:{x:5,y:8}});
  assert.equal(global.__routeBuilds,calls,'No route builder call for cosmetic edits, including hidden preview');
  store.getState().setPoints(store.getState().project.points.map((p,i)=>i===0?{...p,x:20}:p));assert.ok(global.__routeBuilds>calls);
  const afterGeometry=global.__routeBuilds;store.getState().updateGroupNumbering('a',{method:'rows'});assert.ok(global.__routeBuilds>afterGeometry);
  store.getState().undo();assert.ok(global.__routeBuilds>afterGeometry+1);
  console.log('PASS PN-071: instrumented actual store makes zero route calls for name/color/label changes, but updates geometry/method/Undo.');

  const contexts=load('frontend/src/utils/pointContext.ts');
  for(const action of ['read','position','write'])for(const change of ['session','point']) {
    store.getState().setProject(fixture());const original=store.getState(), selected=original.project.points[0], response=defer();let writes=0;
    const run=handler('frontend/src/components/PointInfoPanel.tsx','runCadAction',{...contexts,useProjectStore:store,projectSessionId:original.projectSessionId,point:selected,cadHandle:'A',cadDocument:'C:/fixture.dwg',objectName:'Pile',objectKind:'block',cadActionBusy:false,locked:false,manualNumberValue:'55',parameterName:'NUMBER',actionGeneration:{current:0},setCadActionBusy(){},setCadActionStatus(){},parseSafeInteger:validation.parseSafeInteger,actOnNanoCadPoint:()=>{writes++;return response.promise;},syncPointFromModel:(...args)=>store.getState().syncPointFromModel(...args)});
    const pending=run(action);
    if(change==='session')store.getState().openProjectFromFile({...fixture(),points:[{...selected,x:500,number:22}]},'copy.json');
    else store.getState().setPoints([{...selected,x:500,number:22}]);
    const before=JSON.stringify(store.getState().project);
    response.resolve({position:{x:10,y:20,z:0},number:55,rawNumber:'55',parameterName:'NUMBER'});await pending;
    assert.equal(JSON.stringify(store.getState().project),before);assert.equal(writes,1);
  }
  store.getState().setProject(fixture());const owner=contexts.capturePointContext(store.getState().projectSessionId,store.getState().project.points[0]);
  store.getState().openProjectFromFile(fixture(),'same-ids.json');let changed=0;
  const staleSave=handler('frontend/src/components/CanvasView.tsx','save',{...contexts,pointEditDialog:{...owner,value:'11'},useProjectStore:store,setPointEditDialog(){},setPointManualNumber:()=>changed++});staleSave();assert.equal(changed,0);
  const staleManual=handler('frontend/src/components/PointInfoPanel.tsx','applyManualNumber',{...contexts,point:store.getState().project.points[0],projectSessionId:owner.sessionId,useProjectStore:store,locked:false,setPointManualNumber:()=>changed++});staleManual();assert.equal(changed,0);
  let previewError='';const stalePreview=handler('frontend/src/components/AutoClusterDialog.tsx','apply',{result:{clusters:[['a1']]},busy:false,useProjectStore:store,snapshot:{sessionId:owner.sessionId},setError:message=>previewError=message});
  const untouched=JSON.stringify(store.getState().project);stalePreview();assert.equal(JSON.stringify(store.getState().project),untouched);assert.match(previewError,/изменился/);
  console.log('PASS PN-006/042: delayed read/position/write cannot alter another session or edited source point; stale Canvas editor cannot save into copied IDs.');

  const client=load('frontend/src/api/client.ts'), requests=[];let disk=null, active=0,maxActive=0;
  const {developmentApiBase}=declarations('frontend/src/api/client.ts',['developmentApiBase']);
  for(const host of ['127.0.0.1','localhost'])assert.equal(new URL(developmentApiBase(host)).hostname,host,'Dev page and asset-cookie host stay on the same site');
  global.fetch=async(url,init)=>{
    if(url.endsWith('/api/session'))return {ok:true,json:async()=>({token:'fixture-token'})};
    assert.ok(url.endsWith('/api/projects/local/save'));const response=defer(), payload=JSON.parse(init.body);active++;maxActive=Math.max(maxActive,active);
    requests.push({payload,finish:()=>{disk=payload;active--;response.resolve({ok:true,json:async()=>({saved:true,fileName:'same.json',name:payload.project.name})});}});return response.promise;
  };
  store.getState().setProject(fixture());const sessionId=store.getState().projectSessionId, oldSnapshot=store.getState().project;
  const first=client.saveLocalProject(oldSnapshot).then(result=>store.getState().completeProjectSave(oldSnapshot,sessionId,result.fileName,result.name));await tick();
  store.getState().setPoints(oldSnapshot.points.map((p,i)=>i===0?{...p,x:7}:p));const latest=store.getState().project;
  const second=client.saveLocalProject(latest).then(result=>store.getState().completeProjectSave(latest,sessionId,result.fileName,result.name));await tick();
  assert.equal(requests.length,1,'Second write must not reach transport before first acknowledges');requests[0].finish();await first;await tick();assert.equal(requests.length,2);
  assert.equal(disk.points[0].x,0);assert.notEqual(store.getState().savedProjectSignature,load('frontend/src/utils/projectSaveState.ts').projectSaveSignature(store.getState().project));
  requests[1].finish();await second;assert.equal(maxActive,1);assert.equal(disk.points[0].x,7);
  assert.equal(store.getState().savedProjectSignature,load('frontend/src/utils/projectSaveState.ts').projectSaveSignature(store.getState().project));
  console.log('PASS PN-003: real API transport serializes actual snapshots; dirty stays true until the final file equals the current project.');
})().catch(error=>{console.error(error);process.exitCode=1;});
