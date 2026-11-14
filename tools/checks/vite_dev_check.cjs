/* PN-073: real dev server, disposable harmless files; no editor or SMB calls. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'../..');

(async()=>{
  const vite=await import(pathToFileURL(path.join(root,'frontend/node_modules/vite/dist/node/index.js')).href);
  // Hosted Windows TEMP can itself use an 8.3 alias. Probe the readable
  // canonical file path, as Vite normalizes its root to the long spelling.
  const tempRoot=fs.realpathSync.native(os.tmpdir());
  const fixture=fs.realpathSync.native(fs.mkdtempSync(path.join(tempRoot,'pilenum-vite-fixture-')));
  let server;
  try {
    const marker='SYNTHETIC_PILE_FIXTURE_NO_SECRET';
    fs.writeFileSync(path.join(fixture,'index.html'),'<html><body>pile-dev-control</body></html>');
    fs.writeFileSync(path.join(fixture,'.env.review'),marker);
    // POSIX has no NTFS streams: create a harmless literal colon-name control
    // so the same raw request exercises a readable denied file there too.
    if(process.platform!=='win32')fs.writeFileSync(path.join(fixture,'.env.review::$DATA'),marker);
    fs.writeFileSync(path.join(fixture,'public.txt'),'pile-raw-control');
    server=await vite.createServer({configFile:path.join(root,'frontend/vite.config.ts'),configLoader:'runner',cacheDir:path.join(fixture,'.vite'),root:fixture,logLevel:'silent',server:{port:0}});
    await server.listen();
    const address=server.httpServer.address();assert.equal(address.address,'127.0.0.1');
    const base=`http://127.0.0.1:${address.port}`;
    const ordinary=await fetch(base+'/');assert.equal(ordinary.status,200);assert.match(await ordinary.text(),/pile-dev-control/);
    const rawControl=await fetch(base+'/public.txt?raw');assert.equal(rawControl.status,200);assert.match(await rawControl.text(),/pile-raw-control/);
    const fsRoute='/@fs/'+vite.normalizePath(path.join(fixture,'.env.review::$DATA'))+'?raw';
    for(const route of ['/.env.review?raw','/.env.review::$DATA?raw','/.env.review:$DATA?raw',fsRoute]) {
      const response=await fetch(base+route),body=await response.text();
      assert.ok(!body.includes(marker),`${route} must never disclose the fixture`);
      // :$DATA is an absent named stream, rather than the default ::$DATA.
      // Vite may serve its ordinary SPA fallback when that stream is absent.
      if (route.includes('.review:$DATA')) {
        assert.ok(response.status>=400 || (response.status===200 && body.includes('pile-dev-control')));
      } else assert.ok(response.status>=400,`${route} must be denied`);
    }
    assert.equal(vite.isFileLoadingAllowed(server.config,vite.normalizePath(path.join(fixture,'.env.review'))),false);
    assert.equal(vite.isFileLoadingAllowed(server.config,vite.normalizePath(path.join(fixture,'.env.review::$DATA'))),false);
    console.log(`PASS PN-073: Vite ${vite.version}, actual loopback listener/dev control and denied ordinary/NTFS alternate .env fixture (${process.platform}); no real secret/editor/UNC access.`);
  } finally {
    if(server)await server.close();
    const resolved=path.resolve(fixture);
    assert.equal(path.dirname(resolved),path.resolve(tempRoot));
    assert.ok(path.basename(resolved).startsWith('pilenum-vite-fixture-'));
    fs.rmSync(resolved,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
