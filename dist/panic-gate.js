import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
const LATCH_FILE = 'panic-latch.json';
export class PanicGate extends EventEmitter {
    latched = false;
    at = 0;
    source;
    file;
    stopTimeoutMs;
    supervisor;
    log;
    constructor(options = {}) {
        super();
        this.supervisor = options.supervisor;
        this.stopTimeoutMs = options.stopTimeoutMs ?? 1500;
        this.log = options.log ?? (() => { });
        const runtimeDir = options.runtimeDir ?? process.env.REPLACER_RUNTIME_DIR
            ?? join(dirname(fileURLToPath(import.meta.url)), '..', '.runtime');
        this.file = join(runtimeDir, LATCH_FILE);
    }
    /** Restore the latch from the persisted file (plugin activate, 修正案一). */
    restore() {
        try {
            const raw = readFileSync(this.file, 'utf8');
            const parsed = JSON.parse(raw);
            const record = parsed;
            if (record.latched === true) {
                this.latched = true;
                this.at = typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : Date.now();
                this.source = record.source === 'button' || record.source === 'hotkey' ? record.source : undefined;
                this.log('[computer-replacer] panic latch restored from disk (source=' + (this.source ?? 'unknown') + ')');
            }
            else {
                // Persisted but explicitly unlatched, or a malformed flag: stay unlatched.
                this.latched = false;
                this.at = 0;
                this.source = undefined;
            }
        }
        catch {
            // Missing or unreadable/corrupt file: unlatched (corrupt = 未闩, fail-safe).
            this.latched = false;
            this.at = 0;
            this.source = undefined;
        }
        return this.snapshot();
    }
    snapshot() {
        return {
            latched: this.latched,
            at: this.at,
            ...(this.source === undefined ? {} : { source: this.source }),
            workerConnected: this.supervisor?.client.connected === true,
        };
    }
    get latchedNow() { return this.latched; }
    /**
     * Trip the latch (idempotent). Persists, then kills the worker chain.
     * The crash-restart supervisor may relaunch a fresh worker afterwards —
     * harmless idle: every gated tool still answers PANIC_ABORTED (拍板②,
     * worker 进程存活 ≠ 工具可用).
     */
    async trip(source, forceStopTimeoutMs) {
        const already = this.latched;
        if (!already) {
            this.latched = true;
            this.at = Date.now();
            this.source = source;
            this.persist();
            this.emit('change', this.snapshot());
        }
        else if (this.source === undefined) {
            // Idempotent trip on a restored latch without a recorded source: backfill it.
            this.source = source;
            this.persist();
        }
        const kill = await this.killWorkerChain(forceStopTimeoutMs ?? this.stopTimeoutMs);
        this.log('[computer-replacer] panic trip(' + source + (already ? ', already latched' : '') + ') kill=' + JSON.stringify(kill));
        return this.snapshot();
    }
    /** Hotkey path: worker exited with 87 → same latch, source 'hotkey' (no kill chain). */
    noteHotkeyExit() {
        if (!this.latched) {
            this.latched = true;
            this.at = Date.now();
            this.source = 'hotkey';
            this.persist();
            this.emit('change', this.snapshot());
            this.log('[computer-replacer] panic latch armed by hotkey path (worker exit 87)');
        }
        return this.snapshot();
    }
    /**
     * Recover: POST success = latch cleared (语义本体, 拍板①). Does not start the
     * worker here — the next gated tool call starts it lazily; until then
     * status shows workerConnected:false. Idempotent.
     */
    recover() {
        if (this.latched) {
            this.latched = false;
            this.at = 0;
            this.source = undefined;
            this.persist();
            this.emit('change', this.snapshot());
            this.log('[computer-replacer] panic latch recovered (button)');
        }
        return this.snapshot();
    }
    /** Atomic persist: temp file + rename; a failed write logs but never throws. */
    persist() {
        try {
            mkdirSync(dirname(this.file), { recursive: true });
            const payload = JSON.stringify({
                latched: this.latched,
                at: this.at,
                ...(this.source === undefined ? {} : { source: this.source }),
            });
            const tmp = this.file + '.tmp-' + process.pid;
            writeFileSync(tmp, payload, 'utf8');
            renameSync(tmp, this.file);
        }
        catch (error) {
            this.log('[computer-replacer] panic latch persist failed: ' + (error instanceof Error ? error.message : String(error)));
        }
    }
    /**
     * Kill chain (验收 e): clean stop first, bounded by stopTimeoutMs; when the
     * stop does not settle in time (wedged/suspended worker) fall back to
     * taskkill /F /PID and then stop again to release supervisor resources.
     */
    async killWorkerChain(stopTimeoutMs) {
        const supervisor = this.supervisor;
        const pid = supervisor?.pid;
        if (supervisor === undefined || pid === undefined)
            return { stopped: true, forced: false };
        let stopped = false;
        try {
            stopped = await Promise.race([
                supervisor.stop().then(() => true),
                new Promise(resolve => setTimeout(() => resolve(false), Math.max(1, stopTimeoutMs))),
            ]);
        }
        catch (error) {
            this.log('[computer-replacer] supervisor.stop threw: ' + (error instanceof Error ? error.message : String(error)));
            stopped = false;
        }
        if (stopped)
            return { stopped: true, forced: false, pid };
        const forced = await supervisor.forceKill(pid);
        // Release the supervisor even if the fallback had to do the killing.
        try {
            await Promise.race([supervisor.stop(), new Promise(resolve => setTimeout(resolve, Math.max(1, stopTimeoutMs)))]);
        }
        catch { }
        return { stopped: false, forced, pid };
    }
    /**
     * Swap the owning supervisor (插件重启单例修复): each plugin activation creates
     * a fresh Supervisor, while the shared latch outlives activations — the new
     * apply() re-binds the kill chain target here. Latch state is untouched.
     */
    attachSupervisor(supervisor) {
        this.supervisor = supervisor;
    }
}
/**
 * Process-wide shared latch (§7.5 重启缺陷修复): the panic HTTP routes are
 * registered on the HOST-owned webServer, which outlives a plugin activation —
 * a route registered by a previous apply() keeps serving with the closures it
 * captured. Keying the latch on Symbol.for + globalThis (not module scope)
 * keeps the old route and the new activation pointing at ONE latch object, so
 * a survived route always serves the live latch state. restore() is called by
 * every apply() so the shared instance re-syncs from the persisted file.
 */
const SHARED_PANIC_GATE = Symbol.for('dsh-computer-replacer.panicGate');
export function sharedPanicLatch() {
    const host = globalThis;
    if (host[SHARED_PANIC_GATE] === undefined) {
        host[SHARED_PANIC_GATE] = new PanicGate({ log: line => { console.error(line); } });
    }
    return host[SHARED_PANIC_GATE];
}
