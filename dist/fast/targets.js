const MAX_ELEMENTS = 20000;
function inBox(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const box = value;
    return ['x', 'y', 'width', 'height'].every(key => typeof box[key] === 'number' && Number.isFinite(box[key]));
}
/**
 * The most recent observation of one window per session, used by the stream
 * interceptor to resolve <C:label> / <I:r:[...]> without another round trip.
 * It is a cache only: every entry is refreshed by replacer_observe or by the
 * silent shadow observation that runs while the model is thinking.
 */
export class FastTargets {
    bySession = new Map();
    record(sessionId, page) {
        if (sessionId === undefined || typeof page !== 'object' || page === null)
            return;
        const candidate = page;
        if (typeof candidate.hwnd !== 'string' || !Array.isArray(candidate.elements))
            return;
        const observedAt = typeof candidate.observedAt === 'number' ? candidate.observedAt : Date.now();
        const previous = this.bySession.get(sessionId);
        if (previous !== undefined && previous.hwnd === candidate.hwnd && previous.observedAt > observedAt)
            return;
        const elements = [];
        for (const raw of candidate.elements) {
            if (typeof raw !== 'object' || raw === null)
                continue;
            const element = raw;
            if (!Array.isArray(element.runtimeId) || element.runtimeId.length === 0 || element.runtimeId.length > 64)
                continue;
            if (!element.runtimeId.every(entry => typeof entry === 'number' && Number.isSafeInteger(entry)))
                continue;
            if (typeof element.label !== 'string' || element.label.length === 0)
                continue;
            if (!inBox(element.bbox))
                continue;
            elements.push({
                runtimeId: [...element.runtimeId],
                label: element.label,
                type: typeof element.type === 'number' ? element.type : 0,
                bbox: element.bbox,
                invokable: element.invokable === true,
                enabled: element.enabled !== false,
                offscreen: element.offscreen === true,
                observedAt,
                ...(typeof element.id === 'string' ? { id: element.id } : {}),
            });
            if (elements.length >= MAX_ELEMENTS)
                break;
        }
        this.bySession.set(sessionId, { hwnd: candidate.hwnd, observedAt, elements });
    }
    get(sessionId) {
        return sessionId === undefined ? undefined : this.bySession.get(sessionId);
    }
    clear() { this.bySession.clear(); }
}
