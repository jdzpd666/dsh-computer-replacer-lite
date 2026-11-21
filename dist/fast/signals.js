const LABEL_PATTERN = /<C:([^<>\r\n]{1,200})>/g;
const RUNTIME_PATTERN = /<I:r:\[(-?\d{1,10}(?:,-?\d{1,10}){0,63})\]/g;
/**
 * Finds the last complete fast signal in the accumulated assistant text.
 *
 * The model may emit either <C:EXACT_LABEL> or <I:r:[a,b,...]>; the last one
 * wins so an earlier half-written or superseded signal never fires.
 */
export function findSignal(text) {
    let best;
    LABEL_PATTERN.lastIndex = 0;
    for (let match = LABEL_PATTERN.exec(text); match !== null; match = LABEL_PATTERN.exec(text)) {
        const label = match[1];
        if (label === undefined)
            continue;
        if (best === undefined || match.index + match[0].length > best.index + best.length) {
            best = { signal: { kind: 'label', label }, index: match.index, length: match[0].length, text: match[0] };
        }
    }
    RUNTIME_PATTERN.lastIndex = 0;
    for (let match = RUNTIME_PATTERN.exec(text); match !== null; match = RUNTIME_PATTERN.exec(text)) {
        const captured = match[1];
        if (captured === undefined)
            continue;
        const ids = captured.split(',').map(part => Number(part));
        if (!ids.every(id => Number.isSafeInteger(id) && id >= -2147483648 && id <= 2147483647))
            continue;
        if (best === undefined || match.index + match[0].length > best.index + best.length) {
            best = { signal: { kind: 'runtime', runtimeId: ids }, index: match.index, length: match[0].length, text: match[0] };
        }
    }
    return best;
}
