import { fileURLToPath } from 'node:url';
import { Supervisor } from './worker/supervisor.js';
import {
  DEFAULT_PAGE_LIMIT, IpcError, normalizeClick, normalizeClickXy, normalizeElevatedClick, normalizeElevatedObserve,
  normalizeKey, normalizeLocate, normalizeReadScreen, normalizeRightClick, normalizeScroll, normalizeType, normalizeWheel,
  type ClickResult, type ElementDetail, type ElevatedElement, type ElevatedPage, type KeyResult, type LocateResult, type ObservePage,
  type ReadScreenResult, type RightClickResult, type ScrollResult, type TypeResult, type WheelResult, type WindowInfo, type WorkerStatus,
} from './ipc/protocol.js';
import { ApprovalGate, type ApprovalAnswerer, type AuditEntry, type GateDecision } from './approval/gate.js';
import { PolicyGate, type PolicyDecision, type PolicyLogEntry, type PolicyServices, type PolicyStateSummary } from './policy/gate.js';
import { BrokerError, callBroker } from './elevated/client.js';
import { sharedPanicLatch, type PanicLatchSnapshot } from './panic-gate.js';
import { FastTargets, type FastElement } from './fast/targets.js';
import { createFastListener } from './fast/interceptor.js';
import type { FastSignal } from './fast/signals.js';

export const name = 'computer-replacer';
export const inject = ['tools', 'webServer', 'connection'];
export const TOOL_NAMES = ['replacer_observe', 'replacer_windows', 'replacer_status', 'replacer_read_screen', 'replacer_locate', 'replacer_click_by_id', 'replacer_type', 'replacer_key', 'replacer_scroll', 'replacer_right_click_by_id', 'replacer_wheel_by_id', 'replacer_observe_elevated', 'replacer_click_elevated', 'replacer_click_xy'] as const;

export interface ApprovalSummary { outcome: string; code?: string; waitedMs: number; }

export interface Result {
  ok: boolean;
  milestone: 'M5';
  /** True once this build can perform L1 input at all; L2/L3 stay off. */
  inputImplemented: true;
  l3Enabled: false;
  code?: string;
  message?: string;
  workerConnected?: boolean;
  /** True while the panic latch holds (button or hotkey; replacer_status and every refused write). */
  panic?: boolean;
  /** Hotkey combination the worker armed, e.g. "ctrl+alt+shift+p" (replacer_status only). */
  panicHotkey?: string;
  /** Which entrance tripped the TS latch last: the input-bar button or the global hotkey (replacer_status only). */
  panicSource?: 'button' | 'hotkey';
  /** True when the approval gate ran under REPLACER_BYPASS_APPROVAL. */
  bypassed?: boolean;
  page?: ObservePage;
  windows?: WindowInfo[];
  status?: WorkerStatus;
  element?: ElementDetail;
  click?: ClickResult;
  write?: TypeResult | ScrollResult;
  /** Directed WM_CONTEXTMENU sent through PostMessageW (L2). */
  rightClick?: RightClickResult;
  /** Directed WM_MOUSEWHEEL messages sent through PostMessageW (L2). */
  wheel?: WheelResult;
  /** Directed key messages sent through PostMessageW (L2). */
  key?: KeyResult;
  /** Read-only snapshot taken through the user-launched elevated broker. */
  elevatedPage?: ElevatedPage;
  /** Read-only screen perception: OCR lines + bboxes, zero image bytes (B-3). */
  readScreen?: ReadScreenResult;
  /** Read-only visual↔UIA fusion: aligned candidate elements + text-only OCR lines, zero injection/image bytes (B-4). */
  locate?: LocateResult;
  /** Result of one UIA Invoke performed by the elevated broker. */
  clickElevated?: { hwnd: string; runtimeId: number[]; method: string; accepted: boolean; label: string; type: number; };
  /** Result of one approval-gated coordinate click (SetCursorPos + SendInput). */
  clickXY?: { hwnd: string; x: number; y: number; method: string; accepted: boolean; reactivated?: boolean; };
  approval?: ApprovalSummary;
  approvals?: AuditEntry[];
  /** PolicyGate decision for this call: allow means the approval card was skipped because the session is under full access. */
  policy?: { allow: boolean; bypassed: boolean; expected: string; observed: string; generation: string; reason: string; anomaly: boolean; };
  /** Current PolicyGate state for the calling session (replacer_status only). */
  policyState?: PolicyStateSummary;
  /** Recent PolicyGate audit entries (replacer_status only). */
  policyAudit?: PolicyLogEntry[];
}

/** The subset of the Host tool execution context this plugin relies on. */
export interface Exec {
  agent?: unknown;
  callId?: string;
  signal?: AbortSignal;
}

interface Definition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: { schema: Record<string, unknown>; render: (args: unknown, value: Result) => { type: 'text'; text: string; }[]; };
  execute: (args: unknown, exec?: Exec) => Promise<Result>;
}

export interface Context {
  tools: { view: () => { knownNames: Set<string>; }; register: (definition: Definition) => () => unknown; };
  on: (event: string, callback: (...args: never[]) => unknown, options?: { global?: boolean; prepend?: boolean; }) => unknown;
  get?: <T>(name: string) => T | undefined;
  /** Host dependency injection (cordis): used only to append the fast-signal prompt. */
  inject?: (dependencies: string[], callback: (scope: {
    systemPrompt?: {
      context?: (value: Record<string, unknown>) => unknown;
      getContextOrder?: (name: string) => number;
    };
  }) => void) => unknown;
  /** Host web server: prefix routes for the client UI (panic button). */
  webServer?: { register: (route: { kind: 'prefix'; path: string; handler: (req: HttpRequest, res: HttpResponse) => void; }) => () => unknown; };
  /** Host connection service: Origin/trust fence for web routes. */
  connection?: { requestRejection?: (req: HttpRequest) => unknown; };
}

/** Minimal shape of an incoming web request (node http IncomingMessage subset). */
export interface HttpRequest { url?: string; method?: string; headers: Record<string, unknown>; }
/** Minimal shape of the response a route handler may write. */
export interface HttpResponse { writeHead(status: number, headers: Record<string, string>): unknown; end(body?: string): unknown; }

// The Host enforces a narrow JSON Schema subset (dsh-tools assertSupportedJsonSchema):
// exactly one scalar `type` per node (no type arrays), `required` only as an
// object-level list of property names (never a per-property boolean), `items`
// for arrays, and same-kind scalar `enum`/`const`. Nullable fields are spelled
// as explicit oneOf branches because the subset rejects type arrays.
type Schema = Record<string, unknown>;

const str = (description?: string): Schema => (description === undefined ? { type: 'string' } : { type: 'string', description });
const int = (): Schema => ({ type: 'integer' });
const num = (): Schema => ({ type: 'number' });
const bool = (): Schema => ({ type: 'boolean' });
const nullable = (schema: Schema): Schema => ({ oneOf: [schema, { type: 'null' }] });
const objectOf = (properties: Record<string, Schema>, requiredKeys: string[]): Schema => ({
  type: 'object',
  additionalProperties: false,
  properties,
  ...(requiredKeys.length === 0 ? {} : { required: requiredKeys }),
});
// Shapes returned by the Rust worker carry fields this file does not model yet
// (for example UIA `runtimeId`). Host output validation rejects unknown keys only
// when a schema says additionalProperties: false, so worker-facing shapes stay open
// while declared fields keep their types and required lists.
const openObjectOf = (properties: Record<string, Schema>, requiredKeys: string[]): Schema => ({
  ...objectOf(properties, requiredKeys),
  additionalProperties: true,
});
const arrayOf = (items: Schema): Schema => ({ type: 'array', items });

