/* Execute the real store, transition coordinator and async UI handlers. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '../..');
const ts = require(path.join(root, 'frontend/node_modules/typescript'));
const cache = new Map();
const api = {getUserConfig:async()=>({}), saveUserConfig:async()=>({})};
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
  mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,file);
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
      needsSaveNamePrompt:()=>false,saveLocalProject:()=>response.promise,
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
    api.saveLocalProject=async p=>{savedProject=p;return{saved:true,fileName:'A.json',name:'A'};};
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
  cleanup.forEach(fn=>fn?.());
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
  console.log('PASS: real App and Canvas shortcuts defer to dialogs and editable text; StartupScreen captures file input before await.');
})().catch(error=>{console.error(error);process.exitCode=1;});
