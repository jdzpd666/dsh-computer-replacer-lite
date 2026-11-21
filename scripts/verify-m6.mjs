// M6 end-to-end run: a 20+ step task against a Win32 application plus winver. The plugin does
// every write; assertions are made by outside processes (files the app wrote itself, scroll
// percentage read by a probe, physical cursor, IsWindow).
//   node scripts/verify-m6.mjs
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'scripts/fixtures');
const work = mkdtempSync(path.join(tmpdir(), 'replacer-m6-'));
// The explicit, opt-in test switch; nothing in the shipped code is bypassed by default.
process.env.REPLACER_BYPASS_APPROVAL = 'true';
const { apply } = await import('../dist/index.js');

const defs = new Map();
let dispose;
let asked = 0;
apply({
  tools: { view: () => ({ knownNames: new Set() }), register: (definition) => { defs.set(definition.name, definition); return () => {}; } },
  on: (event, callback) => { if (event === 'dispose') dispose = callback; },
  get: (name) => name === 'approval' ? { request: async () => { asked += 1; return 'allowed-once'; } } : undefined,
});
let calls = 0;
const tool = (name) => {
  const definition = defs.get(name);
  assert.ok(definition, name + ' is registered');
  return { ...definition, execute: (...args) => { calls += 1; return definition.execute(...args); } };
};
const exec = { agent: { id: 'verify-m6' }, callId: 'verify-m6' };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function powershell(script) { return execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim(); }
function isWindow(hwnd) { return powershell('Add-Type -Namespace W -Name N -MemberDefinition \'[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);\'; [W.N]::IsWindow([IntPtr]' + hwnd + ')') === 'True'; }
function cursor() { return powershell('Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; "$($p.X),$($p.Y)"'); }
function activate(hwnd) { return execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(fixtures, 'activate.ps1'), '-Hwnd', String(hwnd)], { encoding: 'utf8' }).trim(); }
function foregroundHwnd() { return powershell('Add-Type -Namespace W -Name F -MemberDefinition \'[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();\'; [W.F]::GetForegroundWindow().ToInt64()'); }
// Switching windows is the user's move, so the test does it explicitly before observing.
async function ensureForeground(hwnd) {
  for (let index = 0; index < 10; index += 1) {
    if (foregroundHwnd() === String(hwnd)) return true;
    activate(hwnd);
    await sleep(400);
  }
  return foregroundHwnd() === String(hwnd);
}
function probeScroll(hwnd, ...extra) {
  const exe = path.join(root, 'worker/target/release/examples/scroll_probe.exe');
  return execFileSync(exe, [hwnd, ...extra], { encoding: 'utf8' }).trim();
}
// "SCROLL_PATTERN id=r:[42,1] horizontal=(0,100) vertical=(12.5,13)"
function parseProbe(line) {
  const parts = (line ?? '').split(' ');
  if (parts[0] !== 'SCROLL_PATTERN' || parts.length < 4) return null;
  const numbers = (token) => token.slice(token.indexOf('(') + 1, -1).split(',').map(Number);
  const [h, hview] = numbers(parts[2]);
  const [v, vview] = numbers(parts[3]);
  return { id: parts[1].slice(3), h, hview, v, vview };
}
const children = [];
function startFixture(scriptName, args) {
  const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(fixtures, scriptName), ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  children.push(child);
  return child;
}
async function windowWhere(predicate, label, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    const windows = await tool('replacer_windows').execute({}, exec);
    if (windows.ok) {
      const found = windows.windows.find(predicate);
      if (found) return found;
    }
    await sleep(250);
  }
  throw Error('window never appeared: ' + label);
}
async function observeAll(hwnd) {
  const first = await tool('replacer_observe').execute({ hwnd, limit: 200 }, exec);
  if (!first.ok) return first;
  const elements = [...first.page.elements];
  let page = first.page;
  while (page.nextOffset !== null && page.nextOffset !== undefined) {
    const next = await tool('replacer_observe').execute({ hwnd, snapshotId: page.snapshotId, offset: page.nextOffset, limit: 200 }, exec);
    if (!next.ok) return next;
    elements.push(...next.page.elements);
    page = next.page;
  }
  return { ...first, page: { ...page, elements } };
}
async function connected() {
  for (let index = 0; index < 80; index += 1) {
    const status = await tool('replacer_status').execute({}, exec);
    if (status.workerConnected && status.status) return status;
    await sleep(150);
  }
  throw Error('worker never connected');
}
const logLines = (file) => existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean) : [];

