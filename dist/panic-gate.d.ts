import { EventEmitter } from 'node:events';
import type { Supervisor } from './worker/supervisor.js';
/**
 * TS-side authoritative panic latch (§7.5 修正案一).
 *
 * Two user entrances, one latch:
 *   Path A (button):  client POST panic.trip → trip('button') → kill worker chain.
 *   Path B (hotkey):  worker exit(87) → supervisor emits 'panic' → noteHotkeyExit().
 *
 * The latch is sticky: only recover() clears it. It survives worker restarts
 * (this TS singleton) and plugin reloads (the persisted state file). While it
 * is set, every gated write path answers PANIC_ABORTED before touching the
 * worker — zero worker dependency (read-only tools stay available).
 *
 * Persistence: <repo>/.runtime/panic-latch.json = {latched, at, source},
 * written atomically (temp file + rename). A missing or corrupt file restores
 * as unlatched (fail-safe for the user, never silently re-arms a panic).
 */
export type PanicSource = 'button' | 'hotkey';
export interface PanicLatchSnapshot {
    latched: boolean;
    /** Epoch ms of the most recent trip (0 when unlatched). */
    at: number;
    /** Which entrance tripped it last ('button' | 'hotkey'). */
    source?: PanicSource;
    /** Live supervisor connection state (worker alive does NOT mean tools usable). */
    workerConnected: boolean;
}
export interface PanicGateOptions {
    /** Supervisor owning the worker process (kill chain target). */
    supervisor?: Supervisor;
    /** Directory for panic-latch.json; defaults to <repo>/.runtime. */
    runtimeDir?: string;
    /** Kill-chain grace for a clean stop before the taskkill fallback. */
    stopTimeoutMs?: number;
    log?: (message: string) => void;
}
export declare class PanicGate extends EventEmitter {
    private latched;
    private at;
    private source;
    private readonly file;
    private readonly stopTimeoutMs;
    private supervisor;
    private readonly log;
    constructor(options?: PanicGateOptions);
    /** Restore the latch from the persisted file (plugin activate, 修正案一). */
    restore(): PanicLatchSnapshot;
    snapshot(): PanicLatchSnapshot;
    get latchedNow(): boolean;
    /**
     * Trip the latch (idempotent). Persists, then kills the worker chain.
     * The crash-restart supervisor may relaunch a fresh worker afterwards —
     * harmless idle: every gated tool still answers PANIC_ABORTED (拍板②,
     * worker 进程存活 ≠ 工具可用).
     */
    trip(source: PanicSource, forceStopTimeoutMs?: number): Promise<PanicLatchSnapshot>;
    /** Hotkey path: worker exited with 87 → same latch, source 'hotkey' (no kill chain). */
    noteHotkeyExit(): PanicLatchSnapshot;
    /**
     * Recover: POST success = latch cleared (语义本体, 拍板①). Does not start the
     * worker here — the next gated tool call starts it lazily; until then
     * status shows workerConnected:false. Idempotent.
     */
    recover(): PanicLatchSnapshot;
    /** Atomic persist: temp file + rename; a failed write logs but never throws. */
    private persist;
    /**
     * Kill chain (验收 e): clean stop first, bounded by stopTimeoutMs; when the
     * stop does not settle in time (wedged/suspended worker) fall back to
     * taskkill /F /PID and then stop again to release supervisor resources.
     */
    private killWorkerChain;
    /**
     * Swap the owning supervisor (插件重启单例修复): each plugin activation creates
     * a fresh Supervisor, while the shared latch outlives activations — the new
     * apply() re-binds the kill chain target here. Latch state is untouched.
     */
    attachSupervisor(supervisor: Supervisor | undefined): void;
}
export declare function sharedPanicLatch(): PanicGate;
