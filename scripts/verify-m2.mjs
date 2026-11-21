import assert from 'node:assert/strict';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Supervisor } from '../dist/worker/supervisor.js';
const hwnd = process.argv[2];
if (!/^[0-9]+$/.test(hwnd ?? '')) throw Error('Usage: node scripts/verify-m2.mjs <HWND>');
const worker = new Supervisor(resolve('dist/replacer-worker.exe'), 0);
worker.on('diagnostic', text => process.stderr.write(String(text)));
let watching = false;
try {
  const ready = once(worker, 'ready', { signal: AbortSignal.timeout(10000) });
  worker.start(); await ready;
  const first = await worker.client.observe({ hwnd });
  assert(first.elements.every(n => n.id.startsWith('r:') || n.id.startsWith('f:')));
  assert.equal(new Set(first.elements.map(n => n.id)).size, first.elements.length);
  await worker.client.request('watch', { hwnd }, 5000); watching = true;
  const end = Date.now() + 7500;
  let diffs = 0;
  while (Date.now() < end) {
    const result = await worker.client.request('events', {}, 6000);
    for (const row of result.events) {
      assert.notEqual(row.event, 'MODEL_REFRESH_FAILED', JSON.stringify(row));
      if (row.event === 'MODEL_DIFF') {
        for (const key of ['added', 'updated', 'removed']) assert(Array.isArray(row.diff[key]));
        diffs++;
      }
    }
    await delay(100);
  }
  assert(diffs >= 2, 'Expected two quiet verification batches');
  console.log(JSON.stringify({ result:'PASS', hwnd, elements:first.totalElements, modelDiffs:diffs }));
} finally {
  try { if (watching && worker.client.connected) await worker.client.request('unwatch', { hwnd }, 6000); }
  finally { await worker.stop(); }
}
