/* Execute the real store, transition coordinator and async UI handlers. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '../..');
const ts = require(path.join(root, 'frontend/node_modules/typescript'));
const cache = new Map();
const api = {getUserConfig:async()=>({}), saveUserConfig:async()=>({}), queueUserConfigPatch() {}, flushUserConfig:async()=>({}), peekUserConfig:()=>({})};
let hooks = [], cursor = 0, effects = [];
const react = {
  useState(initial) {
    const i = cursor++;
    if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial;
    return [hooks[i], value => {hooks[i] = typeof value === 'function' ? value(hooks[i]) : value;}];
  },
  useRef(initial) {const i=cursor++; return hooks[i] ?? (hooks[i]={current:initial});},
  useEffect(fn) {const i=cursor++; if (!(i in hooks)) {hooks[i]=true; effects.push(fn);}},
};
const jsx = (type, props) => ({type,props:props||{}});
function load(relative) {
  const file=path.resolve(root,relative);
  if (cache.has(file)) return cache.get(file).exports;
  const mod=new Module(file,module); mod.filename=file; mod.paths=Module._nodeModulePaths(path.dirname(file));
  const native=mod.require.bind(mod);
  mod.require=name=>{
    if(name==='react') return react;
    if(name==='react/jsx-runtime') return {jsx,jsxs:jsx};
    if(name.endsWith('/api/client')) return api;
    if(name.endsWith('.json')) return native(name);
    if(name.startsWith('.')) {
      const base=path.resolve(path.dirname(file),name);
      return load(fs.existsSync(base+'.ts')?base+'.ts':base+'.tsx');
    }
    return native(name);
  };
  cache.set(file,mod);
  const source=fs.readFileSync(file,'utf8').replaceAll('import.meta.env','({DEV:false})');
  mod._compile(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,file);
  return mod.exports;
}
global.window=Object.assign(new EventTarget(),{localStorage:{getItem:()=>null,setItem(){}},requestAnimationFrame:()=>0,cancelAnimationFrame(){}});
global.requestAnimationFrame=fn=>fn();
const {useProjectStore:store}=load('frontend/src/store/useProjectStore.ts');
const {createEmptyProject}=load('frontend/src/types/project.ts');
const {projectSaveSignature}=load('frontend/src/utils/projectSaveState.ts');
const session=load('frontend/src/utils/projectSession.ts');
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const point=(id,x=0)=>({id,x,y:0,groupId:null,number:null,sourceNumber:null,locked:false,manualNumber:false,syncState:'added'});
function project(name){const p=createEmptyProject();p.project.name=name;p.points=[point(name)];return p;}
function open(p){store.getState().openProjectFromFile(p,p.project.name+'.pilenum.json');}
function dirty(){return projectSaveSignature(store.getState().project)!==store.getState().savedProjectSignature;}
function handler(file,name,deps,index=0){
  deps={queueProjectSave:load('frontend/src/utils/projectSaves.ts').queueProjectSave,...deps};
  const source=ts.createSourceFile(file,fs.readFileSync(path.join(root,file),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const matches=[];
  function visit(node){if(ts.isVariableDeclaration(node)&&node.name.getText(source)===name)matches.push(node.initializer.getText(source));ts.forEachChild(node,visit);}
  visit(source);const initializer=matches[index];assert.ok(initializer,`handler ${name} exists`);
  const code=ts.transpileModule(`return (${initializer});`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  return new Function(...Object.keys(deps),code)(...Object.values(deps));
}
const toolbar='frontend/src/components/Toolbar.tsx';
function nodes(node){if(!node||typeof node!=='object')return[];if(Array.isArray(node))return node.flatMap(nodes);return[node,...nodes(node.props?.children)];}
function text(node){if(typeof node==='string')return node;if(Array.isArray(node))return node.map(text).join('');return node&&typeof node==='object'?text(node.props?.children):'';}

(async()=>{
  const a=project('A'),b=project('B');
  open(a);store.getState().setPoints([point('A',5)]);store.getState().undo();
  assert.equal(store.getState().redoStack.length,1);
  store.setState({vectorPathDraft:[{x:1,y:2}],numberingLinkFromId:'A'});
  open(b);store.getState().undo();store.getState().redo();
  assert.equal(store.getState().project.project.id,b.project.id);
  assert.equal(store.getState().history.length,0);assert.equal(store.getState().redoStack.length,0);
  assert.deepEqual(store.getState().vectorPathDraft,[]);assert.equal(store.getState().numberingLinkFromId,null);
  assert.equal(Object.keys(store.getState().journalSnapshots).length,1);

  open(a);const old=session.captureProjectContext();const snapshot=store.getState().project;
  open(a);assert.notEqual(old.sessionId,store.getState().projectSessionId);
  assert.throws(()=>session.assertProjectContext(old),/Проект изменился/);
  assert.equal(store.getState().completeProjectSave(snapshot,old.sessionId,'wrong.json','wrong'),false);
  const current=session.captureProjectContext();const saved=store.getState().project;
  store.getState().setProjectName('renamed');
  assert.ok(store.getState().completeProjectSave(saved,current.sessionId,'A.json','A'));
  assert.equal(store.getState().project.project.name,'renamed');assert.ok(dirty());

  open(a);const slow=defer(),fast=defer();
  const first=session.openProjectSafely(()=>slow.promise);
  const second=session.openProjectSafely(()=>fast.promise);
  fast.resolve({project:b,fileName:'B.json'});assert.equal(await second,true);
  store.getState().setPoints([point('B',9)]);
  slow.resolve({project:a,fileName:'A.json'});assert.equal(await first,false);
  assert.equal(store.getState().project.points[0].x,9);
  open(a);const waiting=defer();const pending=session.openProjectSafely(()=>waiting.promise);
  store.getState().setPoints([point('A',7)]);waiting.resolve({project:b,fileName:'B.json'});
  await assert.rejects(pending,/Проект изменился/);assert.equal(store.getState().project.points[0].x,7);

  for(const action of ['rename','switch']){
    open(a);const response=defer();let statuses=[];
    const save=handler(toolbar,'saveProjectToLocalFolder',{
      ...session,useProjectStore:store,project:store.getState().project,
      needsSaveNamePrompt:()=>false,saveLocalProject:async(_,ack)=>{const result=await response.promise;ack(result);return result;},
      recordOperation:(...args)=>store.getState().recordOperation(...args),
      refreshLocalProjects:async()=>{},setProjectStatus:value=>statuses.push(value),
    });
    const saving=save();
    if(action==='rename')store.getState().setProjectName('new name');else open(b);
    response.resolve({saved:true,fileName:'A.json',name:'A'});await saving;
    assert.equal(store.getState().project.project.name,action==='rename'?'new name':'B');
    if(action==='rename')assert.ok(dirty());else assert.deepEqual(statuses,[]);
  }

  open(a);const csv=defer();let importStatus='';let csvCalls=0;
  const importFile=handler(toolbar,'confirmImportFromFile',{
    ...session,importPreview:{fileName:'points.csv',sourceKind:'csv'},importPreviewContext:{current:session.captureProjectContext()},
    importXColumn:'0',importYColumn:'1',importNumberColumn:'',importUseBasePoint:false,
    importBaseX:'0',importBaseY:'0',parseImportNumber:Number,
    runFileOperation:async(_,fn)=>fn(),makeNormalizedCsvFile:()=>({}),
    importCsv:()=>{csvCalls++;return csv.promise;},appendImportedPoints:(...args)=>store.getState().appendImportedPoints(...args),
    setImportStatus:value=>{importStatus=value;},setProjectStatus(){},setImportPreview(){},setFileImportProgress(){},
    zoomExtents(){},canvasWidth:800,canvasHeight:600,
  });
  const importing=importFile();open(b);csv.resolve([point('foreign')]);await importing;
  assert.equal(csvCalls,1);assert.match(importStatus,/Проект изменился/);
  assert.deepEqual(store.getState().project.points.map(p=>p.id),['B']);
  for(const mode of ['blocks','model_studio']){
    open(a);const response=defer();let calls=0,status='';
    const cad=handler(toolbar,'confirmNanoCadBlockImport',{
      ...session,scanReady:()=>true,beginCad(){},nanoCadMode:mode,
      importUseBasePoint:false,importBaseX:'0',importBaseY:'0',parseImportNumber:Number,
      selectedModelStudioObjectNamesForRequest:()=>['Pile'],modelStudioNumberParameterForObject:()=> 'NUMBER',
      nanoCadSelectedBlock:'Pile',nanoCadNumberAttribute:'NUMBER',nanoCadModelNumberParameter:'NUMBER',
      scanScope:'all',nanoCadModelScanId:'scan',nanoCadBlockScanId:'scan',preserveHandles:true,overwriteImportedNumbers:false,
      importNanoCadBlocks:()=>{calls++;return response.promise;},
      importNanoCadModelStudioObjects:()=>{calls++;return response.promise;},
      syncCadImportedPoints:(...args)=>store.getState().syncCadImportedPoints(...args),
      setNanoCadStatus:value=>{status=value;},setTransferTab(){},setScanStatus(){},
      setOverwriteImportedNumbers(){},setProjectStatus(){},zoomExtents(){},canvasWidth:800,canvasHeight:600,
    });
    const importing=cad();open(b);response.resolve(mode==='blocks'?[point('foreign')]:{points:[point('foreign')]});await importing;
    assert.equal(calls,1);assert.match(status,/Проект изменился/);
    assert.deepEqual(store.getState().project.points.map(p=>p.id),['B']);
  }

  // Exercise the actual Save / Discard / Cancel UI against a real dirty store.
  const {CloseProjectGuard}=load('frontend/src/components/CloseProjectGuard.tsx');
  hooks=[];effects=[];cursor=0;CloseProjectGuard();const cleanup=effects.map(effect=>effect());
  function render(){cursor=0;return CloseProjectGuard();}
  function click(label){const matches=nodes(render()).filter(n=>n.type==='button'&&text(n)===label);assert.equal(matches.length,1);return matches[0].props.onClick();}
  for(const decision of ['Отмена','Не сохранять','Сохранить']){
    open(a);store.getState().setPoints([point('A',5)]);let savedProject;
    api.saveLocalProject=async (p,ack)=>{savedProject=p;const result={saved:true,fileName:'A.json',name:'A'};ack(result);return result;};
    const changing=session.openProjectSafely(async()=>({project:b,fileName:'B.json'}));await tick();
    assert.match(text(render()),/Сохранить изменения перед сменой проекта/);
    await click(decision);assert.equal(await changing,decision!=='Отмена');
    assert.equal(store.getState().project.project.id,decision==='Отмена'?a.project.id:b.project.id);
    if(decision==='Сохранить')assert.equal(savedProject.points[0].x,5);
  }
  open(a);store.getState().setPoints([point('A',11)]);
  api.saveLocalProject=async()=>{throw new Error('disk full');};
  const failed=session.openProjectSafely(async()=>({project:b,fileName:'B.json'}));await tick();
  await click('Сохранить');assert.match(text(render()),/disk full/);
  await click('Отмена');assert.equal(await failed,false);assert.equal(store.getState().project.points[0].x,11);

  const fileName = 'A.pilenum.json';
  const {queueProjectSave} = load('frontend/src/utils/projectSaves.ts');
  for (const source of ['local', 'native']) {
    open(a);
    store.getState().setPoints([point('A',7)]);
    let disk = structuredClone(a);
    const order = [];
    api.saveLocalProject = async (value, acknowledge) => {
      order.push('save');
      disk = structuredClone(value);
      const result = {saved:true, fileName, name:'A'};
      acknowledge(result);
      return result;
    };
    let reopen;
    if (source === 'local') {
      reopen = handler(toolbar, 'openLocal', {
        openProjectSafely:session.openProjectSafely, setProjectStatus(){},
        openLocalProject:async name => {
          assert.equal(name, fileName);
          order.push('read');
          return structuredClone(disk);
        },
      });
    } else {
      window.pywebview = {api:{
        selectProjectJson:async () => { order.push('pick'); return {selectionId:'selected-file'}; },
        saveProjectJson:async (_name, content) => { order.push('save'); disk=JSON.parse(content); return {saved:true}; },
        readProjectJson:async id => {
          assert.equal(id, 'selected-file');
          order.push('read');
          return {fileName, content:JSON.stringify(disk)};
        },
      }};
      reopen = handler(toolbar, 'openProjectCommand', {
        openProjectFromPickerSafely:session.openProjectFromPickerSafely,
        openProjectInputRef:{current:null}, setProjectStatus(){},
      });
    }
    const reopening = reopen(fileName);
    await tick();
    assert.match(text(render()), /Сохранить изменения перед сменой проекта/);
    assert.deepEqual(order, source === 'native' ? ['pick'] : []);
    await click('Сохранить');
    await reopening;
    assert.deepEqual(order, source === 'native' ? ['pick','save','read'] : ['save','read']);
    assert.equal(disk.points[0].x, 7);
    assert.equal(store.getState().project.points[0].x, 7);
    assert.equal(dirty(), false);
    delete window.pywebview;
  }
  console.log('PASS R16: reopening a local or native file reads after Save, retaining X=7 and a clean working project.');

  for (const action of ['open', 'create']) {
    open(a);
    store.getState().setPoints([point('A',1)]);
    const earlier = store.getState().project;
    const sessionId = store.getState().projectSessionId;
    const allowWrite = defer();
    let disk = structuredClone(a);
    const saving = queueProjectSave(a.project.id, async () => {
      await allowWrite.promise;
      disk = structuredClone(earlier);
      store.getState().completeProjectSave(earlier, sessionId, fileName, 'A');
    });
    store.getState().undo();
    assert.equal(dirty(), false);
    let loaded = false;
    api.saveLocalProject = async (value, acknowledge) => {
      disk = structuredClone(value);
      const result = {saved:true, fileName, name:'A'};
      acknowledge(result);
      return result;
    };
    const openOther = handler(toolbar, 'openLocal', {
      openProjectSafely:session.openProjectSafely, setProjectStatus(){},
      openLocalProject:async () => { loaded = true; return b; },
    });
    const create = handler(toolbar, 'createProjectFromDialog', {
      createProjectName:'Fresh', runProjectTransition:session.runProjectTransition,
      createNewProject:name=>store.getState().createNewProject(name),
      setCreateProjectOpen(){}, setProjectsOpen(){}, setProjectStatus(){},
    });
    const transition = action === 'open' ? openOther('B.pilenum.json') : create();
    await tick();
    assert.equal(loaded, false);
    assert.equal(store.getState().project.project.id, a.project.id);
    assert.equal(render(), null, 'Wait for the pending save before checking dirty state');
    allowWrite.resolve();
    await saving;
    await tick();
    assert.equal(disk.points[0].x, 1);
    assert.ok(dirty());
    assert.match(text(render()), /Сохранить изменения перед сменой проекта/);
    await click('Сохранить');
    await transition;
    assert.equal(disk.points[0].x, 0);
    assert.equal(store.getState().project.project.name, action === 'open' ? 'B' : 'Fresh');
  }
  console.log('PASS R17: Open and New wait for a delayed write and ask to save the undone revision.');
  cleanup.forEach(fn=>fn?.());

  const {makeNormalizedCsvFile, parseImportNumber} = load('frontend/src/utils/tabularImport.ts');
  for (const x of ['1000', '1_000', '١٠٠٠']) {
    open(a);
    const previous = store.getState();
    let sent, status;
    const importWithBase = handler(toolbar, 'confirmImportFromFile', {
      ...session, importPreview:{fileName:'offset.csv', sourceKind:'csv', hasHeader:true,
        columns:['X','Y','Number'], rows:[[x,'20','P1']]}, importPreviewContext:{current:session.captureProjectContext()},
      importXColumn:'0', importYColumn:'1', importNumberColumn:'2', importUseBasePoint:true,
      importBaseX:'10', importBaseY:'5', parseImportNumber, makeNormalizedCsvFile, runFileOperation:async (_, fn)=>fn(),
      importCsv:async file => { sent = await file.text(); return [point('offset',990)]; },
      appendImportedPoints:(...args)=>store.getState().appendImportedPoints(...args),
      setImportStatus:value=>{ status=value; }, setProjectStatus(){}, setImportPreview(){}, setFileImportProgress(){},
      zoomExtents(){}, canvasWidth:800, canvasHeight:600,
    });
    await importWithBase();
    if (x === '1000') {
      assert.equal(sent, 'X,Y,Number\n990,15,P1');
      assert.equal(store.getState().project.points.length, 2);
    } else {
      assert.equal(sent, undefined);
      assert.match(status, /Строка 2, координата X/);
      assert.equal(store.getState().project, previous.project);
      assert.equal(store.getState().history, previous.history);
    }
  }
  console.log('PASS R18: both coordinates are validated before the import request and an invalid row leaves state and history intact.');

  const client=load('frontend/src/api/client.ts');
  const closeRequested=()=>window.dispatchEvent(new Event('pile-numbering:close-requested'));
  const mountCloseGuard=()=>{hooks=[];effects=[];cursor=0;CloseProjectGuard();return effects.map(effect=>effect());};
  for(const initiallyClean of [false,true]) {
    open(a);store.getState().setPoints([point('A',1)]);
    const activeSave=defer(), writes=[];
    let closed=false, nativeSaveStarted=false;
    global.fetch=async (url,init)=>{
      if(url==='/api/session') return {ok:true,json:async()=>({token:'fixture-token'})};
      assert.equal(url,'/api/projects/local/save');
      const snapshot=JSON.parse(init.body);
      await activeSave.promise;
      writes.push(snapshot.points[0].x);
      return {ok:true,json:async()=>({saved:true,fileName:'A.json',name:'A'})};
    };
    const snapshot=store.getState().project, sid=store.getState().projectSessionId;
    const saving=client.saveLocalProject(snapshot, result=>store.getState().completeProjectSave(snapshot,sid,result.fileName,result.name));
    await tick();
    if(initiallyClean) store.getState().undo(); else store.getState().setPoints([point('A',7)]);
    assert.equal(dirty(),!initiallyClean);
    window.pywebview={api:{
      saveProjectJson:async(_name,data)=>{nativeSaveStarted=true;writes.push(JSON.parse(data).points[0].x);return {saved:true};},
      closeConfirmed:async()=>{assert.equal(dirty(),false);closed=true;}
    }};
    const unmount=mountCloseGuard();
    closeRequested();await tick();
    if(!initiallyClean) void click('Сохранить');
    await tick();assert.equal(nativeSaveStarted,false);assert.equal(closed,false);
    activeSave.resolve();await saving;await tick();
    if(initiallyClean) {
      assert.deepEqual(writes,[1]);assert.equal(closed,false);assert.ok(dirty());
      assert.match(text(render()),/Проект изменился во время закрытия/);
    } else {
      assert.deepEqual(writes,[1,7]);assert.equal(closed,true);
    }
    unmount.forEach(fn=>fn?.());
  }
  open(a);
  let canceledPreparation=0;
  const preparing=defer();
  window.pywebview={api:{prepareClose:()=>preparing.promise,cancelClose:async()=>{canceledPreparation++;},
    closeConfirmed:async()=>{assert.fail('A newly edited project cannot close after CAD preparation');}}};
  const unmount=mountCloseGuard();
  closeRequested();await tick();store.getState().setPoints([point('A',17)]);preparing.resolve();await tick();
  assert.equal(canceledPreparation,1);
  assert.match(text(render()),/Проект изменился во время закрытия/);
  unmount.forEach(fn=>fn?.());delete window.pywebview;
  console.log('PASS R01: delayed HTTP write, native save and receipt run in order; clean/dirty state rechecked after waiting.');

  open(a);const input={value:'selected',files:[{name:'B.json',text:async()=>JSON.stringify(b)}]};
  let ready=0;
  const browserOpen=handler('frontend/src/components/StartupScreen.tsx','openBrowserFile',{
    openProjectSafely:session.openProjectSafely,onReady:()=>{ready++;},setError:message=>{throw new Error(message);},
  });
  const event={currentTarget:input};const opening=browserOpen(event);event.currentTarget=null;
  await opening;assert.equal(input.value,'');assert.equal(ready,1);
  assert.equal(store.getState().project.project.id,b.project.id);
  let modal=false;
  global.document={querySelector:()=>modal?{}:null};
  global.HTMLElement=class {constructor(selector='canvas'){this.selector=selector;}closest(selectors){return selectors.includes(this.selector)?this:null;}};
  const {workspaceKeyboardBlocked}=load('frontend/src/utils/workspaceKeyboard.ts');
  const keyboardCases=[
    ['frontend/src/App.tsx',0,'Delete','Delete'],
    ['frontend/src/components/CanvasView.tsx',0,'Enter','Enter'],
    ['frontend/src/components/CanvasView.tsx',1,'z','KeyZ'],
    ['frontend/src/components/CanvasView.tsx',2,'Backspace','Backspace'],
  ];
  for(const [file,index,key,code] of keyboardCases){
    for(const target of ['modal','input','textarea','select','[contenteditable="true"]','[role="textbox"]','canvas']){
      modal=target==='modal';let mutations=0;
      const act=()=>{mutations++;};
      const deps={workspaceKeyboardBlocked,vectorPathDrawMode:false,vectorPathEditMode:false,
        vectorExtendState:null,vectorSelectedIndex:1,vectorSelectedSegmentIndex:null,selectedGroupId:'g',
        project:{groups:[{id:'g'}]},selectedPointIds:['point'],
        consume:event=>{event.preventDefault();},
      };
      for(const name of ['undo','redo','deleteSelectedPoints','cancelNumberingPreview','setSelection',
        'cancelGroupOutlineDrawing','closeGroupOutlineDrawing','setVectorPointerDown',
        'undoLastVectorPathDraftPoint','cancelVectorPathDrawing','finishVectorPathDrawing',
        'undoVectorExtensionPoint','finishVectorExtension','cancelVectorExtension',
        'cancelVectorPathEdit','deleteVectorPathPoint','setVectorSelectedIndex','setVectorSelectedSegmentIndex'])deps[name]=act;
      deps.deleteSelectedNumberingManualLink=()=>{mutations++;return false;};
      const onKeyDown=handler(file,'onKeyDown',deps,index);
      const event={key,code,ctrlKey:code==='KeyZ',metaKey:false,shiftKey:false,defaultPrevented:false,
        target:new HTMLElement(target),preventDefault(){this.defaultPrevented=true;},stopPropagation(){},stopImmediatePropagation(){}};
      onKeyDown(event);
      assert.equal(mutations>0,target==='canvas',`${file} ${key}: keyboard owner ${target}`);
      assert.equal(event.defaultPrevented,target==='canvas');
    }
  }
  console.log('PASS: session histories, stale saves/opens, CSV and both CAD imports, Save/Discard/Cancel and failed-save preservation.');
  const canvasFile='frontend/src/components/CanvasView.tsx';
  const canvasSource=ts.createSourceFile(canvasFile,fs.readFileSync(path.join(root,canvasFile),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let captureText;
  function findCapture(node){if(ts.isJsxAttribute(node)&&node.name.text==='onKeyDownCapture')captureText=node.initializer.expression.getText(canvasSource);ts.forEachChild(node,findCapture);}findCapture(canvasSource);
  assert.ok(captureText);
  for(const key of ['z','Enter','Escape'])for(const target of ['input','canvas']){
    modal=false;let mutations=0;
    const mutate=()=>mutations++;
    const deps={workspaceKeyboardBlocked,groupOutlineDrawMode:false,vectorPathDrawMode:true,vectorPathEditMode:false,
      undoLastVectorPathDraftPoint:mutate,finishVectorPathDrawing:mutate,cancelVectorPathDrawing:mutate};
    const capture=new Function(...Object.keys(deps),ts.transpileModule(`return (${captureText});`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText)(...Object.values(deps));
    const event={key,code:key==='z'?'KeyZ':key,ctrlKey:key==='z',metaKey:false,target:new HTMLElement(target),defaultPrevented:false,
      preventDefault(){this.defaultPrevented=true;},stopPropagation(){}};
    event.nativeEvent=event;capture(event);
    assert.equal(mutations,target==='canvas'?1:0,`Canvas capture ${key} in ${target}`);
    assert.equal(event.defaultPrevented,target==='canvas');
  }
  console.log('PASS: real App/Canvas shortcuts and Canvas capture defer to dialogs/editors; StartupScreen captures file input before await.');
})().catch(error=>{console.error(error);process.exitCode=1;});
