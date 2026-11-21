export declare const MAX_FRAME_BYTES = 65536;
export declare const DEFAULT_PAGE_LIMIT = 200;
export declare const MAX_ELEMENTS = 20000;
/** Soft byte ceiling for one locate reply (plan §2.4/§4: trailing textOnly first, then matches). */
export declare const MAX_LOCATE_SOFT_BYTES = 58982;
export declare const ERROR_CODES: readonly ["STALE_STATE", "ELEMENT_NOT_INVOKABLE", "CONTEXT_CHANGED", "WORKER_UNAVAILABLE", "TIMEOUT", "REJECTED", "UNSUPPORTED_OPERATION", "L3_DISABLED", "UIPI_BLOCKED", "INJECTION_UNCERTAIN", "INVALID_ARGUMENT", "OBSERVATION_LIMIT", "UIA_ERROR", "AMBIGUOUS_IDENTITY", "PANIC_ABORTED", "VISION_UNAVAILABLE", "VISION_TIMEOUT"];
export type ErrorCode = (typeof ERROR_CODES)[number];
export declare class IpcError extends Error {
    readonly code: ErrorCode;
    constructor(code: ErrorCode, message: string);
}
export interface ObserveRequest {
    hwnd: string;
    snapshotId?: string;
    offset?: number;
    limit?: number;
}
export interface NormalizedObserveRequest {
    hwnd: string;
    snapshotId?: string;
    offset: number;
    limit: number;
}
export interface WorldElement {
    id: string;
    parentId: string | null;
    type: number;
    label: string;
    bbox: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    enabled: boolean;
    offscreen: boolean;
    invokable: boolean;
    confidence: number;
    observedAt: number;
}
export interface ObservePage {
    snapshotId: string;
    version: number;
    hwnd: string;
    observedAt: number;
    complete: true;
    totalElements: number;
    returnedElements: number;
    nextOffset: number | null;
    pullMs: number;
    modelMs: number;
    observeMs: number;
    elements: WorldElement[];
}
export interface ClickRequest {
    hwnd: string;
    elementId: string;
}
export interface ElementDetail {
    id: string;
    parentId: string | null;
    type: number;
    label: string;
    windowLabel: string;
    bbox: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    enabled: boolean;
    offscreen: boolean;
    invokable: boolean;
    confidence: number;
}
export interface ClickResult {
    hwnd: string;
    elementId: string;
    method: 'l1_invoke';
    accepted: true;
    /** False when the window no longer exists after the Invoke settled. */
    windowAlive?: boolean;
}
export interface TypeRequest {
    hwnd: string;
    elementId: string;
    text: string;
}
export interface TypeResult {
    hwnd: string;
    elementId: string;
    method: 'l1_value';
    accepted: true;
    characters: number;
}
export type ScrollAxis = 'no' | 'left' | 'right' | 'up' | 'down';
export interface ScrollRequest {
    hwnd: string;
    elementId: string;
    horizontal: 'no' | 'left' | 'right';
    vertical: 'no' | 'up' | 'down';
    steps: number;
}
export interface ScrollResult {
    hwnd: string;
    elementId: string;
    method: 'l1_scroll';
    accepted: true;
    horizontal: string;
    vertical: string;
    steps: number;
}
export interface RightClickRequest {
    hwnd: string;
    elementId: string;
}
export interface RightClickResult {
    hwnd: string;
    elementId: string;
    method: 'postmessage_right_click';
    accepted: true;
    targetHwnd: string;
    /** Client coordinates inside targetHwnd. */
    x: number;
    y: number;
    screenX: number;
    screenY: number;
    reactivated?: boolean;
    windowAlive?: boolean;
}
export interface WheelRequest {
    hwnd: string;
    elementId: string;
    vertical: 'up' | 'down';
    steps: number;
}
export interface WheelResult {
    hwnd: string;
    elementId: string;
    method: 'postmessage_wheel';
    accepted: true;
    targetHwnd: string;
    screenX: number;
    screenY: number;
    vertical: 'up' | 'down';
    steps: number;
    delta: number;
    reactivated?: boolean;
    windowAlive?: boolean;
}
export interface KeyArgs {
    hwnd: string;
    /** One single key name or one single character; normalizeKey rejects chords outright. */
    combo: string;
}
/** Worker reply for one posted key (op 'key'); the key goes to the focus window. */
export interface KeyResult {
    hwnd: string;
    combo: string;
    method: 'postmessage_key';
    accepted: boolean;
    keysPosted: number;
    focusHwnd: string;
    reactivated?: boolean;
    windowAlive: boolean;
}
export interface WindowInfo {
    hwnd: string;
    label: string;
    type: number;
    bbox: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    enabled: boolean;
    offscreen: boolean;
}
export interface WorldSummary {
    hwnd: string;
    version: number;
    elements: number;
    observedAt: number;
}
export interface WorkerStatus {
    /** Capability tier: L2 once the PostMessageW primitives are live; L3 stays sealed. */
    tier: 'L1' | 'L2';
    l2: boolean;
    l3: false;
    pid: number;
    /** True once the emergency-stop hotkey tripped; the worker exits (code 87) shortly after and the supervisor relaunches a clean instance. */
    panic: boolean;
    /** Hotkey combination the worker armed, e.g. "ctrl+alt+shift+p"; empty when none. */
    panicHotkey?: string;
    worlds: WorldSummary[];
}
/** Element shape returned by the elevated broker (UIA RuntimeId is always present there). */
export interface ElevatedElement {
    id: string;
    parentId: string | null;
    runtimeId: number[];
    type: number;
    label: string;
    bbox: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    enabled: boolean;
    offscreen: boolean;
    invokable: boolean;
    confidence: number;
    observedAt: number;
}
export interface ElevatedPage {
    hwnd: string;
    observedAt: number;
    complete: boolean;
    totalElements: number;
    elements: ElevatedElement[];
    focus: number[] | null;
    pullMs: number;
    modelMs: number;
    brokerPid: number;
}
export interface ElevatedObserveRequest {
    hwnd: string;
}
export interface FastElementFacts {
    runtimeId: number[];
    type: number;
    label: string;
    bbox: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    enabled: boolean;
    offscreen: boolean;
    invokable: boolean;
}
export interface LabelLookup {
    hwnd: string;
    label: string;
    matches: number;
    element: FastElementFacts;
}
export interface RuntimeLookup {
    hwnd: string;
    element: FastElementFacts;
}
export interface FastClickRequest {
    hwnd: string;
    runtimeId: number[];
    elementId: string;
}
export interface FastClickResult {
    hwnd: string;
    elementId: string;
    method: string;
    accepted: true;
    label?: string;
    type?: number;
    reactivated?: boolean;
    /** False when the window no longer exists after the Invoke settled. */
    windowAlive?: boolean;
}
export interface FastClickXyRequest {
    hwnd: string;
    x: number;
    y: number;
}
export interface FastClickXyResult {
    hwnd: string;
    x: number;
    y: number;
    method: string;
    accepted: true;
    reactivated?: boolean;
}
export interface ElevatedClickRequest {
    hwnd: string;
    runtimeId: number[];
}
/** Optional crop region for replacer_read_screen: full-screen physical pixels (口径③). */
export interface ReadScreenRegion {
    x: number;
    y: number;
    width: number;
    height: number;
}
export interface NormalizedReadScreenRequest {
    region?: ReadScreenRegion;
}
/** One OCR line hit; bbox stays in full-screen physical pixels even after region crop. */
export interface ReadScreenLine {
    text: string;
    bbox: ReadScreenRegion;
    words?: {
        text: string;
        bbox: ReadScreenRegion;
    }[];
}
export interface ReadScreenResult {
    width: number;
    height: number;
    lines: ReadScreenLine[];
    text: string;
    truncated: boolean;
    /** Original line count; present only when truncated. */
    totalLines?: number;
    timings: {
        buildMs: number;
        captureMs: number;
        ocrMs: number;
    };
}
/**
 * Read-only visual↔UIA fusion request (B-4, plan §3). `hwnd` names the target
 * window; `query` is optional screen text (≤512 characters, CJK-safe count);
 * `maxResults` is 1..50 (default 10); `minScore` is finite 0..1 (default 0.5).
 */
