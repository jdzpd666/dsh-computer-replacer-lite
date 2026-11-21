import type { FastElement, FastTarget } from './targets.js';
import { type FastSignal } from './signals.js';
export interface FastChunk {
    type: string;
    index?: number;
    blockType?: string;
    text?: string;
    block?: {
        type?: string;
        text?: string;
        [key: string]: unknown;
    };
    reason?: {
        kind?: string;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}
export interface FastApprovalInput {
    toolName: string;
    reason: string;
    displayReason: {
        en: string;
        zh: string;
    };
    agent?: unknown;
    signal?: AbortSignal;
    [key: string]: unknown;
}
export interface FastApprovalDecision {
    allowed: boolean;
    outcome: string;
    code?: string;
    waitedMs: number;
}
export interface FastClickOutcome {
    ok: boolean;
    elementId?: string;
    method?: string;
    accepted?: boolean;
    label?: string;
    type?: number;
    windowAlive?: boolean;
    code?: string;
    message?: string;
}
export interface FastDeps {
    targets: {
        get: (sessionId: string | undefined) => FastTarget | undefined;
    };
    agent: () => unknown;
    approve: (input: FastApprovalInput) => Promise<FastApprovalDecision>;
    resolve: (signal: FastSignal, hwnd: string, sessionId: string) => Promise<FastElement | {
        error: string;
        message: string;
    }>;
    click: (hwnd: string, runtimeId: number[]) => Promise<FastClickOutcome>;
    warm: (sessionId: string, hwnd: string) => void;
    log: (message: string) => void;
}
/**
 * Wraps one llm/stream call. If the session has a cached observation and a
 * signal appears in the assistant text, the harness stops consuming the model
 * stream, asks for approval, invokes the element and synthesizes a stop finish.
 * Anything unexpected falls back to the untouched stream.
 */
export declare function createFastListener(deps: FastDeps): (options: unknown, next: () => AsyncIterable<FastChunk>) => AsyncIterable<FastChunk>;