const evidence = [];
let seq = 0;
const record = (line) => { seq += 1; evidence.push({ seq, ...line }); };
const cursorBefore = cursor();
const writes = [];

try {
  // 1-2: read-only surface.
  const status = await connected();
  assert.equal(status.status.tier, 'L1');
  assert.equal(status.status.l2, false);
  assert.equal(status.status.l3, false);
  assert.equal(status.bypassed, true);
  record({ step: 'status', tier: status.status.tier, l2: status.status.l2, l3: status.status.l3, bypassed: status.bypassed, pid: status.status.pid });

  const deskOut = path.join(work, 'desk.json');
  const deskLog = path.join(work, 'desk.log');
  const desk = startFixture('desk.ps1', ['-Name', 'DESK', '-Out', deskOut, '-Log', deskLog, '-Nodes', '200']);
  const deskInfo = await windowWhere((w) => w.label === 'REPLACER_FIXTURE_DESK', 'REPLACER_FIXTURE_DESK');
  record({ step: 'windows', hwnd: deskInfo.hwnd, label: deskInfo.label, enabled: deskInfo.enabled });
  await sleep(1200);
  assert.equal(await ensureForeground(deskInfo.hwnd), true, 'the fixture window must be in front before observing');

  // 3: full world model with pagination.
  const model = await observeAll(deskInfo.hwnd);
  assert.equal(model.ok, true, 'desk observe failed');
  const nodes = model.page.elements;
  const edit = nodes.find((n) => n.type === 50004);
  const button = (label) => nodes.find((n) => n.type === 50000 && n.label === label);
  const alpha = button('APPEND_ALPHA');
  const beta = button('APPEND_BETA');
  const save = button('SAVE');
  assert.ok(edit && alpha && beta && save, 'desk controls are observable');
  record({ step: 'observe', hwnd: deskInfo.hwnd, totalElements: model.page.totalElements, version: model.page.version, edit: edit.id, alpha: alpha.id, beta: beta.id, save: save.id });

  // 4-5: Invoke mutates the app; the app itself logs the click.
  writes.push(await tool('replacer_click_by_id').execute({ hwnd: deskInfo.hwnd, elementId: alpha.id }, exec));
  assert.equal(writes.at(-1).ok, true, JSON.stringify(writes.at(-1)));
  assert.equal(writes.at(-1).click.method, 'l1_invoke');
  await sleep(250);
  assert.deepEqual(logLines(deskLog), ['APPEND_ALPHA']);
  record({ step: 'click-alpha', method: writes.at(-1).click.method, appLog: logLines(deskLog) });

  // 6: ValuePattern replaces the whole value; the next click appends to it.
  const typed1 = await tool('replacer_type').execute({ hwnd: deskInfo.hwnd, elementId: edit.id, text: '第一段 ' }, exec);
  assert.equal(typed1.ok, true, JSON.stringify(typed1));
  assert.equal(typed1.write.method, 'l1_value');
  assert.equal(typed1.write.characters, 4);
  writes.push(typed1);
  record({ step: 'type-1', characters: typed1.write.characters, method: typed1.write.method });

  writes.push(await tool('replacer_click_by_id').execute({ hwnd: deskInfo.hwnd, elementId: beta.id }, exec));
  assert.equal(writes.at(-1).ok, true);
  await sleep(250);
  assert.deepEqual(logLines(deskLog), ['APPEND_ALPHA', 'APPEND_BETA']);

  const typed2 = await tool('replacer_type').execute({ hwnd: deskInfo.hwnd, elementId: edit.id, text: '第二段 覆盖测试' }, exec);
  assert.equal(typed2.ok, true, JSON.stringify(typed2));
  writes.push(typed2);
  record({ step: 'type-2', characters: typed2.write.characters, semantics: 'set-value replaces the whole field' });

  // 7-8: a second observation must carry a newer model version.
  const model2 = await observeAll(deskInfo.hwnd);
  assert.equal(model2.ok, true);
  assert.ok(model2.page.version >= model.page.version, 'model version must not go backwards');
  record({ step: 'observe-again', version: model2.page.version, totalElements: model2.page.totalElements });

  // 9-11: scroll through the tree view, verified by an external ScrollPattern probe that reads
  // exactly the element the plugin scrolled (the window also has a text box with a scroll pattern).
  const candidates = probeScroll(deskInfo.hwnd, '--all').split(/\r?\n/).map(parseProbe).filter(Boolean);
  const scrollTarget = candidates.find((entry) => nodes.some((n) => n.id === entry.id) && entry.vview < 100)
    ?? candidates.find((entry) => nodes.some((n) => n.id === entry.id));
  assert.ok(scrollTarget, 'a scrollable element must be addressable in the world model: ' + JSON.stringify(candidates));
  const readPercent = () => parseProbe(probeScroll(deskInfo.hwnd, '--id', scrollTarget.id)).v;
  const percentBefore = readPercent();
  const down1 = await tool('replacer_scroll').execute({ hwnd: deskInfo.hwnd, elementId: scrollTarget.id, vertical: 'down', steps: 1 }, exec);
  assert.equal(down1.ok, true, JSON.stringify(down1));
  assert.equal(down1.write.method, 'l1_scroll');
  writes.push(down1);
  await sleep(350);
  const percentDown1 = readPercent();
  assert.ok(percentDown1 > percentBefore, percentBefore + ' -> ' + percentDown1);
  const down2 = await tool('replacer_scroll').execute({ hwnd: deskInfo.hwnd, elementId: scrollTarget.id, vertical: 'down', steps: 1 }, exec);
  assert.equal(down2.ok, true);
  writes.push(down2);
  await sleep(350);
  const percentDown2 = readPercent();
  assert.ok(percentDown2 > percentDown1, percentDown1 + ' -> ' + percentDown2);
  const up1 = await tool('replacer_scroll').execute({ hwnd: deskInfo.hwnd, elementId: scrollTarget.id, vertical: 'up', steps: 1 }, exec);
  assert.equal(up1.ok, true);
  writes.push(up1);
  await sleep(350);
  const percentUp = readPercent();
  assert.ok(percentUp < percentDown2, percentDown2 + ' -> ' + percentUp);
  record({ step: 'scroll', elementId: scrollTarget.id, viewSize: scrollTarget.vview, series: [percentBefore, percentDown1, percentDown2, percentUp] });

  // 12: unknown identity is a stale model, not an input attempt.
  const stale = await tool('replacer_click_by_id').execute({ hwnd: deskInfo.hwnd, elementId: 'r:[1234567,7654321]' }, exec);
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'STALE_STATE');
  record({ step: 'stale', code: stale.code });

  // 13-14: a different foreground window must forbid the write, and nothing may be injected.
  const thief = startFixture('tree.ps1', ['-Name', 'THIEF', '-Nodes', '5']);
  const thiefInfo = await windowWhere((w) => w.label === 'REPLACER_FIXTURE_THIEF', 'REPLACER_FIXTURE_THIEF');
  await sleep(1500);
  const blocked = await tool('replacer_click_by_id').execute({ hwnd: deskInfo.hwnd, elementId: alpha.id }, exec);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'CONTEXT_CHANGED');
  assert.deepEqual(logLines(deskLog), ['APPEND_ALPHA', 'APPEND_BETA'], 'no click may reach the app');
  assert.equal(isWindow(deskInfo.hwnd), true);
  record({ step: 'context-block', code: blocked.code, target: deskInfo.hwnd, foreground: thiefInfo.hwnd, appLog: logLines(deskLog) });

  // 15-17: switch back like a user would, re-ground, then keep going.
  const activation = activate(deskInfo.hwnd);
  record({ step: 'activate', result: activation });
  await sleep(900);
  const model3 = await observeAll(deskInfo.hwnd);
  assert.equal(model3.ok, true, 'observe after refocus failed');
  const edit3 = model3.page.elements.find((n) => n.type === 50004);
  const alpha3 = model3.page.elements.find((n) => n.type === 50000 && n.label === 'APPEND_ALPHA');
  const typed3 = await tool('replacer_type').execute({ hwnd: deskInfo.hwnd, elementId: edit3.id, text: '第三段' }, exec);
  assert.equal(typed3.ok, true, JSON.stringify(typed3));
  writes.push(typed3);
  writes.push(await tool('replacer_click_by_id').execute({ hwnd: deskInfo.hwnd, elementId: alpha3.id }, exec));
  assert.equal(writes.at(-1).ok, true, JSON.stringify(writes.at(-1)));
  await sleep(250);
  assert.deepEqual(logLines(deskLog), ['APPEND_ALPHA', 'APPEND_BETA', 'APPEND_ALPHA']);
  record({ step: 'resume', characters: typed3.write.characters, appLog: logLines(deskLog) });

  // 18-20: save, then read what the application itself wrote.
  const saveClick = await tool('replacer_click_by_id').execute({ hwnd: deskInfo.hwnd, elementId: save.id }, exec);
  assert.equal(saveClick.ok, true, JSON.stringify(saveClick));
  writes.push(saveClick);
  await new Promise((resolve) => { if (desk.exitCode !== null) return resolve(); desk.once('exit', resolve); setTimeout(resolve, 8000); });
  assert.equal(isWindow(deskInfo.hwnd), false, 'SAVE closes the fixture');
  const payload = JSON.parse(readFileSync(deskOut, 'utf8'));
  assert.equal(payload.text, '第三段 [ALPHA]', 'the field holds exactly what the plugin set and the app appended');
  assert.deepEqual(payload.appendLog, ['APPEND_ALPHA', 'APPEND_BETA', 'APPEND_ALPHA'], 'SAVE logs itself after the dump');
  const treeTopIndex = Number(/node (\d+)/.exec(payload.treeTop)[1]);
  assert.ok(treeTopIndex > 1, 'the tree view really scrolled: top node is ' + payload.treeTop);
  record({ step: 'save', text: payload.text, appends: payload.appendLog, treeTop: payload.treeTop });

  const afterSave = await tool('replacer_windows').execute({}, exec);
  assert.equal(afterSave.ok, true);
  assert.equal(afterSave.windows.some((w) => w.label === 'REPLACER_FIXTURE_DESK'), false);
  record({ step: 'windows-after-save', remaining: afterSave.windows.length });

  // 21-22: a real Windows dialog, not a fixture.
  const winver = spawn('winver.exe', [], { stdio: 'ignore', windowsHide: false });
  children.push(winver);
  // The dialog's title is localized (“关于“Windows””); match that shape, not any window that mentions Windows.
  const winverInfo = await windowWhere((w) => /^关于.*Windows/.test(w.label) && w.hwnd !== deskInfo.hwnd, 'winver');
  await sleep(1200);
  assert.equal(await ensureForeground(winverInfo.hwnd), true, 'the real dialog must be in front before observing');
  const winverModel = await observeAll(winverInfo.hwnd);
  assert.equal(winverModel.ok, true, 'winver observe failed: ' + JSON.stringify(winverModel.code ?? winverModel.page?.totalElements));
  const winverButton = winverModel.page.elements.find((n) => n.type === 50000);
  assert.ok(winverButton, 'winver exposes a button');
  const winverClick = await tool('replacer_click_by_id').execute({ hwnd: winverInfo.hwnd, elementId: winverButton.id }, exec);
  assert.equal(winverClick.ok, true, JSON.stringify(winverClick));
  writes.push(winverClick);
  const closed = await (async () => { for (let i = 0; i < 40; i += 1) { if (!isWindow(winverInfo.hwnd)) return true; await sleep(100); } return false; })();
  assert.equal(closed, true, 'the real dialog closed after Invoke');
  record({ step: 'winver', hwnd: winverInfo.hwnd, button: winverButton.label, method: winverClick.click.method, closed });

  // 23-25: whole-run invariants.
  const finalStatus = await tool('replacer_status').execute({}, exec);
  assert.equal(finalStatus.workerConnected, true);
  assert.equal(finalStatus.bypassed, true);
  const outcomes = finalStatus.approvals.map((entry) => entry.outcome);
  assert.equal(outcomes.every((outcome) => outcome === 'bypassed'), true, JSON.stringify(outcomes));
  assert.equal(asked, 0, 'the bypass must never reach the approval channel');
  const cursorAfter = cursor();
  assert.equal(cursorAfter, cursorBefore, 'physical cursor must not move for the whole run');
  record({ step: 'audit', recentAudit: outcomes.length, outcomes: [...new Set(outcomes)], writes, asked, cursor: { before: cursorBefore, after: cursorAfter } });
  record({ step: 'status-final', workerConnected: finalStatus.workerConnected, tier: finalStatus.status.tier, worlds: finalStatus.status.worlds.length });

  console.log(evidence.map((line) => JSON.stringify(line)).join('\n'));
  console.log(JSON.stringify({ result: 'PASS', steps: evidence.length, writes: writes.length, toolCalls: calls }));
} finally {
  await dispose?.();
  for (const child of children) { try { child.kill(); } catch {} }
}