const bboxSchema = objectOf({ x: num(), y: num(), width: num(), height: num() }, ['x', 'y', 'width', 'height']);
const elementSchema = openObjectOf({
  id: str(), parentId: nullable(str()), type: int(), label: str(), bbox: bboxSchema,
  enabled: bool(), offscreen: bool(), invokable: bool(), confidence: num(), observedAt: int(),
}, ['id', 'parentId', 'type', 'label', 'bbox', 'enabled', 'offscreen', 'invokable', 'confidence', 'observedAt']);
const pageSchema = openObjectOf({
  snapshotId: str(), version: int(), hwnd: str(), observedAt: int(), complete: bool(),
  totalElements: int(), returnedElements: int(), nextOffset: nullable(int()),
  pullMs: num(), modelMs: num(), observeMs: num(), elements: arrayOf(elementSchema),
}, ['snapshotId', 'version', 'hwnd', 'observedAt', 'complete', 'totalElements', 'returnedElements', 'nextOffset', 'pullMs', 'modelMs', 'observeMs', 'elements']);
const detailSchema = openObjectOf({
  id: str(), parentId: nullable(str()), type: int(), label: str(), windowLabel: str(), bbox: bboxSchema,
  enabled: bool(), offscreen: bool(), invokable: bool(), confidence: num(),
}, ['id', 'parentId', 'type', 'label', 'windowLabel', 'bbox', 'enabled', 'offscreen', 'invokable', 'confidence']);
const clickSchema = openObjectOf({ hwnd: str(), elementId: str(), method: str(), accepted: bool() }, ['hwnd', 'elementId', 'method', 'accepted']);
const writeSchema = openObjectOf({ hwnd: str(), elementId: str(), method: str(), accepted: bool(), characters: int(), horizontal: str(), vertical: str(), steps: int() }, ['hwnd', 'elementId', 'method', 'accepted']);
const windowSchema = openObjectOf({ hwnd: str(), label: str(), type: int(), bbox: bboxSchema, enabled: bool(), offscreen: bool() }, ['hwnd', 'label', 'type', 'bbox', 'enabled', 'offscreen']);
const worldSchema = openObjectOf({ hwnd: str(), version: int(), elements: int(), observedAt: int() }, ['hwnd', 'version', 'elements', 'observedAt']);
const statusSchema = openObjectOf({ tier: str(), l2: bool(), l3: bool(), pid: int(), worlds: arrayOf(worldSchema) }, ['tier', 'l2', 'l3', 'pid', 'worlds']);
const runtimeIdSchema = arrayOf(int());
const elevatedElementSchema = openObjectOf({
  id: str(), parentId: nullable(str()), runtimeId: runtimeIdSchema, type: int(), label: str(), bbox: bboxSchema,
  enabled: bool(), offscreen: bool(), invokable: bool(), confidence: num(), observedAt: int(),
}, ['id', 'type', 'label', 'bbox', 'enabled', 'offscreen', 'invokable']);
const elevatedPageSchema = openObjectOf({
  hwnd: str(), observedAt: int(), complete: bool(), totalElements: int(), elements: arrayOf(elevatedElementSchema),
  focus: nullable(runtimeIdSchema), pullMs: num(), modelMs: num(), brokerPid: int(),
}, ['hwnd', 'observedAt', 'complete', 'totalElements', 'elements']);
const elevatedClickSchema = openObjectOf({ hwnd: str(), runtimeId: runtimeIdSchema, method: str(), accepted: bool(), label: str(), type: int() }, ['hwnd', 'runtimeId', 'method', 'accepted']);
const clickXySchema = openObjectOf({ hwnd: str(), x: int(), y: int(), method: str(), accepted: bool(), reactivated: bool() }, ['hwnd', 'x', 'y', 'method', 'accepted']);
const rightClickSchema = openObjectOf({
  hwnd: str(), elementId: str(), method: str(), accepted: bool(), targetHwnd: str(),
  x: int(), y: int(), screenX: int(), screenY: int(), reactivated: bool(), windowAlive: bool(),
}, ['hwnd', 'elementId', 'method', 'accepted', 'targetHwnd', 'x', 'y', 'screenX', 'screenY']);
const wheelSchema = openObjectOf({
  hwnd: str(), elementId: str(), method: str(), accepted: bool(), targetHwnd: str(),
  screenX: int(), screenY: int(), vertical: str(), steps: int(), delta: int(), reactivated: bool(), windowAlive: bool(),
}, ['hwnd', 'elementId', 'method', 'accepted', 'targetHwnd', 'screenX', 'screenY', 'vertical', 'steps', 'delta']);
const keySchema = openObjectOf({
  hwnd: str(), combo: str(), method: str(), accepted: bool(), keysPosted: int(), focusHwnd: str(),
  reactivated: bool(), windowAlive: bool(),
}, ['hwnd', 'combo', 'method', 'accepted', 'keysPosted', 'focusHwnd', 'windowAlive']);
const approvalSchema = openObjectOf({ outcome: str(), code: str(), waitedMs: num() }, ['outcome', 'waitedMs']);
const readScreenLineSchema = openObjectOf({
  text: str(), bbox: bboxSchema, words: arrayOf(objectOf({ text: str(), bbox: bboxSchema }, ['text', 'bbox'])),
}, ['text', 'bbox']);
const readScreenSchema = openObjectOf({
  width: int(), height: int(), lines: arrayOf(readScreenLineSchema), text: str(),
  truncated: bool(), totalLines: int(),
  timings: objectOf({ buildMs: num(), captureMs: num(), ocrMs: num() }, ['buildMs', 'captureMs', 'ocrMs']),
}, ['width', 'height', 'lines', 'text', 'truncated', 'timings']);
const locateMatchSchema = openObjectOf({
  elementId: str(), label: str(), type: int(), bbox: bboxSchema,
  enabled: bool(), invokable: bool(), offscreen: bool(),
  source: { type: 'string', enum: ['fusion', 'uia'] }, score: num(), textScore: num(), overlap: num(), ocrText: nullable(str()),
}, ['elementId', 'label', 'type', 'bbox', 'enabled', 'invokable', 'offscreen', 'source', 'score', 'textScore', 'overlap', 'ocrText']);
const locateTextHitSchema = openObjectOf({ text: str(), bbox: bboxSchema, score: num() }, ['text', 'bbox', 'score']);
const locateSchema = openObjectOf({
  hwnd: str(), snapshotId: str(), observedAt: int(), query: nullable(str()),
  channel: { type: 'string', enum: ['fusion', 'uia_only'] }, degraded: bool(), degradeReason: nullable(str()),
  capabilities: objectOf({ capture: bool(), ocr: bool(), grounding: bool() }, ['capture', 'ocr', 'grounding']),
  window: bboxSchema, matches: arrayOf(locateMatchSchema), textOnly: arrayOf(locateTextHitSchema),
  timings: objectOf({ observeMs: num(), captureMs: num(), ocrMs: num(), fusionMs: num(), buildMs: num() }, ['observeMs', 'captureMs', 'ocrMs', 'fusionMs', 'buildMs']),
  truncated: bool(), totalMatches: int(), totalTextOnly: int(),
}, ['hwnd', 'snapshotId', 'observedAt', 'query', 'channel', 'degraded', 'degradeReason', 'capabilities', 'window', 'matches', 'textOnly', 'timings', 'truncated', 'totalMatches', 'totalTextOnly']);
const auditSchema = openObjectOf({ at: int(), toolName: str(), callId: str(), reason: str(), outcome: str(), waitedMs: num() }, ['at', 'toolName', 'reason', 'outcome', 'waitedMs']);
const policyDecisionSchema = openObjectOf({ allow: bool(), bypassed: bool(), expected: str(), observed: str(), generation: str(), reason: str(), anomaly: bool() }, ['allow', 'bypassed', 'expected', 'observed', 'generation', 'reason', 'anomaly']);
const policyStateSchema = openObjectOf({ expected: str(), observed: str(), generation: str(), cacheValid: bool(), lastChangeReason: str() }, ['expected', 'observed', 'generation', 'cacheValid', 'lastChangeReason']);
const policyLogSchema = openObjectOf({ at: int(), kind: str(), sessionId: str(), tool: str(), expected: str(), observed: str(), generation: str(), reason: str(), summary: str() }, ['at', 'kind', 'expected', 'observed', 'generation']);
const outputSchema = openObjectOf({
  ok: bool(), milestone: str(), inputImplemented: bool(), l3Enabled: bool(),
  code: str(), message: str(), workerConnected: bool(), bypassed: bool(),
  page: pageSchema, windows: arrayOf(windowSchema), status: statusSchema, element: detailSchema,
  click: clickSchema, write: writeSchema, rightClick: rightClickSchema, wheel: wheelSchema, key: keySchema,
  readScreen: readScreenSchema, locate: locateSchema,
  elevatedPage: elevatedPageSchema, clickElevated: elevatedClickSchema, clickXY: clickXySchema,
  approval: approvalSchema, approvals: arrayOf(auditSchema),
  policy: policyDecisionSchema, policyState: policyStateSchema, policyAudit: arrayOf(policyLogSchema),
}, ['ok', 'milestone', 'inputImplemented', 'l3Enabled']);
const hwndParameter = str('Target window handle as a nonzero decimal integer string, as returned by replacer_windows or supplied by the user.');
const elementParameter = str('Element id from replacer_observe for that same window (a stale id fails with STALE_STATE).');
const observeParameters = objectOf({
  hwnd: hwndParameter,
  snapshotId: str('Read an existing immutable snapshot. Omit to capture a new snapshot.'),
  offset: { type: 'integer', description: 'Zero-based element offset, default 0. Nonzero requires snapshotId.' },
  limit: { type: 'integer', description: 'Maximum elements in this page, 1..' + DEFAULT_PAGE_LIMIT + '; default ' + DEFAULT_PAGE_LIMIT + '.' },
}, ['hwnd']);
const clickParameters = objectOf({ hwnd: hwndParameter, elementId: elementParameter }, ['hwnd', 'elementId']);
const typeParameters = objectOf({
  hwnd: hwndParameter,
  elementId: elementParameter,
  text: str('Text to write into the element through UIA ValuePattern (1..8192 characters). This build never synthesizes keystrokes.'),
}, ['hwnd', 'elementId', 'text']);
const scrollParameters = objectOf({
  hwnd: hwndParameter,
  elementId: elementParameter,
  horizontal: { type: 'string', enum: ['no', 'left', 'right'], description: 'Horizontal direction, default no.' },
  vertical: { type: 'string', enum: ['no', 'up', 'down'], description: 'Vertical direction, default no. At least one direction must be given.' },
  steps: { type: 'integer', description: 'Viewports to move, 1..10; default 1.' },
}, ['hwnd', 'elementId']);
const rightClickParameters = objectOf({ hwnd: hwndParameter, elementId: elementParameter }, ['hwnd', 'elementId']);
const wheelParameters = objectOf({
  hwnd: hwndParameter,
  elementId: elementParameter,
  vertical: { type: 'string', enum: ['up', 'down'], description: 'Wheel direction, default down.' },
  steps: { type: 'integer', description: 'Wheel messages to send, 1..10; default 1. Each step is WHEEL_DELTA * 3.' },
}, ['hwnd', 'elementId']);
const readScreenParameters = objectOf({
  region: objectOf({
    x: { type: 'integer', description: 'Region origin X in full-screen physical pixels (0 or greater; same coordinate system as replacer_click_xy).' },
    y: { type: 'integer', description: 'Region origin Y in full-screen physical pixels (0 or greater).' },
    width: { type: 'integer', description: 'Region width in physical pixels (1 or greater; parts outside the screen are clamped).' },
    height: { type: 'integer', description: 'Region height in physical pixels (1 or greater; parts outside the screen are clamped).' },
  }, ['x', 'y', 'width', 'height']),
}, []);
const locateParameters = openObjectOf({
  hwnd: hwndParameter,
  query: str('Optional screen text to locate (1..512 characters, CJK-safe). Omit to align every on-screen OCR line with the UIA element tree instead.'),
  maxResults: { type: 'integer', description: 'Maximum aligned candidate elements to return, 1..50; default 10. Candidates beyond the cap are dropped and truncated:true is set.' },
  minScore: { type: 'number', description: 'Minimum fusion score, finite 0..1; default 0.5. Weaker candidates are dropped.' },
}, ['hwnd']);
const keyParameters = objectOf({
  hwnd: hwndParameter,
  combo: str('One key to post to the input surface (the editor-like descendant of the hwnd): a key name such as "enter", "return", "esc", "escape", "tab", "backspace", "delete", "del", "home", "end", "pageup", "pagedown", "up", "down", "left", "right", "space", "a".."z", "0".."9", "f1".."f12", or one single character (Chinese included), for example "键". Modifier chords (ctrl/alt/shift/meta/win + key) are not supported: PostMessageW cannot deliver modifier state, so "ctrl+a" arrives as the literal letter a. For text input use replacer_type.'),
}, ['hwnd', 'combo']);
const observeElevatedParameters = objectOf({ hwnd: hwndParameter }, ['hwnd']);
const clickElevatedParameters = objectOf({
  hwnd: hwndParameter,
  runtimeId: { type: 'array', items: int(), description: 'UIA RuntimeId of one element returned by replacer_observe_elevated for the same hwnd (1..64 integers).' },
}, ['hwnd', 'runtimeId']);
const clickXyParameters = objectOf({
  hwnd: hwndParameter,
  x: { type: 'integer', description: 'Screen X in physical pixels (virtual-screen coordinates).' },
  y: { type: 'integer', description: 'Screen Y in physical pixels (virtual-screen coordinates).' },
}, ['hwnd', 'x', 'y']);

