// Panic hotkey E2E harness (真机). 只写不跑 — 由集成者在部署新 worker exe 后执行:
//   node scripts/verify-panic.mjs
//
// ⚠️ 运行前必须打印"请勿碰键鼠"提示（脚本自己会打）。真按压热键保留为一次性人工冒烟,
// 不进自动化（终审拍板: 自动触发一律走 PostThreadMessageW, harness 自己绝不 SendInput）。
//
// 验收（计划 §6 + 终审 v2 §10）:
//   a) 触发热键（PostThreadMessageW WM_HOTKEY 到 PANIC_HOTKEY_THREAD 日志给出的线程 id）
//      → worker 进程 exit(87) → supervisor 自动拉起新实例 → status 干净（panic:false, 新 pid）
//   b) trip 后原始 IPC 发 replacer_key / replacer_click 等价 op → PANIC_ABORTED +
//      夹具文本零变化（复用 scripts/fixtures/kb-fixture.ps1, 不用 notepad; 原始 IPC 绕过
//      TS 审批, 所以"零变化"就是零注入的直接证据）
//   c) 外部 PowerShell 进程抢注 ctrl+alt+shift+p → 新 worker 照常 ping +
//      日志 PANIC_HOTKEY_UNAVAILABLE（不致命）
//   d) 释放热键 → 再起 worker → 恢复 PANIC_HOTKEY_THREAD / PANIC_HOTKEY_ARMED 日志
//
// 运行前提: 关闭 DSH Host 或 taskkill replacer-worker.exe — 否则已部署实例占用真实热键,
// 本 harness 的 worker 注册会失败（那正好是场景 c, 会把 a 判成 fail, 日志会说明）。
// 依赖: dist/replacer-worker.exe（新部署）、dist/ipc/protocol.js、dist/worker/supervisor.js、
//       worker/target/release/examples/keyboard_probe.exe（cargo build --release --examples 产物）。
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Hard ceiling for the whole run, installed first so a wedged spawn cannot hang forever.
setTimeout(() => { console.error('WATCHDOG: harness exceeded 240s; aborting'); process.exit(2); }, 240000).unref();

console.log('===================================================================');
console.log('>>> 急停热键真机验证即将开始：请勿触碰键盘和鼠标（约 1 分钟）<<<');
console.log('>>> Do NOT touch the keyboard or mouse during this harness.  <<<');
console.log('===================================================================');
await new Promise((r) => setTimeout(r, 2000));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = fileURLToPath(new URL('../dist/replacer-worker.exe', import.meta.url));
const supervisorModule = new URL('../dist/worker/supervisor.js', import.meta.url).href;
const protocolModule = new URL('../dist/ipc/protocol.js', import.meta.url).href;
const { Supervisor } = await import(supervisorModule);
const { Frames, encode } = await import(protocolModule);
const probe = path.join(root, 'worker/target/release/examples/keyboard_probe.exe');
const fixturePs1 = path.join(root, 'scripts/fixtures/kb-fixture.ps1');
const work = mkdtempSync(path.join(tmpdir(), 'replacer-panic-'));
const committed = path.join(work, 'committed.txt');
const stateFile = path.join(work, 'kb-fixture-hwnd.txt');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (command, timeoutMs = 10000) =>
  execFileSync('powershell', ['-NoProfile', '-Command', command + '; exit 0'], { encoding: 'utf8', timeout: timeoutMs }).trim();
const WM_HOTKEY = 0x0312;

