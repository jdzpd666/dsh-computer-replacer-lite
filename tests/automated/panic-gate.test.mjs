// Panic button (§7.5) automated tests: latch state machine, persistence,
// hotkey-exit arming, kill chain, exit-code classification and the three
// client routes. The real-worker hotkey path stays in scripts/verify-panic.mjs;
// these tests simulate children and supervisors at the seams the production
// code exposes (spawnArguments override, fake supervisor duck typing).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PanicGate, sharedPanicLatch } from '../../dist/panic-gate.js';
import { Supervisor, isPanicExit, PANIC_EXIT_CODE } from '../../dist/worker/supervisor.js';
import { apply, TOOL_NAMES } from '../../dist/index.js';

const tempRoot = mkdtempSync(join(tmpdir(), 'replacer-panic-gate-'));
process.env.REPLACER_RUNTIME_DIR = tempRoot;

const runtimeFile = (name) => join(tempRoot, name);
const fakeSupervisor = (extra = {}) => ({ client: { connected: false }, pid: undefined, stop: async () => {}, forceKill: async () => false, ...extra });

test('panic latch: trip is sticky, recover clears, both idempotent', async () => {
  const gate = new PanicGate({ supervisor: fakeSupervisor(), runtimeDir: runtimeFile('latch-a') });
  const first = await gate.trip('button');
  assert.equal(first.latched, true);
  assert.equal(first.source, 'button');
  assert.ok(first.at > 0);
  const again = await gate.trip('button');
  assert.equal(again.latched, true);
  assert.equal(again.at, first.at, 'idempotent trip must not bump the timestamp');
  assert.equal(gate.latchedNow, true);
  const recovered = gate.recover();
  assert.equal(recovered.latched, false);
  assert.equal(recovered.source, undefined);
  const recoveredAgain = gate.recover();
  assert.equal(recoveredAgain.latched, false);
});

test('panic latch emits change on trip and recover only', async () => {
  const gate = new PanicGate({ supervisor: fakeSupervisor(), runtimeDir: runtimeFile('latch-b') });
  const events = [];
  gate.on('change', snapshot => events.push(snapshot.latched));
  await gate.trip('button');
  await gate.trip('button');
  gate.recover();
  gate.recover();
  assert.deepEqual(events, [true, false]);
});

test('panic latch persists atomically and restores on a fresh instance', async () => {
  const dir = runtimeFile('latch-c');
  const gate = new PanicGate({ supervisor: fakeSupervisor(), runtimeDir: dir });
  await gate.trip('button');
  const raw = JSON.parse(readFileSync(join(dir, 'panic-latch.json'), 'utf8'));
  assert.equal(raw.latched, true);
  assert.equal(raw.source, 'button');
  const leftovers = readdirSync(dir).filter(name => name.includes('.tmp-'));
  assert.deepEqual(leftovers, [], 'temp file is renamed, never left behind');
  const restored = new PanicGate({ supervisor: fakeSupervisor(), runtimeDir: dir }).restore();
  assert.equal(restored.latched, true);
  assert.equal(restored.source, 'button');
});

test('panic latch: corrupt state file restores as unlatched (fail-safe)', () => {
  const dir = runtimeFile('latch-d');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'panic-latch.json'), '{latched: true, at: oops', 'utf8');
  const restored = new PanicGate({ supervisor: fakeSupervisor(), runtimeDir: dir }).restore();
  assert.equal(restored.latched, false);
  assert.equal(restored.source, undefined);
});

test('panic latch: recover persists the cleared state', async () => {
  const dir = runtimeFile('latch-e');
  const gate = new PanicGate({ supervisor: fakeSupervisor(), runtimeDir: dir });
  await gate.trip('button');
  gate.recover();
  const raw = JSON.parse(readFileSync(join(dir, 'panic-latch.json'), 'utf8'));
  assert.equal(raw.latched, false);
  assert.equal(new PanicGate({ supervisor: fakeSupervisor(), runtimeDir: dir }).restore().latched, false);
});

