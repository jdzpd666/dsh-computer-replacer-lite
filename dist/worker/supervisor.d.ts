import { EventEmitter } from 'node:events';
import { IpcClient } from '../ipc/client.js';
/** Worker exit code that means "own panic latch tripped (hotkey path)". */
export declare const PANIC_EXIT_CODE = 87;
/** 拍板补充③: 87 arms the latch; 1 is an ordinary taskkill /F strong kill
 * (verified exit code of `taskkill /F /PID` on this machine) and never arms it. */
export declare const isPanicExit: (code: number | null) => boolean;
export declare class Supervisor extends EventEmitter {
    private readonly executable;
    private readonly maxRestarts;
    readonly client: IpcClient;
    private child;
    private server;
    private sockets;
    private retry;
    private startup;
    private stopped;
    private attempts;
    private starts;
    private generation;
    pipeName: string;
    constructor(executable: string, maxRestarts?: number);
    get pid(): number | undefined;
    get startCount(): number;
    start(): void;
    /** Spawn argv for the worker (protected test seam: the default stays exactly
     * [pipeName]; a test subclass can inject a fake child such as
     * ["-e","process.exit(87)"] to drive exit-code classification). */
    protected spawnArguments(pipeName: string): string[];
    private launch;
    stop(): Promise<void>;
    /** Panic-button fallback (验收 e): taskkill /F a child pid when a clean stop
     * does not settle (wedged or suspended worker). Defaults to the current
     * child; callers may pass a pid captured before stop() cleared it. Resolves
     * false when no pid is given/alive or taskkill failed. Does not change
     * restart bookkeeping — stop() remains the only state-resetting path. */
    forceKill(pid?: number): Promise<boolean>;
}
