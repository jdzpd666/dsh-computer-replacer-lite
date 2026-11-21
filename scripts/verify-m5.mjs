// Live M5 verification against controlled Win32 fixtures. The plugin performs the writes;
// every side effect below is read back by an outside process, never through the plugin.
//   node scripts/verify-m5.mjs
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'scripts/fixtures');
const work = mkdtempSync(path.join(tmpdir(), 'replacer-m5-'));
// The explicit, opt-in test switch: without it every write would need a real approval card.
process.env.REPLACER_BYPASS_APPROVAL = 'true';
const { apply } = await import('../dist/index.js');

const defs = new Map();
let dispose;
let asked = 0;
apply({
  tools: { view: () => ({ knownNames: new Set() }), register: (definition) => { defs.set(definition.name, definition); return () => {}; } },
  on: (event, callback) => { if (event === 'dispose') dispose = callback; },
  // Any call here would prove the bypass leaked into the approval channel.
  get: (name) => name === 'approval' ? { request: async () => { asked += 1; return 'allowed-once'; } } : undefined,
});
const tool = (name) => { const definition = defs.get(name); assert.ok(definition, name + ' is registered'); return definition; };
const exec = { agent: { id: 'verify-m5' }, callId: 'verify-m5' };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function powershell(script) { return execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim(); }
function isWindow(hwnd) { return powershell('Add-Type -Namespace W -Name N -MemberDefinition \'[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);\'; [W.N]::IsWindow([IntPtr]' + hwnd + ')') === 'True'; }
function cursor() { return powershell('Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; "$($p.X),$($p.Y)"'); }
function probeScroll(hwnd) {
  const exe = path.join(root, 'worker/target/release/examples/scroll_probe.exe');
  return execFileSync(exe, [hwnd], { encoding: 'utf8' }).trim();
}
const children = [];
function startFixture(script, args) {
  const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(fixtures, script), ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  children.push(child);
  return child;
}
async function windowByLabel(label, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    const windows = await tool('replacer_windows').execute({}, exec);
    if (windows.ok) {
      const found = windows.windows.find((w) => w.label === label);
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
  // `complete` describes the captured snapshot; only nextOffset tells whether more pages exist.
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

const evidence = [];
try {
  const status = await connected();
  assert.equal(status.status.tier, 'L1');
  assert.equal(status.status.l2, false);
  assert.equal(status.status.l3, false);
  assert.equal(status.bypassed, true);
  evidence.push({ step: 'status', tier: status.status.tier, l2: status.status.l2, l3: status.status.l3, bypassed: status.bypassed, pid: status.status.pid });

  // Form fixture: text is entered through ValuePattern, then committed by Invoke.
  const out = path.join(work, 'form.txt');
  const form = startFixture('form.ps1', ['-Name', 'A', '-Out', out]);
  const info = await windowByLabel('REPLACER_FIXTURE_A');
  await sleep(1400);
  const model = await tool('replacer_observe').execute({ hwnd: info.hwnd, limit: 200 }, exec);
  assert.equal(model.ok, true);
  const nodes = model.page.elements;
  const edit = nodes.find((n) => n.type === 50004);
  const button = nodes.find((n) => n.type === 50000 && n.label === 'COMMIT');
  assert.ok(edit, 'fixture text box is observable');
  assert.ok(button, 'fixture commit button is observable');
  evidence.push({ step: 'observe', hwnd: info.hwnd, total: model.page.totalElements, edit: edit.id, button: button.id });

  const text = 'hello M5 中文 ' + Date.now();
  const before = cursor();
  const typed = await tool('replacer_type').execute({ hwnd: info.hwnd, elementId: edit.id, text }, exec);
  assert.equal(typed.ok, true, JSON.stringify(typed));
  assert.equal(typed.write.method, 'l1_value');
  assert.equal(typed.write.characters, [...text].length);
  assert.equal(typed.approval.outcome, 'bypassed');
  const clicked = await tool('replacer_click_by_id').execute({ hwnd: info.hwnd, elementId: button.id }, exec);
  assert.equal(clicked.ok, true, JSON.stringify(clicked));
  assert.equal(clicked.click.method, 'l1_invoke');
  await new Promise((resolve) => { if (form.exitCode !== null) return resolve(); form.once('exit', resolve); setTimeout(resolve, 8000); });
  const committed = readFileSync(out, 'utf8');
  assert.equal(committed, text, 'the target app itself reported the typed text');
  const after = cursor();
  assert.equal(after, before, 'physical cursor must not move');
  assert.equal(asked, 0, 'the bypass must never reach the approval channel');
  evidence.push({ step: 'type+click', textCharacters: [...text].length, method: clicked.click.method, committedBy: 'fixture app', cursor: { before, after } });

  // Unknown identity is a stale model, not an input attempt.
  const stale = await tool('replacer_click_by_id').execute({ hwnd: info.hwnd, elementId: 'r:[1234567,7654321]' }, exec);
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'STALE_STATE');
  evidence.push({ step: 'stale', code: stale.code, asked });

  // Scroll: an outside probe reads ScrollPattern before and after; only the plugin scrolls.
  const list = startFixture('tree.ps1', ['-Name', 'LIST', '-Nodes', '200']);
  const listInfo = await windowByLabel('REPLACER_FIXTURE_LIST');
  await sleep(1400);
  const listModel = await observeAll(listInfo.hwnd);
  assert.equal(listModel.ok, true, 'list observe failed: ' + JSON.stringify(listModel.code ?? listModel.page?.totalElements));
  const listNodes = listModel.page.elements;
  const beforeScroll = probeScroll(listInfo.hwnd);
  if (beforeScroll.startsWith('SCROLL_PATTERN id=')) {
    const id = /id=(r:\[[^\]]*\])/.exec(beforeScroll)[1];
    const target = listNodes.find((n) => n.id === id) ?? listNodes.find((n) => n.type === 50023);
    assert.ok(target, 'scroll probe element is addressable in the world model');
    const scrolled = await tool('replacer_scroll').execute({ hwnd: listInfo.hwnd, elementId: target.id, vertical: 'down', steps: 1 }, exec);
    assert.equal(scrolled.ok, true, JSON.stringify(scrolled));
    assert.equal(scrolled.write.method, 'l1_scroll');
    await sleep(400);
    const afterScroll = probeScroll(listInfo.hwnd);
    const percent = (line) => Number(/vertical=\(([-0-9.]+)/.exec(line)[1]);
    assert.ok(percent(afterScroll) > percent(beforeScroll), beforeScroll + ' -> ' + afterScroll);
    evidence.push({ step: 'scroll', elementId: target.id, before: beforeScroll, after: afterScroll, method: scrolled.write.method });
  } else {
    evidence.push({ step: 'scroll', skipped: 'fixture exposes no ScrollPattern', probe: beforeScroll });
  }

  // Context fingerprint: a different foreground window must forbid the write.
  const out2 = path.join(work, 'form2.txt');
  const form2 = startFixture('form.ps1', ['-Name', 'B', '-Out', out2]);
  const form2Info = await windowByLabel('REPLACER_FIXTURE_B');
  await sleep(1400);
  const model2 = await tool('replacer_observe').execute({ hwnd: form2Info.hwnd, limit: 200 }, exec);
  const button2 = model2.page.elements.find((n) => n.type === 50000 && n.label === 'COMMIT');
  assert.ok(button2, 'second fixture button is observable');
  const thief = startFixture('tree.ps1', ['-Name', 'THIEF', '-Nodes', '5']);
  const thiefInfo = await windowByLabel('REPLACER_FIXTURE_THIEF');
  await sleep(1800);
  const changed = await tool('replacer_click_by_id').execute({ hwnd: form2Info.hwnd, elementId: button2.id }, exec);
  assert.equal(changed.ok, false);
  assert.equal(changed.code, 'CONTEXT_CHANGED');
  assert.equal(existsSync(out2), false, 'no write may happen when the context moves');
  assert.equal(isWindow(form2Info.hwnd), true, 'the untouched fixture window is still open');
  evidence.push({ step: 'context', code: changed.code, target: form2Info.hwnd, foreground: thiefInfo.hwnd, committed: false });

  const finalStatus = await tool('replacer_status').execute({}, exec);
  assert.equal(finalStatus.bypassed, true);
  assert.equal(asked, 0);
  evidence.push({ step: 'audit', outcomes: finalStatus.approvals.slice(0, 6).map((entry) => entry.outcome), asked });
  console.log(evidence.map((line) => JSON.stringify(line)).join('\n'));
  console.log(JSON.stringify({ result: 'PASS', evidenceLines: evidence.length }));
} finally {
  await dispose?.();
  for (const child of children) { try { child.kill(); } catch {} }
}
