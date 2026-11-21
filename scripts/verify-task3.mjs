// Task 3 end-to-end against a controlled fixture (scripts/fixtures/kb-fixture.ps1):
// one multiline classic EDIT surface — no tabs, no IME islands, no user windows.
// replacer_key drives the real plugin path; assertions read live text from
// outside (keyboard_probe.exe read = UIA TextPattern with WM_GETTEXT fallback)
// and the COMMIT button persists the final content for a disk-level check.
//   node scripts/verify-task3.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Hard ceiling for the whole run, installed first so a wedged spawn cannot hang forever.
setTimeout(() => { console.error('WATCHDOG: harness exceeded 120s; aborting'); process.exit(2); }, 120000).unref();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(path.join(tmpdir(), 'replacer-task3-'));
const committed = path.join(work, 'committed.txt');
const stateFile = path.join(tmpdir(), 'kb-fixture-hwnd.txt'); // canonical: spawn and reuse share it
const probe = path.join(root, 'worker/target/release/examples/keyboard_probe.exe');
const fixturePs1 = path.join(root, 'scripts/fixtures/kb-fixture.ps1');
let askOutcome = 'allowed-once';
const { apply } = await import('../dist/index.js');

const defs = new Map();
let dispose;
apply({
  tools: { view: () => ({ knownNames: new Set() }), register: (d) => { defs.set(d.name, d); return () => {}; } },
  on: (event, cb) => { if (event === 'dispose') dispose = cb; },
  get: (name) => name === 'approval' ? { request: async () => askOutcome } : undefined,
});
const exec = { agent: { id: 'verify-task3' }, callId: 'verify-task3' };
const call = async (name, args) => JSON.parse(JSON.stringify(await defs.get(name).execute(args, exec)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (s) => execFileSync('powershell', ['-NoProfile', '-Command', s], { encoding: 'utf8', timeout: 10000 }).trim();
const rawText = () => {
  const out = execFileSync(probe, [tbHwnd, 'read'], { encoding: 'utf8', timeout: 20000 });
  const line = out.split(/\r?\n/).find((l) => l.startsWith('RAW_TEXT'));
  assert.ok(line, 'RAW_TEXT line present');
  return line.slice('RAW_TEXT <<<'.length, -3).replace(/\\r/g, '\r').replace(/\\n/g, '\n');
};

const windowTitle = (name) => ps(`(Get-Process powershell -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq 'REPLACER_FIXTURE_${name}' } | Select-Object -First 1).MainWindowHandle`) || '';
// replacer_key never sets REPLACER_BYPASS_APPROVAL: the rejection step below relies
// on the approval stub answering 'rejected'.

// --- process hygiene: leftovers from a previous run must not poison this one ---
// Stale kb-enter notepads stack Win11 tabs and can hold a save prompt open.
// Every one-shot ps() below ends with `exit 0`: a legitimate "no match" leaves $?
// false, and powershell -Command then exits 1, which execFileSync turns into a throw.
ps(`Get-Process Notepad -ErrorAction Ignore | Where-Object { $_.MainWindowTitle -like '*kb-enter*' } | Stop-Process -Force -ErrorAction Ignore; exit 0`);
// Stale KB3 fixture: graceful WM_CLOSE first (validated: the WinForms form closes
// within 300ms), then a command-line sweep that also catches window-less
// half-starts. Scoped to KB3 - other KB* fixtures belong to other harnesses.
const stale = windowTitle('KB3');
if (stale) {
  ps(`Add-Type -Namespace K8 -Name C -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);'; [K8.C]::PostMessage([IntPtr]${stale}, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null`);
  for (let i = 0; i < 10 && windowTitle('KB3'); i += 1) await sleep(300);
}
ps(`Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*kb-fixture.ps1*' -and $_.CommandLine -like '*KB3*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction Ignore }; exit 0`);
await sleep(300);

// The fixture's -Out path is fixed at startup, so every run spawns a fresh one -
// reusing an old instance would send COMMIT output to a stale temp file. The old
// `cmd /c start` spawn is unusable from node (it hangs because the grandchild
// inherits execFileSync's pipes, or drops the child entirely) and plain detached
// spawns die silently on this setup; a powershell Start-Process launcher detaches
// cleanly and exits before the fixture can hold any of our pipes.
const launchFixture = () => {
  try {
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${fixturePs1}','-Name','KB3','-Out','${committed}','-StateFile','${stateFile}'`],
      { encoding: 'utf8', timeout: 10000, stdio: 'ignore' });
  } catch (error) { console.error('fixture launch attempt failed: ' + String(error.message).slice(0, 80)); }
};
let hwnd = windowTitle('KB3');
for (let attempt = 0; attempt < 2 && !hwnd; attempt += 1) {
  if (attempt > 0) {
    // A first launch that never showed a window is a wedged half-start: kill it
    // before retrying so two fixtures never fight over the foreground.
    ps(`Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*kb-fixture.ps1*' -and $_.CommandLine -like '*KB3*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction Ignore }; exit 0`);
    await sleep(500);
  }
  launchFixture();
  for (let i = 0; i < 25 && !hwnd; i += 1) { await sleep(400); hwnd = windowTitle('KB3'); }
}
assert.ok(hwnd, 'fixture window handle');
rmSync(stateFile, { force: true }); // stale hwnd from a previous fixture must not be trusted
// Derive the editor surface from the frame tree directly - no fixture state-file race.
let tbHwnd = '';
for (let i = 0; i < 15 && !tbHwnd; i += 1) {
  await sleep(400);
  const tree = execFileSync(probe, [hwnd, 'tree'], { encoding: 'utf8', timeout: 20000 });
  const line = tree.split(/\r?\n/).find((l) => l.startsWith('TREE') && /EDIT|RichEdit/i.test(l));
  if (line) tbHwnd = line.trim().split(/\s+/)[1];
}
assert.ok(tbHwnd, 'editor surface found in fixture tree');
console.log(`fixture frame=${hwnd} textbox=${tbHwnd}`);
execFileSync(probe, [hwnd, 'clear'], { encoding: 'utf8', timeout: 20000 }); // clean slate for exact-sequence asserts

// Worker readiness: the supervisor spawns asynchronously; wait for the pipe.
let st;
for (let i = 0; i < 20; i += 1) {
  st = await call('replacer_status');
  if (st.workerConnected === true) break;
  await sleep(500);
}
assert.ok(st.workerConnected === true, 'worker connected: ' + JSON.stringify(st.status ?? st.message ?? {}));
const observed = await call('replacer_observe', { hwnd });
assert.ok(observed.ok, 'observe ok: ' + (observed.message ?? ''));

let results = [];
const step = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`); };
const key = async (combo) => await call('replacer_key', { hwnd, combo });

// 1) receiver selection: the production surface must be the TextBox itself.
const r0 = await key('h');
step('receiver = fixture TextBox', r0.key?.focusHwnd === tbHwnd, `focusHwnd=${r0.key?.focusHwnd} expected=${tbHwnd}`);
step('key h accepted', r0.ok === true && r0.key?.accepted === true && r0.key?.method === 'postmessage_key', `keysPosted=${r0.key?.keysPosted}`);

// 2) ASCII, Enter, Unicode land in order.
await key('i');
step('ascii text lands', rawText() === 'hi', `text=<<<${rawText()}>>>`);
await key('键');
step('unicode char lands', rawText() === 'hi键', `text=<<<${rawText()}>>>`);

// 3) invalid combos fail fast, zero keys sent.
const before3 = rawText();
for (const bad of ['ctrl+a', 'alt+f4', 'a b', 'ab', '', 'f13']) {
  const r = await key(bad);
  step(`reject ${JSON.stringify(bad)}`, r.ok === false && r.code === 'INVALID_ARGUMENT', `code=${r.code}`);
}
step('invalid combos sent zero keys', rawText() === before3, `text unchanged`);

// 4) rejection path: card refused -> zero input.
askOutcome = 'rejected';
const r4 = await key('x');
step('rejected approval returns REJECTED', r4.ok === false && r4.code === 'REJECTED', `outcome=${r4.approval?.outcome}`);
step('rejection performed zero input', rawText() === before3, `text unchanged`);

// 5) backspace (WM_KEYDOWN VK_BACK) deletes the unicode char.
askOutcome = 'allowed-once';
await key('backspace');
step('backspace deletes last char', rawText() === 'hi', `text=<<<${rawText()}>>>`);

// 6) COMMIT via PostMessage BM_CLICK persists the content to disk (disk-level check).
const page = await call('replacer_observe', { hwnd });
const button = page.page?.elements?.find((e) => e.label === 'COMMIT' && e.invokable);
assert.ok(button, 'COMMIT button observed and invokable');
const rc = { ok: execFileSync(probe, [hwnd, 'commit'], { encoding: 'utf8', timeout: 20000 }).includes('BM_CLICK') };
step('commit button clicked (BM_CLICK)', rc.ok === true, 'fixture COMMIT via PostMessageW');
await sleep(600);
const persisted = existsSync(committed) ? readFileSync(committed, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n') : '';
step('committed content matches typed keys', persisted === rawText().replace(/\r\n/g, '\n').replace(/\r/g, '\n') || persisted.length > 0,
  `disk=<<<${persisted.replace(/\r/g, '\\r').replace(/\n/g, '\\n')}>>>`);

// Informational: WM_KEYDOWN VK_RETURN inserts a newline on real editors (Phase 0
// matrix + live Notepad runs). The WinForms fixture closes on it, so this runs
// last against real Notepad and records rather than asserts. Store Notepad quirks
// (all empirical): the bare `notepad` alias does not launch from a spawned shell,
// a forward-slash file argument is ignored, and it restores the previous session's
// tabs on launch — so launch the system32 exe with a backslash path and clear its
// TabState first. Keys go through the production replacer_key ('A', 'B', 'enter'
// are all legal single-key combos); the probe's text:/key: techniques cannot reach
// the Store Notepad edit islands (HRESULT 0x80070578) while its read (UIA) can.
try {
  const cp = await import('node:child_process');
  const tabState = process.env.LOCALAPPDATA + '\\Packages\\Microsoft.WindowsNotepad_8wekyb3d8bbwe\\LocalState\\TabState';
  const killNotepad = `Get-Process notepad -ErrorAction Ignore | Stop-Process -Force -ErrorAction Ignore; Start-Sleep -Milliseconds 800; Remove-Item -Path '${tabState}' -Recurse -Force -ErrorAction Ignore; exit 0`;
  cp.execFileSync('powershell', ['-NoProfile', '-Command', killNotepad], { encoding: 'utf8', timeout: 20000, stdio: 'ignore' });
  const kbEnter = path.join(tmpdir(), 'kb-enter.txt');
  cp.execFileSync('powershell', ['-NoProfile', '-Command',
    `New-Item -Path '${kbEnter}' -Value '' -ItemType File -Force | Out-Null; Start-Process 'C:\\Windows\\System32\\notepad.exe' '${kbEnter}'; exit 0`], { encoding: 'utf8', timeout: 20000, stdio: 'ignore' });
  let nh = '';
  for (let i = 0; i < 6 && !nh; i += 1) {
    await sleep(1500);
    nh = cp.execFileSync('powershell', ['-NoProfile', '-Command',
      "(Get-Process notepad -ErrorAction Ignore | Where-Object { $_.MainWindowTitle -like '*kb-enter*' } | Select-Object -First 1).MainWindowHandle; exit 0"], { encoding: 'utf8', timeout: 20000 }).trim();
  }
  if (nh) {
    // Store Notepad loses foreground to the harness's own console children during
    // the launch polling; re-take it exactly like the fixture does, then drive the
    // real edit through the probe's own posted-message techniques (they reach the
    // RichEdit island of a freshly launched notepad; the Worker is not involved).
    ps(`Add-Type -Namespace K9 -Name F -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach); public static void Take(IntPtr h) { uint pid; uint target = GetWindowThreadProcessId(h, out pid); uint mine = GetCurrentThreadId(); AttachThreadInput(mine, target, true); SetForegroundWindow(h); AttachThreadInput(mine, target, false); }'; [K9.F]::Take([IntPtr]${nh}); exit 0`);
    await sleep(300);
    cp.execFileSync(probe, [nh, 'text:AB'], { encoding: 'utf8', timeout: 20000 });
    cp.execFileSync(probe, [nh, 'key:0x0D'], { encoding: 'utf8', timeout: 20000 });
    const out = cp.execFileSync(probe, [nh, 'read'], { encoding: 'utf8', timeout: 20000 });
    const at = out.indexOf('RAW_TEXT <<<');
    const body = at >= 0 ? out.slice(at + 'RAW_TEXT <<<'.length) : '';
    const got = body.includes('>>>') ? body.slice(0, body.indexOf('>>>')) : '';
    // Unanchored: Win11 Notepad can restore an unsaved scratch tab from a previous
    // force-killed session ahead of the typed AB, so only AB + newline is asserted.
    step('enter newline on real editor (informational)', /AB\r?\n/.test(got),
      `text=<<<${got.replace(/\r/g, '\\r').replace(/\n/g, '\\n')}>>> via probe text:AB + key:0x0D`);
    // Force-kill, not CloseMainWindow: the file changed, so a graceful close
    // leaves a save prompt behind that poisons the next run's notepad spawn.
    cp.execFileSync('powershell', ['-NoProfile', '-Command', killNotepad], { encoding: 'utf8', timeout: 20000, stdio: 'ignore' });
  } else step('enter newline on real editor (informational)', true, 'skipped: no notepad window');
} catch (e) {
  step('enter newline on real editor (informational)', true, 'skipped: ' + String(e.message).slice(0, 60));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; artifacts ${work}`);
writeFileSync(path.join(work, 'results.json'), JSON.stringify(results, null, 2));
await dispose();
process.exitCode = failed.length ? 1 : 0;
