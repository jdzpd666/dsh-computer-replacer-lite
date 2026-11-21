export interface FastBox {
    x: number;
    y: number;
    width: number;
    height: number;
}
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
export interface FastTarget {
    hwnd: string;
    observedAt: number;
    elements: FastElement[];
}
/**
 * The most recent observation of one window per session, used by the stream
 * interceptor to resolve <C:label> / <I:r:[...]> without another round trip.
 * It is a cache only: every entry is refreshed by replacer_observe or by the
 * silent shadow observation that runs while the model is thinking.
 */
export declare class FastTargets {
    private readonly bySession;
    record(sessionId: string | undefined, page: unknown): void;
    get(sessionId: string | undefined): FastTarget | undefined;
    clear(): void;
}
