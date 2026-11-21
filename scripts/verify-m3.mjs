import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Supervisor } from '../dist/worker/supervisor.js';
const hwnd = process.argv[2];
if (!/^[0-9]+$/.test(hwnd ?? '')) throw Error('Usage: node scripts/verify-m3.mjs <HWND> [--click <elementId>]');
const clickAt = process.argv.indexOf('--click');
const clickId = clickAt > 0 ? process.argv[clickAt + 1] : null;
// External assertion lane: physical cursor is read with Win32, never through the plugin.
function cursor() {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    'Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; "$($p.X),$($p.Y)"'],
    { encoding: 'utf8' }).trim();
  return out;
}
const worker = new Supervisor(resolve('dist/replacer-worker.exe'), 0);
worker.on('diagnostic', text => process.stderr.write(String(text)));
try {
  const ready = once(worker, 'ready', { signal: AbortSignal.timeout(10000) });
  worker.start(); await ready;
  const model = await worker.client.observe({ hwnd, limit: 200 });
  const nodes = model.elements.filter(n => !n.offscreen);
  const invokable = nodes.filter(n => n.invokable);
  console.log(JSON.stringify({ step: 'observe', hwnd, total: model.totalElements,
    visible: nodes.length, invokable: invokable.length,
    sample: invokable.slice(0, 8).map(n => ({ id: n.id, type: n.type, label: n.label })) }));
  // Negative path 1: an address that is not in the world model must never reach the provider.
  await assert.rejects(worker.client.request('click', { hwnd, elementId: 'r:[2147483647]' }, 8000),
    error => error.code === 'ELEMENT_NOT_INVOKABLE');
  // Negative path 2: a real, visible node without Invoke must fail before any injection.
  const plain = nodes.find(n => !n.invokable);
  if (plain) {
    await assert.rejects(worker.client.request('click', { hwnd, elementId: plain.id }, 8000),
      error => error.code === 'ELEMENT_NOT_INVOKABLE' || error.code === 'STALE_STATE');
    console.log(JSON.stringify({ step: 'reject-non-invokable', elementId: plain.id, label: plain.label }));
  }
  const still = await worker.client.observe({ hwnd, limit: 1 });
  assert.equal(still.hwnd, hwnd, 'worker must stay healthy after rejected clicks');
  if (clickId) {
    const before = cursor();
    const result = await worker.client.request('click', { hwnd, elementId: clickId }, 8000);
    const after = cursor();
    assert.equal(after, before, 'physical cursor must not move');
    console.log(JSON.stringify({ step: 'click', elementId: clickId, result, cursor: { before, after } }));
  }
  console.log(JSON.stringify({ result: 'PASS', hwnd, click: clickId ?? 'none' }));
} finally { await worker.stop(); }
