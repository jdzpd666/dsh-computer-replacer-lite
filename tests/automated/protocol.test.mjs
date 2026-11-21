import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Frames, encode, MAX_LOCATE_SOFT_BYTES, MAX_FRAME_BYTES, locateResult, normalizeKey, normalizeLocate, normalizeReadScreen, readScreenResult, response, workerStatus } from '../../dist/ipc/protocol.js';
import { IpcClient } from '../../dist/ipc/client.js';
class Socket extends EventEmitter {
  destroyed=false; writes=[];
  write(bytes,cb){this.writes.push(JSON.parse(bytes));cb?.();}
  destroy(){this.destroyed=true;}
  reply(value){this.emit('data',encode(value));}
}
const setup=()=>{const c=new IpcClient(),s=new Socket();c.attach(s);return [c,s];};
test('frames: split at every byte including Unicode; coalesced frames',()=>{
 const data=Buffer.concat([encode({text:'中文🙂'}),encode({id:2})]);const f=new Frames();let out=[];
 for(const byte of data)out.push(...f.push(Buffer.from([byte])));
 assert.deepEqual(out,[{text:'中文🙂'},{id:2}]);f.end();
 assert.equal(new Frames().push(data).length,2);
});
test('frames: exact limit, oversize, malformed JSON, UTF8 and EOF fail closed',()=>{
 const atLimit=Buffer.from('"'+'a'.repeat(MAX_FRAME_BYTES-2)+'"');
 assert.equal(new Frames().push(Buffer.concat([atLimit,Buffer.from([10])]))[0].length,MAX_FRAME_BYTES-2);
 for(const bytes of [Buffer.alloc(MAX_FRAME_BYTES+1,65),Buffer.from('{no}\n'),Buffer.from([34,255,34,10])])assert.throws(()=>new Frames().push(bytes));
 const f=new Frames();f.push(Buffer.from('{'));assert.throws(()=>f.end());
 assert.throws(()=>encode({text:'a'.repeat(MAX_FRAME_BYTES)}));
 for(const value of [{},{id:1,ok:true,result:1},{id:'x',ok:false,error:{code:'BAD',message:'x'}}])assert.throws(()=>response(value));
});
test('client correlates concurrent out-of-order responses and notifications',async()=>{
 const [c,s]=setup();try{
 let notified=0;c.on('notification',()=>notified++);
 const a=c.request('ping'),b=c.request('ping');
 s.reply({event:'CONTEXT_CHANGED',fingerprint:{version:1}});
 s.reply({id:s.writes[1].id,ok:true,result:'B'});s.reply({id:s.writes[0].id,ok:true,result:'A'});
 assert.deepEqual(await Promise.all([a,b]),['A','B']);assert.equal(notified,1);assert.equal(c.pendingCount,0);
 }finally{c.disconnect();}
});
test('timeout removes pending, late reply ignored, new id never confused',async()=>{
 const [c,s]=setup();try{
 await assert.rejects(c.request('ping',{},10),{code:'TIMEOUT'});assert.equal(c.pendingCount,0);
 const next=c.request('ping');s.reply({id:s.writes[0].id,ok:true,result:'late'});
 assert.equal(c.pendingCount,1);s.reply({id:s.writes[1].id,ok:true,result:'new'});assert.equal(await next,'new');
 }finally{c.disconnect();}
});
test('disconnect rejects inflight, reconnect does not replay; errors surfaced',async()=>{
 const [c,s]=setup();const p=assert.rejects(c.request('ping'),{code:'WORKER_UNAVAILABLE'});c.disconnect();await p;
 const replacement=new Socket();c.attach(replacement);assert.equal(replacement.writes.length,0);
 const q=assert.rejects(c.request('click'),{code:'UNSUPPORTED_OPERATION'});
 replacement.reply({id:replacement.writes[0].id,ok:false,error:{code:'UNSUPPORTED_OPERATION',message:'M0'}});await q;c.disconnect();
});
test('malformed response terminates connection and clears pending',async()=>{
 const [c,s]=setup();const p=assert.rejects(c.request('ping'),{code:'WORKER_UNAVAILABLE'});
 s.emit('data',Buffer.from('invalid\n'));await p;assert.equal(c.pendingCount,0);assert.equal(c.connected,false);
});
test('pending cap, invalid timeout and frame size send no extra requests',async()=>{
 const [c,s]=setup();
 const requests=Array.from({length:128},()=>assert.rejects(c.request('ping'),{code:'WORKER_UNAVAILABLE'}));
 await assert.rejects(c.request('ping'),{code:'WORKER_UNAVAILABLE'});assert.equal(s.writes.length,128);c.disconnect();await Promise.all(requests);
 const [d,t]=setup();await assert.rejects(d.request('ping',{},0));await assert.rejects(d.request('ping',{text:'a'.repeat(70000)}));assert.equal(t.writes.length,0);d.disconnect();
});
test('normalizeKey accepts single key names, single characters and lowercases key names',()=>{
 assert.deepEqual(normalizeKey({hwnd:'42',combo:'enter'}),{hwnd:'42',combo:'enter'});
 assert.deepEqual(normalizeKey({hwnd:'42',combo:'space'}),{hwnd:'42',combo:'space'});
 assert.deepEqual(normalizeKey({hwnd:'42',combo:'7'}),{hwnd:'42',combo:'7'});
 assert.deepEqual(normalizeKey({hwnd:'42',combo:'pagedown'}),{hwnd:'42',combo:'pagedown'});
 assert.deepEqual(normalizeKey({hwnd:'42',combo:'f12'}),{hwnd:'42',combo:'f12'});
 assert.deepEqual(normalizeKey({hwnd:'42',combo:'ENTER'}),{hwnd:'42',combo:'enter'});
 assert.deepEqual(normalizeKey({hwnd:'42',combo:'F5'}),{hwnd:'42',combo:'f5'});
 assert.deepEqual(normalizeKey({hwnd:'42',combo:'键'}),{hwnd:'42',combo:'键'});
 assert.deepEqual(normalizeKey({hwnd:'42',combo:'A'}),{hwnd:'42',combo:'A'});
});
test('normalizeKey rejects every modifier chord: PostMessageW cannot deliver modifier state',()=>{
 for(const combo of ['ctrl+a','CTRL+A','Shift+CTRL+F5','ctrl+shift+TAB','alt+ctrl+shift+enter','ctrl+ctrl+a','ctrl+alt+a','alt+shift+a','win+a','meta+a','cmd+tab','ctrl','ctrl+alt','ctrl+foo','ctrl+s,v','ctrl+','+enter','a+','++','ctrl + a'])
  assert.throws(()=>normalizeKey({hwnd:'42',combo}),{code:'INVALID_ARGUMENT'},combo);
 assert.throws(()=>normalizeKey({hwnd:'42',combo:'ctrl+a'}),err=>err.code==='INVALID_ARGUMENT'&&/PostMessageW/.test(err.message)&&/零按键已发送/.test(err.message)&&/replacer_type/.test(err.message));
});
test('normalizeKey rejects empty, whitespace, unknown names and oversized combos',()=>{
 for(const combo of ['','foo','f13','enter ','a b','a,b',',','a'.repeat(33)])assert.throws(()=>normalizeKey({hwnd:'42',combo}),{code:'INVALID_ARGUMENT'},combo);
 assert.equal(normalizeKey({hwnd:'42',combo:'escape'}).combo,'escape'); // worker superset alias
 assert.equal(normalizeKey({hwnd:'42',combo:'del'}).combo,'del');
});
test('normalizeKey rejects bad hwnd, missing combo and unknown arguments',()=>{
 assert.throws(()=>normalizeKey({hwnd:'0',combo:'enter'}),{code:'INVALID_ARGUMENT'});
 assert.throws(()=>normalizeKey({hwnd:'12x',combo:'enter'}),{code:'INVALID_ARGUMENT'});
 assert.throws(()=>normalizeKey({hwnd:'42'}),{code:'INVALID_ARGUMENT'});
 assert.throws(()=>normalizeKey({hwnd:'42',combo:'enter',extra:1}),{code:'INVALID_ARGUMENT'});
 assert.throws(()=>normalizeKey('enter'),{code:'INVALID_ARGUMENT'});
});
test('workerStatus validates the panic latch: missing or non-boolean panic is a protocol error',()=>{
 const base={tier:'L2',l2:true,l3:false,pid:42,worlds:[]};
 assert.throws(()=>workerStatus(base),{code:'WORKER_UNAVAILABLE'});
 assert.throws(()=>workerStatus({...base,panic:'yes'}),{code:'WORKER_UNAVAILABLE'});
 assert.throws(()=>workerStatus({...base,panic:1}),{code:'WORKER_UNAVAILABLE'});
 assert.throws(()=>workerStatus({...base,panic:null}),{code:'WORKER_UNAVAILABLE'});
 assert.throws(()=>workerStatus({...base,panic:true,panicHotkey:123}),{code:'WORKER_UNAVAILABLE'});
});
test('workerStatus passes panic and the armed hotkey label through',()=>{
 const base={tier:'L2',l2:true,l3:false,pid:42,worlds:[]};
 assert.equal(workerStatus({...base,panic:false}).panic,false);
 assert.equal(workerStatus({...base,panic:false}).panicHotkey,undefined);
 const armed=workerStatus({...base,panic:true,panicHotkey:'ctrl+alt+shift+p'});
 assert.equal(armed.panic,true);
 assert.equal(armed.panicHotkey,'ctrl+alt+shift+p');
 const worlds=[{hwnd:'42',version:1,elements:3,observedAt:7}];
 assert.equal(workerStatus({...base,panic:false,worlds}).worlds.length,1);
});
test('response accepts the PANIC_ABORTED error code from the emergency stop',()=>{
 const frame={id:'p1',ok:false,error:{code:'PANIC_ABORTED',message:'Panic latch tripped; zero messages were issued'}};
 const parsed=response(frame);
 assert.equal(parsed.ok,false);
 assert.equal(parsed.ok===false&&parsed.error.code,'PANIC_ABORTED');
 assert.throws(()=>response({id:'p2',ok:false,error:{code:'PANIC_UNKNOWN',message:'x'}}));
});
test('client.key posts op key, validates the worker echo and disconnects on mismatch',async()=>{
 const [c,s]=setup();try{
 const ok=c.key({hwnd:'42',combo:'ENTER'});
 assert.equal(s.writes[0].method,'key');
 assert.deepEqual(s.writes[0].params,{hwnd:'42',combo:'enter'});
 s.reply({id:s.writes[0].id,ok:true,result:{hwnd:'42',combo:'enter',method:'postmessage_key',accepted:true,keysPosted:1,focusHwnd:'42',reactivated:true,windowAlive:true}});
 assert.equal((await ok).keysPosted,1);
 const wrong=c.key({hwnd:'42',combo:'esc'});
 s.reply({id:s.writes[1].id,ok:true,result:{hwnd:'42',combo:'enter',method:'postmessage_key',accepted:true,keysPosted:1,focusHwnd:'42',windowAlive:true}});
 await assert.rejects(wrong,{message:'Invalid worker response: the worker did not confirm a PostMessage key'});assert.equal(c.connected,false);
 }finally{c.disconnect();}
});
test('client.key maps a lost reply after dispatch to INJECTION_UNCERTAIN',async()=>{
 const [c,s]=setup();try{
 const lost=c.key({hwnd:'42',combo:'enter'});
 s.reply({id:s.writes[0].id,ok:false,error:{code:'TIMEOUT',message:'slow'}});
 await assert.rejects(lost,{code:'INJECTION_UNCERTAIN'});
 }finally{c.disconnect();}
});