const noParameters = objectOf({}, []);

/** Every Host-facing schema, exported so the enforced-subset check can inspect the built artifact. */
export const SCHEMAS = { observeParameters, clickParameters, typeParameters, scrollParameters, rightClickParameters, wheelParameters, keyParameters, keySchema, readScreenParameters, readScreenSchema, locateParameters, locateSchema, observeElevatedParameters, clickElevatedParameters, clickXyParameters, noParameters, outputSchema } as const;

const CONTROL_TYPES: Record<number, string> = { 50000: 'button', 50001: 'calendar', 50002: 'check box', 50003: 'combo box', 50004: 'edit', 50005: 'hyperlink', 50006: 'image', 50007: 'list item', 50008: 'list', 50009: 'menu', 50010: 'menu bar', 50011: 'menu item', 50012: 'progress bar', 50013: 'radio button', 50014: 'scroll bar', 50015: 'slider', 50016: 'spinner', 50017: 'status bar', 50018: 'tab', 50019: 'tab item', 50020: 'text', 50021: 'tool bar', 50022: 'tool tip', 50023: 'tree', 50024: 'tree item', 50025: 'custom', 50026: 'group', 50027: 'thumb', 50028: 'data grid', 50029: 'data item', 50030: 'document', 50031: 'split button', 50032: 'window', 50033: 'pane', 50034: 'header', 50035: 'header item', 50036: 'table', 50037: 'title bar', 50038: 'separator' };
const typeName = (type: number): string => CONTROL_TYPES[type] ?? ('control ' + type);
const truncated = (text: string, max = 80): string => (text.length <= max ? text : text.slice(0, max - 1) + '…');
const boxText = (bbox: ElementDetail['bbox']): string => Math.round(bbox.x) + ',' + Math.round(bbox.y) + ' ' + Math.round(bbox.width) + 'x' + Math.round(bbox.height);
const preview = (text: string): string => truncated(text.replace(/\s+/g, ' ').trim(), 60) || '(whitespace only)';

const REJECTION_MESSAGES: Record<string, string> = {
  REJECTED: 'The user rejected this operation; zero input was performed',
  TIMEOUT: 'Approval timed out; zero input was performed',
  CANCELLED: 'Approval was cancelled; zero input was performed',
  APPROVAL_UNAVAILABLE: 'No approval channel is available for this session; zero input was performed',
};

