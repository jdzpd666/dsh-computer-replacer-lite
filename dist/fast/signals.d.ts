export type FastSignal = {
    kind: 'label';
    label: string;
} | {
    kind: 'runtime';
    runtimeId: number[];
};
export interface FastSignalMatch {
    signal: FastSignal;
    index: number;
    length: number;
    text: string;
}
/**
 * Finds the last complete fast signal in the accumulated assistant text.
 *
 * The model may emit either <C:EXACT_LABEL> or <I:r:[a,b,...]>; the last one
 * wins so an earlier half-written or superseded signal never fires.
 */
export declare function findSignal(text: string): FastSignalMatch | undefined;