test('hotkey path B: worker exit 87 arms the same latch with source hotkey (idempotent)', async () => {
  const gate = new PanicGate({ supervisor: fakeSupervisor(), runtimeDir: runtimeFile('latch-f') });
  await gate.trip('button');
  const snapshot = gate.noteHotkeyExit();
  assert.equal(snapshot.latched, true, 'sticky latch ignores a second entrance while held');
  const other = new PanicGate({ supervisor: fakeSupervisor(), runtimeDir: runtimeFile('latch-g') });
  const armed = other.noteHotkeyExit();
  assert.equal(armed.latched, true);
  assert.equal(armed.source, 'hotkey');
});

test('exit code classification: 87 is panic, 1 (taskkill /F) and null are not', () => {
  assert.equal(PANIC_EXIT_CODE, 87);
  assert.equal(isPanicExit(87), true);
  assert.equal(isPanicExit(1), false);
  assert.equal(isPanicExit(null), false);
  assert.equal(isPanicExit(0), false);
});

test('supervisor: fake child exit 87 emits panic AND crash-restart continues (拍板② no suppression)', async () => {
  class PanicChildSupervisor extends Supervisor { }
  // JS subclass override of the protected test seam (spawnArguments).
  PanicChildSupervisor.prototype.spawnArguments = function () { return ['-e', 'process.exit(87)']; };
  const supervisor = new PanicChildSupervisor(process.execPath, 2);
  const panicCodes = [];
  supervisor.on('panic', code => panicCodes.push(code));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('supervisor never exhausted (diagnostics: none)')), 20000);
    supervisor.on('exhausted', () => { clearTimeout(timer); resolve(); });
    supervisor.on('diagnostic', chunk => { if (String(chunk).includes('EADDRINUSE') || String(chunk).includes('EACCES')) { clearTimeout(timer); reject(new Error(String(chunk))); } });
    supervisor.start();
  });
  await supervisor.stop();
  assert.equal(panicCodes.length, 3, 'every 87 exit arms the panic event: ' + JSON.stringify(panicCodes));
  assert.ok(supervisor.startCount >= 3, 'restart logic ran untouched (starts=' + supervisor.startCount + ')');
});

test('supervisor: fake child exit 1 (taskkill /F strong kill) never emits panic', async () => {
  class StrongKillSupervisor extends Supervisor { }
  StrongKillSupervisor.prototype.spawnArguments = function () { return ['-e', 'process.exit(1)']; };
  const supervisor = new StrongKillSupervisor(process.execPath, 1);
  const panicCodes = [];
  supervisor.on('panic', code => panicCodes.push(code));
  await new Promise((resolve) => {
    supervisor.on('exhausted', resolve);
    supervisor.start();
  });
  await supervisor.stop();
  assert.deepEqual(panicCodes, []);
  assert.ok(supervisor.startCount >= 2);
});

test('kill chain: clean stop wins the race and never force-kills', async () => {
  const forced = [];
  const supervisor = fakeSupervisor({
    pid: 4321,
    stop: async () => {},
    forceKill: async (pid) => { forced.push(pid); return true; },
  });
  const gate = new PanicGate({ supervisor, runtimeDir: runtimeFile('latch-h') });
  const snapshot = await gate.trip('button');
  assert.deepEqual(forced, [], 'taskkill fallback must not run behind a settled stop');
  assert.equal(snapshot.latched, true);
});

test('kill chain (验收 e): wedged stop falls back to taskkill /F on the captured pid', async () => {
  const forced = [];
  const supervisor = fakeSupervisor({
    pid: 4321,
    stop: () => new Promise(() => {}), // never settles: wedged/suspended worker
    forceKill: async (pid) => { forced.push(pid); return true; },
  });
  const gate = new PanicGate({ supervisor, runtimeDir: runtimeFile('latch-i'), stopTimeoutMs: 30 });
  const snapshot = await gate.trip('button');
  assert.deepEqual(forced, [4321], 'fallback must taskkill the pid captured before stop()');
  assert.equal(snapshot.latched, true);
});

