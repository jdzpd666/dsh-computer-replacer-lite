import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { IpcClient } from '../ipc/client.js';
import { Frames, object } from '../ipc/protocol.js';
/** Worker exit code that means "own panic latch tripped (hotkey path)". */
export const PANIC_EXIT_CODE = 87;
/** 拍板补充③: 87 arms the latch; 1 is an ordinary taskkill /F strong kill
 * (verified exit code of `taskkill /F /PID` on this machine) and never arms it. */
export const isPanicExit = (code) => code === PANIC_EXIT_CODE;
export class Supervisor extends EventEmitter {
    executable;
    maxRestarts;
    client = new IpcClient();
    child;
    server;
    sockets = new Set();
    retry;
    startup;
    stopped = true;
    attempts = 0;
    starts = 0;
    generation = 0;
    pipeName = '';
    constructor(executable, maxRestarts = 5) {
        super();
        this.executable = executable;
        this.maxRestarts = maxRestarts;
    }
    get pid() { return this.child?.pid; }
    get startCount() { return this.starts; }
    start() { if (!this.stopped)
        return; this.stopped = false; this.attempts = 0; this.launch(); }
    /** Spawn argv for the worker (protected test seam: the default stays exactly
     * [pipeName]; a test subclass can inject a fake child such as
     * ["-e","process.exit(87)"] to drive exit-code classification). */
    spawnArguments(pipeName) { return [pipeName]; }
    launch() {
        if (this.stopped)
            return;
        const generation = ++this.generation;
        const secret = randomBytes(32).toString('hex');
        const slash = String.fromCharCode(92);
        this.pipeName = slash + slash + '.' + slash + 'pipe' + slash + 'replacer-' + randomUUID();
        const server = createServer(socket => {
            if (generation !== this.generation || this.client.connected || this.sockets.size >= 4) {
                socket.destroy();
                return;
            }
            this.sockets.add(socket);
            socket.once('close', () => this.sockets.delete(socket));
            socket.on('error', () => socket.destroy());
            const frames = new Frames();
            const timer = setTimeout(() => socket.destroy(), 1000);
            socket.once('close', () => clearTimeout(timer));
            const handshake = (chunk) => {
                try {
                    const messages = frames.push(chunk);
                    if (!messages.length)
                        return;
                    const hello = messages[0];
                    if (messages.length !== 1 || !object(hello) || hello.pid !== this.child?.pid || typeof hello.hello !== 'string' || hello.hello.length !== 64 || !timingSafeEqual(Buffer.from(hello.hello), Buffer.from(secret)))
                        throw new Error('Unauthorized peer');
                    frames.end();
                    clearTimeout(timer);
                    clearTimeout(this.startup);
                    socket.off('data', handshake);
                    if (this.client.connected)
                        throw new Error('Already connected');
                    this.client.attach(socket);
                    socket.once('close', () => { if (!this.stopped && generation === this.generation)
                        this.child?.kill(); });
                    this.emit('ready');
                }
                catch {
                    socket.destroy();
                }
            };
            socket.on('data', handshake);
        });
        this.server = server;
        server.once('error', error => { this.emit('diagnostic', String(error)); void this.stop(); });
        server.listen(this.pipeName, () => {
            if (this.stopped || generation !== this.generation) {
                server.close();
                return;
            }
            const child = spawn(this.executable, this.spawnArguments(this.pipeName), { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
            this.child = child;
            this.starts++;
            child.stdin?.on('error', () => { });
            child.stdin?.end(secret);
            child.stderr?.setEncoding('utf8');
            child.stderr?.on('data', chunk => this.emit('diagnostic', chunk));
            child.once('exit', (code, signal) => {
                this.emit('diagnostic', `WORKER_EXIT code=${code} hex=${code === null ? 'none' : `0x${(code >>> 0).toString(16).padStart(8, '0')}`} signal=${signal} stopping=${this.stopped}\n`);
                // Panic path only (§7.5): the worker exits 87 when its own hotkey latch
                // tripped. We surface the code as an event so the TS latch arms too;
                // restart logic below stays untouched (crash-restart continues — the
                // relaunched worker is a harmless idle body while the TS latch holds).
                if (isPanicExit(code))
                    this.emit('panic', PANIC_EXIT_CODE);
            });
            this.startup = setTimeout(() => child.kill(), 5000);
            child.once('error', error => this.emit('diagnostic', String(error)));
            child.once('close', () => {
                clearTimeout(this.startup);
                if (this.child === child)
                    this.child = undefined;
                if (generation !== this.generation)
                    return;
                this.client.disconnect();
                for (const socket of this.sockets)
                    socket.destroy();
                server.close(() => {
                    if (this.stopped)
                        return;
                    if (this.attempts >= this.maxRestarts) {
                        this.stopped = true;
                        this.emit('exhausted');
                        return;
                    }
                    const delay = Math.min(100 * 2 ** this.attempts++, 2000);
                    this.retry = setTimeout(() => this.launch(), delay);
                });
            });
        });
    }
    async stop() {
        this.stopped = true;
        this.generation++;
        clearTimeout(this.retry);
        clearTimeout(this.startup);
        this.client.disconnect();
        for (const socket of this.sockets)
            socket.destroy();
        this.sockets.clear();
        const child = this.child;
        this.child = undefined;
        if (child && child.exitCode === null && child.signalCode === null)
            await new Promise(resolve => { child.once('close', () => resolve()); child.kill(); });
        const server = this.server;
        this.server = undefined;
        if (server?.listening)
            await new Promise(resolve => server.close(() => resolve()));
    }
    /** Panic-button fallback (验收 e): taskkill /F a child pid when a clean stop
     * does not settle (wedged or suspended worker). Defaults to the current
     * child; callers may pass a pid captured before stop() cleared it. Resolves
     * false when no pid is given/alive or taskkill failed. Does not change
     * restart bookkeeping — stop() remains the only state-resetting path. */
    async forceKill(pid) {
        const target = pid ?? this.child?.pid;
        if (target === undefined)
            return false;
        return new Promise(resolve => {
            const killer = spawn('taskkill', ['/F', '/PID', String(target)], { stdio: 'ignore', windowsHide: true });
            killer.once('error', () => resolve(false));
            killer.once('exit', code => resolve(code === 0));
        });
    }
}
