import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { type ClickResult, type ElementDetail, type FastClickResult, type FastClickXyResult, type KeyResult, type LabelLookup, type LocateResult, type ObservePage, type ReadScreenResult, type RightClickResult, type RuntimeLookup, type ScrollResult, type TypeResult, type WheelResult, type WindowInfo, type WorkerStatus } from './protocol.js';
export declare class IpcClient extends EventEmitter {
    private socket;
    private readonly pending;
    get pendingCount(): number;
    get connected(): boolean;
    attach(socket: Socket): void;
    request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
    observe(args: unknown, timeoutMs?: number): Promise<ObservePage>;
    nextPage(previous: ObservePage, limit?: number, timeoutMs?: number): Promise<ObservePage | null>;
    /** Read-only element facts for an approval card. Never captures or injects. */
    lookup(args: unknown, timeoutMs?: number): Promise<ElementDetail>;
    /**
     * Request one L1 click. Callers must have an approval grant before this is
     * reached; a dispatch whose reply is lost is reported INJECTION_UNCERTAIN
     * rather than TIMEOUT, because the Invoke may already have run.
     */
    click(args: unknown, timeoutMs?: number): Promise<ClickResult>;
    /** Read-only top-level window enumeration; never captures or injects. */
    topWindows(timeoutMs?: number): Promise<WindowInfo[]>;
    /**
     * Read-only screen perception (B-3): DXGI capture + local OCR, text + bounding
     * boxes only, zero image bytes and zero injection. Timeout covers the whole
     * chain (lazy pipeline build + capture 2s + OCR 10s); 15s is the documented
     * ceiling. A lost reply is plain TIMEOUT: nothing was ever injected.
     */
    readScreen(args: unknown, timeoutMs?: number): Promise<ReadScreenResult>;
    /**
     * Read-only visual↔UIA fusion (B-4): DXGI capture + local OCR fused with the
     * UIA element tree, returning aligned candidate elements plus text-only OCR
     * lines. Zero injection and zero image bytes; the 20s ceiling covers worker
     * observe (4s) + vision (14s). A lost reply is plain TIMEOUT: nothing was
     * ever injected, and a malformed reply rejects without disconnecting (same
     * read-only family as readScreen).
     */
    locate(args: unknown, timeoutMs?: number): Promise<LocateResult>;
    /** Read-only worker self-report: tier flags, worlds and process id. */
    status(timeoutMs?: number): Promise<WorkerStatus>;
    /**
     * Write text through ValuePattern. Approval must already be granted; a lost
     * reply is INJECTION_UNCERTAIN because SetValue may have landed.
     */
    typeText(args: unknown, timeoutMs?: number): Promise<TypeResult>;
    /**
     * Scroll a container through ScrollPattern. Approval must already be granted;
     * a lost reply is INJECTION_UNCERTAIN because the view may have moved.
     */
    scroll(args: unknown, timeoutMs?: number): Promise<ScrollResult>;
    /**
     * Post WM_CONTEXTMENU to the deepest child under one element.
     * Approval must already be granted; a lost reply is INJECTION_UNCERTAIN
     * because the message may already have been delivered.
     */
    rightClick(args: unknown, timeoutMs?: number): Promise<RightClickResult>;
    /**
     * Post WM_MOUSEWHEEL to the focused window of one element. Approval must
     * already be granted; a lost reply is INJECTION_UNCERTAIN because some or all
     * wheel messages may already have been delivered.
     */
    wheel(args: unknown, timeoutMs?: number): Promise<WheelResult>;
    /**
     * Post one key to the focused window of one hwnd through PostMessageW.
     * Approval must already be granted; a lost reply is INJECTION_UNCERTAIN because
     * some or all key messages may already have been delivered.
     */
    key(args: unknown, timeoutMs?: number): Promise<KeyResult>;
    /** Read-only exact-name lookup; facts for the approval card, never input. */
    lookupLabel(args: unknown, timeoutMs?: number): Promise<LabelLookup>;
    /** Read-only RuntimeId lookup; facts for the approval card, never input. */
    lookupRuntime(args: unknown, timeoutMs?: number): Promise<RuntimeLookup>;
    /**
     * Fast path: invoke one RuntimeId without publishing a world snapshot.
     * Approval must already be granted; a lost reply is INJECTION_UNCERTAIN
     * because the element may already have been invoked.
     */
    clickRuntime(args: unknown, timeoutMs?: number): Promise<FastClickResult>;
    /**
     * Coordinate fallback: move the pointer and send one left click.
     * Approval must already be granted; a lost reply is INJECTION_UNCERTAIN.
     */
    clickXy(args: unknown, timeoutMs?: number): Promise<FastClickXyResult>;
    disconnect(): void;
}
