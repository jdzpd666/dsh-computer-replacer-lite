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

import { createHash } from 'node:crypto';

export type PolicyLevel = 'Never' | 'ReadOnly' | 'WorkspaceWrite' | 'FullAccess' | 'Unknown';

export interface PermissionPresetsService {
  current(session: unknown): string;
}

export interface SandboxPolicyService {
  resolve(request?: { session?: unknown; }): { mode: string; };
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
  previous?: { expected: PolicyLevel; observed: PolicyLevel; generation: string; };
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

interface PolicySnapshot {
  preset: string;
  sandboxMode: string;
  approvalPolicy: string;
  expected: PolicyLevel;
  observed: PolicyLevel;
  generation: string;
  errors: string[];
}

interface SessionState extends PolicyStateSummary {}

const MAX_AUDIT = 200;
const MAX_SUMMARY = 200;
const FULL_ACCESS_PRESET = 'danger-full-access';

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

const sessionIdOf = (session: unknown): string | undefined => {
  if (typeof session !== 'object' || session === null) return undefined;
  const id = (session as { id?: unknown; }).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
};

/** Map the live (sandbox, approval) pair to one policy level. Full access requires both. */
export function levelOfKnobs(sandboxMode: string, approvalPolicy: string): PolicyLevel {
  if (sandboxMode === 'danger-full-access' && approvalPolicy === 'never') return 'FullAccess';
  if (sandboxMode === 'workspace-write' && approvalPolicy === 'never') return 'Never';
  if (sandboxMode === 'workspace-write' && approvalPolicy === 'ask') return 'WorkspaceWrite';
  return 'Unknown';
}

/** A preset name never changes the level; preset selection and live knobs share one mapping. */
export function levelOfPreset(sandboxMode: string, approvalPolicy: string): PolicyLevel {
  return levelOfKnobs(sandboxMode, approvalPolicy);
}

const generationOf = (parts: readonly string[]): string => createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);

const summarize = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return undefined;
  return flat.length > MAX_SUMMARY ? flat.slice(0, MAX_SUMMARY - 1) + '…' : flat;
};

export class PolicyGate {
  readonly #services: PolicyServices;
  readonly #logger: PolicyLogger;
  readonly #now: () => number;
  readonly #sessions = new Map<string, SessionState>();
  readonly #audit: PolicyLogEntry[] = [];

  constructor(options: { services: PolicyServices; logger?: PolicyLogger; now?: () => number; }) {
    this.#services = options.services;
    this.#logger = options.logger ?? (line => { console.error(line); });
    this.#now = options.now ?? Date.now;
  }

  /** Read one session's policy. Missing services and exceptions become Unknown. */
  #snapshot(session: unknown): PolicySnapshot {
    const errors: string[] = [];
    let preset = 'unavailable';
    let sandboxMode = 'unavailable';
    let approvalPolicy = 'unavailable';

    const presets = this.#services.permissionPresets;
    if (presets === undefined) errors.push('permissionPresets service is not available');
    else {
      try { preset = presets.current(session); }
      catch (error) { errors.push('permissionPresets.current failed: ' + messageOf(error)); }
    }

    const sandbox = this.#services.sandboxPolicy;
    if (sandbox === undefined) errors.push('sandboxPolicy service is not available');
    else {
      try { sandboxMode = sandbox.resolve(session === undefined ? {} : { session }).mode; }
      catch (error) { errors.push('sandboxPolicy.resolve failed: ' + messageOf(error)); }
    }

    const approval = this.#services.approval;
    if (approval === undefined) errors.push('approval service is not available');
    else {
      try { approvalPolicy = approval.effectivePolicy(session); }
      catch (error) { errors.push('approval.effectivePolicy failed: ' + messageOf(error)); }
    }

