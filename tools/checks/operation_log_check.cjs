const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const ts = require(path.join(root, 'frontend/node_modules/typescript'));
function load(relative, context) {
  let source = fs.readFileSync(path.join(root, relative), 'utf8').replace('import.meta.env.VITE_API_BASE', "'http://test'");
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, ...context });
  return exports;
}
const tick = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  let now = 0;
  const runtime = { performance: { now: () => now }, Date, console };
  const utils = load('frontend/src/utils/operationLog.ts', runtime);
  assert.equal(utils.formatDuration(4.25), '4,3 с');
  assert.equal(utils.formatDuration(125), '2 мин 5 с');
  assert.equal(utils.formatDuration(3661), '1 ч 1 мин 1 с');
  const states = [];
  await utils.runFileOperation('import', async () => { now = 2500; return 'Прочитано 5 точек'; }, state => states.push(state));
  assert.equal(states.at(-1).clientElapsedSeconds, 2.5);
  const completed = states.at(-1);
  now = 100000;
  assert.equal(completed.clientElapsedSeconds, 2.5, 'Completed duration must not grow');
  await assert.rejects(utils.runFileOperation('export', async () => { now += 1000; throw new Error('disk full'); }, state => states.push(state)));
  assert.equal(states.at(-1).status, 'failed');
  assert.equal(states.at(-1).clientElapsedSeconds, 1);
  assert.match(utils.formatOperationLog(states.at(-1), 'Ошибка сохранения'), /disk full/);

  async function scenario(responses) {
    const events = [];
    const window = { dispatchEvent: event => events.push(event.detail), setTimeout: callback => queueMicrotask(callback) };
    const client = load('frontend/src/api/client.ts', { ...runtime, window, CustomEvent: class { constructor(name, options) { this.detail = options.detail; } },
      fetch: async () => {
        now += 500;
        const response = responses.shift();
        if (response instanceof Error) throw response;
        if (!response) throw new Error('Unexpected request');
        return { ok: true, json: async () => response };
      },
    });
    let failure;
    try { await client.scanNanoCadBlocks(); } catch (error) { failure = error; }
    return { events, failure };
  }
  let run = await scenario([{ id: 'scan-one' }, { id: 'scan-one', status: 'completed', phase: 'Готово', completed: 10, total: 10, elapsedSeconds: 0.2, result: { blocks: [] } }]);
  assert.equal(run.failure, undefined);
  assert.equal(run.events.at(-1).clientElapsedSeconds, 1);
  assert.equal(run.events.at(-1).kind, 'blocks/scan');
  run = await scenario([{ id: 'scan-two' }, ...Array.from({ length: 5 }, () => new Error('connection lost'))]);
  assert.ok(run.failure);
  const failed = run.events.at(-1);
  assert.equal(failed.id, 'scan-two', 'Keep job ID even when the first status request fails');
  assert.equal(failed.status, 'failed');
  assert.ok(failed.clientElapsedSeconds > 0);
  assert.match(failed.clientLog.join('\n'), /connection lost/);
  const text = utils.formatOperationLog(failed, 'Не удалось получить статус', { id: 'scan-two', kind: 'blocks/scan', droppedEntries: 2,
    entries: [{ timestamp: 1, elapsedSeconds: 0.5, level: 'ERROR', event: 'cad_failed', details: 'RPC unavailable' }] });
  assert.match(text, /scan-two/);
  assert.match(text, /RPC unavailable/);
  assert.match(text, /Пропущено ранних записей: 2/);
  run = await scenario([new Error('server offline')]);
  assert.equal(run.events.at(-1).status, 'failed');
  assert.match(utils.formatOperationLog(run.events.at(-1), ''), /server offline/);

  let copied = false, removed = false, restored = false;
  const fallback = load('frontend/src/utils/operationLog.ts', { ...runtime,
    navigator: { clipboard: { writeText: async () => { throw new Error('denied'); } } },
    document: { activeElement: { focus: () => { restored = true; } }, body: { appendChild() {} },
      createElement: () => ({ style: {}, focus() {}, select() {}, remove: () => { removed = true; } }),
      execCommand: command => { copied = command === 'copy'; return true; },
    },
  });
  await fallback.copyOperationText(text);
  assert.ok(copied && removed && restored, 'Clipboard denial must fall back and restore focus');
  await tick();
  console.log('PASS: operation durations, logs, network failures, file errors and clipboard fallback.');
})().catch(error => { console.error(error); process.exitCode = 1; });