// ---- B-3 replacer_read_screen：normalize + 结果校验（零图像字段固化） ----
const readScreenOk={
 width:1920,height:1080,
 lines:[{text:'今 8 编队开工',bbox:{x:10,y:20,width:300,height:32},words:[{text:'今',bbox:{x:10,y:20,width:16,height:32}}]}],
 text:'今 8 编队开工',truncated:false,
 timings:{buildMs:12.5,captureMs:9.8,ocrMs:800.25},
};
test('normalizeReadScreen accepts empty args (full screen) and a valid physical-pixel region',()=>{
 assert.deepEqual(normalizeReadScreen({}),{});
 assert.deepEqual(normalizeReadScreen({region:{x:0,y:0,width:1920,height:1080}}),{region:{x:0,y:0,width:1920,height:1080}});
 assert.deepEqual(normalizeReadScreen({region:{x:960,y:540,width:480,height:270}}),{region:{x:960,y:540,width:480,height:270}});
});
test('normalizeReadScreen rejects negative origin, zero size, floats, oversize and unknown keys',()=>{
 for(const args of [
 {region:{x:-1,y:0,width:100,height:100}},{region:{x:0,y:-2,width:100,height:100}},
 {region:{x:0,y:0,width:0,height:100}},{region:{x:0,y:0,width:100,height:0}},
 {region:{x:0,y:0,width:1.5,height:100}},{region:{x:0,y:0,width:100_001,height:100}},
 {region:{x:0,y:0,width:100}},{region:{x:0,y:0,width:100,height:100,color:'rgb'}},{region:'fullscreen'},{extra:1},
 ]) assert.throws(()=>normalizeReadScreen(args),err=>err.code==='INVALID_ARGUMENT',JSON.stringify(args));
});
test('readScreenResult validates the worker frame and passes truncated/totalLines through',()=>{
 const parsed=readScreenResult(readScreenOk);
 assert.equal(parsed.truncated,false);
 assert.equal(parsed.lines[0].words.length,1);
 const truncated=readScreenResult({...readScreenOk,lines:[{text:'头部保留',bbox:{x:0,y:0,width:10,height:10}}],text:'头部保留',truncated:true,totalLines:300});
 assert.equal(truncated.truncated,true);
 assert.equal(truncated.totalLines,300);
});
test('readScreenResult enforces the zero-image contract: any unexpected top-level field is a protocol error',()=>{
 for(const [field,value] of [['png','AAAA'],['image','x'],['screenshot','x'],['bitmapBytes',123]]){
 assert.throws(()=>readScreenResult({...readScreenOk,[field]:value}),err=>/zero-image contract/.test(err.message),field);
 }
});
test('readScreenResult rejects malformed frames: missing truncated, bad bbox, non-array words, bad timings',()=>{
 for(const broken of [
 {...readScreenOk,truncated:undefined},{...readScreenOk,truncated:true},
 {...readScreenOk,lines:[{text:'a',bbox:{x:'x',y:0,width:1,height:1}}]},
 {...readScreenOk,lines:[{text:'a',bbox:{x:0,y:0,width:1,height:1},words:'no'}]},
 {...readScreenOk,timings:{buildMs:'x',captureMs:1,ocrMs:2}},
 {...readScreenOk,width:0},
 {...readScreenOk,truncated:false,lines:[],text:''},
 ]) assert.throws(()=>readScreenResult(broken),err=>/Invalid worker response/.test(err.message),JSON.stringify(broken).slice(0,80));
});
test('client.readScreen posts op read_screen with normalized params; malformed replies reject but never disconnect (read-only family)',async()=>{
 const [c,s]=setup();try{
 const call=c.readScreen({region:{x:0,y:0,width:1920,height:1080}});
 assert.equal(s.writes[0].method,'read_screen');
 assert.deepEqual(s.writes[0].params,{region:{x:0,y:0,width:1920,height:1080}});
 s.reply({id:s.writes[0].id,ok:true,result:readScreenOk});
 assert.equal((await call).width,1920);
 const bad=c.readScreen({});
 s.reply({id:s.writes[1].id,ok:true,result:{...readScreenOk,png:'AAAA'}});
 await assert.rejects(bad,{message:'Invalid worker response: unexpected field in read-screen result (zero-image contract violated)'});
 // Read-only family contract (same as lookup/topWindows): a malformed reply is
 // rejected but the connection stays; only write-path validation disconnects.
 assert.equal(c.connected,true);
 }finally{c.disconnect();}
});
test('client.readScreen maps a lost reply to plain TIMEOUT: read-only, never INJECTION_UNCERTAIN',async()=>{
 const [c,s]=setup();try{
 const lost=c.readScreen({});
 s.reply({id:s.writes[0].id,ok:false,error:{code:'TIMEOUT',message:'slow OCR'}});
 await assert.rejects(lost,{code:'TIMEOUT'});
 }finally{c.disconnect();}
});
test('read_screen VISION_* error codes flow through the response envelope',()=>{
 for(const code of ['VISION_UNAVAILABLE','VISION_TIMEOUT']){
 const parsed=response({id:'v1',ok:false,error:{code,message:'vision stage failed'}});
 assert.equal(parsed.ok===false&&parsed.error.code,code);
 }
});

