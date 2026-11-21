export declare const BROKER_PIPE = "\\\\.\\pipe\\replacer_elevated";
/** Frames can carry a whole window tree; the broker enforces the same ceiling. */
export declare const MAX_BROKER_FRAME_BYTES: number;
export declare class BrokerError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export interface BrokerReply {
    ok: boolean;
    code?: string;
    message?: string;
    [key: string]: unknown;
}
export interface BrokerCallOptions {
    timeoutMs?: number;
}
/**
 * Send one request and resolve with the broker's reply object.
 *
 * Rejects with BrokerError on any transport failure and on a reply whose ok is not
 * true; a reply is never interpreted as success just because bytes arrived.
 */
export declare function callBroker(request: Record<string, unknown>, options?: BrokerCallOptions): Promise<BrokerReply>;
