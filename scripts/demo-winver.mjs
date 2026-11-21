import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { apply } from '../dist/index.js';

// The live Host session keeps approval prompts disabled ("never"), so the gate
// would fail closed. This script exercises the plugin's real tools in its
// documented test mode: REPLACER_BYPASS_APPROVAL=true records every write as
// "bypassed" in the audit ring instead of asking for a card.
process.env.REPLACER_BYPASS_APPROVAL = 'true';

function cursor() {
  return execFileSync('powershell', ['-NoProfile', '-Command',
    'Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; "$($p.X),$($p.Y)"'],
    { encoding: 'utf8' }).trim();
}
function isWindow(hwnd) {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    `Add-Type -Namespace W -Name N -MemberDefinition '[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);'; [W.N]::IsWindow([IntPtr]${hwnd})`],
    { encoding: 'utf8' }).trim();
  return out === 'True';
}

const defs = new Map();
let dispose;
const ctx = {
  tools: { view: () => ({ knownNames: new Set() }), register: d => { defs.set(d.name, d); return () => {}; } },
  on: (event, cb) => { if (event === 'dispose') dispose = cb; },
  get: name => name === 'approval' ? { request: async () => { throw Error('approval channel must not be used in bypass mode'); } } : undefined,
};
apply(ctx);

const windows = defs.get('replacer_windows');
const observe = defs.get('replacer_observe');
const click = defs.get('replacer_click_by_id');
const status = defs.get('replacer_status');
assert.ok(windows && observe && click && status);

const before = await windows.execute({});
const known = new Set((before.windows ?? []).map(w => w.hwnd));
console.log(JSON.stringify({ step: 'windows-before', count: (before.windows ?? []).length }));

spawn('winver', [], { detached: true, stdio: 'ignore' }).unref();

let target = null;
for (let i = 0; i < 50 && target === null; i += 1) {
  await new Promise(r => setTimeout(r, 200));
  const now = await windows.execute({});
  target = (now.windows ?? []).find(w => !known.has(w.hwnd) && /Windows/i.test(w.label)) ?? null;
}
assert.ok(target, 'winver window did not appear');
console.log(JSON.stringify({ step: 'windows-after', hwnd: target.hwnd, label: target.label }));

// replacer_observe: read-only, no approval.
const model = await observe.execute({ hwnd: target.hwnd, limit: 200 });
assert.equal(model.ok, true, model.message);
const nodes = model.page.elements;
const okButton = nodes.find(n => /^(确定|OK)$/.test(n.label));
assert.ok(okButton, 'no 确定/OK button in the observed model');
console.log(JSON.stringify({
  step: 'observe', hwnd: target.hwnd, version: model.page.version, total: model.page.totalElements,
  observeMs: model.page.observeMs, elements: nodes.map(n => ({ id: n.id, type: n.type, label: n.label, invokable: n.invokable, bbox: n.bbox })),
}, null, 0));

// replacer_click_by_id: approval-gated (bypassed here), UIA InvokePattern only.
const cursorBefore = cursor();
const result = await click.execute({ hwnd: target.hwnd, elementId: okButton.id }, { agent: {}, callId: 'demo-winver' });
const cursorAfter = cursor();
console.log(JSON.stringify({ step: 'click', ok: result.ok, code: result.code, message: result.message, click: result.click, approval: result.approval, bypassed: result.bypassed }));

const alive = isWindow(target.hwnd);
const audit = await status.execute({});
console.log(JSON.stringify({
  step: 'assert', windowClosed: !alive, cursor: { before: cursorBefore, after: cursorAfter, unchanged: cursorBefore === cursorAfter },
  recentAudit: audit.approvals?.slice(0, 3), tier: audit.status?.tier, l2: audit.status?.l2, l3: audit.status?.l3,
}));

assert.equal(result.ok, true, result.message);
assert.equal(result.click?.method, 'l1_invoke');
assert.equal(result.click?.accepted, true);
assert.equal(alive, false, 'winver window must be closed by the click');
assert.equal(cursorAfter, cursorBefore, 'physical cursor must not move');
console.log(JSON.stringify({ result: 'PASS', label: okButton.label, elementId: okButton.id }));
await dispose?.();
process.exit(0);
