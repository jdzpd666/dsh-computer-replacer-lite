import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Supervisor } from '../../dist/worker/supervisor.js';
const exe=fileURLToPath(new URL('../../dist/replacer-worker.exe',import.meta.url));
const ready=s=>once(s,'ready',{signal:AbortSignal.timeout(8000)});
test('real Windows Worker: ping, concurrent IDs, unsupported writes, crash restart/no replay, shutdown', {timeout:20000},async t=>{
 const s=new Supervisor(exe);t.after(()=>s.stop());const r=ready(s);s.start();await r;
 const first=await s.client.request('ping');assert.equal(first.reply,'pong');assert.equal(first.sequence,1);
 const replies=await Promise.all(Array.from({length:20},()=>s.client.request('ping')));
 assert.deepEqual(replies.map(x=>x.sequence),Array.from({length:20},(_,i)=>i+2));
 // Write methods validate arguments before any action thread work: nothing is injected.
 for(const method of ['click','type','scroll'])await assert.rejects(s.client.request(method),{code:'INVALID_ARGUMENT'});
 await assert.rejects(s.client.request('type',{hwnd:'1',elementId:'r:[1]',text:''}),{code:'INVALID_ARGUMENT'});
 await assert.rejects(s.client.request('scroll',{hwnd:'1',elementId:'r:[1]'}),{code:'INVALID_ARGUMENT'});
 // key is now a real PostMessageW primitive (task 3): invalid combos fail fast,
 // chord combos are rejected (no thread key state), and L2/L3 stay unexposed.
 await assert.rejects(s.client.request('key',{hwnd:'1',combo:''}),{code:'INVALID_ARGUMENT'});
 await assert.rejects(s.client.request('key',{hwnd:'1',combo:'ctrl+a'}),{code:'INVALID_ARGUMENT'});
 await assert.rejects(s.client.request('key',{hwnd:'1',combo:'a b'}),{code:'INVALID_ARGUMENT'});
 await assert.rejects(s.client.request('set_l3_enabled'),{code:'UNSUPPORTED_OPERATION'});
 // Read-only surfaces: real enumeration over this desktop, and a truthful tier report.
 const listed=await s.client.request('windows');
 assert.ok(Array.isArray(listed.windows)&&listed.windows.length>0,'expected at least one top-level window');
 const status=await s.client.request('status');
 assert.equal(status.tier,'L2');assert.equal(status.l2,true);assert.equal(status.l3,false);assert.ok(status.pid>0);
 const oldPid=s.pid,oldPipe=s.pipeName;const restarted=ready(s);process.kill(oldPid);await restarted;
 assert.notEqual(s.pid,oldPid);assert.notEqual(s.pipeName,oldPipe);assert.equal(s.startCount,2);
 assert.equal((await s.client.request('ping')).sequence,1,'old requests were not replayed');
 const pid=s.pid;await s.stop();assert.equal(s.client.connected,false);assert.equal(s.client.pendingCount,0);
 assert.throws(()=>process.kill(pid,0));
});
test('extra unauthorized pipe connection cannot replace worker', {timeout:12000},async t=>{
 const s=new Supervisor(exe);t.after(()=>s.stop());const r=ready(s);s.start();await r;
 const socket=createConnection(s.pipeName);socket.on('error',()=>{});const closed=once(socket,'close');socket.on('connect',()=>socket.write('{"hello":"forged","pid":1}\n'));await closed;
 assert.equal((await s.client.request('ping')).reply,'pong');
});
test('missing executable exhausts bounded restart budget', {timeout:10000},async()=>{
 const s=new Supervisor(exe+'.missing',1);const exhausted=once(s,'exhausted',{signal:AbortSignal.timeout(8000)});s.start();await exhausted;
 assert.equal(s.startCount,2);assert.equal(s.client.connected,false);await s.stop();
});
test('stop during initial listen prevents worker spawn',async()=>{
 const s=new Supervisor(exe);s.start();await s.stop();assert.equal(s.pid,undefined);assert.equal(s.client.connected,false);
});
test('release copy is byte-identical and Windows PE',async()=>{
 const a=await readFile(exe),b=await readFile(new URL('../../worker/target/release/replacer-worker.exe',import.meta.url));
 assert.equal(a.subarray(0,2).toString(),'MZ');assert.deepEqual(a,b);
 console.log('ARTIFACT_SHA256='+createHash('sha256').update(a).digest('hex')+' bytes='+a.length);
});
