import { spawn } from 'node:child_process';
const child = spawn('dist/replacer-worker.exe', [], { stdio: ['pipe', 'pipe', 'pipe'] });

child.stderr.on('data', (data) => {
  console.error(`\n====== [RUST STDERR] ======\n${data.toString()}\n===========================\n`);
});

child.stdout.on('data', (data) => {
  console.log(`[RUST STDOUT]: ${data.toString().trim()}`);
});

child.on('close', (code, signal) => {
  console.log(`\n[Worker 彻底退出] code: ${code}, signal: ${signal}`);
});

const req = JSON.stringify({
  id: "1",
  method: "watch",
  params: { hwnd: process.argv[2] }
}) + '\n';

setTimeout(() => {
  console.log(`\nSending watch request for HWND: ${process.argv[2]}...`);
  child.stdin.write(req);
}, 1000);