test('supervisor.forceKill really kills a live process (taskkill /F branch mechanics)', async () => {
  const sleeper = spawn('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 60'], { stdio: 'ignore' });
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(sleeper.exitCode, null);
  const killed = await new Supervisor(process.execPath).forceKill(sleeper.pid);
  assert.equal(killed, true);
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.notEqual(sleeper.exitCode, null, 'taskkill /F must have terminated the process');
});

test('kill chain: no supervisor or no pid still trips the latch', async () => {
  const gate = new PanicGate({ runtimeDir: runtimeFile('latch-j') });
  const snapshot = await gate.trip('button');
  assert.equal(snapshot.latched, true);
  assert.equal(snapshot.workerConnected, false);
});

// ── Client routes over apply(): trip/recover/status, 405, 403 ──────────────
const fakeResponse = () => {
  const res = { status: undefined, body: undefined };
  res.writeHead = (status) => { res.status = status; return res; };
  res.end = (body) => { res.body = body; return res; };
  return res;
};
const routeContext = (options = {}) => {
  const routes = [];
  const definitions = new Map();
  let dispose;
  const ctx = {
    tools: { view: () => ({ knownNames: new Set() }), register: (definition) => { definitions.set(definition.name, definition); return () => definitions.delete(definition.name); } },
    on: (event, callback) => { if (event === 'dispose') dispose = callback; },
    webServer: { register: (route) => { if (options.registerThrow) throw options.registerThrow; routes.push(route); return () => routes.splice(routes.indexOf(route), 1); } },
    ...(options.connection === undefined ? {} : { connection: options.connection }),
  };
  apply(ctx);
  return {
    definitions, routes,
    call: async (method, path = '/computer-replacer/api/panic.status') => {
      const res = fakeResponse();
      const route = routes[0];
      if (routes.length !== 1) throw new Error('expected exactly one registered prefix route, got ' + routes.length);
      await route.handler({ method, url: path, headers: {} }, res);
      return { status: res.status, body: res.body === undefined ? undefined : JSON.parse(res.body) };
    },
    dispose: async () => { await dispose(); },
  };
};

test('client routes: panic.status answers the live latch and stays idempotent', async () => {
  const harness = routeContext();
  try {
    const first = await harness.call('POST', '/computer-replacer/api/panic.status');
    assert.equal(first.status, 200);
    assert.equal(first.body.ok, true);
    assert.equal(first.body.latched, false);
    assert.equal(first.body.workerConnected, typeof first.body.workerConnected === 'boolean' ? first.body.workerConnected : undefined);
    const second = await harness.call('POST', '/computer-replacer/api/panic.status');
    assert.deepEqual(second.body.latched, first.body.latched);
  } finally { rmSync(runtimeFile('panic-latch.json'), { force: true }); await harness.dispose(); }
});

test('client routes: trip latches (worker killed), recover clears — both idempotent', async () => {
  const harness = routeContext();
  try {
    const trip = await harness.call('POST', '/computer-replacer/api/panic.trip');
    assert.equal(trip.status, 200);
    assert.equal(trip.body.ok, true);
    assert.equal(trip.body.latched, true);
    assert.equal(trip.body.source, 'button');
    const tripAgain = await harness.call('POST', '/computer-replacer/api/panic.trip');
    assert.equal(tripAgain.body.latched, true, 'trip is idempotent');
    const recover = await harness.call('POST', '/computer-replacer/api/panic.recover');
    assert.equal(recover.status, 200);
    assert.equal(recover.body.latched, false);
    const recoverAgain = await harness.call('POST', '/computer-replacer/api/panic.recover');
    assert.equal(recoverAgain.body.latched, false, 'recover is idempotent');
    const status = await harness.call('POST', '/computer-replacer/api/panic.status');
    assert.equal(status.body.latched, false);
    assert.equal(existsSync(runtimeFile('panic-latch.json')), true, 'cleared state is persisted');
    assert.equal(JSON.parse(readFileSync(runtimeFile('panic-latch.json'), 'utf8')).latched, false);
  } finally { rmSync(runtimeFile('panic-latch.json'), { force: true }); await harness.dispose(); }
});

