import { type ClickResult, type ElementDetail, type ElevatedPage, type KeyResult, type LocateResult, type ObservePage, type ReadScreenResult, type RightClickResult, type ScrollResult, type TypeResult, type WheelResult, type WindowInfo, type WorkerStatus } from './ipc/protocol.js';
import { type AuditEntry } from './approval/gate.js';
import { type PolicyLogEntry, type PolicyStateSummary } from './policy/gate.js';
export declare const name = "computer-replacer";
export declare const inject: string[];
export declare const TOOL_NAMES: readonly ["replacer_observe", "replacer_windows", "replacer_status", "replacer_read_screen", "replacer_locate", "replacer_click_by_id", "replacer_type", "replacer_key", "replacer_scroll", "replacer_right_click_by_id", "replacer_wheel_by_id", "replacer_observe_elevated", "replacer_click_elevated", "replacer_click_xy"];
export interface ApprovalSummary {
    outcome: string;
    code?: string;
    waitedMs: number;
}
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
    clickElevated?: {
        hwnd: string;
        runtimeId: number[];
        method: string;
        accepted: boolean;
        label: string;
        type: number;
    };
    /** Result of one approval-gated coordinate click (SetCursorPos + SendInput). */
    clickXY?: {
        hwnd: string;
        x: number;
        y: number;
        method: string;
        accepted: boolean;
        reactivated?: boolean;
    };
    approval?: ApprovalSummary;
    approvals?: AuditEntry[];
    /** PolicyGate decision for this call: allow means the approval card was skipped because the session is under full access. */
    policy?: {
        allow: boolean;
        bypassed: boolean;
        expected: string;
        observed: string;
        generation: string;
        reason: string;
        anomaly: boolean;
    };
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
    output: {
        schema: Record<string, unknown>;
        render: (args: unknown, value: Result) => {
            type: 'text';
            text: string;
        }[];
    };
    execute: (args: unknown, exec?: Exec) => Promise<Result>;
}
export interface Context {
    tools: {
        view: () => {
            knownNames: Set<string>;
        };
        register: (definition: Definition) => () => unknown;
    };
    on: (event: string, callback: (...args: never[]) => unknown, options?: {
        global?: boolean;
        prepend?: boolean;
    }) => unknown;
    get?: <T>(name: string) => T | undefined;
    /** Host dependency injection (cordis): used only to append the fast-signal prompt. */
    inject?: (dependencies: string[], callback: (scope: {
        systemPrompt?: {
            context?: (value: Record<string, unknown>) => unknown;
            getContextOrder?: (name: string) => number;
        };
    }) => void) => unknown;
    /** Host web server: prefix routes for the client UI (panic button). */
    webServer?: {
        register: (route: {
            kind: 'prefix';
            path: string;
            handler: (req: HttpRequest, res: HttpResponse) => void;
        }) => () => unknown;
    };
    /** Host connection service: Origin/trust fence for web routes. */
    connection?: {
        requestRejection?: (req: HttpRequest) => unknown;
    };
}
/** Minimal shape of an incoming web request (node http IncomingMessage subset). */
export interface HttpRequest {
    url?: string;
    method?: string;
    headers: Record<string, unknown>;
}
/** Minimal shape of the response a route handler may write. */
export interface HttpResponse {
    writeHead(status: number, headers: Record<string, string>): unknown;
    end(body?: string): unknown;
}
type Schema = Record<string, unknown>;
/** Every Host-facing schema, exported so the enforced-subset check can inspect the built artifact. */
export declare const SCHEMAS: {
    readonly observeParameters: Schema;
    readonly clickParameters: Schema;
    readonly typeParameters: Schema;
    readonly scrollParameters: Schema;
    readonly rightClickParameters: Schema;
    readonly wheelParameters: Schema;
    readonly keyParameters: Schema;
    readonly keySchema: Schema;
    readonly readScreenParameters: Schema;
    readonly readScreenSchema: Schema;
    readonly locateParameters: Schema;
    readonly locateSchema: Schema;
    readonly observeElevatedParameters: Schema;
    readonly clickElevatedParameters: Schema;
    readonly clickXyParameters: Schema;
    readonly noParameters: Schema;
    readonly outputSchema: Schema;
};
export declare function apply(ctx: Context): void;
export {};
