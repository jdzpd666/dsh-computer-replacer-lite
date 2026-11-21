export interface FastBox { x: number; y: number; width: number; height: number; }

export interface FastElement {
  runtimeId: number[];
  label: string;
  type: number;
  bbox: FastBox;
  invokable: boolean;
  enabled: boolean;
  offscreen: boolean;
  observedAt: number;
  id?: string;
}

export interface FastTarget { hwnd: string; observedAt: number; elements: FastElement[]; }

const MAX_ELEMENTS = 20000;

function inBox(value: unknown): value is FastBox {
  if (typeof value !== 'object' || value === null) return false;
  const box = value as Record<string, unknown>;
  return ['x', 'y', 'width', 'height'].every(key => typeof box[key] === 'number' && Number.isFinite(box[key]));
}

/**
 * The most recent observation of one window per session, used by the stream
 * interceptor to resolve <C:label> / <I:r:[...]> without another round trip.
 * It is a cache only: every entry is refreshed by replacer_observe or by the
 * silent shadow observation that runs while the model is thinking.
 */
export class FastTargets {
  private readonly bySession = new Map<string, FastTarget>();

  record(sessionId: string | undefined, page: unknown): void {
    if (sessionId === undefined || typeof page !== 'object' || page === null) return;
    const candidate = page as { hwnd?: unknown; observedAt?: unknown; elements?: unknown };
    if (typeof candidate.hwnd !== 'string' || !Array.isArray(candidate.elements)) return;
    const observedAt = typeof candidate.observedAt === 'number' ? candidate.observedAt : Date.now();
    const previous = this.bySession.get(sessionId);
    if (previous !== undefined && previous.hwnd === candidate.hwnd && previous.observedAt > observedAt) return;
    const elements: FastElement[] = [];
    for (const raw of candidate.elements) {
      if (typeof raw !== 'object' || raw === null) continue;
      const element = raw as Record<string, unknown>;
      if (!Array.isArray(element.runtimeId) || element.runtimeId.length === 0 || element.runtimeId.length > 64) continue;
      if (!element.runtimeId.every(entry => typeof entry === 'number' && Number.isSafeInteger(entry))) continue;
      if (typeof element.label !== 'string' || element.label.length === 0) continue;
      if (!inBox(element.bbox)) continue;
      elements.push({
        runtimeId: [...(element.runtimeId as number[])],
        label: element.label,
        type: typeof element.type === 'number' ? element.type : 0,
        bbox: element.bbox,
        invokable: element.invokable === true,
        enabled: element.enabled !== false,
        offscreen: element.offscreen === true,
        observedAt,
        ...(typeof element.id === 'string' ? { id: element.id } : {}),
      });
      if (elements.length >= MAX_ELEMENTS) break;
    }
    this.bySession.set(sessionId, { hwnd: candidate.hwnd, observedAt, elements });
  }

  get(sessionId: string | undefined): FastTarget | undefined {
    return sessionId === undefined ? undefined : this.bySession.get(sessionId);
  }

  clear(): void { this.bySession.clear(); }
}
