/* Run the actual Vite worker bundles in separate Node worker threads. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {Worker}=require('node:worker_threads');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'../..');
const XLSX=require(path.join(root,'frontend/node_modules/xlsx'));
const ts=require(path.join(root,'frontend/node_modules/typescript'));
const taskSource=ts.transpileModule(fs.readFileSync(path.join(root,'frontend/src/utils/workerTask.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const mod={exports:{}};new Function('exports','module',taskSource)(mod.exports,mod);
const {workerTask}=mod.exports;
async function worker(kind){
  const asset=fs.readdirSync(path.join(root,'frontend/dist/assets')).find(name=>name.startsWith(kind+'.worker-')&&name.endsWith('.js'));
  assert.ok(asset,`${kind} production worker exists`);
  const url=pathToFileURL(path.join(root,'frontend/dist/assets',asset)).href;
  const node=new Worker(`const {parentPort}=require('node:worker_threads');globalThis.self=globalThis;globalThis.postMessage=data=>parentPort.postMessage(data);import(${JSON.stringify(url)}).then(()=>{parentPort.on('message',data=>self.onmessage({data}));parentPort.postMessage({ready:true});}).catch(error=>{throw error;});`,{eval:true});
  await new Promise((resolve,reject)=>{node.once('error',reject);node.once('message',data=>data.ready?resolve():reject(new Error('Worker failed startup')));});
  const adapter={postMessage:data=>node.postMessage(data),terminate:()=>node.terminate(),onmessage:null,onerror:null};
  node.on('message',data=>adapter.onmessage?.({data}));node.on('error',error=>adapter.onerror?.({message:error.message,preventDefault(){}}));
  return adapter;
}
(async()=>{
  assert.equal(XLSX.version,'0.20.3');
  for(const bookType of ['xlsx','xls']){
    const book=XLSX.utils.book_new();const sheet=XLSX.utils.aoa_to_sheet([['X','Y','Номер'],[1234.56789,2345.67891,'Свая-001'],[110,220,'P-002']]);
    sheet.A2.z='0.00';sheet.B2.z='0.00';XLSX.utils.book_append_sheet(book,sheet,'Сваи');
    const buffer=XLSX.write(book,{type:'buffer',bookType});
    const result=await workerTask(await worker('excel'),buffer);
    assert.equal(result.sheetName,'Сваи');assert.deepEqual(result.rows[1],['1234.56789','2345.67891','Свая-001']);assert.equal(result.rows.length,3);
  }
  await assert.rejects(workerTask(await worker('excel'),Buffer.from('not a workbook')),/колонок|пуст|строк|Excel|sheet|Unsupported|No data/i);
  let heartbeats=0;const pulse=setInterval(()=>heartbeats++,2),controller=new AbortController();
  const running=workerTask(await worker('cluster'),{points:Array.from({length:5000},(_,i)=>({id:String(i),x:i%100,y:Math.floor(i/100),locked:false,manualNumber:false,syncState:'added'})),factor:1},controller.signal,30000);
  setTimeout(()=>controller.abort(),30);
  await assert.rejects(running,error=>error.name==='AbortError');clearInterval(pulse);assert.ok(heartbeats>=2);
  const originalPoints=[{id:'a',x:0,y:0},{id:'b',x:100,y:0},{id:'c',x:10000,y:0}];
  const clusters=await workerTask(await worker('cluster'),{points:originalPoints,factor:1});assert.equal(new Set(clusters.flat()).size,3);
  const hanging={postMessage(){},terminate(){this.terminated=true;}};
  await assert.rejects(workerTask(hanging,{},undefined,5),/время/);assert.equal(hanging.terminated,true);
  console.log('PASS PN-055/058: actual worker bundles, XLS/XLSX/Cyrillic, malformed input, main-thread heartbeat, active cancellation and timeout termination.');
})().catch(error=>{console.error(error);process.exitCode=1;});
