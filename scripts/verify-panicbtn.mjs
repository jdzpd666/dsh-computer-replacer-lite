// Panic button (§7.5) real-machine harness. 只写不跑 — 由集成者执行:
//   node scripts/verify-panicbtn.mjs
//
// 覆盖路由层与状态层（按钮 UI 点击属人肉真机验收，由集成者负责）：
//   a) trip（按钮路径）→ 杀 worker 链：真实 supervisor + 真实 worker exe，
//      trip 后 worker 进程死亡、闩锁上锁（source:button）、持久化落盘
//   b) recover → 闩锁解除 + 惰性拉起 worker（拍板①：recover 成功=闩锁解除，
//      worker 是否拉起不影响成功判定；status workerConnected 如实展示）
//   c) 模拟 exit 87 → supervisor panic 事件 → TS 闩锁上锁 source:hotkey
//      （假子进程 node -e process.exit(87)，不真按键；真热键路径归 verify-panic.mjs）
//   e) 挂死 worker（ntdll NtSuspendProcess 暂停进程）→ 急停 trip 依然杀掉它；
//      再用 stopTimeoutMs=1 强制走 taskkill /F 兜底分支（真 taskkill 杀真 pid）
//   f) 重建 panic-gate 实例 → 持久化恢复（修正案一）
//
// 运行前提: dist/replacer-worker.exe（当前部署件）、dist/panic-gate.js、
//           dist/worker/supervisor.js、dist/index.js。全程自建随机管道，与
//           DSH Host 已部署实例无冲突；只杀本 harness 自己的子进程。
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

setTimeout(() => { console.error('WATCHDOG: harness exceeded 180s; aborting'); process.exit(2); }, 180000).unref();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = fileURLToPath(new URL('../dist/replacer-worker.exe', import.meta.url));
const supervisorModule = new URL('../dist/worker/supervisor.js', import.meta.url).href;
const gateModule = new URL('../dist/panic-gate.js', import.meta.url).href;
const { Supervisor } = await import(supervisorModule);
const { PanicGate } = await import(gateModule);
const work = mkdtempSync(path.join(tmpdir(), 'replacer-panicbtn-'));
const runtimeDir = path.join(work, '.runtime');
process.env.REPLACER_RUNTIME_DIR = runtimeDir;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (command, timeoutMs = 15000) =>
  execFileSync('powershell', ['-NoProfile', '-Command', command + '; exit 0'], { encoding: 'utf8', timeout: timeoutMs }).trim();