export interface LocateRequest {
    hwnd: string;
    query?: string;
    maxResults?: number;
    minScore?: number;
}
export interface NormalizedLocateRequest {
    hwnd: string;
    query?: string;
    maxResults: number;
    minScore: number;
}
/** One UIA element aligned with on-screen text; elementId is the stable world id click_by_id accepts. */
export interface LocateMatch {
    elementId: string;
    label: string;
    type: number;
    bbox: ReadScreenRegion;
    enabled: boolean;
    invokable: boolean;
    offscreen: boolean;
    source: 'fusion' | 'uia';
    score: number;
    textScore: number;
    overlap: number;
    ocrText: string | null;
}
/** One OCR text line with no usable UIA element behind it (UIA cannot address it). */
export interface LocateTextHit {
    text: string;
    bbox: ReadScreenRegion;
    score: number;
}
/**
 * Locate reply (B-4): read-only fusion over one window, zero image bytes.
 * Bboxes are full-screen physical pixels. channel "fusion" means capture + OCR +
 * grounding all ran; "uia_only" means the worker degraded to the UIA tree alone
 * (degraded/degradeReason explain why). returned text may contain sensitive
 * screen content; a match is a candidate, never a click.
 */
export interface LocateResult {
    hwnd: string;
    snapshotId: string;
    observedAt: number;
    query: string | null;
    channel: 'fusion' | 'uia_only';
    degraded: boolean;
    degradeReason: string | null;
    capabilities: {
        capture: boolean;
        ocr: boolean;
        grounding: boolean;
    };
    window: ReadScreenRegion;
    matches: LocateMatch[];
    textOnly: LocateTextHit[];
    timings: {
        observeMs: number;
        captureMs: number;
        ocrMs: number;
        fusionMs: number;
        buildMs: number;
    };
    truncated: boolean;
    totalMatches: number;
    totalTextOnly: number;
}
export type Response = {
    id: string;
    ok: true;
    result: unknown;
} | {
    id: string;
    ok: false;
    error: {
        code: ErrorCode;
        message: string;
    };
};
export declare function object(value: unknown): value is Record<string, unknown>;
export declare function normalizeObserve(value: unknown): NormalizedObserveRequest;
export declare function normalizeClick(value: unknown): ClickRequest;
export declare function normalizeType(value: unknown): TypeRequest;
export declare function normalizeScroll(value: unknown): ScrollRequest;
export declare function normalizeRightClick(value: unknown): RightClickRequest;
export declare function normalizeWheel(value: unknown): WheelRequest;
/** Window-directed key op: no elementId, the combo goes to the focus window of hwnd. */
export declare function normalizeKey(value: unknown): KeyArgs;
/**
 * Read-only screen perception (B-3): region is optional; when present it must be
 * full-screen physical pixels with non-negative x/y and positive width/height
 * (口径③; the worker clamps out-of-screen parts, zero area after clamp fails).
 */
