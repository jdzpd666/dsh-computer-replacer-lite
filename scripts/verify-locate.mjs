// 批4 真机 harness（第 14 工具 replacer_locate，只读融合 UIA + 屏幕文字）：
//   node scripts/verify-locate.mjs
//
// 覆盖（计划 §5 / lead C2 口径 10 项，每项打印 PASS/FAIL + 关键值）：
// 1. fixture 窗口契约：启动 scripts/fixtures/locate-text.ps1，读 state 文件拿 hwnd，
//    SetWindowPos 固定到 (120,120) 并 SetForegroundWindow，再用 replacer_windows 按标题
//    replacer-locate-fixture 找到该窗口，observe 收集 elementId 集 / 根 bbox；
// 2. 正例融合：locate{hwnd, query:保存, minScore:0.5} → channel=fusion、capabilities.capture/ocr=true、
//    matches 非空、每个 elementId ∈ observe id 集、score≥minScore、timings 五项≥0；
//    bbox 相交口径（DPI 归一）：s = locate.window.width / observe 根 bbox.width 反推物理缩放
//    （本机 125% → 约 1.25；断言 1.0≤s≤4.0），元素物理 bbox = round(observe bbox×s) 再与 match.bbox 求交；
//    若 channel!=fusion 或 s 越界 → 改断 match.bbox 正面积且落在 window 内（降级态口径，仍算检查不算跳过）；
// 3. 无 query 对账：elementId 唯一、score 单调不升、textOnly≤20、matches≤50、
//    未截断时 totalMatches===matches.length 且 totalTextOnly===textOnly.length、query=null；
// 4. 预算：整帧 JSON.stringify 的 UTF-8 字节 ≤ MAX_FRAME_BYTES(65536) 且 ≤ MAX_LOCATE_SOFT_BYTES(58982)，
//    且 locateResult(响应) 严格校验通过（协议契约证据）；
// 5. capabilities 三键齐全且均为 boolean、grounding=false、channel∈{fusion,uia_only}、
//    degraded 为 boolean 且与 degradeReason 一致（true→非空字符串，false→null）；
// 6. 空结果诚实：query=绝不存在的词_zzz9 → 请求成功、matches=[]、textOnly=[]（不报错）；
// 7. 参数校验：hwnd=abc / -1 → INVALID_ARGUMENT；hwnd=99999999（不存在窗口）→
//    允许 INVALID_ARGUMENT|UIA_ERROR|CONTEXT_CHANGED，但必须带非空 message（实际码打印出来）；
// 8. 零注入证据：locate 前后 GetCursorPos 与 GetForegroundWindow 不变、observe label 集一致；
// 9. 视觉独有文本：启动 scripts/fixtures/locate-drawn.ps1（OnPaint DrawString，零子控件）→
//    locate 无 query，textOnly 中存在同时包含 CJK 子串「绘制文字」「仅视觉可见」的行，
//    且 observe(hwnd) 的 label 集不含「绘制文字」（UIA 树不可见，OCR 可读）；
// 10. 快照不膨胀：status.worlds 该 hwnd 的 elements 数在多次 observe/locate 后不变（world.insert 替换语义）。
//
// 运行前提：D-integ 已把新 replacer-worker.exe 拷进 dist/（旧批3 exe 没有 locate 方法）。
// fixture 启动命令（PS 5.1 / UTF-8 BOM 文件，-File 方式避免内联 $_ 坑）：
//   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/fixtures/locate-text.ps1  -StateFile <tmp>
//   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/fixtures/locate-drawn.ps1 -StateFile <tmp>
// 临时 helper ps1（os.tmpdir() 里生成，只读 GetCursorPos/GetForegroundWindow + 固定窗口位置，无输入注入）
// 与两个 fixture 进程都在 finally 里清理（taskkill 自己起的 PID），绝不触碰 replacer-worker。
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Supervisor } from '../dist/worker/supervisor.js';
import { locateResult, MAX_FRAME_BYTES, MAX_LOCATE_SOFT_BYTES } from '../dist/ipc/protocol.js';