test('client routes: non-POST answers 405, fenced request answers 403, unknown method 404', async () => {
  const fenced = routeContext({ connection: { requestRejection: () => ({ reason: 'untrusted origin' }) } });
  try {
    assert.equal((await fenced.call('GET', '/computer-replacer/api/panic.status')).status, 403);
    assert.equal((await fenced.call('POST', '/computer-replacer/api/panic.trip')).status, 403);
  } finally { rmSync(runtimeFile('panic-latch.json'), { force: true }); await fenced.dispose(); }
  const harness = routeContext();
  try {
    assert.equal((await harness.call('GET', '/computer-replacer/api/panic.status')).status, 405);
    assert.equal((await harness.call('PUT', '/computer-replacer/api/panic.recover')).status, 405);
    assert.equal((await harness.call('POST', '/computer-replacer/api/other.method')).status, 404);
  } finally { rmSync(runtimeFile('panic-latch.json'), { force: true }); await harness.dispose(); }
});

test('latched plugin refuses every gated write with PANIC_ABORTED, zero approvals asked', async () => {
  const harness = routeContext({
    connection: undefined,
  });
  // Swap in an approval channel that would be consulted by any non-panic path.
  try {
    const trip = await harness.call('POST', '/computer-replacer/api/panic.trip');
    assert.equal(trip.body.latched, true);
    for (const [name, args] of [
      ['replacer_click_by_id', { hwnd: '1234', elementId: 'r:[1,2]' }],
      ['replacer_type', { hwnd: '1234', elementId: 'r:[1,2]', text: 'hi' }],
      ['replacer_key', { hwnd: '1234', combo: 'enter' }],
      ['replacer_wheel_by_id', { hwnd: '1234', elementId: 'r:[1,2]', vertical: 'down' }],
      ['replacer_click_xy', { hwnd: '1234', x: 10, y: 20 }],
    ]) {
      const result = await harness.definitions.get(name).execute(args, { agent: { session: { id: 's' } }, callId: 'c' });
      assert.equal(result.ok, false, name);
      assert.equal(result.code, 'PANIC_ABORTED', name);
      assert.equal(result.panic, true, name);
      assert.equal(result.panicSource, 'button', name);
      assert.match(result.message, /cannot be recalled/, name);
      assert.equal(result.approval, undefined, name + ' must never show an approval card while latched');
    }
    // Read-only tools stay available (拍板补充②): status still answers (it always answers).
    const status = await harness.definitions.get('replacer_status').execute({}, {});
    assert.equal(status.ok, true);
    assert.equal(status.panic, true);
    assert.equal(status.panicSource, 'button');
    assert.equal(status.workerConnected, false, 'worker was killed by the trip; process alive does not mean usable');
    // B-3 explicit contrast (批3 计划 §4): the panic latch does NOT block
    // replacer_read_screen — the emergency stop cuts injection, not perception.
    // The exact outcome depends on the (relaunched) worker, but it must never be
    // the write-path refusal above. Run last: ensureWorker may relaunch a worker.
    const readScreen = await harness.definitions.get('replacer_read_screen').execute({}, { agent: { session: { id: 's' } }, callId: 'c' });
    assert.notEqual(readScreen.code, 'PANIC_ABORTED', 'read-only perception must pass the panic latch');
    assert.equal(readScreen.panic, undefined, 'read_screen carries no panic refusal marker');
    assert.ok(
      readScreen.ok === true
        || ['APPROVAL_UNAVAILABLE', 'WORKER_UNAVAILABLE', 'TIMEOUT', 'VISION_UNAVAILABLE', 'VISION_TIMEOUT'].includes(readScreen.code),
      readScreen.code,
    );
  } finally { rmSync(runtimeFile('panic-latch.json'), { force: true }); await harness.dispose(); }
});