let results = [];
const step = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`); };

const startSupervised = async () => {
  const supervisor = new Supervisor(exe);
  let diagnostics = '';
  supervisor.on('diagnostic', (chunk) => { diagnostics += String(chunk); });
  const ready = once(supervisor, 'ready');
  supervisor.start();
  await ready;
  return { supervisor, diagnostics: () => diagnostics };
};
const pidAlive = (pid) => {
  const out = ps(`(Get-Process -Id ${pid} -ErrorAction SilentlyContinue) -ne $null`);
  return out.includes('True');
};

// ── (a) 按钮路径 trip：杀 worker 链 + 闩锁上锁 ─────────────────────────────
const gate = new PanicGate({ supervisor: undefined, runtimeDir, log: () => {} });
const a = await startSupervised();
gate['supervisor'] = a.supervisor; // attach the real supervisor to the gate under test
const pidBefore = a.supervisor.pid;
assert.ok(pidBefore, 'worker pid known after ready');
const snapshotA = await gate.trip('button');
await sleep(500);
const deadAfterTrip = !pidAlive(pidBefore);
step('a1 trip arms the latch with source=button', snapshotA.latched === true && snapshotA.source === 'button', JSON.stringify(snapshotA));
step('a2 trip kills the worker chain (clean stop path)', deadAfterTrip && !a.supervisor.client.connected && a.supervisor.pid === undefined, `pid=${pidBefore} alive=${!deadAfterTrip} connected=${a.supervisor.client.connected}`);
const persisted = JSON.parse(readFileSync(path.join(runtimeDir, 'panic-latch.json'), 'utf8'));
step('a3 trip persists {latched:true, source:button}', persisted.latched === true && persisted.source === 'button', JSON.stringify(persisted));

// ── (b) recover：闩锁解除 + 惰性拉起（拍板①）──────────────────────────────
const snapshotB = gate.recover();
const bLatch = snapshotB.latched === false && snapshotB.source === undefined;
const recoveredFile = JSON.parse(readFileSync(path.join(runtimeDir, 'panic-latch.json'), 'utf8'));
const lazyStart = (async () => {
  a.supervisor.start(); // 模拟"下次工具调用惰性拉起"（生产里由 ensureWorker 触发）
  await once(a.supervisor, 'ready');
  return a.supervisor.client.connected;
})();
const bConnected = await lazyStart;
step('b1 recover clears the latch (semantic core, 拍板①)', bLatch, JSON.stringify(snapshotB));
step('b2 recover persists the cleared state', recoveredFile.latched === false, JSON.stringify(recoveredFile));
step('b3 lazy worker pull-up after recover (workerConnected:true)', bConnected === true, `connected=${a.supervisor.client.connected}`);

// ── (c) 模拟 exit 87 → panic 事件 → 闩锁 source:hotkey ────────────────────
const gateC = new PanicGate({ supervisor: undefined, runtimeDir, log: () => {} });
class PanicChildSupervisor extends Supervisor {}
PanicChildSupervisor.prototype.spawnArguments = function () { return ['-e', 'process.exit(87)']; };
const fakeWorker = new PanicChildSupervisor(process.execPath, 1);
fakeWorker.on('panic', () => { gateC.noteHotkeyExit(); }); // 生产里是 index.ts 的同一接线
await new Promise((resolve) => { fakeWorker.on('exhausted', resolve); fakeWorker.start(); });
await fakeWorker.stop();
const snapshotC = gateC.snapshot();
step('c1 simulated exit(87) arms the latch with source=hotkey', snapshotC.latched === true && snapshotC.source === 'hotkey', JSON.stringify(snapshotC));
const persistedC = JSON.parse(readFileSync(path.join(runtimeDir, 'panic-latch.json'), 'utf8'));
step('c2 hotkey trip persists source=hotkey', persistedC.latched === true && persistedC.source === 'hotkey', JSON.stringify(persistedC));
gateC.recover();

// ── (e) 挂死 worker（暂停进程）→ 急停依然有效 + taskkill /F 兜底 ──────────
const e = await startSupervised();
gate['supervisor'] = e.supervisor;
gate.recover(); // reset from any earlier state before the kill-chain runs
const suspendPs = `
Add-Type -Namespace PB -Name Nt -MemberDefinition '[DllImport("ntdll.dll")] public static extern uint NtSuspendProcess(IntPtr h); [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint a, bool b, uint p);';
$p = Get-Process -Id ${e.supervisor.pid}; $h = [PB.Nt]::OpenProcess(0x0800, $false, ${e.supervisor.pid}); [void][PB.Nt]::NtSuspendProcess($h); "SUSPENDED"`;
const suspended = ps(suspendPs);
const pidE = e.supervisor.pid;
await gate.trip('button');
await sleep(500);
const deadE = !pidAlive(pidE);
step('e1 suspended (hung) worker is still killed by the panic trip', suspended.includes('SUSPENDED') && deadE, `suspended=${suspended} pid=${pidE} alive=${!deadE}`);
await e.supervisor.stop().catch(() => {});
// 兜底分支：把 clean stop 的 kill 延迟 200ms，让 1ms 超时稳定赢下竞态 →
// 真实 taskkill /F 杀掉仍然存活的 worker pid（生产语义：stop() 挂死时的兜底）
const e2 = await startSupervised();
gate['supervisor'] = e2.supervisor;
gate.recover();
let forcedKillObserved = false;
const origForceKill = e2.supervisor.forceKill.bind(e2.supervisor);
const origStop = e2.supervisor.stop.bind(e2.supervisor);
e2.supervisor.stop = () => new Promise((resolve) => setTimeout(async () => { await origStop(); resolve(); }, 200));
e2.supervisor.forceKill = async (pid) => { const r = await origForceKill(pid); forcedKillObserved = r === true; return r; };
const pidE2 = e2.supervisor.pid;
const tripStart = Date.now();
const snapshotE2 = await gate.trip('button', 1);
await sleep(400);
const deadE2 = !pidAlive(pidE2);
step('e2 taskkill /F fallback branch kills a live worker (forced timeout path)', forcedKillObserved === true && deadE2 && snapshotE2.latched === true, `forced=${forcedKillObserved} pid=${pidE2} alive=${!deadE2} took=${Date.now() - tripStart}ms`);
await origStop().catch(() => {});

// ── (f) 重建 panic-gate 实例 → 持久化恢复（修正案一 / 验收 f）─────────────
const gateF = new PanicGate({ supervisor: undefined, runtimeDir, log: () => {} });
const restored = gateF.restore();
step('f1 rebuilt gate restores the latch from disk', restored.latched === true && restored.source === 'button', JSON.stringify(restored));
gateF.recover();
const cleared = JSON.parse(readFileSync(path.join(runtimeDir, 'panic-latch.json'), 'utf8'));
step('f2 cleanup recover leaves persisted state cleared', cleared.latched === false, JSON.stringify(cleared));

// 清理：b3 惰性拉起后的 (a) supervisor 仍在跑真实 worker，必须停掉，否则进程不退出。
await a.supervisor.stop().catch(() => {});
rmSync(work, { recursive: true, force: true });
const failed = results.filter(r => !r.ok);
console.log('-------------------------------------------------------------------');
console.log(`verify-panicbtn: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) { for (const f of failed) console.log('FAILED: ' + f.name); process.exit(1); }
