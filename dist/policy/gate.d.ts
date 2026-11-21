/**
 * PolicyGate: suppress per-call approval prompts while the DSH session is under
 * the full-access preset, and stop doing so the instant that stops being true.
 *
 * Where this lives, and why:
 *
 * The DSH policy is a fold over per-session events (permission/preset,
 * sandbox/mode, approval/policy), not a global setting. The Rust Worker is a
 * single session-agnostic process launched by the Supervisor and its pipe frames
 * carry no session identity, so it cannot answer "what is this session's policy
 * right now". The approval card is also issued by this TypeScript layer through
 * ctx.approval.request. The only enforcement point that sees both the session and
 * the card is therefore here, one call before ApprovalGate.ask().
 *
 * Every check re-reads the three host services. Nothing is cached across calls,
 * across plugin restarts, or across sessions; the only stored state is the
 * per-session generation used to log an invalidation and to report status. A
 * change of generation clears the allow state immediately and the next call
 * falls back to the ordinary approval path.
 *
 * Fail-closed rules:
 *   - Only expected === FullAccess AND observed === FullAccess allows.
 *   - expected FullAccess with any other observed value is a contradiction: it
 *     is logged as an anomaly and never silently allowed.
 *   - A missing or throwing host service is Unknown, never FullAccess.
 *   - There is no time-based bypass and no persisted grant.
 */
export type PolicyLevel = 'Never' | 'ReadOnly' | 'WorkspaceWrite' | 'FullAccess' | 'Unknown';
export interface PermissionPresetsService {
    current(session: unknown): string;
}
export interface SandboxPolicyService {
    resolve(request?: {
        session?: unknown;
    }): {
        mode: string;
    };
}
export interface ApprovalPolicyService {
    effectivePolicy(session: unknown): string;
}
export interface PolicyServices {
    permissionPresets?: PermissionPresetsService | undefined;
    sandboxPolicy?: SandboxPolicyService | undefined;
    approval?: ApprovalPolicyService | undefined;
}
export type PolicyLogger = (line: string) => void;
export type PolicyLogKind = 'enabled' | 'invalidated' | 'allow' | 'deny' | 'anomaly' | 'result';
export interface PolicyLogEntry {
    at: number;
    kind: PolicyLogKind;
    expected: PolicyLevel;
    observed: PolicyLevel;
    generation: string;
    sessionId?: string;
    tool?: string;
    reason?: string;
    summary?: string;
    previous?: {
        expected: PolicyLevel;
        observed: PolicyLevel;
        generation: string;
    };
}
export interface PolicyDecision {
    allow: boolean;
    bypassed: boolean;
    tool: string;
    expected: PolicyLevel;
    observed: PolicyLevel;
    generation: string;
    reason: string;
    anomaly: boolean;
    sessionId?: string;
    log: PolicyLogEntry[];
}
export interface PolicyStateSummary {
    expected: PolicyLevel;
    observed: PolicyLevel;
    generation: string;
    cacheValid: boolean;
    lastChangeReason: string;
}
export interface PolicyInspection {
    summary: PolicyStateSummary;
    audit: PolicyLogEntry[];
}
/** Map the live (sandbox, approval) pair to one policy level. Full access requires both. */
export declare function levelOfKnobs(sandboxMode: string, approvalPolicy: string): PolicyLevel;
/** A preset name never changes the level; preset selection and live knobs share one mapping. */
export declare function levelOfPreset(sandboxMode: string, approvalPolicy: string): PolicyLevel;
export declare class PolicyGate {
    #private;
    constructor(options: {
        services: PolicyServices;
        logger?: PolicyLogger;
        now?: () => number;
    });
    /**
     * Decide one tool call. This re-reads the host services every time, so a
     * policy switch takes effect on the very next call. Returning allow=false
     * means the caller must use the ordinary ApprovalGate path.
     */
    check(input: {
        session?: unknown;
        tool: string;
        summary?: string;
    }): PolicyDecision;
    /** Record the outcome of a call that PolicyGate allowed, for the allow audit trail. */
    recordResult(decision: PolicyDecision, ok: boolean, code?: string): void;
    /** Read the current state for replacer_status without allowing anything. */
    inspect(session: unknown): PolicyInspection;
    /** Recent policy audit, oldest first. */
    recent(limit?: number): PolicyLogEntry[];
}
