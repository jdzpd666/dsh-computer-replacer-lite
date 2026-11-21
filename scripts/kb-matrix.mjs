// Task 3 Phase 0 driver: runs keyboard_probe.exe against a fresh Notepad and
// prints each technique's verdict. Pure diagnosis — no production code involved.
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(path.join(tmpdir(), 'kb3-'));
const notes = path.join(work, 'scratch.txt');
writeFileSync(notes, 'seed line\n');
const probe = path.join(root, 'worker/target/release/examples/keyboard_probe.exe');

const notepad = spawn('notepad.exe', [notes], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (s) => execFileSync('powershell', ['-NoProfile', '-Command', s], { encoding: 'utf8' }).trim();

let hwnd = '';
for (let i = 0; i < 30 && !hwnd; i += 1) {
  await sleep(400);
  hwnd = ps(`(Get-Process notepad -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).MainWindowHandle`) || '';
}
if (!hwnd) { console.error('NO_NOTEPAD'); process.exit(1); }
console.log(`notepad hwnd=${hwnd}`);
ps(`Add-Type -Namespace K3 -Name F -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);'; [K3.F]::SetForegroundWindow([IntPtr]${hwnd})`);
await sleep(600);

const run = (technique) => {
  try {
    return execFileSync(probe, [hwnd, technique], { encoding: 'utf8', timeout: 20000 });
  } catch (e) {
    return `PROBE_ERROR ${e.status ?? ''} ${e.stderr ?? e.message}`.slice(0, 400);
  }
};

const techniques = process.argv.slice(2).length ? process.argv.slice(2) : [
  'text:hi',
  'enter',
  'text:键',
  'charcode:0x01',   // select-all via WM_CHAR control code
  'chord:ctrl+0x41', // Ctrl+A via WM_KEYDOWN route (needs thread key state — expect fail)
  'alt',             // menu-activation probe with WM_CANCELMODE
];
for (const t of techniques) {
  console.log(`\n=== ${t} ===`);
  console.log(run(t));
}
console.log(`\nnotepad left open (hwnd=${hwnd}); scratch=${notes}`);