export function apply(ctx: Context): void {
  const known = ctx.tools.view().knownNames;
  for (const tool of TOOL_NAMES) { if (known.has(tool)) throw new Error('TOOL_NAME_COLLISION: ' + tool); }
  const workerExe = fileURLToPath(new URL('./replacer-worker.exe', import.meta.url));
  const worker = new Supervisor(workerExe);
  // TS-side authoritative panic latch (§7.5): one latch for both entrances,
  // sticky across worker restarts, persisted under .runtime so a plugin reload
  // never silently loses an emergency stop. Restore happens at activation.
  // Shared singleton (重启缺陷修复): webServer routes survive a plugin restart,
  // so old route closures must serve the SAME latch object as this activation —
  // sharedPanicLatch() guarantees that; the fresh supervisor is re-bound here.
  const panicGate = sharedPanicLatch();
  panicGate.attachSupervisor(worker);
  const panicSnapshot = (): PanicLatchSnapshot => panicGate.snapshot();
  const latchRestored = panicGate.restore();
  if (latchRestored.latched) console.error('[computer-replacer] panic latch restored (source=' + (latchRestored.source ?? 'unknown') + ')');
  // Hotkey path B: worker exit(87) → arm the same latch (source 'hotkey').
  worker.on('panic', () => { panicGate.noteHotkeyExit(); });
  // Lazy restart (拍板①): the panic kill chain leaves the supervisor stopped.
  // After a recover, the next tool call / status query pulls the worker back up
  // instead of failing forever with WORKER_UNAVAILABLE. Idempotent; the wait is
  // bounded so a wedged spawn degrades to one failed call, not a hung tool.
  const ensureWorker = async (): Promise<void> => {
    if (worker.client.connected) return;
    worker.start();
    if (worker.client.connected) return;
    await new Promise<void>(resolve => {
      const onReady = (): void => { clearTimeout(timer); worker.off('ready', onReady); resolve(); };
      const timer = setTimeout(() => { worker.off('ready', onReady); resolve(); }, 3000);
      worker.once('ready', onReady);
    });
  };
  const approval = ctx.get?.<ApprovalAnswerer>('approval');
  const gate = new ApprovalGate(approval === undefined ? {} : { approval });
  // Resolve the host policy services lazily on every check. After a host restart
  // this plugin can be constructed before permissionPresets, sandboxPolicy and
  // approval are registered; a one-time lookup would then pin Unknown for the
  // rest of the process. These getters re-read ctx on each property access, so a
  // late service is picked up and a service that disappears still fails closed.
  const policyServices: PolicyServices = {
    get permissionPresets() {
      return ctx.get?.<{ current(session: unknown): string; }>('permissionPresets');
    },
    get sandboxPolicy() {
      return ctx.get?.<{ resolve(request?: { session?: unknown; }): { mode: string; }; }>('sandboxPolicy');
    },
    get approval() {
      return ctx.get?.<{ effectivePolicy(session: unknown): string; }>('approval');
    },
  };
  const policy = new PolicyGate({
    services: policyServices,
    logger: line => { console.error(line); },
  });
  const policySummary = (decision: PolicyDecision): NonNullable<Result['policy']> => ({
    allow: decision.allow, bypassed: decision.bypassed, expected: decision.expected, observed: decision.observed,
    generation: decision.generation, reason: decision.reason, anomaly: decision.anomaly,
  });
  const policyGrant = (): GateDecision => ({ allowed: true, outcome: 'policy-full-access', waitedMs: 0 });
  const disposers: (() => unknown)[] = [];
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return; disposed = true;
    try { for (const unregister of disposers.reverse()) { try { unregister(); } catch {} } } finally { await worker.stop(); }
  };
  const base = { milestone: 'M5', inputImplemented: true, l3Enabled: false } as const;
  const failure = (error: unknown): Result => error instanceof IpcError
    ? { ...base, ok: false, code: error.code, message: error.message, bypassed: gate.bypassed }
    : error instanceof BrokerError
      ? { ...base, ok: false, code: error.code, message: error.message, bypassed: gate.bypassed }
      : { ...base, ok: false, code: 'WORKER_UNAVAILABLE', message: error instanceof Error ? error.message : 'Worker request failed', bypassed: gate.bypassed };
  // A missing broker is the normal state until the user starts it: name the exact command.
  const brokerFailure = (error: unknown): Result => {
    const reported = failure(error);
    if (error instanceof BrokerError && error.code === 'BROKER_NOT_RUNNING') {
      return { ...reported, message: error.message + ' Start it once through UAC: Start-Process -FilePath "' + workerExe + '" -ArgumentList "elevated-broker" -Verb RunAs' };
    }
    return reported;
  };
  // PANIC_ABORTED (button/hotkey latch): mirrors the worker's hotkey wording
  // (zero injection performed, already-sent messages cannot be recalled).
  // Answered from the TS latch alone — no worker request, no approval card.
  const panicRefusal = (): Result => ({
    ...base, ok: false, code: 'PANIC_ABORTED',
    message: 'Panic latch tripped (emergency stop button or hotkey); aborted before any message was issued; zero injection performed. Messages already sent cannot be recalled',
    panic: true,
    ...(panicSnapshot().source === undefined ? {} : { panicSource: panicSnapshot().source }),
    bypassed: gate.bypassed,
  });
  // ---------------------------------------------------------------------------
  // Fast path: <C:label> and <I:r:[...]> signals inside the assistant stream.
  // The listener wraps llm/stream, so the turn is still open when it asks for
  // approval: approval and invocation happen before the model is allowed to
  // finish, and the stream is then closed with a synthetic stop.
  // ---------------------------------------------------------------------------
  const targets = new FastTargets();
  const warmAt = new Map<string, number>();
  const sessionIdOf = (agent: unknown): string | undefined => {
    if (typeof agent !== 'object' || agent === null) return undefined;
    const session = (agent as { session?: unknown }).session;
    if (typeof session !== 'object' || session === null) return undefined;
    const id = (session as { id?: unknown }).id;
    return typeof id === 'string' && id.length > 0 ? id : undefined;
  };
  const sessionOf = (agent: unknown): unknown => {
    if (typeof agent !== 'object' || agent === null) return undefined;
    return (agent as { session?: unknown }).session;
  };
  const agents = ctx.get?.<{ currentInitiator?: () => unknown; }>('agents');
  const fastAgent = (): unknown => agents?.currentInitiator?.();
  const factsOf = (element: FastElement): FastElement => ({ ...element });
  const resolveFastTarget = async (signal: FastSignal, hwnd: string, sessionId: string): Promise<FastElement | { error: string; message: string; }> => {
    const cached = targets.get(sessionId);
    if (cached !== undefined && cached.hwnd === hwnd) {
      if (signal.kind === 'runtime') {
        const wanted = JSON.stringify(signal.runtimeId);
        const hit = cached.elements.find(element => JSON.stringify(element.runtimeId) === wanted);
        if (hit !== undefined) return factsOf(hit);
      } else {
        const matches = cached.elements.filter(element => element.label === signal.label);
        const only = matches[0];
        if (matches.length === 1 && only !== undefined) return factsOf(only);
        if (matches.length > 1) {
          const invokable = matches.filter(element => element.invokable);
          const chosen = invokable[0];
          if (invokable.length === 1 && chosen !== undefined) return factsOf(chosen);
          return { error: 'AMBIGUOUS_IDENTITY', message: String(matches.length) + ' cached elements share the exact name ' + signal.label + '; use one <I:r:[...]> signal instead' };
        }
      }
    }
    try {
      if (signal.kind === 'runtime') {
        const reply = await worker.client.lookupRuntime({ hwnd, runtimeId: signal.runtimeId });
        const element = reply.element;
        return factsOf({ runtimeId: element.runtimeId, label: element.label, type: element.type, bbox: element.bbox, invokable: element.invokable, enabled: element.enabled, offscreen: element.offscreen, observedAt: Date.now() });
      }
      const reply = await worker.client.lookupLabel({ hwnd, label: signal.label });
      const element = reply.element;
      return factsOf({ runtimeId: element.runtimeId, label: element.label, type: element.type, bbox: element.bbox, invokable: element.invokable, enabled: element.enabled, offscreen: element.offscreen, observedAt: Date.now() });
    } catch (error) {
      if (error instanceof IpcError) return { error: error.code, message: error.message };
      return { error: 'WORKER_UNAVAILABLE', message: error instanceof Error ? error.message : 'Fast lookup failed' };
    }
  };
  const warm = (sessionId: string, hwnd: string): void => {
    const now = Date.now();
    const previous = warmAt.get(sessionId) ?? 0;
    if (now - previous < 800) return;
    warmAt.set(sessionId, now);
    void (async () => {
      try {
        const page = await worker.client.observe({ hwnd, limit: DEFAULT_PAGE_LIMIT });
        targets.record(sessionId, page);
      } catch {
        // Best effort: the resolved lookup still works when the shadow observation fails.
      }
    })();
  };
  const fastPrompt = [
    '极速点击暗号（computer-replacer）：',
    '1. 每个会话第一次使用暗号前，先调用一次 replacer_observe(hwnd) 让 harness 记住目标窗口；暗号只对最近一次被观察的窗口生效，没有观察过的会话里暗号不会触发。',
    '2. 提权窗口不适用暗号：高权限窗口请继续用 replacer_observe_elevated + replacer_click_elevated。',
    '3. 要点击界面上已知文本的控件时，直接输出 <C:控件的精确 Name>，例如 <C:确定>。',
    '4. 已知 UIA RuntimeId 时输出 <I:r:[42,1115222]> 形式，例如 <I:r:[42,329312,4,1]>。',
    '5. 暗号必须单独出现在回复文本里，不要放进代码块、引号或反引号，暗号之后不要再写别的字：harness 一看到完整暗号就会停止生成并弹出审批卡，批准后立即用 UIA Invoke 点击。',
    '6. 只有能通过 UIA 寻址的控件才发暗号；一个 UIA 节点都拿不到时，才改用 replacer_click_xy(hwnd, x, y) 坐标兜底。',
    '7. 破坏性动作（删除、格式化、支付、关闭未保存文档）不要用暗号，先说明再用普通工具并等用户确认。',
    '8. 需要按键（Enter/Esc/方向键/Backspace/F1-F12/单个字符）时用 replacer_key(hwnd, combo)：只支持单键，不支持 Ctrl/Alt/Shift 和弦（PostMessageW 无法传递修饰键状态）；连续文本一律用 replacer_type（ValuePattern），不要把 replacer_key 当打字机。',
    '9. 目标窗口切换过前台后，旧的观察会失效并报 CONTEXT_CHANGED（这是保护，不是故障）：正确顺序是先把窗口调到前台 → 重新 replacer_observe → 再执行点击/输入。',
  ].join(String.fromCharCode(10));
  const fastListener = createFastListener({
    targets,
    agent: fastAgent,
    approve: async input => {
      // Panic latch holds: no approval card, no click — the fast signal aborts.
      if (panicGate.latchedNow) return { allowed: false, outcome: 'panic-aborted', code: 'PANIC_ABORTED', waitedMs: 0 };
      const decision = policy.check({ session: sessionOf(input.agent), tool: input.toolName, summary: input.reason });
      if (decision.allow) return { allowed: true, outcome: 'policy-full-access', waitedMs: 0 };
      return gate.ask(input);
    },
    resolve: resolveFastTarget,
    click: async (hwnd, runtimeId) => {
      if (panicGate.latchedNow) return { ok: false, code: 'PANIC_ABORTED', message: 'Panic latch tripped (emergency stop button or hotkey); aborted before any message was issued; zero injection performed. Messages already sent cannot be recalled' };
      await ensureWorker();
      try {
        const result = await worker.client.clickRuntime({ hwnd, runtimeId });
        return {
          ok: true, elementId: result.elementId, method: result.method, accepted: result.accepted,
          ...(result.label === undefined ? {} : { label: result.label }),
          ...(result.type === undefined ? {} : { type: result.type }),
          ...(result.windowAlive === undefined ? {} : { windowAlive: result.windowAlive }),
        };
      } catch (error) {
        const reported = failure(error);
        return {
          ok: false,
          ...(reported.code === undefined ? {} : { code: reported.code }),
          ...(reported.message === undefined ? {} : { message: reported.message }),
        };
      }
    },
    warm,
    log: message => { console.error('[computer-replacer] ' + message); },
  });
  const disposeFast = ctx.on('llm/stream', fastListener as unknown as (...args: never[]) => unknown, { global: true });
  if (typeof disposeFast === 'function') disposers.push(disposeFast as () => unknown);
  ctx.inject?.(['systemPrompt'], scope => {
    const service = scope.systemPrompt;
    if (service?.context === undefined) return;
    const order = service.getContextOrder?.('TOOL_COMPUTER_USE');
    service.context({
      name: 'computer-replacer:fast-signals',
      order: typeof order === 'number' && Number.isFinite(order) ? order : 3000,
      text: fastPrompt,
    });
  });

  const approvalSummary = (decision: { outcome: string; code?: string; waitedMs: number; }): ApprovalSummary => ({
    outcome: decision.outcome, waitedMs: decision.waitedMs, ...(decision.code === undefined ? {} : { code: decision.code }),
  });

  // ---------------------------------------------------------------------------
  // Panic button routes (§7.5): client UI ⇄ host RPC over the same-origin web
  // server (Electron shell forwards /computer-replacer/* to the Host). Fenced
  // through the connection trust check, POST-only, three methods, idempotent.
  // These are UI-only surfaces: panic is never a model tool, so the model can
  // neither trip nor clear the latch through the tool protocol (it could only
  // forge a local HTTP call, which is accepted risk — 修正案二).
  // ---------------------------------------------------------------------------
  if (ctx.webServer) {
    const writeJson = (res: HttpResponse, code: number, payload: unknown): void => {
      try { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); }
      catch (error) { console.error('[computer-replacer] panic route write failed: ' + (error instanceof Error ? error.message : String(error))); }
    };
    // Duplicate-tolerant registration (重启缺陷修复): the host-owned webServer can
    // outlive a plugin activation — "立即重启" without a graceful dispose leaves
    // the previous prefix route in place, and a naive re-register throws
    // "duplicate prefix route", which used to kill the whole plugin (tools
    // vanished, worker never started, button still visible). The survived route
    // serves the SHARED latch (sharedPanicLatch), so keeping it is correct.
    let disposeRoutes: (() => unknown) | undefined;
    try {
      disposeRoutes = ctx.webServer.register({
      kind: 'prefix',
      path: '/computer-replacer/api',
      handler: (req, res) => {
        if (ctx.connection?.requestRejection && ctx.connection.requestRejection(req) !== undefined) {
          writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } });
          return;
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } });
          return;
        }
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
        const method = pathname.startsWith('/computer-replacer/api/')
          ? pathname.slice('/computer-replacer/api/'.length)
          : undefined;
        if (method !== 'panic.trip' && method !== 'panic.recover' && method !== 'panic.status') {
          writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown computer-replacer API method' } });
          return;
        }
        if (method === 'panic.trip') {
          // Answer after the kill chain settles so "已急停" on the button means
          // the worker was already cut down (or force-killed). Returning the
          // promise lets route-level tests await completion.
          return panicGate.trip('button').then(snapshot =>
            writeJson(res, 200, { ok: true, latched: snapshot.latched, at: snapshot.at, ...(snapshot.source === undefined ? {} : { source: snapshot.source }) }))
            .catch(error => writeJson(res, 500, { ok: false, error: { code: 'PANIC_TRIP_FAILED', message: error instanceof Error ? error.message : String(error) } }));
        }
        if (method === 'panic.recover') {
          // Recover success = latch cleared (拍板①): worker start is lazy and
          // never fails this answer.
          const snapshot = panicGate.recover();
          writeJson(res, 200, { ok: true, latched: snapshot.latched, workerConnected: snapshot.workerConnected });
          return;
        }
        const snapshot = panicSnapshot();
        writeJson(res, 200, { ok: true, latched: snapshot.latched, at: snapshot.at, ...(snapshot.source === undefined ? {} : { source: snapshot.source }), workerConnected: snapshot.workerConnected });
      },
      });
    } catch (error) {
      if (error instanceof Error && /duplicate/i.test(error.message)) {
        console.error('[computer-replacer] panic routes survived restart, serving shared-latch state (duplicate registration skipped)');
      } else {
        throw error;
      }
    }
    if (typeof disposeRoutes === 'function') disposers.push(disposeRoutes);
  }

  /** One gated L1 write: read-only facts, then a decision, then - only then - the worker call. */
  const gated = async (options: {
    tool: string;
    hwnd: string;
    /** Omitted only by window-directed tools (replacer_key): there is no element to look up. */
    elementId?: string;
    exec: Exec | undefined;
    blocked: (detail: ElementDetail) => string | null;
    card: (detail: ElementDetail) => { reason: string; en: string; zh: string; };
    run: (detail: ElementDetail) => Promise<Result>;
  }): Promise<Result> => {
    // Panic latch first (拍板补充②: interception scope = every gated write path;
    // read-only tools never enter here). Before any lookup, before PolicyGate,
    // before the approval card: zero worker dependency while latched.
    if (panicGate.latchedNow) return panicRefusal();
    // Unlatched: pull the worker back up after a recover before its first use.
    await ensureWorker();
    // Read-only facts for the card come from the Worker, never from the model's text.
    let detail: ElementDetail;
    if (options.elementId === undefined) {
      // Window-directed injection targets the input surface of the hwnd, not an element:
      // no lookup can run, so a placeholder stands in and window-directed cards read
      // only their own request from the closure, never this detail.
      detail = { id: '', parentId: null, type: 0, label: '', windowLabel: '', bbox: { x: 0, y: 0, width: 0, height: 0 }, enabled: true, offscreen: false, invokable: false, confidence: 0 };
    } else {
      try { detail = await worker.client.lookup({ hwnd: options.hwnd, elementId: options.elementId }); } catch (error) { return failure(error); }
    }
    const refusal = options.blocked(detail);
    if (refusal !== null) return { ...base, ok: false, code: 'ELEMENT_NOT_INVOKABLE', message: refusal, bypassed: gate.bypassed };
    const card = options.card(detail);
    const exec = options.exec;
    // PolicyGate runs before the card. Under full access it returns allow and the
    // card is skipped; in every other case the ordinary approval path is used.
    const policyDecision = policy.check({ session: sessionOf(exec?.agent), tool: options.tool, summary: card.reason });
    const decision = policyDecision.allow ? policyGrant() : await gate.ask({
      toolName: options.tool,
      reason: card.reason,
      displayReason: { en: card.en, zh: card.zh },
      ...(exec?.agent === undefined ? {} : { agent: exec.agent }),
      ...(exec?.callId === undefined ? {} : { callId: exec.callId }),
      ...(exec?.signal === undefined ? {} : { signal: exec.signal }),
    });
    if (!decision.allowed) {
      const code = decision.code ?? 'APPROVAL_UNAVAILABLE';
      return { ...base, ok: false, code, message: REJECTION_MESSAGES[code] ?? 'Approval was not granted; zero input was performed', approval: approvalSummary(decision), policy: policySummary(policyDecision), bypassed: gate.bypassed };
    }
    try {
      const result = await options.run(detail);
      if (policyDecision.allow) policy.recordResult(policyDecision, result.ok === true, result.code);
      return { ...result, approval: approvalSummary(decision), policy: policySummary(policyDecision), bypassed: gate.bypassed };
    } catch (error) {
      if (policyDecision.allow) policy.recordResult(policyDecision, false, error instanceof IpcError ? error.code : undefined);
      return { ...failure(error), approval: approvalSummary(decision), policy: policySummary(policyDecision) };
    }
  };

  const click = async (args: unknown, exec: Exec | undefined): Promise<Result> => {
    let request: ReturnType<typeof normalizeClick>;
    try { request = normalizeClick(args); } catch (error) { return failure(error); }
    return gated({
      tool: 'replacer_click_by_id', hwnd: request.hwnd, elementId: request.elementId, exec,
      blocked: detail => detail.invokable ? null : 'Element ' + truncated(detail.id, 60) + ' ("' + truncated(detail.label, 40) + '") exposes no Invoke pattern; zero input was performed',
      card: detail => {
        const label = truncated(detail.label, 40) || '(unlabeled)';
        const window = truncated(detail.windowLabel, 60) || 'unknown window';
        return {
          reason: 'click ' + detail.id + ' (' + typeName(detail.type) + ' "' + detail.label + '") in "' + detail.windowLabel + '" hwnd=' + request.hwnd + ' bbox=' + boxText(detail.bbox),
          en: 'Click "' + label + '" (' + typeName(detail.type) + ') in window "' + window + '" via UIA Invoke. No mouse movement. Nothing runs unless you approve.',
          zh: '点击窗口「' + window + '」中的「' + label + '」（' + typeName(detail.type) + '），通过 UIA Invoke 执行，不移动鼠标。批准后才会执行。',
        };
      },
      run: async detail => ({ ...base, ok: true, element: detail, click: await worker.client.click(request) }),
    });
  };

  const type = async (args: unknown, exec: Exec | undefined): Promise<Result> => {
    let request: ReturnType<typeof normalizeType>;
    try { request = normalizeType(args); } catch (error) { return failure(error); }
    const text = request.text;
    return gated({
      tool: 'replacer_type', hwnd: request.hwnd, elementId: request.elementId, exec,
      blocked: detail => detail.offscreen ? 'Element ' + truncated(detail.id, 60) + ' is offscreen; zero input was performed'
        : detail.enabled ? null : 'Element ' + truncated(detail.id, 60) + ' is disabled; zero input was performed',
      card: detail => {
        const label = truncated(detail.label, 40) || '(unlabeled)';
        const window = truncated(detail.windowLabel, 60) || 'unknown window';
        return {
          reason: 'type into ' + detail.id + ' (' + typeName(detail.type) + ' "' + detail.label + '") in "' + detail.windowLabel + '" hwnd=' + request.hwnd + ' chars=' + [...text].length + ' text=' + preview(text),
          en: 'Write ' + [...text].length + ' characters into "' + label + '" (' + typeName(detail.type) + ') in window "' + window + '" via UIA ValuePattern. No keystrokes are synthesized. Nothing runs unless you approve.',
          zh: '向窗口「' + window + '」中的「' + label + '」（' + typeName(detail.type) + '）写入 ' + [...text].length + ' 个字符，通过 UIA ValuePattern 赋值，不合成按键。批准后才会执行。',
        };
      },
      run: async detail => ({ ...base, ok: true, element: detail, write: await worker.client.typeText(request) }),
    });
  };

  const scroll = async (args: unknown, exec: Exec | undefined): Promise<Result> => {
    let request: ReturnType<typeof normalizeScroll>;
    try { request = normalizeScroll(args); } catch (error) { return failure(error); }
    return gated({
      tool: 'replacer_scroll', hwnd: request.hwnd, elementId: request.elementId, exec,
      blocked: detail => detail.offscreen ? 'Element ' + truncated(detail.id, 60) + ' is offscreen; zero input was performed' : null,
      card: detail => {
        const label = truncated(detail.label, 40) || '(unlabeled)';
        const window = truncated(detail.windowLabel, 60) || 'unknown window';
        const where = 'horizontal=' + request.horizontal + ' vertical=' + request.vertical + ' steps=' + request.steps;
        return {
          reason: 'scroll ' + detail.id + ' (' + typeName(detail.type) + ' "' + detail.label + '") in "' + detail.windowLabel + '" hwnd=' + request.hwnd + ' ' + where,
          en: 'Scroll "' + label + '" in window "' + window + '" via UIA ScrollPattern (' + where + '). No mouse wheel is synthesized. Nothing runs unless you approve.',
          zh: '滚动窗口「' + window + '」中的「' + label + '」，通过 UIA ScrollPattern（' + where + '），不合成滚轮。批准后才会执行。',
        };
      },
      run: async detail => ({ ...base, ok: true, element: detail, write: await worker.client.scroll(request) }),
    });
  };

  // L2: no UIA pattern is required. These primitives post a message to the
  // HWND under the element and never touch the physical pointer or wheel.
  const l2Blocked = (detail: ElementDetail): string | null => detail.offscreen
    ? 'Element ' + truncated(detail.id, 60) + ' is offscreen; zero messages were posted'
    : detail.enabled ? null : 'Element ' + truncated(detail.id, 60) + ' is disabled; zero messages were posted';

  const rightClick = async (args: unknown, exec: Exec | undefined): Promise<Result> => {
    let request: ReturnType<typeof normalizeRightClick>;
    try { request = normalizeRightClick(args); } catch (error) { return failure(error); }
    return gated({
      tool: 'replacer_right_click_by_id', hwnd: request.hwnd, elementId: request.elementId, exec,
      blocked: l2Blocked,
      card: detail => {
        const label = truncated(detail.label, 40) || '(unlabeled)';
        const window = truncated(detail.windowLabel, 60) || 'unknown window';
        return {
          reason: 'right-click ' + detail.id + ' (' + typeName(detail.type) + ' "' + detail.label + '") in "' + detail.windowLabel + '" hwnd=' + request.hwnd + ' via PostMessageW method=postmessage_right_click bbox=' + boxText(detail.bbox),
          en: 'Right-click "' + label + '" (' + typeName(detail.type) + ') in window "' + window + '" by posting WM_CONTEXTMENU to the deepest child under its center, with the child HWND and the element center in screen coordinates. PostMessage only: the physical mouse does not move, no SendInput/SetCursorPos is used, and the Worker returns once the message is posted. Nothing runs unless you approve.',
          zh: '在窗口「' + window + '」中的「' + label + '」（' + typeName(detail.type) + '）上通过 PostMessage 发送 WM_CONTEXTMENU（wParam=元素中心下最深的子窗口，lParam=屏幕坐标），只发给该子窗口；不移动物理鼠标，不使用 SendInput/SetCursorPos；消息投递后 Worker 立即返回，不等待菜单出现。批准后才会执行。',
        };
      },
      run: async detail => ({ ...base, ok: true, element: detail, rightClick: await worker.client.rightClick(request) }),
    });
  };

  const wheel = async (args: unknown, exec: Exec | undefined): Promise<Result> => {
    let request: ReturnType<typeof normalizeWheel>;
    try { request = normalizeWheel(args); } catch (error) { return failure(error); }
    return gated({
      tool: 'replacer_wheel_by_id', hwnd: request.hwnd, elementId: request.elementId, exec,
      blocked: l2Blocked,
      card: detail => {
        const label = truncated(detail.label, 40) || '(unlabeled)';
        const window = truncated(detail.windowLabel, 60) || 'unknown window';
        const where = 'vertical=' + request.vertical + ' steps=' + request.steps + ' delta=' + (request.vertical === 'up' ? 360 : -360);
        return {
          reason: 'wheel ' + detail.id + ' (' + typeName(detail.type) + ' "' + detail.label + '") in "' + detail.windowLabel + '" hwnd=' + request.hwnd + ' via PostMessageW method=postmessage_wheel ' + where,
          en: 'Send WM_MOUSEWHEEL to the focused window of "' + label + '" in window "' + window + '" (' + where + '). PostMessage only: the physical wheel does not move and no SendInput/SetCursorPos is used. Nothing runs unless you approve.',
          zh: '向窗口「' + window + '」中的「' + label + '」的焦点窗口发送 WM_MOUSEWHEEL（' + where + '），通过 PostMessage 定向发送；不移动物理滚轮，不使用 SendInput/SetCursorPos。批准后才会执行。',
        };
      },
      run: async detail => ({ ...base, ok: true, element: detail, wheel: await worker.client.wheel(request) }),
    });
  };

  // Key injection is window-directed like the other L2 primitives: the combo is
  // posted to the focus window of the given hwnd, so there is no UIA element to
  // look up and gated() runs without its read-only element lookup.
  const key = async (args: unknown, exec: Exec | undefined): Promise<Result> => {
    let request: ReturnType<typeof normalizeKey>;
    try { request = normalizeKey(args); } catch (error) { return failure(error); }
    return gated({
      tool: 'replacer_key', hwnd: request.hwnd, exec,
      blocked: () => null,
      card: () => ({
        reason: 'post key combo=' + request.combo + ' to the focus window of hwnd=' + request.hwnd + ' via PostMessageW method=postmessage_key',
        en: 'Post the key "' + request.combo + '" to the focused window of hwnd=' + request.hwnd + ' through PostMessage. The message is addressed to that window directly and never passes through the system input queue, so the physical keyboard is untouched. Nothing is sent unless you approve; rejecting, timing out or cancelling sends zero keys.',
        zh: '通过 PostMessage 向 hwnd=' + request.hwnd + ' 的焦点窗口定向发送按键「' + request.combo + '」：只投递给该窗口，不经过系统输入队列，不碰物理键盘。批准后才会发送；拒绝、超时或取消都是零输入。',
      }),
      run: async () => ({ ...base, ok: true, key: await worker.client.key(request) }),
    });
  };

  const windows = async (): Promise<Result> => {
    if (!panicGate.latchedNow) await ensureWorker();
    try { return { ...base, ok: true, windows: await worker.client.topWindows(), bypassed: gate.bypassed }; } catch (error) { return failure(error); }
  };

  // Status always answers: a status report that cannot reach the Worker is itself status.
  const status = async (exec?: Exec): Promise<Result> => {
    if (!panicGate.latchedNow) await ensureWorker();
    const approvals = gate.recent();
    const policyView = policy.inspect(sessionOf(exec?.agent));
    try {
      const workerStatus = await worker.client.status();
      // Emergency stop surfaced top-level, dual source (拍板②): the TS latch
      // (button or hotkey path) OR the worker's own latch. Both fields are
      // shown honestly: workerConnected:true with panic:true means a freshly
      // relaunched idle worker — worker 进程存活 ≠ 工具可用 (every gated tool
      // still answers PANIC_ABORTED).
      const latched = panicSnapshot();
      const panic = latched.latched || workerStatus.panic === true;
      const panicNotice = panic
        ? '急停已触发：所有注入已停止；已发出的消息无法撤回' + (latched.latched ? '（来源：' + (latched.source === 'hotkey' ? '急停热键' : '急停按钮') + '）' : '') + (worker.client.connected ? '；worker 进程存活但工具全部被闩锁拦截（进程存活 ≠ 工具可用）' : '；worker 未连接，恢复后将在下次工具调用时惰性拉起') + ' / PANIC LATCH TRIPPED: all injection is stopped; already-sent messages cannot be recalled' + (worker.client.connected ? '; the worker process is alive but every gated tool is refused by the latch (worker alive does NOT mean tools usable)' : '')
        : undefined;
      return {
        ...base,
        ok: true,
        workerConnected: worker.client.connected,
        status: workerStatus,
        panic,
        ...(latched.source === undefined ? {} : { panicSource: latched.source }),
        ...(workerStatus.panicHotkey ? { panicHotkey: workerStatus.panicHotkey } : {}),
        ...(panicNotice ? { message: panicNotice } : {}),
        approvals,
        policyState: policyView.summary,
        policyAudit: policyView.audit,
        bypassed: gate.bypassed,
      };
    } catch (error) {
      const reported = failure(error);
      // Worker unreachable: the TS latch is still authoritative truth — a latched
      // panic shows here too (worker offline, lazy restart on the next tool call).
      const latched = panicSnapshot();
      const panic = latched.latched;
      const offlineNotice = (reported.message ?? 'Worker request failed') + ' Tier flags, world versions and the Worker process id are unknown until a Worker is running.';
      const panicNotice = '急停闩锁生效中：所有注入已停止，工具恢复需在输入栏急停按钮上二次确认恢复 / PANIC LATCH TRIPPED: all injection is stopped until the panic button confirms recovery';
      return {
        ...reported, ok: true, workerConnected: false,
        ...(panic ? { panic, ...(latched.source === undefined ? {} : { panicSource: latched.source }) } : {}),
        approvals, policyState: policyView.summary, policyAudit: policyView.audit,
        ...(panic ? { message: panicNotice } : { message: offlineNotice }),
      };
    }
  };

  const observe = async (args: unknown, exec: Exec | undefined): Promise<Result> => {
    if (!panicGate.latchedNow) await ensureWorker();
    try {
      const page = await worker.client.observe(args);
      targets.record(sessionIdOf(exec?.agent), page);
      return { ...base, ok: true, page, bypassed: gate.bypassed };
    } catch (error) { return failure(error); }
  };

  // replacer_read_screen（B-3）：只读屏幕感知——独立审批路径，审批卡明示“读取屏
  // 幕内容（无鼠标键盘注入）”，与写工具的注入卡区分（计划 §3）。每次调用都弹卡
  // （approval 本就一次性，无会话免审批，零特例）；PolicyGate 三态语义不变，
  // FullAccess 预设下自动放行（既有语义）。
  //
  // panic 闩锁不拦 read_screen（只读先例，计划 §4）：急停 = 切断注入，不切断感
  // 知；所以故意不走 gated()（其首行是闩锁检查），也不检查 panicGate.latchedNow
  // ——与上方 gated()/click_xy/click_elevated 写路径的 panicRefusal() 显式对照。
  const readScreen = async (args: unknown, exec: Exec | undefined): Promise<Result> => {
    let request: ReturnType<typeof normalizeReadScreen>;
    try { request = normalizeReadScreen(args); } catch (error) { return failure(error); }
    await ensureWorker();
    const summary = 'read screen ' + (request.region
      ? 'region x=' + request.region.x + ' y=' + request.region.y + ' ' + request.region.width + 'x' + request.region.height
      : '(full screen)') + ' via DXGI capture + local OCR (read-only)';
    const policyDecision = policy.check({ session: sessionOf(exec?.agent), tool: 'replacer_read_screen', summary });
    const decision = policyDecision.allow ? policyGrant() : await gate.ask({
      toolName: 'replacer_read_screen',
      reason: summary,
      displayReason: {
        en: 'Read the screen contents (DXGI capture + local OCR) and return text lines with bounding boxes in full-screen physical pixels. Read-only: no mouse or keyboard injection, the physical pointer and keyboard are untouched, and zero image bytes leave the worker. Nothing is captured until you approve.',
        zh: '读取屏幕内容（DXGI 捕获 + 本地 OCR，无鼠标键盘注入）：返回文字行与全屏物理像素坐标位置框；不移动物理鼠标、不碰物理键盘、零图像字节离开 worker。批准后才会截屏。',
      },
      ...(exec?.agent === undefined ? {} : { agent: exec.agent }),
      ...(exec?.callId === undefined ? {} : { callId: exec.callId }),
      ...(exec?.signal === undefined ? {} : { signal: exec.signal }),
    });
    if (!decision.allowed) {
      const code = decision.code ?? 'APPROVAL_UNAVAILABLE';
      return { ...base, ok: false, code, message: REJECTION_MESSAGES[code] ?? 'Approval was not granted; nothing was captured', approval: approvalSummary(decision), policy: policySummary(policyDecision), bypassed: gate.bypassed };
    }
    try {
      const result = await worker.client.readScreen(request);
      if (policyDecision.allow) policy.recordResult(policyDecision, true, undefined);
      return { ...base, ok: true, readScreen: result, approval: approvalSummary(decision), policy: policySummary(policyDecision), bypassed: gate.bypassed };
    } catch (error) {
      if (policyDecision.allow) policy.recordResult(policyDecision, false, error instanceof IpcError ? error.code : undefined);
      return { ...failure(error), approval: approvalSummary(decision), policy: policySummary(policyDecision) };
    }
  };

  // replacer_locate（B-4）：只读视觉↔UIA 融合定位——与 read_screen 同一只读族
  // （独立审批卡、零注入、panic 闩锁不拦；理由见 read_screen 上方注释）。审批卡
  // 明示“读取屏幕内容并定位控件（无鼠标键盘注入）”，并提醒返回文字可能含屏幕敏
  // 感内容、点击匹配项仍需另一次审批（匹配只是候选，不是点击）。
  const locate = async (args: unknown, exec: Exec | undefined): Promise<Result> => {
    let request: ReturnType<typeof normalizeLocate>;
    try { request = normalizeLocate(args); } catch (error) { return failure(error); }
    await ensureWorker();
    const summary = 'locate ' + (request.query === undefined ? '(all on-screen text)' : JSON.stringify(preview(request.query)))
      + ' in hwnd ' + request.hwnd + ' via DXGI capture + local OCR fused with UIA (read-only)';
    const policyDecision = policy.check({ session: sessionOf(exec?.agent), tool: 'replacer_locate', summary });
    const decision = policyDecision.allow ? policyGrant() : await gate.ask({
      toolName: 'replacer_locate',
      reason: summary,
      displayReason: {
        en: 'Read the screen contents (DXGI capture + local OCR) and locate the described controls by fusing the OCR text with the UIA element tree. Read-only: no mouse or keyboard injection, the physical pointer and keyboard are untouched, and zero image bytes leave the worker. Returned text may contain sensitive on-screen content; a candidate match is not a click - clicking it still needs a separate approval. Nothing is captured until you approve.',
        zh: '读取屏幕内容并定位控件（DXGI 捕获 + 本地 OCR，与 UIA 元素树融合，无鼠标键盘注入）：不移动物理鼠标、不碰物理键盘、零图像字节离开 worker；返回的文字可能包含屏幕敏感内容；候选匹配不是点击，点击仍需另一次审批。批准后才会截屏。',
      },
      ...(exec?.agent === undefined ? {} : { agent: exec.agent }),
      ...(exec?.callId === undefined ? {} : { callId: exec.callId }),
      ...(exec?.signal === undefined ? {} : { signal: exec.signal }),
    });
    if (!decision.allowed) {
      const code = decision.code ?? 'APPROVAL_UNAVAILABLE';
      return { ...base, ok: false, code, message: REJECTION_MESSAGES[code] ?? 'Approval was not granted; nothing was captured', approval: approvalSummary(decision), policy: policySummary(policyDecision), bypassed: gate.bypassed };
    }
    try {
      const result = await worker.client.locate(request);
      if (policyDecision.allow) policy.recordResult(policyDecision, true, undefined);
      return { ...base, ok: true, locate: result, approval: approvalSummary(decision), policy: policySummary(policyDecision), bypassed: gate.bypassed };
    } catch (error) {
      if (policyDecision.allow) policy.recordResult(policyDecision, false, error instanceof IpcError ? error.code : undefined);
      return { ...failure(error), approval: approvalSummary(decision), policy: policySummary(policyDecision) };
    }
  };

  // Elevated tools never touch the normal Worker: the broker is a separate, user-launched
  // process and the only thing asked of it is a read-only observe or one UIA Invoke.
  const observeElevated = async (args: unknown): Promise<Result> => {
    let request: ReturnType<typeof normalizeElevatedObserve>;
    try { request = normalizeElevatedObserve(args); } catch (error) { return brokerFailure(error); }
    try {
      const reply = await callBroker({ op: 'observe', hwnd: request.hwnd });
      const elements = Array.isArray(reply.elements) ? (reply.elements as ElevatedElement[]) : [];
      const focus = Array.isArray(reply.focus) ? (reply.focus as number[]) : null;
      const page: ElevatedPage = {
        hwnd: typeof reply.hwnd === 'string' ? reply.hwnd : request.hwnd,
        observedAt: typeof reply.observedAt === 'number' ? reply.observedAt : 0,
        complete: reply.complete === true,
        totalElements: elements.length,
        elements,
        focus,
        pullMs: typeof reply.pullMs === 'number' ? reply.pullMs : 0,
        modelMs: typeof reply.modelMs === 'number' ? reply.modelMs : 0,
        brokerPid: typeof reply.pid === 'number' ? reply.pid : 0,
      };
      return { ...base, ok: true, elevatedPage: page, bypassed: gate.bypassed };
    } catch (error) { return brokerFailure(error); }
  };

  const clickElevated = async (args: unknown, exec: Exec | undefined): Promise<Result> => {
    let request: ReturnType<typeof normalizeElevatedClick>;
    try { request = normalizeElevatedClick(args); } catch (error) { return brokerFailure(error); }
    // Panic latch first: this write path bypasses gated() but must refuse too.
    if (panicGate.latchedNow) return panicRefusal();
    // Card facts come from the broker's own read-only capture, never from model text.
    let observed: Awaited<ReturnType<typeof callBroker>>;
    try { observed = await callBroker({ op: 'observe', hwnd: request.hwnd }); } catch (error) { return brokerFailure(error); }
    const elements = Array.isArray(observed.elements) ? (observed.elements as ElevatedElement[]) : [];
    const target = elements.find(element => Array.isArray(element.runtimeId)
      && element.runtimeId.length === request.runtimeId.length
      && element.runtimeId.every((value, index) => value === request.runtimeId[index]));
    if (target === undefined) {
      return { ...base, ok: false, code: 'STALE_STATE', message: 'RuntimeId ' + JSON.stringify(request.runtimeId) + ' is no longer present in hwnd ' + request.hwnd + '; observe the window again. Zero input was performed.', bypassed: gate.bypassed };
    }
    if (target.invokable !== true) {
      return { ...base, ok: false, code: 'ELEMENT_NOT_INVOKABLE', message: 'Element "' + truncated(target.label, 40) + '" (' + typeName(target.type) + ') exposes no Invoke pattern; zero input was performed', bypassed: gate.bypassed };
    }
    const label = truncated(target.label, 40) || '(unlabeled)';
    const type = typeName(target.type);
    const policyDecision = policy.check({ session: sessionOf(exec?.agent), tool: 'replacer_click_elevated', summary: 'elevated click ' + JSON.stringify(target.runtimeId) + ' hwnd=' + request.hwnd });
    const decision = policyDecision.allow ? policyGrant() : await gate.ask({
      toolName: 'replacer_click_elevated',
      reason: 'elevated click ' + JSON.stringify(target.runtimeId) + ' (' + type + ' "' + target.label + '") in hwnd=' + request.hwnd + ' bbox=' + boxText(target.bbox),
      displayReason: {
        en: 'Click "' + label + '" (' + type + ') in the higher-integrity window hwnd=' + request.hwnd + ' through the user-launched elevated broker (UIA Invoke). No mouse movement. Nothing runs unless you approve.',
        zh: '通过你亲自以 UAC 启动的提权 Broker，点击高权限窗口 hwnd=' + request.hwnd + ' 中的「' + label + '」（' + type + '），使用 UIA Invoke，不移动鼠标。批准后才会执行。',
      },
      ...(exec?.agent === undefined ? {} : { agent: exec.agent }),
      ...(exec?.callId === undefined ? {} : { callId: exec.callId }),
      ...(exec?.signal === undefined ? {} : { signal: exec.signal }),
    });
    if (!decision.allowed) {
      const code = decision.code ?? 'APPROVAL_UNAVAILABLE';
      return { ...base, ok: false, code, message: REJECTION_MESSAGES[code] ?? 'Approval was not granted; zero input was performed', approval: approvalSummary(decision), policy: policySummary(policyDecision), bypassed: gate.bypassed };
    }
    try {
      const reply = await callBroker({ op: 'invoke', hwnd: request.hwnd, runtimeId: request.runtimeId });
      if (policyDecision.allow) policy.recordResult(policyDecision, reply.accepted === true, reply.accepted === true ? undefined : 'NOT_ACCEPTED');
      return {
        ...base, ok: true,
        clickElevated: {
          hwnd: typeof reply.hwnd === 'string' ? reply.hwnd : request.hwnd,
          runtimeId: request.runtimeId,
          method: typeof reply.method === 'string' ? reply.method : 'elevated_uia_invoke',
          accepted: reply.accepted === true,
          label: target.label,
          type: target.type,
        },
        approval: approvalSummary(decision),
        policy: policySummary(policyDecision),
        bypassed: gate.bypassed,
      };
    } catch (error) {
      if (policyDecision.allow) policy.recordResult(policyDecision, false, error instanceof BrokerError ? error.code : undefined);
      return { ...brokerFailure(error), approval: approvalSummary(decision), policy: policySummary(policyDecision) };
    }
  };

  const clickXy = async (args: unknown, exec: Exec | undefined): Promise<Result> => {
    let request: ReturnType<typeof normalizeClickXy>;
    try { request = normalizeClickXy(args); } catch (error) { return failure(error); }
    // Panic latch first: this write path bypasses gated() but must refuse too.
    if (panicGate.latchedNow) return panicRefusal();
    await ensureWorker();
    const policyDecision = policy.check({ session: sessionOf(exec?.agent), tool: 'replacer_click_xy', summary: 'coordinate click ' + request.x + ',' + request.y + ' hwnd=' + request.hwnd });
    const decision = policyDecision.allow ? policyGrant() : await gate.ask({
      toolName: 'replacer_click_xy',
      reason: 'coordinate click ' + request.x + ',' + request.y + ' in hwnd=' + request.hwnd,
      displayReason: {
        en: 'Coordinate fallback: bring hwnd=' + request.hwnd + ' to the foreground, move the pointer to (' + request.x + ', ' + request.y + ') and left-click once. Approve to run it; rejecting, timing out or cancelling performs zero input.',
        zh: '坐标兜底：把 hwnd=' + request.hwnd + ' 拉到前台，把鼠标移到 (' + request.x + ', ' + request.y + ') 并左键单击一次。批准后执行；拒绝、超时或取消都是零输入。',
      },
      ...(exec?.agent === undefined ? {} : { agent: exec.agent }),
      ...(exec?.callId === undefined ? {} : { callId: exec.callId }),
      ...(exec?.signal === undefined ? {} : { signal: exec.signal }),
    });
    if (!decision.allowed) {
      const code = decision.code ?? 'APPROVAL_UNAVAILABLE';
      return { ...base, ok: false, code, message: REJECTION_MESSAGES[code] ?? 'Approval was not granted; zero input was performed', approval: approvalSummary(decision), policy: policySummary(policyDecision), bypassed: gate.bypassed };
    }
    try {
      const result = await worker.client.clickXy(request);
      if (policyDecision.allow) policy.recordResult(policyDecision, result.accepted === true, result.accepted === true ? undefined : 'NOT_ACCEPTED');
      return {
        ...base, ok: true,
        clickXY: {
          hwnd: result.hwnd, x: result.x, y: result.y, method: result.method, accepted: result.accepted,
          ...(result.reactivated === undefined ? {} : { reactivated: result.reactivated }),
        },
        approval: approvalSummary(decision), policy: policySummary(policyDecision), bypassed: gate.bypassed,
      };
    } catch (error) {
      if (policyDecision.allow) policy.recordResult(policyDecision, false, error instanceof IpcError ? error.code : undefined);
      return { ...failure(error), approval: approvalSummary(decision), policy: policySummary(policyDecision) };
    }
  };

  try {
    for (const tool of TOOL_NAMES) {
      const description = tool === 'replacer_observe' ? 'Read-only UIA snapshot of an explicit HWND. Returns one bounded page. Continue with the returned snapshotId and nextOffset. Does not focus, click, type, or inject input. Provider-exposed elements do not prove that all application controls are exposed.'
        : tool === 'replacer_windows' ? 'Read-only list of top-level windows with hwnd, label, control type and bounds. Does not focus, capture pixels or inject input; use replacer_observe on one returned hwnd for its elements.'
        : tool === 'replacer_status' ? 'Report Worker tier flags, per-window world versions, process id, the emergency-stop hotkey state (panic latch plus the armed combination such as ctrl+alt+shift+p), approval audit and whether the test bypass is active. Connection does not prove UIA observation readiness or application tree completeness.'
        : tool === 'replacer_click_by_id' ? 'Click one observed element by id through UIA InvokePattern. Every call is approval-gated: rejection, timeout or cancellation performs zero input. Never moves the physical mouse. Elements without Invoke return ELEMENT_NOT_INVOKABLE. Fails with CONTEXT_CHANGED when the target window is no longer foreground or focus moved, and STALE_STATE when the node no longer exists.'
        : tool === 'replacer_type' ? 'Write text into one observed element through UIA ValuePattern (SetValue). Approval-gated; rejection, timeout or cancellation performs zero input. Never synthesizes keystrokes, so elements without a writable Value pattern return ELEMENT_NOT_INVOKABLE. Context fingerprinting applies exactly as for clicks.'
        : tool === 'replacer_scroll' ? 'Scroll one observed container through UIA ScrollPattern by whole viewports (1..10 steps). Approval-gated; rejection, timeout or cancellation performs zero input. Never synthesizes a mouse wheel; non-scrollable elements return ELEMENT_NOT_INVOKABLE.'
        : tool === 'replacer_right_click_by_id' ? 'Right-click one observed element by posting WM_CONTEXTMENU to the deepest child under its center, with the child HWND and screen coordinates (L2 fallback for controls without UIA patterns). There is no down/up fallback: applications that ignore WM_CONTEXTMENU must be handled by another route. Approval-gated; rejection, timeout or cancellation posts zero messages. PostMessageW only: never moves the physical mouse, never uses SendInput/SetCursorPos. Returns as soon as the message is posted. A UIPI refusal returns UIPI_BLOCKED and directs higher-integrity targets to the elevated broker.'
        : tool === 'replacer_wheel_by_id' ? 'Send 1..10 WM_MOUSEWHEEL messages (WHEEL_DELTA * 3 each) to the focused window of one observed element through PostMessageW, for custom containers without ScrollPattern. Approval-gated; rejection, timeout or cancellation posts zero messages. Never moves the physical wheel and never uses SendInput/SetCursorPos. A UIPI refusal returns UIPI_BLOCKED.'
        : tool === 'replacer_key' ? 'Post one key to the focused window of an explicit HWND through PostMessageW: the message is addressed to that window directly and never passes through the system input queue, so the physical keyboard is untouched. The key is a key name (enter esc tab backspace delete home end pageup pagedown up down left right space, a..z, 0..9, f1..f12) or a single character (Chinese included). Modifier chords are not supported: PostMessageW cannot deliver modifier state, so "ctrl+a" arrives as the literal letter a; for select/copy scenarios use UIA patterns (replacer_type) or the elevated broker. Approval-gated; rejection, timeout or cancellation posts zero messages. A UIPI refusal returns UIPI_BLOCKED and directs higher-integrity targets to the elevated broker.'
        : tool === 'replacer_observe_elevated' ? 'Read-only UIA snapshot through the user-launched elevated broker, for windows of higher-integrity processes that the normal Worker cannot see (for example Task Manager). Elements carry runtimeId; pass one to replacer_click_elevated. Does not click, type, focus or inject input. Returns BROKER_NOT_RUNNING until the user starts replacer-worker.exe elevated-broker through UAC; the broker only serves ping/observe/invoke/stop and rejects other user accounts.'
        : tool === 'replacer_click_elevated' ? 'Click one element of a higher-integrity window through the user-launched elevated broker (UIA InvokePattern). Every call is approval-gated: rejection, timeout or cancellation performs zero input. The target must come from replacer_observe_elevated; a stale runtimeId fails with STALE_STATE. The broker refuses while a secure desktop is up and never moves the physical mouse.'
        : tool === 'replacer_read_screen' ? 'Read-only screen perception: capture the primary screen (DXGI Desktop Duplication) and run local Windows OCR, returning text lines with bounding boxes in full-screen physical pixels (same coordinate system as replacer_click_xy; an optional region crops the OCR input only, bboxes stay full-screen). Zero injection: no mouse, keyboard or window messages; zero image bytes leave the worker. Responses are byte-budgeted against the IPC frame limit: under pressure word-level hits are dropped first, then trailing lines, with truncated:true plus totalLines. Read-only precedent: the emergency-stop (panic) latch does NOT block this tool - it cuts injection, not perception. Approval-gated with a dedicated read-only card; rejection, timeout or cancellation captures nothing. VISION_UNAVAILABLE is retryable; VISION_TIMEOUT keeps the vision thread serving (a timed-out OCR attempt may linger until process exit).'
        : tool === 'replacer_locate' ? 'Read-only screen locate: capture the primary screen (DXGI) and fuse local OCR with the UIA element tree of one HWND, returning up to maxResults candidate elements (stable elementId usable with replacer_click_by_id, label, control type, bbox in full-screen physical pixels, enabled/invokable/offscreen, fusion scores) plus textOnly OCR lines that no UIA element could address (UIA cannot target those, so no elementId exists for them). A returned candidate is NOT a click: clicking it is a separate approval-gated call. channel "fusion" means capture + OCR + grounding all ran; channel "uia_only" with degraded:true means the worker fell back to the UIA tree alone and degradeReason says why, while capabilities reports which stages are available. Zero injection: no mouse, keyboard or window messages; zero image bytes leave the worker. Returned text may contain sensitive on-screen content. Read-only precedent: the emergency-stop (panic) latch does NOT block this tool - it cuts injection, not perception. Approval-gated with a dedicated read-only card; rejection, timeout or cancellation captures nothing. VISION_UNAVAILABLE is retryable (the reply may degrade to uia_only); VISION_TIMEOUT keeps the vision thread serving (a timed-out OCR attempt may linger until process exit).'
        : tool === 'replacer_click_xy' ? 'Coordinate fallback: bring hwnd to the foreground and left-click one physical screen coordinate through SetCursorPos + SendInput. Approval-gated; rejection, timeout or cancellation performs zero input. The pointer moves. Use only when no UIA element can be addressed; prefer replacer_click_by_id or the <C:>/<I:> fast signals.'
        : 'Reserved tool name with no implementation in this build; it always returns UNSUPPORTED_OPERATION and performs zero input.';
      const parameters = tool === 'replacer_observe' ? observeParameters
        : tool === 'replacer_click_by_id' ? clickParameters
        : tool === 'replacer_type' ? typeParameters
        : tool === 'replacer_scroll' ? scrollParameters
        : tool === 'replacer_right_click_by_id' ? rightClickParameters
        : tool === 'replacer_wheel_by_id' ? wheelParameters
        : tool === 'replacer_observe_elevated' ? observeElevatedParameters
        : tool === 'replacer_click_elevated' ? clickElevatedParameters
        : tool === 'replacer_read_screen' ? readScreenParameters
        : tool === 'replacer_locate' ? locateParameters
        : tool === 'replacer_click_xy' ? clickXyParameters
        : tool === 'replacer_key' ? keyParameters
        : noParameters;
      disposers.push(ctx.tools.register({
        name: tool,
        description,
        parameters,
        output: { schema: outputSchema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        async execute(args, exec): Promise<Result> {
          if (disposed) return { ...base, ok: false, code: 'WORKER_UNAVAILABLE', message: 'Plugin disposed' };
          switch (tool) {
            case 'replacer_status': return status(exec);
            case 'replacer_windows': return windows();
            case 'replacer_read_screen': return readScreen(args, exec);
            case 'replacer_locate': return locate(args, exec);
            case 'replacer_observe': return observe(args, exec);
            case 'replacer_click_by_id': return click(args, exec);
            case 'replacer_type': return type(args, exec);
            case 'replacer_scroll': return scroll(args, exec);
            case 'replacer_right_click_by_id': return rightClick(args, exec);
            case 'replacer_wheel_by_id': return wheel(args, exec);
            case 'replacer_key': return key(args, exec);
            case 'replacer_observe_elevated': return observeElevated(args);
            case 'replacer_click_elevated': return clickElevated(args, exec);
            case 'replacer_click_xy': return clickXy(args, exec);
            default: return { ...base, ok: false, code: 'UNSUPPORTED_OPERATION', message: 'This tool name is registered as a placeholder for a future operation and has no implementation in this build; zero input was performed.', bypassed: gate.bypassed };
          }
        },
      }));
    }
    ctx.on('dispose', dispose);
    worker.start();
  } catch (error) { void dispose(); throw error; }
}
