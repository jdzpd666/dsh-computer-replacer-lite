export const MAX_FRAME_BYTES = 65_536;
export const DEFAULT_PAGE_LIMIT = 200;
export const MAX_ELEMENTS = 20_000;
/** Soft byte ceiling for one locate reply (plan §2.4/§4: trailing textOnly first, then matches). */
export const MAX_LOCATE_SOFT_BYTES = 58_982;
export const ERROR_CODES = [
    'STALE_STATE', 'ELEMENT_NOT_INVOKABLE', 'CONTEXT_CHANGED',
    'WORKER_UNAVAILABLE', 'TIMEOUT', 'REJECTED', 'UNSUPPORTED_OPERATION',
    'L3_DISABLED', 'UIPI_BLOCKED', 'INJECTION_UNCERTAIN', 'INVALID_ARGUMENT',
    'OBSERVATION_LIMIT', 'UIA_ERROR', 'AMBIGUOUS_IDENTITY', 'PANIC_ABORTED',
    'VISION_UNAVAILABLE', 'VISION_TIMEOUT',
];
export class IpcError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'IpcError';
    }
}
export function object(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function integer(value) {
    return typeof value === 'number' && Number.isSafeInteger(value);
}
function nonnegative(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function invalid(message) {
    throw new IpcError('INVALID_ARGUMENT', message);
}
function protocolError(message) {
    throw new IpcError('WORKER_UNAVAILABLE', `Invalid worker response: ${message}`);
}
export function normalizeObserve(value) {
    if (!object(value))
        invalid('Observe arguments must be an object');
    const allowed = new Set(['hwnd', 'snapshotId', 'offset', 'limit']);
    if (Object.keys(value).some(key => !allowed.has(key)))
        invalid('Unknown observe argument');
    if (typeof value.hwnd !== 'string' || !/^[0-9]{1,20}$/.test(value.hwnd))
        invalid('hwnd must be a decimal integer string');
    const hwnd = BigInt(value.hwnd);
    if (hwnd === 0n || hwnd > 0xffffffffffffffffn)
        invalid('hwnd is outside the supported range');
    const offset = value.offset ?? 0;
    const limit = value.limit ?? DEFAULT_PAGE_LIMIT;
    if (!integer(offset) || offset < 0 || offset > MAX_ELEMENTS)
        invalid('offset must be an integer between 0 and 20000');
    if (!integer(limit) || limit < 1 || limit > DEFAULT_PAGE_LIMIT)
        invalid('limit must be an integer between 1 and 200');
    const result = { hwnd: hwnd.toString(), offset, limit };
    if (value.snapshotId !== undefined) {
        if (typeof value.snapshotId !== 'string' || value.snapshotId.length === 0 || value.snapshotId.length > 128)
            invalid('snapshotId must contain 1..128 characters');
        result.snapshotId = value.snapshotId;
    }
    else if (offset !== 0)
        invalid('A nonzero offset requires snapshotId');
    return result;
}
/** Shared hwnd + elementId validation: both are model-facing strings, never numbers. */
function address(value) {
    if (typeof value.hwnd !== 'string' || !/^[0-9]{1,20}$/.test(value.hwnd))
        invalid('hwnd must be a decimal integer string');
    const hwnd = BigInt(value.hwnd);
    if (hwnd === 0n || hwnd > 0xffffffffffffffffn)
        invalid('hwnd is outside the supported range');
    const elementId = value.elementId;
    if (typeof elementId !== 'string' || elementId.length === 0 || elementId.length > 4096 || /[\u0000-\u001f\u007f]/.test(elementId))
        invalid('elementId must be a node id returned by observe');
    // Worker ids are "r:[runtimeId]" or "f:[parent,type,label]"; anything else cannot resolve.
    if (!/^[rf]:/.test(elementId))
        invalid('elementId must be a node id returned by observe');
    return { hwnd: hwnd.toString(), elementId };
}
export function normalizeClick(value) {
    if (!object(value))
        invalid('Click arguments must be an object');
    const allowed = new Set(['hwnd', 'elementId']);
    if (Object.keys(value).some(key => !allowed.has(key)))
        invalid('Unknown click argument');
    return address(value);
}
export function normalizeType(value) {
    if (!object(value))
        invalid('Type arguments must be an object');
    const allowed = new Set(['hwnd', 'elementId', 'text']);
    if (Object.keys(value).some(key => !allowed.has(key)))
        invalid('Unknown type argument');
    const target = address(value);
    const text = value.text;
    if (typeof text !== 'string')
        invalid('text must be a string');
    if (text.length === 0 || text.includes('\u0000'))
        invalid('text must contain 1..8192 characters and no NUL');
    if ([...text].length > 8192)
        invalid('text must contain 1..8192 characters and no NUL');
    return { ...target, text };
}
export function normalizeScroll(value) {
    if (!object(value))
        invalid('Scroll arguments must be an object');
    const allowed = new Set(['hwnd', 'elementId', 'horizontal', 'vertical', 'steps']);
    if (Object.keys(value).some(key => !allowed.has(key)))
        invalid('Unknown scroll argument');
    const target = address(value);
    const horizontal = value.horizontal ?? 'no';
    const vertical = value.vertical ?? 'no';
    if (horizontal !== 'no' && horizontal !== 'left' && horizontal !== 'right')
        invalid('horizontal must be no, left or right');
    if (vertical !== 'no' && vertical !== 'up' && vertical !== 'down')
        invalid('vertical must be no, up or down');
    if (horizontal === 'no' && vertical === 'no')
        invalid('At least one scroll direction is required');
    const steps = value.steps ?? 1;
    if (!integer(steps) || steps < 1 || steps > 10)
        invalid('steps must be an integer between 1 and 10');
    return { ...target, horizontal, vertical, steps };
}
export function normalizeRightClick(value) {
    if (!object(value))
        invalid('Right-click arguments must be an object');
    const allowed = new Set(['hwnd', 'elementId']);
    if (Object.keys(value).some(key => !allowed.has(key)))
        invalid('Unknown right-click argument');
    return address(value);
}
export function normalizeWheel(value) {
    if (!object(value))
        invalid('Wheel arguments must be an object');
    const allowed = new Set(['hwnd', 'elementId', 'vertical', 'steps']);
    if (Object.keys(value).some(key => !allowed.has(key)))
        invalid('Unknown wheel argument');
    const target = address(value);
    const vertical = value.vertical ?? 'down';
    if (vertical !== 'up' && vertical !== 'down')
        invalid('vertical must be up or down');
    const steps = value.steps ?? 1;
    if (!integer(steps) || steps < 1 || steps > 10)
        invalid('steps must be an integer between 1 and 10');
    return { ...target, vertical, steps };
}
function windowHandle(value) {
    if (typeof value.hwnd !== 'string' || !/^[0-9]{1,20}$/.test(value.hwnd))
        invalid('hwnd must be a decimal integer string');
    const hwnd = BigInt(value.hwnd);
    if (hwnd === 0n || hwnd > 0xffffffffffffffffn)
        invalid('hwnd is outside the supported range');
    return hwnd.toString();
}
/** Key names accepted as single-key combos. */
const KEY_NAMES = new Set([
    'enter', 'return', 'esc', 'escape', 'tab', 'backspace', 'delete', 'del', 'home', 'end', 'pageup', 'pagedown', 'pgdn',
    'up', 'down', 'left', 'right', 'space',
    ...'abcdefghijklmnopqrstuvwxyz', ...'0123456789',
    ...Array.from({ length: 12 }, (_, index) => 'f' + (index + 1)),
]);
/** Modifier words that mark a combo as a chord; none may appear anywhere in a combo. */
const CHORD_MODIFIERS = new Set(['ctrl', 'alt', 'shift', 'meta', 'win', 'cmd']);
/**
 * Validate and normalize one combo: a single key name or a single character
 * (Chinese included). Every modifier chord is rejected outright because
 * PostMessageW cannot deliver modifier state - a posted chord reaches the
 * window as literal characters; the Worker re-validates the same rule.
 */
function keyCombo(value) {
    if (typeof value !== 'string' || value.length === 0) {
        invalid('combo 必须是单个键名或单个字符（如 "enter"、"space"、"7"、"键"） / combo must be a single key name or a single character (such as "enter", "space", "7" or a Chinese character)');
    }
    if ([...value].length > 32)
        invalid('combo 长度不能超过 32 个字符 / combo must not exceed 32 characters');
    const lowered = value.toLowerCase();
    if (value.includes('+') || [...CHORD_MODIFIERS].some(modifier => lowered.includes(modifier))) {
        invalid('和弦 combo 不受支持：PostMessageW 无法传递修饰键状态，和弦会变成字面字符（如 "ctrl+a" 只会输入字母 a）；选择/复制场景请改用 UIA 模式（replacer_type）或提权 Broker；零按键已发送 / modifier chords are unsupported for combo: PostMessageW cannot deliver modifier state, so a chord arrives as literal characters (for example "ctrl+a" types only the letter a); for select/copy use UIA patterns (replacer_type) or the elevated broker; zero keys were sent');
    }
    if (/\s/.test(value))
        invalid('combo 不能包含空白：只支持单个键名或单个字符 / combo must not contain whitespace: only a single key name or a single character is supported');
    if (value.includes(','))
        invalid('combo 不能包含逗号：只支持单个键名或单个字符 / combo must not contain commas: only a single key name or a single character is supported');
    if (KEY_NAMES.has(value))
        return value;
    if ([...value].length === 1) {
        if (hasControl(value))
            invalid('combo 不能是控制字符（如 0x01）：控制码无法通过 PostMessage 交付 / combo must not be a control character (such as 0x01): control codes cannot be delivered through PostMessage');
        return value;
    }
    if (KEY_NAMES.has(lowered))
        return lowered;
    invalid('未知键名 "' + value + '"；支持 enter esc tab backspace delete home end pageup pagedown up down left right space、a..z、0..9、f1..f12，或改用单个字符（含中文） / unknown key name "' + value + '"; supported keys are enter esc tab backspace delete home end pageup pagedown up down left right space, a..z, 0..9 and f1..f12, or use a single character (Chinese included)');
}
/** Window-directed key op: no elementId, the combo goes to the focus window of hwnd. */
export function normalizeKey(value) {
    if (!object(value))
        invalid('Key arguments must be an object');
    const allowed = new Set(['hwnd', 'combo']);
    if (Object.keys(value).some(key => !allowed.has(key)))
        invalid('Unknown key argument');
    return { hwnd: windowHandle(value), combo: keyCombo(value.combo) };
}
/**
 * Read-only screen perception (B-3): region is optional; when present it must be
 * full-screen physical pixels with non-negative x/y and positive width/height
 * (口径③; the worker clamps out-of-screen parts, zero area after clamp fails).
 */
export function normalizeReadScreen(value) {
    if (!object(value))
        invalid('Read-screen arguments must be an object');
    const allowed = new Set(['region']);
    if (Object.keys(value).some(key => !allowed.has(key)))
        invalid('Unknown read-screen argument');
    const result = {};
    if (value.region !== undefined) {
        const region = value.region;
        if (!object(region))
            invalid('region must be an object {x,y,width,height} in physical pixels');
        const regionAllowed = new Set(['x', 'y', 'width', 'height']);
        if (Object.keys(region).some(key => !regionAllowed.has(key)))
            invalid('Unknown region argument');
        const field = (key) => {
            if (!integer(region[key]) || region[key] > 100_000) {
                invalid(`region.${key} must be an integer in physical pixels (0..100000)`);
            }
            return region[key];
        };
        const x = field('x');
        const y = field('y');
        const width = field('width');
        const height = field('height');
        if (x < 0 || y < 0 || width <= 0 || height <= 0) {
            invalid('region must carry non-negative x/y and positive width/height in physical pixels');
        }
        result.region = { x, y, width, height };
    }
    return result;
}
/** Locate request bounds (B-4): frozen by plan §3/§4, shared with locateResult. */
const LOCATE_MAX_QUERY_LENGTH = 512;
const LOCATE_DEFAULT_RESULTS = 10;
const LOCATE_MAX_RESULTS = 50;
const LOCATE_DEFAULT_MIN_SCORE = 0.5;
/** Hard ceiling for one timing value: a bogus huge number is a protocol violation. */
const LOCATE_MAX_TIMING_MS = 600_000;
/** A reply never carries more than maxResults (≤50) matches or 20 text-only hits. */
const LOCATE_MAX_MATCHES = 50;
const LOCATE_MAX_TEXT_ONLY = 20;
const LOCATE_MAX_STRING = 4096;
/**
 * Read-only locate request (B-4): hwnd is required (decimal nonzero handle);
 * query is optional text to locate on screen (1..512 characters, CJK-safe);
 * maxResults defaults to 10 (1..50); minScore defaults to 0.5 (finite, 0..1).
 * Unknown keys are rejected so a model typo cannot silently widen the read.
 */
export function normalizeLocate(value) {
    if (!object(value))
        invalid('Locate arguments must be an object');
    const allowed = new Set(['hwnd', 'query', 'maxResults', 'minScore']);
    if (Object.keys(value).some(key => !allowed.has(key)))
        invalid('Unknown locate argument');
    const hwnd = windowHandle(value);
    let query;
    if (value.query !== undefined) {
        if (typeof value.query !== 'string')
            invalid('query must be a string');
        if ([...value.query].length > LOCATE_MAX_QUERY_LENGTH)
            invalid('query must be at most 512 characters');
        query = value.query;
    }
    const maxResults = value.maxResults ?? LOCATE_DEFAULT_RESULTS;
    if (!integer(maxResults))
        invalid('maxResults must be an integer between 1 and 50');
    if (maxResults < 1 || maxResults > LOCATE_MAX_RESULTS)
        invalid('maxResults must be an integer between 1 and 50');
    const minScore = value.minScore ?? LOCATE_DEFAULT_MIN_SCORE;
    if (typeof minScore !== 'number' || !Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
        invalid('minScore must be a finite number between 0 and 1');
    }
    const result = { hwnd, maxResults, minScore };
    if (query !== undefined)
        result.query = query;
    return result;
}
export function normalizeElevatedObserve(value) {
    if (!object(value))
        invalid('Elevated observe arguments must be an object');
    const allowed = new Set(['hwnd']);
    if (Object.keys(value).some(key => !allowed.has(key)))
        invalid('Unknown elevated observe argument');
    return { hwnd: windowHandle(value) };
}
export function normalizeElevatedClick(value) {
    if (!object(value))
        invalid('Elevated click arguments must be an object');
    const allowed = new Set(['hwnd', 'runtimeId']);
    if (Object.keys(value).some(key => !allowed.has(key)))
        invalid('Unknown elevated click argument');
    const hwnd = windowHandle(value);
    const runtimeId = value.runtimeId;
    if (!Array.isArray(runtimeId) || runtimeId.length === 0 || runtimeId.length > 64)
        invalid('runtimeId must be an array of 1..64 integers');
    const ids = [];
    for (const entry of runtimeId) {
        if (!integer(entry) || entry < -2147483648 || entry > 2147483647)
            invalid('runtimeId entries must be 32-bit integers');
        ids.push(entry);
    }
    return { hwnd, runtimeId: ids };
}
function runtime_ids(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
        invalid('runtimeId must be an array of 1..64 integers');
    }
    const ids = [];
    for (const entry of value) {
        if (!integer(entry) || entry < -2147483648 || entry > 2147483647) {
            invalid('runtimeId entries must be 32-bit integers');
        }
        ids.push(entry);
    }
    return ids;
}
function hasControl(text) {
    return [...text].some(character => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
    });
}
export function normalizeLabelLookup(value) {
    if (!object(value))
        invalid('Label lookup arguments must be an object');
    const allowed = new Set(['hwnd', 'label']);
    if (Object.keys(value).some(key => !allowed.has(key)))
        invalid('Unknown label lookup argument');
    const label = value.label;
    if (typeof label !== 'string' || [...label].length === 0 || [...label].length > 512 || hasControl(label)) {
        invalid('label must contain 1..512 characters and no control characters');
    }
    return { hwnd: windowHandle(value), label };
}
export function normalizeRuntimeLookup(value) {
    if (!object(value))
        invalid('Runtime lookup arguments must be an object');
    const allowed = new Set(['hwnd', 'runtimeId']);
    if (Object.keys(value).some(key => !allowed.has(key)))
        invalid('Unknown runtime lookup argument');
    return { hwnd: windowHandle(value), runtimeId: runtime_ids(value.runtimeId) };
}
export function normalizeRuntimeClick(value) {
    if (!object(value))
        invalid('Fast click arguments must be an object');
    const allowed = new Set(['hwnd', 'runtimeId']);
    if (Object.keys(value).some(key => !allowed.has(key)))
        invalid('Unknown fast click argument');
    const runtimeId = runtime_ids(value.runtimeId);
    return { hwnd: windowHandle(value), runtimeId, elementId: 'r:' + JSON.stringify(runtimeId) };
}
export function normalizeClickXy(value) {
    if (!object(value))
        invalid('Coordinate click arguments must be an object');
    const allowed = new Set(['hwnd', 'x', 'y']);
    if (Object.keys(value).some(key => !allowed.has(key)))
        invalid('Unknown coordinate click argument');
    const x = value.x;
    const y = value.y;
    if (!integer(x) || !integer(y) || Math.abs(x) > 1000000 || Math.abs(y) > 1000000) {
        invalid('x and y must be integers inside the virtual screen');
    }
    return { hwnd: windowHandle(value), x, y };
}
function box(value) {
    if (!object(value))
        return false;
    const bbox = value;
    return ['x', 'y', 'width', 'height'].every(key => typeof bbox[key] === 'number' && Number.isFinite(bbox[key]));
}
export function elementDetail(value, request) {
    if (!object(value))
        protocolError('expected element detail');
    if (value.id !== request.elementId || typeof value.label !== 'string' || typeof value.windowLabel !== 'string' || !integer(value.type) || !(value.parentId === null || (typeof value.parentId === 'string' && value.parentId.length > 0 && value.parentId.length <= 4096)) || !box(value.bbox) || typeof value.enabled !== 'boolean' || typeof value.offscreen !== 'boolean' || typeof value.invokable !== 'boolean' || !nonnegative(value.confidence) || value.confidence > 1)
        protocolError('invalid element detail');
    return value;
}
export function clickResult(value, request) {
    if (!object(value) || value.hwnd !== request.hwnd || value.elementId !== request.elementId || value.method !== 'l1_invoke' || value.accepted !== true)
        protocolError('the worker did not confirm an L1 invoke');
    return value;
}
export function typeResult(value, request) {
    if (!object(value) || value.hwnd !== request.hwnd || value.elementId !== request.elementId || value.method !== 'l1_value' || value.accepted !== true)
        protocolError('the worker did not confirm an L1 value write');
    if (!integer(value.characters) || value.characters !== [...request.text].length)
        protocolError('the worker reported a different character count');
    return value;
}
export function scrollResult(value, request) {
    if (!object(value) || value.hwnd !== request.hwnd || value.elementId !== request.elementId || value.method !== 'l1_scroll' || value.accepted !== true)
        protocolError('the worker did not confirm an L1 scroll');
    if (value.horizontal !== request.horizontal || value.vertical !== request.vertical || value.steps !== request.steps)
        protocolError('the worker echoed different scroll parameters');
    return value;
}
function decimalHandle(value) {
    if (typeof value !== 'string' || !/^[0-9]{1,20}$/.test(value))
        return false;
    const handle = BigInt(value);
    return handle > 0n && handle <= 0xffffffffffffffffn;
}
export function rightClickResult(value, request) {
    if (!object(value) || value.hwnd !== request.hwnd || value.elementId !== request.elementId || value.method !== 'postmessage_right_click' || value.accepted !== true)
        protocolError('the worker did not confirm a PostMessage right-click');
    if (!decimalHandle(value.targetHwnd) || !integer(value.x) || !integer(value.y) || !integer(value.screenX) || !integer(value.screenY))
        protocolError('the worker reported invalid right-click coordinates');
    if (value.reactivated !== undefined && typeof value.reactivated !== 'boolean')
        protocolError('invalid reactivated flag');
    if (value.windowAlive !== undefined && typeof value.windowAlive !== 'boolean')
        protocolError('invalid windowAlive flag');
    return value;
}
export function wheelResult(value, request) {
    if (!object(value) || value.hwnd !== request.hwnd || value.elementId !== request.elementId || value.method !== 'postmessage_wheel' || value.accepted !== true)
        protocolError('the worker did not confirm a PostMessage wheel');
    if (value.vertical !== request.vertical || value.steps !== request.steps)
        protocolError('the worker echoed different wheel parameters');
    if (!decimalHandle(value.targetHwnd) || !integer(value.screenX) || !integer(value.screenY) || !integer(value.delta) || value.delta === 0)
        protocolError('the worker reported an invalid wheel result');
    const expected = request.vertical === 'up' ? 1 : -1;
    if (Math.sign(value.delta) !== expected)
        protocolError('the worker reported the wrong wheel direction');
    if (value.reactivated !== undefined && typeof value.reactivated !== 'boolean')
        protocolError('invalid reactivated flag');
    if (value.windowAlive !== undefined && typeof value.windowAlive !== 'boolean')
        protocolError('invalid windowAlive flag');
    return value;
}
export function keyResult(value, request) {
    if (!object(value) || value.hwnd !== request.hwnd || value.combo !== request.combo || value.method !== 'postmessage_key' || value.accepted !== true)
        protocolError('the worker did not confirm a PostMessage key');
    if (!integer(value.keysPosted) || value.keysPosted < 0)
        protocolError('the worker reported an invalid posted-key count');
    if (!decimalHandle(value.focusHwnd))
        protocolError('the worker reported an invalid focus window');
    if (typeof value.windowAlive !== 'boolean')
        protocolError('the worker reported an invalid window state');
    if (value.reactivated !== undefined && typeof value.reactivated !== 'boolean')
        protocolError('invalid reactivated flag');
    return value;
}
/**
 * Read-only screen result validation (B-3). The allowed top-level key set is
 * exact: anything else - especially any image/binary field - is a protocol
 * violation (PNG red line: zero image bytes leave the worker; test-frozen).
 */
