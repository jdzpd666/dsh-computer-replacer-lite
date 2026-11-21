import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Frames, encode } from '../../dist/ipc/protocol.js';
const exe=fileURLToPath(new URL('../../dist/replacer-worker.exe',import.meta.url));
async function harness(t){
 const slash=String.fromCharCode(92),path=slash+slash+'.'+slash+'pipe'+slash+'replacer-'+randomUUID();
 const server=createServer();server.listen(path);await once(server,'listening');
 const connection=once(server,'connection');const child=spawn(exe,[path],{stdio:['pipe','ignore','pipe'],windowsHide:true});child.stderr.resume();child.stdin.end('a'.repeat(64));
 const exit=once(child,'exit');const [socket]=await connection;socket.on('error',()=>{});
 t.after(async()=>{socket.destroy();if(child.exitCode===null){child.kill();await exit;}await new Promise(resolve=>server.close(resolve));});
 const frames=new Frames();let rows=[];socket.on('data',b=>rows.push(...frames.push(b)));
 // Await actual hello, not an arbitrary delay.
 if(!rows.length)await once(socket,'data');assert.equal(rows.shift().hello,'a'.repeat(64));
 return {socket,rows,exit};
}
for(const [label,bytes] of [['malformed JSON',Buffer.from('no\n')],['invalid UTF8',Buffer.from([34,255,34,10])],['oversize',Buffer.alloc(65538,65)],['invalid envelope',encode({id:7})]])test('real worker rejects '+label,{timeout:8000},async t=>{
 const h=await harness(t);h.socket.write(bytes);const [code]=await h.exit;assert.equal(code,1);assert.equal(h.rows.length,0);
});
test('real worker parses split Unicode and multiple frames',{timeout:8000},async t=>{
 const h=await harness(t);const bytes=Buffer.concat([encode({id:'中文🙂',method:'ping',params:{}}),encode({id:'second',method:'ping',params:{}})]);
 h.socket.write(bytes.subarray(0,9));h.socket.write(bytes.subarray(9));
 while(h.rows.length<2)await once(h.socket,'data');assert.deepEqual(h.rows.map(x=>x.id),['中文🙂','second']);
});
