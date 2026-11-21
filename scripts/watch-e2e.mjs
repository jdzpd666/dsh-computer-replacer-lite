import { once } from 'node:events';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Supervisor } from '../dist/worker/supervisor.js';
const hwnd = process.argv[2];
if (!/^[0-9]+$/.test(hwnd ?? '') || BigInt(hwnd) === 0n) throw Error('Usage: node scripts/watch-e2e.mjs <decimal HWND>');
process.env.RUST_BACKTRACE = 'full';
const worker = new Supervisor(resolve('dist/replacer-worker.exe'), 0);
worker.on('diagnostic', message => {
  const text = String(message);
  process.stderr.write(`[worker ${new Date().toISOString()}] ${text}${text.endsWith('\n') ? '' : '\n'}`);
});
worker.on('exhausted', () => process.stderr.write('[worker] restart budget exhausted (restarts disabled)\n'));
let stopped = false, watched = false, count = 0;
process.once('SIGINT', () => { stopped = true; });
try {
  const ready = once(worker, 'ready', { signal: AbortSignal.timeout(10000) });
  worker.start(); await ready;
  console.log(await worker.client.request('observe', { hwnd, limit:2 }, 5000));
  console.log(await worker.client.request('watch', { hwnd }, 5000)); watched = true;
  console.log('For 60 seconds, manually type or change focus in the target. Do not submit commands. Ctrl+C stops.');
  const end = Date.now()+60000;
  while (!stopped && Date.now()<end) {
    const result = await worker.client.request('events', {}, 5000);
    for (const event of result.events) { console.log(JSON.stringify(event)); count++; }
    await delay(100);
  }
  console.log(JSON.stringify({capturedEvents:count, note:'MODEL_DIFF carries atomic model changes; UIA_EVENT is diagnostic; global focus may originate outside target.'}));
} finally {
  try { if (watched && worker.client.connected) console.log(await worker.client.request('unwatch', { hwnd }, 5000)); }
  finally { await worker.stop(); }
}