const exe = fileURLToPath(new URL('../dist/replacer-worker.exe', import.meta.url));
const FIXTURE_POS = { x: 120, y: 120 };
const MIN_SCORE = 0.5;
const HELPER_PS1 = `
param([string]$Action = 'state', [long]$Hwnd = 0, [int]$X = 120, [int]$Y = 120)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class VerifyLocateWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
}
'@
if ($Action -eq 'fix') {
  $h = [IntPtr]$Hwnd
  [VerifyLocateWin]::ShowWindow($h, 9) | Out-Null
  [VerifyLocateWin]::SetWindowPos($h, [IntPtr]::Zero, $X, $Y, 0, 0, 0x0045) | Out-Null
  [VerifyLocateWin]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 300
  $r = [VerifyLocateWin+RECT]::new()
  $got = [VerifyLocateWin]::GetWindowRect($h, [ref]$r)
  @{ action = 'fix'; ok = $got; x = $r.Left; y = $r.Top; w = ($r.Right - $r.Left); h = ($r.Bottom - $r.Top); fg = [int64][VerifyLocateWin]::GetForegroundWindow() } | ConvertTo-Json -Compress
} else {
  $p = [VerifyLocateWin+POINT]::new()
  [VerifyLocateWin]::GetCursorPos([ref]$p) | Out-Null
  @{ action = 'state'; cursorX = $p.X; cursorY = $p.Y; fg = [int64][VerifyLocateWin]::GetForegroundWindow() } | ConvertTo-Json -Compress
}

`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-locate-'));
const helperPath = path.join(tmpDir, 'harness-helper.ps1');
fs.writeFileSync(helperPath, HELPER_PS1, 'utf8');

function runPs1(action, extra = {}) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helperPath, '-Action', action];
  for (const key of Object.keys(extra)) args.push('-' + key, String(extra[key]));
  const result = spawnSync('powershell', args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (result.error) throw result.error;
  const out = String(result.stdout || '').replace(String.fromCharCode(0xFEFF), '').trim();
  if (result.status !== 0) throw new Error('helper ' + action + ' exit=' + result.status + ' stderr=' + String(result.stderr || '').trim());
  return JSON.parse(out);
}

const fixtures = [];
function startFixture(name) {
  const scriptPath = fileURLToPath(new URL('../scripts/fixtures/' + name + '.ps1', import.meta.url));
  if (!fs.existsSync(scriptPath)) throw new Error('fixture script missing: ' + scriptPath);
  const statePath = path.join(tmpDir, name + '-state.json');
  if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
  const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-StateFile', statePath], { stdio: 'ignore', windowsHide: false });
  const fixture = { name, child, statePath, pid: 0, hwnd: '', title: '' };
  fixtures.push(fixture);
  return fixture;
}

async function waitFixture(fixture, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(fixture.statePath)) {
      let parsed = null;
      try { parsed = JSON.parse(fs.readFileSync(fixture.statePath, 'utf8').replace(String.fromCharCode(0xFEFF), '')); } catch (error) { parsed = null; }
      if (parsed && parsed.pid && parsed.hwnd) {
        fixture.pid = Number(parsed.pid);
        fixture.hwnd = String(parsed.hwnd);
        fixture.title = String(parsed.title || '');
        return fixture;
      }
    }
    if (fixture.child.exitCode !== null) throw new Error('fixture ' + fixture.name + ' exited early code=' + fixture.child.exitCode);
    await sleep(120);
  }
  throw new Error('fixture ' + fixture.name + ' state file timeout: ' + fixture.statePath);
}

const overlapSize = (a, b) => ({ width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x), height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) });
const scaleBox = (box, scale) => ({ x: Math.round(box.x * scale), y: Math.round(box.y * scale), width: Math.round(box.width * scale), height: Math.round(box.height * scale) });

