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
  displayReason?: { en: string; zh: string; };
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
  displayReason: { en: string; zh: string; };
  signal?: AbortSignal;
}

export const DEFAULT_APPROVAL_TIMEOUT_MS = 30_000;

/**
 * Test-only switch. When REPLACER_BYPASS_APPROVAL is exactly "true", every ask is
 * settled as 'bypassed' without contacting the Host approval channel.
 *
 * This is deliberately narrow: it grants nothing at the transport layer, it is
 * never written into the code, and each bypassed call is still recorded in the
 * audit trail and announced once on stderr. Set it only in a shell that is
 * running a deliberate test session, never in a normal DSH session.
 */
export const BYPASS_ENV = 'REPLACER_BYPASS_APPROVAL';
const MAX_AUDIT = 32;

export class ApprovalGate {
  private readonly approval: ApprovalAnswerer | undefined;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly audit: AuditEntry[] = [];

  private readonly bypass: boolean;

  constructor(deps: { approval?: ApprovalAnswerer; timeoutMs?: number; now?: () => number; bypass?: boolean; } = {}) {
    this.approval = deps.approval;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.now = deps.now ?? Date.now;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 600_000) throw new RangeError('Invalid approval timeout');
    const env = typeof process === 'undefined' ? undefined : process.env[BYPASS_ENV];
    this.bypass = deps.bypass === true || env === 'true';
    if (this.bypass) {
      console.warn('[computer-replacer] APPROVAL BYPASSED: ' + BYPASS_ENV + '=true; every write tool runs without a card.');
    }
  }

  /** Whether an approval channel exists at all; false means every write fails closed. */
  get available(): boolean { return this.approval !== undefined; }

  /** True only under the explicit test switch; surfaced by replacer_status. */
  get bypassed(): boolean { return this.bypass; }

  /** Newest-first audit trail, bounded; callers cannot mutate the stored rows. */
  recent(limit = 8): AuditEntry[] {
    const size = Math.max(0, Math.min(limit, MAX_AUDIT));
    return this.audit.slice(-size).reverse().map(entry => ({ ...entry }));
  }

  async ask(input: AskInput): Promise<GateDecision> {
    const started = this.now();
    const settle = (outcome: GateDecision['outcome'], code?: GateCode): GateDecision => {
      const decision: GateDecision = { allowed: outcome === 'allowed-once' || outcome === 'bypassed', outcome, waitedMs: this.now() - started };
      if (code !== undefined) decision.code = code;
      this.audit.push({
        at: started, toolName: input.toolName, reason: input.reason, outcome, waitedMs: decision.waitedMs,
        ...(input.callId === undefined ? {} : { callId: input.callId }),
      });
      if (this.audit.length > MAX_AUDIT) this.audit.shift();
      return decision;
    };

    const aborted = (): boolean => input.signal?.aborted === true;
    // Test switch: settles before any approval channel is consulted.
    if (this.bypass) return settle('bypassed');
    if (this.approval === undefined) return settle('unavailable', 'APPROVAL_UNAVAILABLE');
    // Without an agent there is no session to route the card through: fail closed.
    if (input.agent === undefined) return settle('unavailable', 'APPROVAL_UNAVAILABLE');
    if (aborted()) return settle('cancelled', 'CANCELLED');

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    const onAbort = (): void => { controller.abort(); };
    input.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const answer = await this.approval.request({
        agent: input.agent,
        toolName: input.toolName,
        reason: input.reason,
        displayReason: input.displayReason,
        signal: controller.signal,
        ...(input.callId === undefined ? {} : { callId: input.callId }),
      });
      // A grant that arrives after our deadline is refused: the card is already gone.
      if (timedOut) return settle('timeout', 'TIMEOUT');
      if (aborted()) return settle('cancelled', 'CANCELLED');
      if (answer === 'allowed-once') return settle('allowed-once');
      if (answer === 'rejected') return settle('rejected', 'REJECTED');
      if (answer === 'cancelled') return settle('cancelled', 'CANCELLED');
      return settle('unavailable', 'APPROVAL_UNAVAILABLE');
    } catch {
      if (timedOut) return settle('timeout', 'TIMEOUT');
      if (aborted()) return settle('cancelled', 'CANCELLED');
      // No answerer, no open turn, or the answerer threw: fail closed.
      return settle('unavailable', 'APPROVAL_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
    }
  }
}