test('latch restored from disk survives a plugin reload (修正案一 / 验收 f)', async () => {
  const dir = runtimeFile('latch-reload');
  const first = new PanicGate({ supervisor: fakeSupervisor(), runtimeDir: dir });
  await first.trip('hotkey');
  // Simulate reload: brand-new gate instance over the same runtime dir.
  const second = new PanicGate({ supervisor: fakeSupervisor(), runtimeDir: dir });
  assert.equal(second.restore().latched, true);
  assert.equal(second.latchedNow, true, 'an emergency stop must never be silently lost on reload');
  second.recover();
  rmSync(join(dir, 'panic-latch.json'), { force: true });
});

test('client bundle ships the slot anchor and route literals', async () => {
  // Guarded as a build artifact check; the bundle is built by npm run build:client.
  const { readFileSync: read } = await import('node:fs');
  const bundle = read(new URL('../../dist/client.js', import.meta.url), 'utf8');
  assert.ok(bundle.includes('window.__ModuleLoader__.load'), 'bundle uses the DSH client module loader format');
  assert.ok(bundle.includes('conversation.input.left'), 'bundle anchors the input-bar left slot');
  assert.ok(bundle.includes('panic.trip'), 'bundle posts panic.trip');
  assert.ok(bundle.includes('panic.recover'), 'bundle posts panic.recover');
  assert.ok(bundle.includes('panic.status'), 'bundle polls panic.status');
  assert.ok(bundle.includes("inject = ['slots']"), 'client entry declares the slots service');
});

test('plugin declares the ./client export and dsh.client platform (loader contract)', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.exports['./client'], './dist/client.js');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(existsSync(new URL('../../dist/client.js', import.meta.url)), true);
  assert.deepEqual(TOOL_NAMES.filter(name => name.startsWith('replacer_')), TOOL_NAMES, 'panic stays out of the model tool protocol');
});


// ── 重启缺陷修复：共享闩锁单例 + duplicate 容错注册 ─────────────────────────
test('shared latch: same instance across calls, attachSupervisor re-binds the kill chain', () => {
  const a = sharedPanicLatch();
  assert.equal(sharedPanicLatch(), a, 'Symbol.for registry must return one instance per process');
  a.attachSupervisor({ client: { connected: true } });
  assert.equal(a.snapshot().workerConnected, true, 'fresh activation re-binds its supervisor');
  a.attachSupervisor(undefined);
  assert.equal(a.snapshot().workerConnected, false);
});

test('plugin restart with survived route: duplicate register skipped, old route serves the shared latch', async () => {
  const first = routeContext();
  try {
    const tripped = await first.call('POST', '/computer-replacer/api/panic.trip');
    assert.equal(tripped.body.latched, true);
    // 第二次激活：webServer 里旧路由仍在（graceful dispose 未跑）→ register 抛 duplicate。
    // 修复后 apply() 必须吞掉 duplicate 且不抛——插件加载成功，旧路由继续服务同一共享闩锁。
    const second = routeContext({ registerThrow: new Error('duplicate prefix route /computer-replacer/api') });
    const status = await first.call('POST', '/computer-replacer/api/panic.status');
    assert.equal(status.body.latched, true, 'survived route must serve the shared latch live state');
    assert.equal(status.body.workerConnected, typeof status.body.workerConnected === 'boolean' ? status.body.workerConnected : undefined);
    const recover = await first.call('POST', '/computer-replacer/api/panic.recover');
    assert.equal(recover.body.latched, false, 'recover through the survived route clears the shared latch');
    await second.dispose();
  } finally { rmSync(runtimeFile('panic-latch.json'), { force: true }); await first.dispose(); }
});
