// Task 2.2 end-to-end: the M7 overlay red dot must land on the exact point each
// injection publishes. Drives the real worker through the real plugin tools, then
// asserts on cursor_target.json (the overlay's only input), on real windows and on
// the physical cursor — all from outside, with no DSH session involved.
//   node scripts/verify-task22.mjs
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(path.join(tmpdir(), 'replacer-task22-'));
const notes = path.join(work, 'task22.txt');
writeFileSync(notes, 'task 2.2 overlay alignment\n'.repeat(400));
const TARGET_FILE = path.join(root, 'cursor_target.json');
const SHOT = path.join(work, 'shot.png');

process.env.REPLACER_BYPASS_APPROVAL = 'true';
const { apply } = await import('../dist/index.js');

const defs = new Map();
let dispose;
apply({
  tools: { view: () => ({ knownNames: new Set() }), register: (d) => { defs.set(d.name, d); return () => {}; } },
  on: (event, cb) => { if (event === 'dispose') dispose = cb; },
  get: () => undefined,
});
const exec = { agent: { id: 'verify-task22' }, callId: 'verify-task22' };
const tool = (name) => defs.get(name)?.execute;
const call = async (name, args) => JSON.parse(JSON.stringify(await tool(name)(args, exec)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (script) => execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim();
const cursor = () => ps('Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; "$($p.X),$($p.Y)"');
const foregroundHwnd = () => ps('Add-Type -Namespace W22 -Name F -MemberDefinition \'[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();\'; [W22.F]::GetForegroundWindow().ToInt64()');
const snapshotPopups = () => ps(`
Add-Type -Namespace W22 -Name N -MemberDefinition '
 [DllImport("user32.dll")] public static extern bool EnumWindows(Func<IntPtr,IntPtr,bool> cb, IntPtr l);
 [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
 public struct R { public int L, T, Rt, B; }';
$found = New-Object System.Collections.ArrayList;
[W22.N]::EnumWindows({ param($h, $l)
  if ([W22.N]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 256
    [void][W22.N]::GetClassName($h, $sb, 256)
    if ($sb.ToString() -like 'Microsoft.UI.Content.PopupWindowSiteBridge*') {
      $r = New-Object W22.N + R
      [void][W22.N]::GetWindowRect($h, [ref]$r)
      [void]$found.Add("hwnd=$($h.ToInt64()) rect=$($r.L),$($r.T),$($r.Rt - $r.L),$($r.B - $r.T)")
    }
  }
  $true }, [IntPtr]::Zero) | Out-Null
$found -join ';'
`).split(';').filter((s) => s.includes('hwnd='));

function shotAround(x, y) {
  ps(`
Add-Type -AssemblyName System.Drawing
$w = 480; $h = 360
$x0 = [Math]::Max(0, ${x} - 240); $y0 = [Math]::Max(0, ${y} - 180)
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$size = New-Object System.Drawing.Size $w, $h
$g.CopyFromScreen($x0, $y0, 0, 0, $size)
$bmp.Save('${SHOT.replace(/\\/g, '/')}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()`);
}

const publish = () => { try { return JSON.parse(readFileSync(TARGET_FILE, 'utf8')); } catch { return {}; } };

// --- overlay: restart fresh so the new MOVE_MIN_MS/SNAP_PX code is loaded ---
ps(`Get-CimInstance Win32_Process -Filter "Name like 'python%'" | Where-Object { $_.CommandLine -like '*overlay.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`);
const overlay = spawn('python', [path.join(root, 'scripts/overlay.py')], { detached: true, stdio: 'ignore', windowsHide: true });
overlay.unref();
await sleep(1200);

// --- Notepad with a scratch file ---
const notepad = spawn('notepad.exe', [notes], { stdio: 'ignore' });
let hwnd = '';
for (let i = 0; i < 30 && !hwnd; i += 1) {
  await sleep(400);
  hwnd = ps(`(Get-Process notepad -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).MainWindowHandle`) || '';
}
assert.ok(hwnd, 'notepad main window handle');

let results = [];
const step = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`); };

// --- observe: find the editor element, compute its center ---
const observed = await call('replacer_observe', { hwnd });
assert.ok(observed.ok, 'observe ok: ' + (observed.message ?? ''));
const page = observed.page;
const editor = page.elements
  .map((e) => ({ ...e, area: e.bbox.width * e.bbox.height }))
  .filter((e) => e.bbox.width > 100 && e.bbox.height > 100)
  .sort((a, b) => b.area - a.area)[0];
assert.ok(editor, 'editor-sized element found in the UIA tree');
const cx = Math.round(editor.bbox.x + editor.bbox.width / 2);
const cy = Math.round(editor.bbox.y + editor.bbox.height / 2);
console.log(`target element ${editor.id} bbox=${JSON.stringify(editor.bbox)} center=(${cx},${cy})`);

// --- 1) right_click: publish == element center, menu at the same point ---
// Foreground first: the worker's guard re-activates too, but the menu only
// appears reliably when the activation has settled before WM_CONTEXTMENU lands.
for (let i = 0; i < 10; i += 1) {
  if (foregroundHwnd() === String(hwnd)) break;
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/fixtures/activate.ps1'), '-Hwnd', String(hwnd)], { encoding: 'utf8' });
  await sleep(400);
}
const before = publish();
const rc = await call('replacer_right_click_by_id', { hwnd, elementId: editor.id });
const after = publish();
step('right_click tool ok', rc.ok === true, `method=${rc.rightClick?.method ?? rc.message}`);
step('right_click publish == element center', rc.ok && Math.abs(after.x - cx) <= 0.5 && Math.abs(after.y - cy) <= 0.5,
  `published=(${after.x},${after.y}) expected=(${cx},${cy}) screen=(${rc.rightClick?.screenX},${rc.rightClick?.screenY})`);
step('publish is fresh', after.ts > before.ts, `ts ${before.ts} -> ${after.ts}`);
await sleep(600);
const menuPage = await call('replacer_observe', { hwnd });
const labels = (menuPage.page?.elements ?? []).map((e) => e.label);
const menuOpen = ['剪切', '复制', '粘贴', 'Cut', 'Copy', 'Paste'].some((w) => labels.some((l) => l === w || l.includes(w)));
step('context menu visible in UIA tree', menuPage.ok === true && menuOpen,
  `menu items found: [${labels.filter((l) => ['剪切', '复制', '粘贴', 'Cut', 'Copy', 'Paste'].some((w) => l && l.includes(w))).join(',') || 'none'}]`);
shotAround(cx, cy);
const shotMenu = readFileSync(SHOT);
ps(`Add-Type -Namespace W22 -Name K -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);'; [W22.K]::keybd_event(27,0,0,[UIntPtr]::Zero); [W22.K]::keybd_event(27,0,2,[UIntPtr]::Zero)`);
await sleep(400);

// --- 2) wheel: publish == element center ---
// The ESC that closed the menu moved keyboard focus, so the world model's
// captured focus is stale: re-observe first (the documented operating order).
await call('replacer_observe', { hwnd });
const beforeW = publish();
const wh = await call('replacer_wheel_by_id', { hwnd, elementId: editor.id, vertical: 'down', steps: 1 });
const afterW = publish();
step('wheel tool ok', wh.ok === true, `method=${wh.write?.method ?? wh.message}`);
step('wheel publish == element center', wh.ok && Math.abs(afterW.x - cx) <= 0.5 && Math.abs(afterW.y - cy) <= 0.5,
  `published=(${afterW.x},${afterW.y}) expected=(${cx},${cy})`);
step('wheel publish is fresh', afterW.ts > beforeW.ts, `ts ${beforeW.ts} -> ${afterW.ts}`);

// --- 3) click_xy: publish == injected point == physical cursor ---
const tx = cx + 12, ty = cy + 9;
const beforeC = publish();
const cxy = await call('replacer_click_xy', { hwnd, x: tx, y: ty });
const afterC = publish();
const phys = cursor();
step('click_xy tool ok', cxy.ok === true, `method=${cxy.clickXY?.method ?? cxy.message}`);
step('click_xy publish == injected point', cxy.ok && afterC.x === tx && afterC.y === ty, `published=(${afterC.x},${afterC.y}) target=(${tx},${ty})`);
step('click_xy physical cursor == target', phys === `${tx},${ty}`, `cursor=${phys}`);
step('click_xy publish is fresh', afterC.ts > beforeC.ts, `ts ${beforeC.ts} -> ${afterC.ts}`);

// --- overlay snap: second publish within 24px lands without flight (visual file check) ---
writeFileSync(TARGET_FILE, JSON.stringify({ x: tx + 5, y: ty + 4, ts: Date.now() }));
await sleep(120);
writeFileSync(TARGET_FILE, JSON.stringify({ x: tx + 12, y: ty + 10, ts: Date.now() }));
await sleep(300);
shotAround(tx, ty);
const shotSnap = readFileSync(SHOT);

// --- report ---
writeFileSync(path.join(work, 'results.json'), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; artifacts in ${work}`);
console.log(`screenshots kept: task22-shot-menu.png / task22-shot-snap.png`);
writeFileSync(path.join(work, 'shot-menu.png'), shotMenu);
writeFileSync(path.join(work, 'shot-snap.png'), shotSnap);
// Close OUR notepad window only (WM_CLOSE; the scratch file is saved, so no
// prompt), never other Notepad instances the user may have open.
ps(`
Add-Type -Namespace W22 -Name C -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);';
[W22.C]::PostMessage([IntPtr]${hwnd}, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null`);
await dispose();
