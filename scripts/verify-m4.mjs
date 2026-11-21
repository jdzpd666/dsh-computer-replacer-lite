import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { apply } from '../dist/index.js';

const hwnd = process.argv[2];
if (!/^[0-9]+$/.test(hwnd ?? '')) throw Error('Usage: node scripts/verify-m4.mjs <HWND> [--click <elementId>] [--approve]');
const clickAt = process.argv.indexOf('--click');
const wanted = clickAt > 0 ? process.argv[clickAt + 1] : null;
const approve = process.argv.includes('--approve');

// External assertion lane: Win32 only, never through the plugin.
function isWindow() {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    `Add-Type -Namespace W -Name N -MemberDefinition '[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);'; [W.N]::IsWindow([IntPtr]${hwnd})`],
    { encoding: 'utf8' }).trim();
  return out === 'True';
}
function cursor() {
  return execFileSync('powershell', ['-NoProfile', '-Command',
    'Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; "$($p.X),$($p.Y)"'],
    { encoding: 'utf8' }).trim();
}

const defs = new Map();
let dispose;
let asked = 0;
let answer = 'rejected';
const ctx = {
  tools: { view: () => ({ knownNames: new Set() }), register: definition => { defs.set(definition.name, definition); return () => {}; } },
  on: (event, callback) => { if (event === 'dispose') dispose = callback; },
  get: name => name === 'approval' ? { request: async () => { asked += 1; return answer; } } : undefined,
};

apply(ctx);
const click = defs.get('replacer_click_by_id');
const status = defs.get('replacer_status');
const observe = defs.get('replacer_observe');
assert.ok(click && status && observe, 'plugin registered its tools');

async function connected() {
  for (let i = 0; i < 60; i += 1) {
    const s = await status.execute({});
    if (s.workerConnected) return s;
    await new Promise(r => setTimeout(r, 150));
  }
  throw Error('worker never connected');
}
await connected();

// Invalid arguments must fail before any card or any worker call.
const invalid = await click.execute({}, { agent: {} });
assert.equal(invalid.code, 'INVALID_ARGUMENT');
assert.equal(asked, 0, 'invalid arguments must not ask for approval');

const model = await observe.execute({ hwnd, limit: 200 });
const nodes = model.page.elements.filter(n => !n.offscreen && n.invokable);
console.log(JSON.stringify({ step: 'observe', hwnd, total: model.page.totalElements, invokable: nodes.length, sample: nodes.slice(0, 6).map(n => ({ id: n.id, label: n.label })) }));
const elementId = wanted ?? nodes[0]?.id;
assert.ok(elementId, 'no invokable element to click');

// Reject path: the card is answered no, so zero input must happen.
answer = 'rejected';
const before = cursor();
const rejected = await click.execute({ hwnd, elementId }, { agent: {}, callId: 'm4-reject' });
const afterReject = cursor();
assert.equal(rejected.ok, false);
assert.equal(rejected.code, 'REJECTED');
assert.equal(rejected.approval.outcome, 'rejected');
assert.equal(asked, 1, 'one card for one click');
assert.equal(afterReject, before, 'physical cursor must not move');
assert.equal(isWindow(), true, 'window must stay open after a rejected click');
console.log(JSON.stringify({ step: 'rejected', elementId, code: rejected.code, approval: rejected.approval, windowAlive: true, cursor: { before, after: afterReject } }));

const audits = await status.execute({});
assert.equal(audits.approvals[0].outcome, 'rejected');

if (!approve) {
  console.log(JSON.stringify({ result: 'PASS', mode: 'reject-only', note: 'rerun with --approve to verify the granted path' }));
} else {
  answer = 'allowed-once';
  const granted = await click.execute({ hwnd, elementId }, { agent: {}, callId: 'm4-grant' });
  const after = cursor();
  assert.equal(granted.ok, true, granted.message ?? 'grant path failed');
  assert.equal(granted.click.accepted, true);
  assert.equal(granted.click.method, 'l1_invoke');
  assert.equal(after, before, 'physical cursor must not move during a granted click either');
  assert.equal(isWindow(), false, 'the invoked button must have taken effect');
  console.log(JSON.stringify({ step: 'granted', elementId, click: granted.click, approval: granted.approval, windowAlive: false, cursor: { before, after } }));
  console.log(JSON.stringify({ result: 'PASS', mode: 'reject+grant' }));
}
await dispose();