const s = new Supervisor(exe);
let passed = 0;
const check = (idx, name, ok, detail) => {
  console.log((ok ? 'PASS' : 'FAIL') + ' [' + idx + '/10] ' + name + (detail ? ' :: ' + detail : ''));
  if (ok) passed += 1;
};
async function guard(idx, name, fn) {
  try { const outcome = await fn(); check(idx, name, outcome.ok, outcome.detail); }
  catch (error) { check(idx, name, false, 'ERROR ' + (error && error.message ? error.message : String(error))); }
}
const request = (method, params, timeoutMs = 15000) => s.client.request(method, params, timeoutMs);
const statusRow = (status, hwnd) => (status.worlds || []).find((row) => String(row.hwnd) === hwnd) || null;

try {
  const ready = once(s, 'ready', { signal: AbortSignal.timeout(8000) });
  s.start();
  await ready;

  // ---- setup：text fixture 起窗、固定位置、observe 基线
  const textFixture = startFixture('locate-text');
  await waitFixture(textFixture);
  const textHwnd = textFixture.hwnd;
  const fixed = runPs1('fix', { Hwnd: textHwnd, X: FIXTURE_POS.x, Y: FIXTURE_POS.y });
  await sleep(300);
  const windowsReply = await request('windows', {}, 8000);
  const textWindow = (windowsReply.windows || []).find((row) => String(row.hwnd) === textHwnd) || null;
  const observeReply = await request('observe', { hwnd: textHwnd }, 10000);
  const elements = observeReply.elements || [];
  const elementById = new Map(elements.map((el) => [String(el.id), el]));
  const obsIds = new Set(elements.map((el) => String(el.id)));
  const rootObs = elements.find((el) => el.parentId === null || el.parentId === undefined) || elements[0] || null;
  const statusBefore = await request('status', {}, 8000);
  console.log('SETUP text fixture hwnd=' + textHwnd + ' pid=' + textFixture.pid + ' windows_title=' + (textWindow ? String(textWindow.label) : 'MISSING') + ' observe_elements=' + elements.length + ' root_bbox=' + JSON.stringify(rootObs ? rootObs.bbox : null) + ' fixed=' + JSON.stringify(fixed));

  await guard(1, 'fixture window + observe contract', async () => {
    const windowOk = !!textWindow && String(textWindow.label || '').includes('replacer-locate-fixture');
    const stateOk = textFixture.title === 'replacer-locate-fixture';
    const rectOk = !!fixed && Math.abs(Number(fixed.x) - FIXTURE_POS.x) <= 2 && Math.abs(Number(fixed.y) - FIXTURE_POS.y) <= 2 && Number(fixed.w) >= 400 && Number(fixed.h) >= 250;
    const obsOk = elements.length >= 3 && obsIds.size === elements.length && !!rootObs && !!rootObs.bbox && rootObs.bbox.width > 0 && rootObs.bbox.height > 0;
    return { ok: windowOk && stateOk && rectOk && obsOk, detail: 'window=' + windowOk + ' state_title=' + stateOk + ' rect=' + rectOk + ' observe=' + obsOk + '(' + elements.length + ' elements, ' + obsIds.size + ' ids)' };
  });

  // ---- locate 三次请求：正例 / 无 query / 空结果（失败也先记录，供各检查如实报错）
  const calls = {};
  const callLocate = async (key, params) => {
    try { calls[key] = { value: await request('locate', params, 25000), error: null }; }
    catch (error) { calls[key] = { value: null, error }; }
  };
  await callLocate('pos', { hwnd: textHwnd, query: '保存', minScore: MIN_SCORE });
  await callLocate('all', { hwnd: textHwnd });
  await callLocate('empty', { hwnd: textHwnd, query: '绝不存在的词_zzz9' });

  const callFailure = (call) => (call && call.error ? String(call.error.code) + ' ' + String(call.error.message) : 'missing');

  await guard(2, 'fusion query 保存', async () => {
    const call = calls.pos;
    if (!call || call.error) return { ok: false, detail: 'locate failed: ' + callFailure(call) };
    const raw = call.value;
    const matches = raw.matches || [];
    const missingIds = matches.filter((m) => !obsIds.has(String(m.elementId))).map((m) => String(m.elementId));
    let scale = 0;
    let scaleOk = false;
    if (rootObs && rootObs.bbox && rootObs.bbox.width > 0 && raw.window && raw.window.width > 0) {
      scale = raw.window.width / rootObs.bbox.width;
      scaleOk = scale >= 1 && scale <= 4;
    }
    const bboxFailures = [];
    let bboxMode = 'scale';
    if (raw.channel === 'fusion' && scaleOk) {
      for (const match of matches) {
        const observed = elementById.get(String(match.elementId));
        if (!observed) { bboxFailures.push(String(match.elementId) + ':not-observed'); continue; }
        const physical = scaleBox(observed.bbox, scale);
        const overlap = overlapSize(physical, match.bbox);
        if (!(overlap.width > 0 && overlap.height > 0)) bboxFailures.push(String(match.elementId) + ':no-overlap');
      }
    } else {
      bboxMode = 'window-confined';
      const win = raw.window || { x: 0, y: 0, width: 0, height: 0 };
      for (const match of matches) {
        const box = match.bbox || { x: 0, y: 0, width: 0, height: 0 };
        const inside = box.width > 0 && box.height > 0 && box.x >= win.x - 1 && box.y >= win.y - 1 && box.x + box.width <= win.x + win.width + 1 && box.y + box.height <= win.y + win.height + 1;
        if (!inside) bboxFailures.push(String(match.elementId) + ':out-of-window');
      }
    }
    const scores = matches.map((m) => m.score);
    const scoresOk = scores.every((value) => value >= MIN_SCORE);
    const timings = raw.timings || {};
    const timingValues = [timings.observeMs, timings.captureMs, timings.ocrMs, timings.fusionMs, timings.buildMs];
    const timingsOk = timingValues.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0);
    const caps = raw.capabilities || {};
    const ok = raw.channel === 'fusion' && caps.capture === true && caps.ocr === true && matches.length > 0 && missingIds.length === 0 && scoresOk && bboxFailures.length === 0 && timingsOk;
    const detail = 'channel=' + String(raw.channel) + ' degraded=' + String(raw.degraded) + ' matches=' + matches.length + ' ids_ok=' + (missingIds.length === 0) + ' scores=' + scores.join(',') + ' bbox_mode=' + bboxMode + ' scale=' + scale.toFixed(3) + ' bbox_fail=' + bboxFailures.join('|') + ' timings=' + timingValues.join('/');
    return { ok, detail };
  });

  await guard(3, 'no-query reconciliation', async () => {
    const call = calls.all;
    if (!call || call.error) return { ok: false, detail: 'locate failed: ' + callFailure(call) };
    const raw = call.value;
    const matches = raw.matches || [];
    const textOnly = raw.textOnly || [];
    const ids = matches.map((m) => String(m.elementId));
    const unique = new Set(ids).size === ids.length;
    const scores = matches.map((m) => m.score);
    let monotonic = true;
    for (let i = 1; i < scores.length; i += 1) if (scores[i] > scores[i - 1]) monotonic = false;
    const totalsOk = raw.truncated === true ? raw.totalMatches >= matches.length && raw.totalTextOnly >= textOnly.length : raw.totalMatches === matches.length && raw.totalTextOnly === textOnly.length;
    const ok = raw.query === null && unique && monotonic && matches.length <= 50 && textOnly.length <= 20 && totalsOk;
    const detail = 'query=' + JSON.stringify(raw.query) + ' matches=' + matches.length + ' unique=' + unique + ' monotonic=' + monotonic + ' textOnly=' + textOnly.length + ' truncated=' + String(raw.truncated) + ' totals=' + raw.totalMatches + '/' + raw.totalTextOnly;
    return { ok, detail };
  });

  await guard(4, 'response budget + strict validator', async () => {
    const entries = [['pos', calls.pos], ['all', calls.all], ['empty', calls.empty]];
    const sizes = [];
    const problems = [];
    for (const entry of entries) {
      const tag = entry[0];
      const call = entry[1];
      if (!call || call.error) { problems.push(tag + ':call-error'); continue; }
      const bytes = Buffer.byteLength(JSON.stringify(call.value), 'utf8');
      sizes.push(tag + '=' + bytes);
      if (bytes > MAX_FRAME_BYTES) problems.push(tag + ':over-frame(' + bytes + ')');
      if (bytes > MAX_LOCATE_SOFT_BYTES) problems.push(tag + ':over-soft(' + bytes + ')');
      try { locateResult(call.value); } catch (error) { problems.push(tag + ':validator(' + (error && error.message ? error.message : String(error)) + ')'); }
    }
    return { ok: problems.length === 0, detail: 'bytes=' + sizes.join(',') + ' soft=' + MAX_LOCATE_SOFT_BYTES + ' frame=' + MAX_FRAME_BYTES + ' problems=' + problems.join('|') };
  });

  await guard(5, 'capabilities + degraded contract', async () => {
    const call = calls.pos;
    if (!call || call.error) return { ok: false, detail: 'locate failed: ' + callFailure(call) };
    const raw = call.value;
    const caps = raw.capabilities || {};
    const capKeys = Object.keys(caps).sort().join(',');
    const capsShapeOk = capKeys === 'capture,grounding,ocr' && typeof caps.capture === 'boolean' && typeof caps.ocr === 'boolean' && typeof caps.grounding === 'boolean';
    const channelOk = raw.channel === 'fusion' || raw.channel === 'uia_only';
    const degradedOk = raw.degraded === true ? typeof raw.degradeReason === 'string' && raw.degradeReason.length > 0 : raw.degraded === false && raw.degradeReason === null;
    const ok = capsShapeOk && caps.grounding === false && channelOk && typeof raw.degraded === 'boolean' && degradedOk;
    const detail = 'caps=' + JSON.stringify(caps) + ' channel=' + String(raw.channel) + ' degraded=' + String(raw.degraded) + ' reason=' + String(raw.degradeReason);
    return { ok, detail };
  });

  await guard(6, 'empty-result honesty', async () => {
    const call = calls.empty;
    if (!call || call.error) return { ok: false, detail: 'locate failed: ' + callFailure(call) };
    const raw = call.value;
    const ok = Array.isArray(raw.matches) && raw.matches.length === 0 && Array.isArray(raw.textOnly) && raw.textOnly.length === 0;
    return { ok, detail: 'matches=' + (raw.matches || []).length + ' textOnly=' + (raw.textOnly || []).length + ' channel=' + String(raw.channel) + ' truncated=' + String(raw.truncated) };
  });

  await guard(7, 'parameter validation', async () => {
    const notDecimal = await request('locate', { hwnd: 'abc' }, 10000).then(() => null, (error) => error);
    const negative = await request('locate', { hwnd: '-1' }, 10000).then(() => null, (error) => error);
    const missingWindow = await request('locate', { hwnd: '99999999' }, 15000).then(() => null, (error) => error);
    const allowed = ['INVALID_ARGUMENT', 'UIA_ERROR', 'CONTEXT_CHANGED'];
    const messageOk = (error) => !!error && typeof error.message === 'string' && error.message.length > 0;
    const ok = !!notDecimal && notDecimal.code === 'INVALID_ARGUMENT' && messageOk(notDecimal) && !!negative && negative.code === 'INVALID_ARGUMENT' && messageOk(negative) && !!missingWindow && allowed.includes(missingWindow.code) && messageOk(missingWindow);
    const code = (error) => error ? String(error.code) + '(' + String(error.message).slice(0, 80) + ')' : 'ACCEPTED';
    return { ok, detail: 'abc=' + code(notDecimal) + ' -1=' + code(negative) + ' absent=' + code(missingWindow) };
  });

  await guard(8, 'zero-injection evidence', async () => {
    const stateBefore = runPs1('state');
    const labelsBefore = ((await request('observe', { hwnd: textHwnd }, 10000)).elements || []).map((el) => String(el.label || '')).sort().join('|');
    const locateError = await request('locate', { hwnd: textHwnd, query: '保存' }, 25000).then(() => null, (error) => error);
    const stateAfter = runPs1('state');
    const labelsAfter = ((await request('observe', { hwnd: textHwnd }, 10000)).elements || []).map((el) => String(el.label || '')).sort().join('|');
    const cursorStable = Number(stateBefore.cursorX) === Number(stateAfter.cursorX) && Number(stateBefore.cursorY) === Number(stateAfter.cursorY);
    const foregroundStable = String(stateBefore.fg) === String(stateAfter.fg);
    const labelsStable = labelsBefore === labelsAfter;
    const ok = !locateError && cursorStable && foregroundStable && labelsStable;
    const detail = 'cursor=' + stateBefore.cursorX + ',' + stateBefore.cursorY + '->' + stateAfter.cursorX + ',' + stateAfter.cursorY + ' fg=' + stateBefore.fg + '->' + stateAfter.fg + ' labels_stable=' + labelsStable + ' locate_error=' + (locateError ? String(locateError.code) : 'none');
    return { ok, detail };
  });

  await guard(9, 'vision-only text (drawn fixture)', async () => {
    const drawnFixture = startFixture('locate-drawn');
    await waitFixture(drawnFixture);
    runPs1('fix', { Hwnd: drawnFixture.hwnd, X: FIXTURE_POS.x, Y: FIXTURE_POS.y });
    await sleep(300);
    const drawnObserve = await request('observe', { hwnd: drawnFixture.hwnd }, 10000);
    const drawnRaw = await request('locate', { hwnd: drawnFixture.hwnd }, 25000);
    const drawnLabels = (drawnObserve.elements || []).map((el) => String(el.label || '')).join('|');
    const hits = (drawnRaw.textOnly || []).filter((line) => String(line.text).includes('绘制文字') && String(line.text).includes('仅视觉可见'));
    const ok = hits.length > 0 && !drawnLabels.includes('绘制文字');
    const hit = hits[0] || null;
    const detail = 'channel=' + String(drawnRaw.channel) + ' textOnly=' + (drawnRaw.textOnly || []).length + ' hit=' + JSON.stringify(hit ? { text: hit.text, bbox: hit.bbox, score: hit.score } : null) + ' uia_labels=' + JSON.stringify((drawnObserve.elements || []).map((el) => el.label));
    return { ok, detail };
  });

  await guard(10, 'snapshot does not inflate', async () => {
    const statusAfter = await request('status', {}, 8000);
    const rowBefore = statusRow(statusBefore, textHwnd);
    const rowAfter = statusRow(statusAfter, textHwnd);
    const baseline = rowBefore ? rowBefore.elements : observeReply.totalElements;
    const ok = !!rowAfter && rowAfter.elements === baseline;
    const detail = 'elements=' + (rowBefore ? String(rowBefore.elements) : 'absent') + '/' + String(baseline) + '->' + (rowAfter ? String(rowAfter.elements) : 'missing') + ' version=' + (rowBefore ? String(rowBefore.version) : '?') + '->' + (rowAfter ? String(rowAfter.version) : '?') + ' observe_total=' + observeReply.totalElements;
    return { ok, detail };
  });
} catch (error) {
  console.log('ERROR harness aborted: ' + (error && error.stack ? error.stack : String(error)));
} finally {
  for (const fixture of fixtures) {
    if (fixture.pid) {
      try { spawnSync('taskkill', ['/PID', String(fixture.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true }); } catch (error) { void error; }
    }
    try { fixture.child.kill(); } catch (error) { void error; }
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (error) { void error; }
  try { await s.stop(); } catch (error) { void error; }
}
console.log('locate: ' + passed + '/10 PASS');
process.exit(passed === 10 ? 0 : 1);