export function readScreenResult(value) {
    if (!object(value))
        protocolError('expected a read-screen object');
    const allowed = new Set(['width', 'height', 'lines', 'text', 'truncated', 'totalLines', 'timings']);
    if (Object.keys(value).some(key => !allowed.has(key)))
        protocolError('unexpected field in read-screen result (zero-image contract violated)');
    if (!integer(value.width) || value.width <= 0 || !integer(value.height) || value.height <= 0)
        protocolError('invalid screen dimensions');
    if (typeof value.truncated !== 'boolean')
        protocolError('invalid truncated flag');
    if (value.truncated && (!integer(value.totalLines) || value.totalLines < 1))
        protocolError('truncated results must carry the original line count');
    if (!value.truncated && value.totalLines !== undefined)
        protocolError('untruncated results must not carry totalLines');
    if (typeof value.text !== 'string' || value.text.length > MAX_FRAME_BYTES)
        protocolError('invalid full text');
    if (!nonnegative(value.timings?.buildMs)
        || !nonnegative(value.timings?.captureMs)
        || !nonnegative(value.timings?.ocrMs))
        protocolError('invalid timing values');
    if (!Array.isArray(value.lines) || value.lines.length > 5000)
        protocolError('invalid line list');
    if (value.truncated === false && value.lines.length === 0)
        protocolError('untruncated results must contain at least one line');
    if (value.truncated === true && value.lines.length === 0 && value.text !== '')
        protocolError('truncated empty results must carry empty text');
    const lines = value.lines.map((row) => {
        if (!object(row) || typeof row.text !== 'string' || !box(row.bbox))
            protocolError('invalid read-screen line');
        if (row.words !== undefined) {
            if (!Array.isArray(row.words))
                protocolError('invalid word list');
            for (const word of row.words) {
                if (!object(word) || typeof word.text !== 'string' || !box(word.bbox))
                    protocolError('invalid read-screen word');
            }
        }
        return row;
    });
    const result = value;
    result.lines = lines;
    return result;
}
/** Unit-interval score/overlap: a finite number in [0, 1]. */
function unitScore(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
function locateMatch(value) {
    if (!object(value))
        protocolError('invalid locate match');
    if (typeof value.elementId !== 'string' || value.elementId.length === 0 || value.elementId.length > LOCATE_MAX_STRING
        || /[\u0000-\u001f\u007f]/.test(value.elementId) || !/^[rf]:/.test(value.elementId))
        protocolError('invalid locate match elementId');
    if (typeof value.label !== 'string' || value.label.length > LOCATE_MAX_STRING)
        protocolError('invalid locate match label');
    if (!integer(value.type))
        protocolError('invalid locate match type');
    if (!box(value.bbox))
        protocolError('invalid locate match bbox');
    if (typeof value.enabled !== 'boolean' || typeof value.invokable !== 'boolean' || typeof value.offscreen !== 'boolean')
        protocolError('invalid locate match flags');
    if (value.source !== 'fusion' && value.source !== 'uia')
        protocolError('invalid locate match source');
    if (!unitScore(value.score) || !unitScore(value.textScore) || !unitScore(value.overlap))
        protocolError('invalid locate match score');
    if (value.source === 'uia') {
        if (value.ocrText !== null)
            protocolError('UIA-sourced locate matches must not carry ocrText');
    }
    else if (typeof value.ocrText !== 'string')
        protocolError('fusion-sourced locate matches must carry ocrText');
    return value;
}
function locateTextHit(value) {
    if (!object(value) || typeof value.text !== 'string' || value.text.length > LOCATE_MAX_STRING || !box(value.bbox) || !unitScore(value.score)) {
        protocolError('invalid locate text-only hit');
    }
    return value;
}
/**
 * Read-only locate reply validation (B-4). plan §4 freezes the field set but
 * deliberately does NOT reject extra top-level keys; every contract field is
 * validated strictly: channel enum, three boolean capabilities, [0,1] scores,
 * five bounded non-negative timings, box() bboxes, integer totals, string|null
 * query/degradeReason, r:/f: match ids, degraded⇒reason consistency. No image
 * field is modeled or forwarded.
 */
export function locateResult(value) {
    if (!object(value))
        protocolError('expected a locate object');
    if (!decimalHandle(value.hwnd))
        protocolError('locate result has an invalid hwnd');
    const snapshotId = value.snapshotId;
    if (typeof snapshotId !== 'string' || snapshotId.length === 0 || snapshotId.length > 128)
        protocolError('locate result has an invalid snapshotId');
    const observedAt = value.observedAt;
    if (!integer(observedAt) || observedAt < 0)
        protocolError('locate result has an invalid observedAt');
    const query = value.query;
    if (query !== null && (typeof query !== 'string' || [...query].length > LOCATE_MAX_QUERY_LENGTH))
        protocolError('locate result has an invalid echoed query');
    const channel = value.channel;
    if (channel !== 'fusion' && channel !== 'uia_only')
        protocolError('locate result has an invalid channel');
    const degraded = value.degraded;
    if (typeof degraded !== 'boolean')
        protocolError('locate result has an invalid degraded flag');
    const degradeReason = value.degradeReason;
    if (degradeReason !== null && (typeof degradeReason !== 'string' || degradeReason.length > LOCATE_MAX_STRING))
        protocolError('locate result has an invalid degradeReason');
    if (degraded === true && (typeof degradeReason !== 'string' || degradeReason.length === 0))
        protocolError('a degraded locate result must carry a degradeReason');
    if (degraded === false && degradeReason !== null)
        protocolError('a non-degraded locate result must not carry a degradeReason');
    const capabilities = value.capabilities;
    if (!object(capabilities) || typeof capabilities.capture !== 'boolean' || typeof capabilities.ocr !== 'boolean' || typeof capabilities.grounding !== 'boolean') {
        protocolError('locate result has invalid capabilities');
    }
    const window = value.window;
    if (!box(window))
        protocolError('locate result has an invalid window box');
    const matches = value.matches;
    if (!Array.isArray(matches) || matches.length > LOCATE_MAX_MATCHES)
        protocolError('locate result has an invalid match list');
    const textOnly = value.textOnly;
    if (!Array.isArray(textOnly) || textOnly.length > LOCATE_MAX_TEXT_ONLY)
        protocolError('locate result has an invalid text-only list');
    const parsedMatches = matches.map(locateMatch);
    const parsedTextOnly = textOnly.map(locateTextHit);
    const timings = value.timings;
    if (!object(timings))
        protocolError('locate result has invalid timings');
    for (const key of ['observeMs', 'captureMs', 'ocrMs', 'fusionMs', 'buildMs']) {
        const timing = timings[key];
        if (typeof timing !== 'number' || !Number.isFinite(timing) || timing < 0 || timing > LOCATE_MAX_TIMING_MS) {
            protocolError('locate result has an invalid timing value: ' + key);
        }
    }
    const totalMatches = value.totalMatches;
    if (!integer(totalMatches) || totalMatches < parsedMatches.length)
        protocolError('locate result has an inconsistent totalMatches');
    const totalTextOnly = value.totalTextOnly;
    if (!integer(totalTextOnly) || totalTextOnly < parsedTextOnly.length)
        protocolError('locate result has an inconsistent totalTextOnly');
    if (typeof value.truncated !== 'boolean')
        protocolError('locate result has an invalid truncated flag');
    const result = value;
    result.matches = parsedMatches;
    result.textOnly = parsedTextOnly;
    return result;
}
export function windows(value) {
    if (!object(value) || !Array.isArray(value.windows) || value.windows.length > 2000)
        protocolError('expected a bounded window list');
    return value.windows.map((row) => {
        if (!object(row) || typeof row.hwnd !== 'string' || !/^[0-9]{1,20}$/.test(row.hwnd) || typeof row.label !== 'string' || !integer(row.type) || !box(row.bbox) || typeof row.enabled !== 'boolean' || typeof row.offscreen !== 'boolean')
            protocolError('invalid window row');
        return row;
    });
}
export function workerStatus(value) {
    if (!object(value) || (value.tier !== 'L1' && value.tier !== 'L2') || typeof value.l2 !== 'boolean' || value.l3 !== false || !integer(value.pid) || value.pid <= 0 || typeof value.panic !== 'boolean' || !Array.isArray(value.worlds))
        protocolError('invalid worker status');
    if (value.panicHotkey !== undefined && (typeof value.panicHotkey !== 'string' || value.panicHotkey.length > 64))
        protocolError('invalid panic hotkey label');
    const worlds = value.worlds.map((row) => {
        if (!object(row) || typeof row.hwnd !== 'string' || !/^[0-9]{1,20}$/.test(row.hwnd) || !integer(row.version) || row.version < 1 || !integer(row.elements) || row.elements < 0 || !integer(row.observedAt) || row.observedAt < 0)
            protocolError('invalid world summary row');
        return row;
    });
    const status = { tier: value.tier, l2: value.l2, l3: false, pid: value.pid, panic: value.panic, worlds };
    if (value.panicHotkey !== undefined)
        status.panicHotkey = value.panicHotkey;
    return status;
}
export function response(value) {
    if (!object(value) || typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 128 || typeof value.ok !== 'boolean')
        throw new Error('Invalid response envelope');
    if (value.ok && Object.hasOwn(value, 'result'))
        return { id: value.id, ok: true, result: value.result };
    if (value.ok === false && object(value.error) && ERROR_CODES.includes(value.error.code) && typeof value.error.message === 'string') {
        return { id: value.id, ok: false, error: { code: value.error.code, message: value.error.message } };
    }
    throw new Error('Invalid response body');
}
export function observePage(value, request) {
    if (!object(value))
        protocolError('expected an object');
    if (typeof value.snapshotId !== 'string' || value.snapshotId.length === 0 || value.snapshotId.length > 128 || !integer(value.version) || value.version < 1 || value.hwnd !== request.hwnd || !integer(value.observedAt) || value.observedAt < 0 || value.complete !== true)
        protocolError('invalid snapshot identity or metadata');
    if (request.snapshotId !== undefined && value.snapshotId !== request.snapshotId)
        protocolError('snapshot changed during pagination');
    if (!integer(value.totalElements) || value.totalElements < 1 || value.totalElements > MAX_ELEMENTS || !integer(value.returnedElements) || value.returnedElements < 0 || value.returnedElements > request.limit || !Array.isArray(value.elements) || value.elements.length !== value.returnedElements)
        protocolError('invalid element counts');
    const end = request.offset + value.returnedElements;
    if (request.offset > value.totalElements || end > value.totalElements || (request.offset < value.totalElements && value.returnedElements === 0))
        protocolError('invalid page bounds or non-progressing page');
    const expectedNext = end < value.totalElements ? end : null;
    if (value.nextOffset !== expectedNext)
        protocolError('invalid nextOffset');
    if (!nonnegative(value.pullMs) || !nonnegative(value.modelMs) || !nonnegative(value.observeMs))
        protocolError('invalid timing values');
    const ids = new Set();
    for (const element of value.elements) {
        if (!object(element) || typeof element.id !== 'string' || element.id.length === 0 || element.id.length > 128 || ids.has(element.id) || !(element.parentId === null || (typeof element.parentId === 'string' && element.parentId.length > 0 && element.parentId.length <= 128)) || !integer(element.type) || typeof element.label !== 'string' || !object(element.bbox) || !['x', 'y', 'width', 'height'].every(key => typeof element.bbox === 'object' && element.bbox !== null && typeof element.bbox[key] === 'number' && Number.isFinite(element.bbox[key])) || typeof element.enabled !== 'boolean' || typeof element.offscreen !== 'boolean' || typeof element.invokable !== 'boolean' || !nonnegative(element.confidence) || element.confidence > 1 || element.observedAt !== value.observedAt)
            protocolError('invalid or duplicate element');
        ids.add(element.id);
    }
    return value;
}
function fastFacts(value) {
    if (!object(value))
        protocolError('expected element facts');
    if (!Array.isArray(value.runtimeId) || value.runtimeId.length === 0 || value.runtimeId.length > 64) {
        protocolError('expected element facts');
    }
    if (!value.runtimeId.every(entry => integer(entry)))
        protocolError('expected element facts');
    if (typeof value.label !== 'string' || !integer(value.type) || !box(value.bbox))
        protocolError('expected element facts');
    if (typeof value.enabled !== 'boolean' || typeof value.offscreen !== 'boolean' || typeof value.invokable !== 'boolean') {
        protocolError('expected element facts');
    }
    return value;
}
export function labelLookup(value, request) {
    if (!object(value) || value.hwnd !== request.hwnd || value.label !== request.label)
        protocolError('invalid label lookup');
    if (!integer(value.matches) || value.matches < 1)
        protocolError('invalid label lookup match count');
    return { hwnd: request.hwnd, label: request.label, matches: value.matches, element: fastFacts(value.element) };
}
export function runtimeLookup(value, request) {
    if (!object(value) || value.hwnd !== request.hwnd)
        protocolError('invalid runtime lookup');
    return { hwnd: request.hwnd, element: fastFacts(value.element) };
}
export function fastClickResult(value, request) {
    if (!object(value) || value.hwnd !== request.hwnd || value.elementId !== request.elementId)
        protocolError('invalid fast click result');
    if (value.method !== 'l1_invoke' || value.accepted !== true)
        protocolError('the worker did not confirm a fast invoke');
    return value;
}
export function fastClickXyResult(value, request) {
    if (!object(value) || value.hwnd !== request.hwnd || value.x !== request.x || value.y !== request.y) {
        protocolError('invalid coordinate click result');
    }
    if (value.method !== 'l1_send_input' || value.accepted !== true)
        protocolError('the worker did not confirm a coordinate click');
    return value;
}
export function encode(value) {
    const text = JSON.stringify(value);
    if (text === undefined)
        throw new Error('Value is not JSON serializable');
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length > MAX_FRAME_BYTES)
        throw new Error('Frame exceeds limit');
    return Buffer.concat([bytes, Buffer.from([10])]);
}
export class Frames {
    chunks = [];
    size = 0;
    append(part) {
        if (this.size + part.length > MAX_FRAME_BYTES)
            throw new Error('Frame exceeds limit');
        if (part.length !== 0) {
            this.chunks.push(Buffer.from(part));
            this.size += part.length;
        }
    }
    push(chunk) {
        const values = [];
        let start = 0;
        for (;;) {
            const newline = chunk.indexOf(10, start);
            if (newline === -1) {
                this.append(chunk.subarray(start));
                return values;
            }
            this.append(chunk.subarray(start, newline));
            const bytes = Buffer.concat(this.chunks, this.size);
            this.chunks = [];
            this.size = 0;
            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            values.push(JSON.parse(text));
            start = newline + 1;
        }
    }
    end() { if (this.size !== 0)
        throw new Error('Truncated frame'); }
}
