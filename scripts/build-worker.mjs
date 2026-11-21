import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') throw new Error('Windows MSVC build required');
const vswhere = path.join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe');
const instances = JSON.parse(execFileSync(vswhere, ['-all', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-format', 'json'], {encoding:'utf8'}));
const instance = instances.find(i => i.isComplete && i.isLaunchable);
if (!instance) throw new Error('MSVC_COMPONENT_MISSING');
const dev = path.join(instance.installationPath, 'VC/Auxiliary/Build/vcvars64.bat');
const mode = process.argv[2] ?? 'build';
const commands = {probe:'run --release --example uia_probe', build:'build --release', test:'test --release', check:'check --release --all-targets', examples:'build --release --examples'};
// Diagnostics: run any example by name, e.g. build-worker.mjs example windows_probe
const example = process.argv[3];
if (mode === 'example' && !/^[a-z0-9_]+$/.test(example ?? '')) throw new Error('Unknown example name');
const command = mode === 'example' ? 'run --release --example ' + example : commands[mode];
if (command === undefined) throw new Error('Unknown build mode');
await mkdir(path.join(root,'.build'), {recursive:true});
const cmd = path.join(root,'.build',mode+'.cmd');
await writeFile(cmd, ['@echo off','set "PATH='+path.dirname(vswhere)+';%PATH%"','call "'+dev+'"','if errorlevel 1 exit /b %errorlevel%','cargo '+command+' --manifest-path "'+path.join(root,'worker/Cargo.toml')+'"','exit /b %errorlevel%'].join(String.fromCharCode(13,10)));
console.log(JSON.stringify({event:'build-start',mode,vs:instance.installationVersion,root}));
const started = Date.now();
const child=spawn(process.env.ComSpec ?? 'cmd.exe',['/d','/c',cmd],{cwd:root,stdio:'inherit',windowsHide:true});
let timedOut=false;
const timer=setTimeout(()=>{timedOut=true;spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'inherit'});},600000);
const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);}).finally(()=>clearTimeout(timer));
if (timedOut || code!==0) throw new Error('BUILD_FAILED code='+code+' timeout='+timedOut);
if (mode==='build') {
  // The exe cannot be overwritten while a worker instance holds it open (EBUSY),
  // so kill any running worker before the dist copy.
  const kill=spawnSync('taskkill',['/IM','replacer-worker.exe','/F'],{encoding:'utf8',windowsHide:true});
  if (kill.status===0) console.log(JSON.stringify({event:'worker-killed'}));
  await mkdir(path.join(root,'dist'),{recursive:true});
  await copyFile(path.join(root,'worker/target/release/replacer-worker.exe'),path.join(root,'dist/replacer-worker.exe'));
  const sha=createHash('sha256').update(await readFile(path.join(root,'dist/replacer-worker.exe'))).digest('hex');
  console.log(JSON.stringify({event:'worker-copied',sha256:sha}));
}
console.log(JSON.stringify({event:'build-complete',mode,elapsed_ms:Date.now()-started}));