let results = [];
const step = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`); };

// --- a/c/d 的 supervisor 工具：收集 stderr 诊断（PANIC_HOTKEY_THREAD / WORKER_EXIT） ---
const startSupervised = async () => {
  const supervisor = new Supervisor(exe);
  let diagnostics = '';
  supervisor.on('diagnostic', (chunk) => { diagnostics += String(chunk); });
  const ready = once(supervisor, 'ready');
  supervisor.start();
  await ready;
  return { supervisor, diagnostics: () => diagnostics };
};
const waitFor = async (supply, pattern, timeoutMs) => {
  for (let deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(100)) {
    const hit = supply().match(pattern);
    if (hit) return hit;
  }
  return null;
};
// PostThreadMessageW 投递 WM_HOTKEY（wParam=1 = PANIC_HOTKEY_ID）。队列未建好时失败,
// 重试直到 worker 消失或超时；线程消失后的 post 静默失败, 无害。
const postWmHotkey = (threadId) => ps(
  `Add-Type -Namespace PH -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostThreadMessage(uint t, uint m, IntPtr w, IntPtr l);'; [void][PH.U]::PostThreadMessage(${threadId}, ${WM_HOTKEY}, [IntPtr]1, [IntPtr]0)`,
);

// --- b 的原始 IPC worker：绕过 supervisor 与 TS 层，直连命名管道（raw-worker.test.mjs 模式） ---
const rawWorker = async () => {
  const slash = String.fromCharCode(92);
  const pipePath = `${slash}${slash}.${slash}pipe${slash}replacer-panic-${randomUUID()}`;
  const server = createServer();
  server.listen(pipePath);
  await once(server, 'listening');
  const connection = once(server, 'connection');
  const child = spawn(exe, [pipePath], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const secret = randomBytes(32).toString('hex'); // 64 hex chars = hello secret
  child.stdin.end(secret);
  const [socket] = await connection;
  socket.on('error', () => {});
  const exit = once(child, 'exit');
  const frames = new Frames();
  const rows = [];
  socket.on('data', (chunk) => rows.push(...frames.push(chunk)));
  // handshake: the first frame must echo the hello secret
  while (!rows.length) await once(socket, 'data');
  assert.equal(rows.shift().hello, secret, 'raw worker hello');
  return { child, socket, rows, exit, stderr: () => stderr,
    send(frame) { socket.write(encode(frame)); },
    async reply(id, timeoutMs = 3000) {
      for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
        const hit = rows.find((row) => row.id === id);
        if (hit) return hit;
        await sleep(20);
      }
      return null;
    },
    async close() {
      socket.destroy();
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await exit; }
      await new Promise((resolve) => server.close(resolve));
    },
  };
};

// --- b 的夹具：kb-fixture.ps1（复用 verify-task3 的启动模式） ---
const windowTitle = (name) => ps(`(Get-Process powershell -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq 'REPLACER_FIXTURE_${name}' } | Select-Object -First 1).MainWindowHandle`) || '';
const launchFixture = () => {
  try {
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${fixturePs1}','-Name','KBP','-Out','${committed}','-StateFile','${stateFile}'`],
      { encoding: 'utf8', timeout: 10000, stdio: 'ignore' });
  } catch (error) { console.error('fixture launch attempt failed: ' + String(error.message).slice(0, 80)); }
};
const fixtureText = () => {
  const out = execFileSync(probe, [fixtureTextbox, 'read'], { encoding: 'utf8', timeout: 20000 });
  const line = out.split(/\r?\n/).find((l) => l.startsWith('RAW_TEXT'));
  assert.ok(line, 'RAW_TEXT line present');
  return line.slice('RAW_TEXT <<<'.length, -3);
};

let fixtureFrame = '';
let fixtureTextbox = '';
for (let attempt = 0; attempt < 2 && !fixtureFrame; attempt += 1) {
  if (attempt > 0) {
    ps(`Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*kb-fixture.ps1*' -and $_.CommandLine -like '*KBP*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction Ignore }`);
    await sleep(500);
  }
  launchFixture();
  for (let i = 0; i < 25 && !fixtureFrame; i += 1) { await sleep(400); fixtureFrame = windowTitle('KBP'); }
}
assert.ok(fixtureFrame, 'KBP fixture window handle');
let tbHwnd = '';
for (let i = 0; i < 15 && !tbHwnd; i += 1) {
  await sleep(400);
  const tree = execFileSync(probe, [fixtureFrame, 'tree'], { encoding: 'utf8', timeout: 20000 });
  const line = tree.split(/\r?\n/).find((l) => l.startsWith('TREE') && /EDIT|RichEdit/i.test(l));
  if (line) tbHwnd = line.trim().split(/\s+/)[1];
}
assert.ok(tbHwnd, 'editor surface found in KBP fixture tree');
fixtureTextbox = tbHwnd;
console.log(`fixture frame=${fixtureFrame} textbox=${fixtureTextbox}`);
const baseline = fixtureText();