export declare function normalizeReadScreen(value: unknown): NormalizedReadScreenRequest;
/**
 * Read-only locate request (B-4): hwnd is required (decimal nonzero handle);
 * query is optional text to locate on screen (1..512 characters, CJK-safe);
 * maxResults defaults to 10 (1..50); minScore defaults to 0.5 (finite, 0..1).
 * Unknown keys are rejected so a model typo cannot silently widen the read.
 */
export declare function normalizeLocate(value: unknown): NormalizedLocateRequest;
export declare function normalizeElevatedObserve(value: unknown): ElevatedObserveRequest;
export declare function normalizeElevatedClick(value: unknown): ElevatedClickRequest;
export declare function normalizeLabelLookup(value: unknown): {
    hwnd: string;
    label: string;
};
export declare function normalizeRuntimeLookup(value: unknown): {
    hwnd: string;
    runtimeId: number[];
};
export declare function normalizeRuntimeClick(value: unknown): FastClickRequest;
export declare function normalizeClickXy(value: unknown): FastClickXyRequest;
export declare function elementDetail(value: unknown, request: ClickRequest): ElementDetail;
export declare function clickResult(value: unknown, request: ClickRequest): ClickResult;
export declare function typeResult(value: unknown, request: TypeRequest): TypeResult;
export declare function scrollResult(value: unknown, request: ScrollRequest): ScrollResult;
export declare function rightClickResult(value: unknown, request: RightClickRequest): RightClickResult;
export declare function wheelResult(value: unknown, request: WheelRequest): WheelResult;
export declare function keyResult(value: unknown, request: KeyArgs): KeyResult;
/**
 * Read-only screen result validation (B-3). The allowed top-level key set is
 * exact: anything else - especially any image/binary field - is a protocol
 * violation (PNG red line: zero image bytes leave the worker; test-frozen).
 */
export declare function readScreenResult(value: unknown): ReadScreenResult;
/**
 * Read-only locate reply validation (B-4). plan §4 freezes the field set but
 * deliberately does NOT reject extra top-level keys; every contract field is
 * validated strictly: channel enum, three boolean capabilities, [0,1] scores,
 * five bounded non-negative timings, box() bboxes, integer totals, string|null
 * query/degradeReason, r:/f: match ids, degraded⇒reason consistency. No image
 * field is modeled or forwarded.
 */
export declare function locateResult(value: unknown): LocateResult;
export declare function windows(value: unknown): WindowInfo[];
export declare function workerStatus(value: unknown): WorkerStatus;
export declare function response(value: unknown): Response;
export declare function observePage(value: unknown, request: NormalizedObserveRequest): ObservePage;
export declare function labelLookup(value: unknown, request: {
    hwnd: string;
    label: string;
}): LabelLookup;
export declare function runtimeLookup(value: unknown, request: {
    hwnd: string;
    runtimeId: number[];
}): RuntimeLookup;
export declare function fastClickResult(value: unknown, request: FastClickRequest): FastClickResult;
export declare function fastClickXyResult(value: unknown, request: FastClickXyRequest): FastClickXyResult;
export declare function encode(value: unknown): Buffer;
export declare class Frames {
    private chunks;
    private size;
    private append;
    push(chunk: Buffer): unknown[];
    end(): void;
}