    const observed = sandboxMode === 'unavailable' || approvalPolicy === 'unavailable'
      ? 'Unknown'
      : levelOfKnobs(sandboxMode, approvalPolicy);
    // The live (sandbox, approval) pair is the observed policy; a preset
    // name alone never authorizes anything. A full-access preset whose live
    // knobs contradict it still reports an anomaly instead of silently
    // allowing.
    const promised = levelOfPreset(sandboxMode, approvalPolicy);
    const presetContradiction = preset === FULL_ACCESS_PRESET && observed !== 'FullAccess';
    const expected: PolicyLevel = presetContradiction
      ? 'FullAccess'
      : promised === 'Unknown'
        ? observed
        : promised;
    const generation = generationOf([preset, sandboxMode, approvalPolicy, expected, observed]);
    return { preset, sandboxMode, approvalPolicy, expected, observed, generation, errors };
  }

  #entry(kind: PolicyLogKind, decision: Pick<PolicyDecision, 'expected' | 'observed' | 'generation' | 'sessionId' | 'tool'>, reason?: string, summary?: string, previous?: PolicyLogEntry['previous']): PolicyLogEntry {
    const entry: PolicyLogEntry = { at: this.#now(), kind, expected: decision.expected, observed: decision.observed, generation: decision.generation };
    if (decision.sessionId !== undefined) entry.sessionId = decision.sessionId;
    if (decision.tool !== undefined && decision.tool.length > 0) entry.tool = decision.tool;
    const flatReason = summarize(reason);
    if (flatReason !== undefined) entry.reason = flatReason;
    const flatSummary = summarize(summary);
    if (flatSummary !== undefined) entry.summary = flatSummary;
    if (previous !== undefined) entry.previous = previous;
    return entry;
  }

  #record(entries: readonly PolicyLogEntry[]): void {
    for (const entry of entries) {
      this.#audit.push(entry);
      this.#logger('[computer-replacer:policy] ' + JSON.stringify(entry));
    }
    while (this.#audit.length > MAX_AUDIT) this.#audit.shift();
  }

  /**
   * Decide one tool call. This re-reads the host services every time, so a
   * policy switch takes effect on the very next call. Returning allow=false
   * means the caller must use the ordinary ApprovalGate path.
   */
  check(input: { session?: unknown; tool: string; summary?: string; }): PolicyDecision {
    const sessionId = sessionIdOf(input.session);
    const key = sessionId === undefined ? 'anonymous' : 'session:' + sessionId;
    const snapshot = this.#snapshot(input.session);
    // Full access is a per-session property. Without a session identity it can
    // never be proven, so an anonymous call fails closed even if a permissive
    // service would answer FullAccess for a missing session.
    if (sessionId === undefined) {
      snapshot.expected = 'Unknown';
      snapshot.observed = 'Unknown';
      snapshot.generation = generationOf(['anonymous']);
      snapshot.errors.push('no session identity is available; the full-access policy cannot be proven');
    }
    const entries: PolicyLogEntry[] = [];
    let state = this.#sessions.get(key);

    if (state === undefined) {
      state = {
        expected: snapshot.expected,
        observed: snapshot.observed,
        generation: snapshot.generation,
        cacheValid: false,
        lastChangeReason: snapshot.errors.length > 0 ? 'policy services unavailable' : 'first evaluation',
      };
      this.#sessions.set(key, state);
    } else if (state.generation !== snapshot.generation) {
      const previous = { expected: state.expected, observed: state.observed, generation: state.generation };
      const wasValid = state.cacheValid;
      state.expected = snapshot.expected;
      state.observed = snapshot.observed;
      state.generation = snapshot.generation;
      state.cacheValid = false;
      state.lastChangeReason = wasValid ? 'policy changed; the full-access grant was cleared' : 'policy changed; no grant was active';
      const probe: Pick<PolicyDecision, 'expected' | 'observed' | 'generation' | 'sessionId' | 'tool'> = {
        expected: snapshot.expected, observed: snapshot.observed, generation: snapshot.generation,
        ...(sessionId === undefined ? {} : { sessionId }), tool: input.tool,
      };
      entries.push(this.#entry('invalidated', probe, '策略变化，PolicyGate 失效（' + state.lastChangeReason + '）', undefined, previous));
    }

    const base = {
      tool: input.tool,
      expected: snapshot.expected,
      observed: snapshot.observed,
      generation: snapshot.generation,
      ...(sessionId === undefined ? {} : { sessionId }),
    };

    let decision: PolicyDecision;
    if (snapshot.errors.length > 0) {
      state.cacheValid = false;
      state.lastChangeReason = 'policy services unavailable';
      const reason = 'PolicyGate denied: ' + snapshot.errors.join('; ');
      entries.push(this.#entry('anomaly', base, reason, input.summary));
      decision = { ...base, allow: false, bypassed: false, reason, anomaly: true, log: entries };
    } else if (snapshot.expected === 'FullAccess' && snapshot.observed === 'FullAccess') {
      const firstOpen = !state.cacheValid;
      state.cacheValid = true;
      state.lastChangeReason = 'full access confirmed';
      const reason = firstOpen ? 'PolicyGate opened: expected=FullAccess observed=FullAccess' : 'full access confirmed';
      entries.push(this.#entry(firstOpen ? 'enabled' : 'allow', base, reason, input.summary));
      decision = { ...base, allow: true, bypassed: true, reason, anomaly: false, log: entries };
    } else if (snapshot.expected === 'FullAccess') {
      state.cacheValid = false;
      state.lastChangeReason = 'contradiction between the preset and the live knobs';
      const reason = '策略接口返回与预期不符：expected=FullAccess, observed=' + snapshot.observed + '（policy interface disagrees with the selected preset; failing closed to the approval path）';
      entries.push(this.#entry('anomaly', base, reason, input.summary));
      decision = { ...base, allow: false, bypassed: false, reason, anomaly: true, log: entries };
    } else {
      state.cacheValid = false;
      // The live knobs are the observed policy; a preset name alone never
      // authorizes anything, so the deny message names what was actually read.
      state.lastChangeReason = 'policy is ' + snapshot.observed;
      const reason = snapshot.observed === 'Never'
        ? 'policy is Never（用户切换至 never，正常拒绝）; the ordinary approval path applies'
        : 'policy is ' + snapshot.observed + '; the ordinary approval path applies';
      entries.push(this.#entry('deny', base, reason, input.summary));
      decision = { ...base, allow: false, bypassed: false, reason, anomaly: false, log: entries };
    }

    this.#record(entries);
    return decision;
  }

  /** Record the outcome of a call that PolicyGate allowed, for the allow audit trail. */
  recordResult(decision: PolicyDecision, ok: boolean, code?: string): void {
    const reason = ok ? 'result ok' : 'result failed: ' + (code ?? 'UNKNOWN');
    const entry = this.#entry('result', decision, reason);
    this.#record([entry]);
  }

  /** Read the current state for replacer_status without allowing anything. */
  inspect(session: unknown): PolicyInspection {
    const sessionId = sessionIdOf(session);
    const key = sessionId === undefined ? 'anonymous' : 'session:' + sessionId;
    const snapshot = this.#snapshot(session);
    let state = this.#sessions.get(key);
    const entries: PolicyLogEntry[] = [];
    if (state === undefined) {
      state = {
        expected: snapshot.expected,
        observed: snapshot.observed,
        generation: snapshot.generation,
        cacheValid: false,
        lastChangeReason: snapshot.errors.length > 0 ? 'policy services unavailable' : 'not evaluated (no gated call yet)',
      };
      this.#sessions.set(key, state);
    } else if (state.generation !== snapshot.generation) {
      const previous = { expected: state.expected, observed: state.observed, generation: state.generation };
      const probe: Pick<PolicyDecision, 'expected' | 'observed' | 'generation' | 'sessionId' | 'tool'> = {
        expected: snapshot.expected, observed: snapshot.observed, generation: snapshot.generation,
        ...(sessionId === undefined ? {} : { sessionId }), tool: 'replacer_status',
      };
      state.expected = snapshot.expected;
      state.observed = snapshot.observed;
      state.generation = snapshot.generation;
      state.cacheValid = false;
      state.lastChangeReason = 'policy changed; the full-access grant was cleared';
      entries.push(this.#entry('invalidated', probe, '策略变化，PolicyGate 失效（detected by replacer_status）', undefined, previous));
      this.#record(entries);
    }
    return { summary: { ...state }, audit: this.#audit.slice(-20) };
  }

  /** Recent policy audit, oldest first. */
  recent(limit = 20): PolicyLogEntry[] {
    return limit <= 0 ? [] : this.#audit.slice(-limit);
  }
}