// =====================================================================
// (a) 热键触发 → worker exit(87) → supervisor 拉起新 pid → status 干净
// =====================================================================
const a = await startSupervised();
const threadHitA = await waitFor(a.diagnostics, /PANIC_HOTKEY_THREAD=(\d+)/, 8000);
if (!threadHitA) {
  step('a1 worker armed the hotkey thread', false,
    'no PANIC_HOTKEY_THREAD within 8s — 热键可能被已部署 worker/其他进程占用（诊断: ' + a.diagnostics().slice(-200) + '）');
} else {
  step('a1 worker armed the hotkey thread', true, `threadId=${threadHitA[1]}`);
  const oldPid = a.supervisor.pid;
  const oldStatus = await a.supervisor.client.status();
  step('a0 initial status clean', oldStatus.panic === false && oldStatus.pid === oldPid,
    `pid=${oldStatus.pid} panic=${oldStatus.panic}`);
  for (let i = 0; i < 30; i += 1) {
    await postWmHotkey(threadHitA[1]);
    if (a.diagnostics().includes(`WORKER_EXIT code=87`)) break;
    await sleep(100);
  }
  const exitHit = a.diagnostics().match(/WORKER_EXIT code=87/);
  step('a2 worker exited with code 87', Boolean(exitHit), a.diagnostics().split(/\r?\n/).find((l) => l.includes('WORKER_EXIT')) || 'no WORKER_EXIT line');
  const ready2 = once(a.supervisor, 'ready');
  await ready2;
  const newStatus = await a.supervisor.client.status();
  step('a3 supervisor relaunched a clean worker', newStatus.panic === false && newStatus.pid !== oldPid,
    `oldPid=${oldPid} newPid=${newStatus.pid} panic=${newStatus.panic} startCount=${a.supervisor.startCount}`);
}
await a.supervisor.stop();
await sleep(300); // registration release on process death

// =====================================================================
// (b) trip 后 key / click 原始 op → PANIC_ABORTED，夹具零变化
//     每个 op 用一个全新原始 worker 实例，避免 500ms 宽限窗口内的队列竞争。
// =====================================================================
const tripAndProbe = async (method, params, label) => {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const w = await rawWorker();
    try {
      const threadHit = await waitFor(w.stderr, /PANIC_HOTKEY_THREAD=(\d+)/, 8000);
      if (!threadHit) return { aborted: false, detail: 'no PANIC_HOTKEY_THREAD (occupied?)' };
      await postWmHotkey(threadHit[1]);
      await sleep(30); // latch trip latency margin; grace window is 500ms
      w.send({ id: 'p1', method, params });
      const reply = await w.reply('p1', 3000);
      const exitHit = await waitFor(w.stderr, /PANIC_HOTKEY_EXIT code=87/, 2000);
      return { aborted: Boolean(reply && reply.ok === false && reply.error?.code === 'PANIC_ABORTED'), detail: JSON.stringify(reply?.error ?? reply), exitHit: Boolean(exitHit) };
    } catch (error) {
      if (attempt === 3) return { aborted: false, detail: 'attempt 3 failed: ' + String(error.message).slice(0, 120) };
    } finally {
      await w.close();
    }
  }
  return { aborted: false, detail: 'unreachable' };
};
{
  const keyProbe = await tripAndProbe('key', { hwnd: fixtureFrame, combo: 'a' }, 'replacer_key');
  step('b1 tripped worker rejects key op with PANIC_ABORTED', keyProbe.aborted, keyProbe.detail);
  step('b2 tripped worker exits 87 (raw instance)', keyProbe.exitHit === true, 'PANIC_HOTKEY_EXIT code=87 seen');
  step('b3 zero injection: fixture text unchanged after key op', fixtureText() === baseline, `text=<<<${fixtureText()}>>> baseline=<<<${baseline}>>>`);

  const clickProbe = await tripAndProbe('click', { hwnd: fixtureFrame, elementId: 'r:[999]' }, 'replacer_click');
  step('b4 tripped worker rejects click op with PANIC_ABORTED', clickProbe.aborted, clickProbe.detail);
  step('b5 zero injection: fixture text unchanged after click op', fixtureText() === baseline, `text=<<<${fixtureText()}>>>`);
}