// ---- B-4 replacer_locate：normalize（冻结默认值/边界/未知键）+ 结果严格校验 + client 只读语义 ----
const locateBbox={x:0,y:0,width:1920,height:1080};
const locateMatchOk={elementId:'r:[42,3145728,4,1]',label:'保存',type:50000,bbox:{x:10,y:20,width:80,height:32},enabled:true,invokable:true,offscreen:false,source:'fusion',score:0.9,textScore:0.8,overlap:0.95,ocrText:'保存'};
const locateOk={hwnd:'1234',snapshotId:'s-1',observedAt:111,query:'保存',channel:'fusion',degraded:false,degradeReason:null,
 capabilities:{capture:true,ocr:true,grounding:true},window:locateBbox,
 matches:[locateMatchOk],textOnly:[{text:'编辑',bbox:{x:200,y:20,width:40,height:24},score:0.4}],
 timings:{observeMs:3.5,captureMs:12.25,ocrMs:410.5,fusionMs:6.75,buildMs:0.5},truncated:false,totalMatches:1,totalTextOnly:1};
test('normalizeLocate fills the frozen defaults and echoes optional query/maxResults/minScore',()=>{
 assert.deepEqual(normalizeLocate({hwnd:'1234'}),{hwnd:'1234',maxResults:10,minScore:0.5});
 assert.deepEqual(normalizeLocate({hwnd:'1234',query:'保存',maxResults:1,minScore:0}),{hwnd:'1234',query:'保存',maxResults:1,minScore:0});
 assert.deepEqual(normalizeLocate({hwnd:'1234',maxResults:50,minScore:1}),{hwnd:'1234',maxResults:50,minScore:1});
});
test('normalizeLocate rejects a missing, zero, negative, non-decimal or out-of-range hwnd',()=>{
 for(const bad of [{},{hwnd:''},{hwnd:'0'},{hwnd:'-1'},{hwnd:'12x'},{hwnd:'0x10'},{hwnd:1234},{hwnd:'99999999999999999999'}]){
  assert.throws(()=>normalizeLocate(bad),err=>err.code==='INVALID_ARGUMENT',JSON.stringify(bad));
 }
});
test('normalizeLocate bounds maxResults to 1..50 (default 10; null means omitted)',()=>{
 for(const bad of [0,51,1.5,'10',true]){
  assert.throws(()=>normalizeLocate({hwnd:'1234',maxResults:bad}),err=>err.code==='INVALID_ARGUMENT',String(bad));
 }
 assert.equal(normalizeLocate({hwnd:'1234',maxResults:null}).maxResults,10);
});
test('normalizeLocate bounds minScore to a finite 0..1 (default 0.5; null means omitted)',()=>{
 for(const bad of [-0.1,1.01,NaN,Infinity,-Infinity,'0.5',true]){
  assert.throws(()=>normalizeLocate({hwnd:'1234',minScore:bad}),err=>err.code==='INVALID_ARGUMENT',String(bad));
 }
 assert.equal(normalizeLocate({hwnd:'1234',minScore:null}).minScore,0.5);
});
test('normalizeLocate rejects a non-string/oversized/null query and unknown keys, counting CJK by characters',()=>{
 for(const bad of [{hwnd:'1234',query:5},{hwnd:'1234',query:null},{hwnd:'1234',query:'x'.repeat(513)},{hwnd:'1234',query:'😀'.repeat(513)},{hwnd:'1234',extra:1},{hwnd:'1234',query2:'x'}]){
  assert.throws(()=>normalizeLocate(bad),err=>err.code==='INVALID_ARGUMENT',JSON.stringify(bad).slice(0,60));
 }
 assert.equal(normalizeLocate({hwnd:'1234',query:'😀'.repeat(512)}).query.length,1024);
});
test('MAX_LOCATE_SOFT_BYTES is exported at the frozen 58_982-byte ceiling',()=>{
 assert.equal(MAX_LOCATE_SOFT_BYTES,58982);
});
test('locateResult accepts a fusion reply and a degraded uia_only reply, normalizing rows',()=>{
 const fusion=locateResult(locateOk);
 assert.equal(fusion.matches.length,1);
 assert.equal(fusion.matches[0].elementId,'r:[42,3145728,4,1]');
 assert.equal(fusion.textOnly[0].text,'编辑');
 const uia=locateResult({...locateOk,query:null,channel:'uia_only',degraded:true,degradeReason:'VISION_UNAVAILABLE: dxgi capture failed',
  capabilities:{capture:false,ocr:false,grounding:false},matches:[{...locateMatchOk,source:'uia',ocrText:null,score:0}],textOnly:[]});
 assert.equal(uia.channel,'uia_only');
 assert.equal(uia.degraded,true);
 assert.equal(uia.matches[0].ocrText,null);
});
test('locateResult rejects a bad channel, out-of-range score, missing bbox, sourceless ocrText and broken totals/timings',()=>{
 for(const [broken,label] of [
  [{...locateOk,channel:'fused'},'channel'],
  [{...locateOk,matches:[{...locateMatchOk,score:1.5}]},'score'],
  [{...locateOk,matches:[{...locateMatchOk,bbox:undefined}]},'bbox'],
  [{...locateOk,matches:[{...locateMatchOk,source:'uia',ocrText:'x'}]},'uia-with-ocrText'],
  [{...locateOk,matches:[{...locateMatchOk,source:'fusion',ocrText:null}]},'fusion-without-ocrText'],
  [{...locateOk,matches:[{...locateMatchOk,elementId:'id'}]},'elementId'],
  [{...locateOk,textOnly:[{text:'x',bbox:locateBbox}]},'textOnly-score'],
  [{...locateOk,textOnly:[{score:0.2,bbox:locateBbox}]},'textOnly-text'],
  [{...locateOk,totalMatches:0},'totalMatches'],
  [{...locateOk,totalTextOnly:0},'totalTextOnly'],
  [{...locateOk,timings:{...locateOk.timings,ocrMs:-1}},'timing-negative'],
  [{...locateOk,timings:{...locateOk.timings,ocrMs:600001}},'timing-ceiling'],
  [{...locateOk,degraded:true},'degraded-without-reason'],
  [{...locateOk,degradeReason:'why'},'reason-without-degraded'],
  [{...locateOk,capabilities:{capture:true,ocr:true}},'capabilities'],
  [{...locateOk,observedAt:-1},'observedAt'],
  [{...locateOk,hwnd:'12x'},'hwnd'],
  [{...locateOk,query:'x'.repeat(513)},'query'],
 ]) assert.throws(()=>locateResult(broken),err=>/Invalid worker response/.test(err.message),label);
});
test('locateResult leaves the top-level key set open on purpose (plan §4 freezes fields, not keys)',()=>{
 assert.doesNotThrow(()=>locateResult({...locateOk,futureField:1}));
});
test('client.locate posts op locate with normalized params and validates a fusion reply (read-only family)',async()=>{
 const [c,s]=setup();try{
  const call=c.locate({hwnd:'1234',query:'保存'});
  assert.equal(s.writes[0].method,'locate');
  assert.deepEqual(s.writes[0].params,{hwnd:'1234',query:'保存',maxResults:10,minScore:0.5});
  s.reply({id:s.writes[0].id,ok:true,result:locateOk});
  assert.equal((await call).matches[0].elementId,'r:[42,3145728,4,1]');
  const bad=c.locate({hwnd:'1234'});
  s.reply({id:s.writes[1].id,ok:true,result:{...locateOk,channel:'fused'}});
  await assert.rejects(bad,{message:'Invalid worker response: locate result has an invalid channel'});
  assert.equal(c.connected,true);
 }finally{c.disconnect();}
});
test('client.locate rejects invalid arguments before any write, maps a lost reply to plain TIMEOUT',async()=>{
 const [c,s]=setup();try{
  await assert.rejects(c.locate({}),{code:'INVALID_ARGUMENT'});
  assert.equal(s.writes.length,0);
  const lost=c.locate({hwnd:'1234'},20);
  s.reply({id:s.writes[0].id,ok:false,error:{code:'TIMEOUT',message:'locate timed out'}});
  await assert.rejects(lost,{code:'TIMEOUT'});
 }finally{c.disconnect();}
});
