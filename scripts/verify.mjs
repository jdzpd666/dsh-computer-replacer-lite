import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
mkdirSync(new URL('../reports/',import.meta.url),{recursive:true});
const steps=[['build-ts','node_modules/typescript/bin/tsc','-p','tsconfig.json'],['build-worker','scripts/build-worker.mjs','build'],['node-tests','--test','tests/automated/plugin.test.mjs','tests/automated/protocol.test.mjs','tests/automated/raw-worker.test.mjs','tests/automated/worker.test.mjs'],['rust-tests','scripts/build-worker.mjs','test'],['uia-probe','scripts/build-worker.mjs','probe']];
const results=[];
for(const [label,...args] of steps){
 const start=Date.now();const r=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',timeout:620000,windowsHide:true});
 writeFileSync(new URL('../reports/'+label+'.log',import.meta.url),(r.stdout??'')+(r.stderr??'')+'\nEXIT_CODE='+r.status+'\n'+(r.error?.message??''));
 results.push({label,exitCode:r.status,elapsedMs:Date.now()-start});
 console.log(results.at(-1));if(r.status!==0){process.exitCode=1;break;}
}
writeFileSync(new URL('../reports/verification.json',import.meta.url),JSON.stringify({at:new Date().toISOString(),platform:process.platform,node:process.version,results},null,2));
