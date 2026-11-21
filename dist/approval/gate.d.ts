/**
 * M4 approval gate: the only path from a model tool call to a write operation.
 *
 * The gate owns a per-ask state machine:
 *
 *   idle -> asking -> granted | rejected | timed-out | cancelled | unavailable
 *
 * Exactly one terminal state is produced per ask, and a grant is the ONLY state
 * that lets the caller reach the worker. Rejection, timeout, cancellation and a
 * missing answerer all return without any injection having been requested.
 */
export type ApprovalOutcome = 'allowed-once' | 'bypassed' | 'policy-full-access' | 'rejected' | 'cancelled' | 'unavailable';
export type GateCode = 'REJECTED' | 'TIMEOUT' | 'CANCELLED' | 'APPROVAL_UNAVAILABLE';
/** The request shape `ctx.approval` accepts (mirrors the Host service). */
export interface ApprovalRequestShape {
    agent: unknown;
    toolName: string;
    callId?: string;
    reason: string;
    displayReason?: {
        en: string;
        zh: string;
    };
    signal?: AbortSignal;
}
/** The Host approval service, addressed as `ctx.get('approval')`. */
export interface ApprovalAnswerer {
    request(request: ApprovalRequestShape): Promise<unknown>;
}
export interface GateDecision {
    allowed: boolean;
    /** Raw terminal state, including 'timeout' which the Host vocabulary lacks. */
    outcome: ApprovalOutcome | 'timeout';
    code?: GateCode;
    waitedMs: number;
}
export interface AuditEntry {
    at: number;
    toolName: string;
    callId?: string;
    reason: string;
    outcome: string;
    waitedMs: number;
}
export interface AskInput {
    toolName: string;
    agent?: unknown;
    callId?: string;
    reason: string;
    displayReason: {
        en: string;
        zh: string;
    };
    signal?: AbortSignal;
}
export declare const DEFAULT_APPROVAL_TIMEOUT_MS = 30000;
/**
 * Test-only switch. When REPLACER_BYPASS_APPROVAL is exactly "true", every ask is
 * settled as 'bypassed' without contacting the Host approval channel.
 *
 * This is deliberately narrow: it grants nothing at the transport layer, it is
 * never written into the code, and each bypassed call is still recorded in the
 * audit trail and announced once on stderr. Set it only in a shell that is
 * running a deliberate test session, never in a normal DSH session.
 */
export declare const BYPASS_ENV = "REPLACER_BYPASS_APPROVAL";
export declare class ApprovalGate {
    private readonly approval;
    private readonly timeoutMs;
    private readonly now;
    private readonly audit;
    private readonly bypass;
    constructor(deps?: {
        approval?: ApprovalAnswerer;
        timeoutMs?: number;
        now?: () => number;
        bypass?: boolean;
    });
    /** Whether an approval channel exists at all; false means every write fails closed. */
    get available(): boolean;
    /** True only under the explicit test switch; surfaced by replacer_status. */
    get bypassed(): boolean;
    /** Newest-first audit trail, bounded; callers cannot mutate the stored rows. */
    recent(limit?: number): AuditEntry[];
    ask(input: AskInput): Promise<GateDecision>;
}