// =====================================================================
// (c) 外部进程抢注热键 → 新 worker 照常 ping + PANIC_HOTKEY_UNAVAILABLE
// =====================================================================
const holder = spawn('powershell', ['-NoProfile', '-Command',
  `Add-Type -Namespace PHC -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);'; [void][PHC.U]::RegisterHotKey([IntPtr]::Zero, 1, 0x0007, 0x50); Start-Sleep -Seconds 600`],
  { stdio: 'ignore', windowsHide: true });
await sleep(800); // holder registers ctrl+alt+shift+p (0x0007 = CTRL|ALT|SHIFT, vk 0x50 = P)
const c = await startSupervised();
// c1 修复（批3 集成）：worker 启动是异步的，UNAVAILABLE/THREAD 行可能尚未输出——
// 等任一标志出现（≤8s）再快照，消除快照竞态（原 12/13 flake 根因）。等待超时则维持原断言语义（判 fail）。
await waitFor(c.diagnostics, /PANIC_HOTKEY_UNAVAILABLE|PANIC_HOTKEY_THREAD/, 8000);
const cDiag = c.diagnostics();
const cUnavailable = cDiag.includes('PANIC_HOTKEY_UNAVAILABLE');
const cNoThread = !cDiag.includes('PANIC_HOTKEY_THREAD');
let cPingOk = false;
try { cPingOk = (await c.supervisor.client.request('ping', {}, 3000)).reply === 'pong'; } catch { cPingOk = false; }
step('c1 occupied hotkey only logs PANIC_HOTKEY_UNAVAILABLE', cUnavailable && cNoThread,
  `unavailable=${cUnavailable} armed=${!cNoThread}`);
step('c2 worker keeps serving while hotkey is occupied', cPingOk, `ping=${cPingOk}`);
await c.supervisor.stop();

// =====================================================================
// (d) 释放热键 → 恢复注册
// =====================================================================
holder.kill();
await sleep(500); // release
const d = await startSupervised();
const threadHitD = await waitFor(d.diagnostics, /PANIC_HOTKEY_THREAD=(\d+)/, 8000);
const armedD = d.diagnostics().includes('PANIC_HOTKEY_ARMED=ctrl+alt+shift+p');
let dPingOk = false;
try { dPingOk = (await d.supervisor.client.request('ping', {}, 3000)).reply === 'pong'; } catch { dPingOk = false; }
step('d1 hotkey rearmed after release', Boolean(threadHitD) && armedD, `thread=${threadHitD?.[1] ?? 'none'} armed=${armedD}`);
step('d2 worker serves after rearm', dPingOk, `ping=${dPingOk}`);
await d.supervisor.stop();

// --- 夹具清理：先 WM_CLOSE（表单在 300ms 内自行关闭），再命令行清扫半启动 ---
ps(`Add-Type -Namespace PHD -Name C -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);'; [void][PHD.C]::PostMessage([IntPtr]${fixtureFrame}, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)`);
for (let i = 0; i < 10 && windowTitle('KBP'); i += 1) await sleep(300);
ps(`Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*kb-fixture.ps1*' -and $_.CommandLine -like '*KBP*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction Ignore }`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; artifacts ${work}`);
rmSync(work, { recursive: true, force: true });
process.exitCode = failed.length ? 1 : 0;
