import { findSignal } from './signals.js';
function short(text, limit = 80) {
    return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
}
async function handleSignal(match, target, sessionId, deps, agent) {
    const resolved = await deps.resolve(match.signal, target.hwnd, sessionId);
    if (!('runtimeId' in resolved)) {
        deps.log('fast resolve failed: ' + resolved.error + ': ' + resolved.message);
        return { truncate: false, note: '' };
    }
    if (!resolved.invokable) {
        deps.log('fast target is not invokable: ' + short(resolved.label));
        return { truncate: false, note: '' };
    }
    const label = short(resolved.label || JSON.stringify(resolved.runtimeId), 60);
    let decision;
    try {
        decision = await deps.approve({
            toolName: 'replacer_fast_click',
            reason: 'fast signal ' + match.text + ' -> ' + label + ' in hwnd=' + target.hwnd,
            displayReason: {
                en: 'Fast click ' + label + ' in window hwnd=' + target.hwnd + '. The element is invoked through UIA and the pointer does not move. Approve to run it now; rejecting performs zero input.',
                zh: '极速点击「' + label + '」（hwnd=' + target.hwnd + '）。通过 UIA Invoke 直接触发，不移动鼠标；批准后立即执行，拒绝则零输入。',
            },
            agent,
        });
    }
    catch (error) {
        deps.log('fast approval failed: ' + (error instanceof Error ? error.message : String(error)));
        return { truncate: false, note: '' };
    }
    if (decision.outcome === 'unavailable') {
        deps.log('fast approval unavailable; the normal stream continues');
        return { truncate: false, note: '' };
    }
    if (!decision.allowed) {
        return {
            truncate: true,
            note: '[fast-click] 未执行「' + label + '」hwnd=' + target.hwnd + ' · ' + (decision.code ?? decision.outcome) + ' · zero input',
        };
    }
    try {
        const outcome = await deps.click(target.hwnd, resolved.runtimeId);
        return {
            truncate: true,
            note: outcome.ok
                ? '[fast-click] 已执行「' + label + '」hwnd=' + target.hwnd + ' · ' + (outcome.method ?? 'l1_invoke') + ' · approval ' + decision.outcome + ' in ' + decision.waitedMs + 'ms' + ' · 窗口' + (outcome.windowAlive === false ? '已关闭' : outcome.windowAlive === true ? '仍打开' : '状态未知')
                : '[fast-click] 未执行「' + label + '」hwnd=' + target.hwnd + ' · ' + (outcome.code ?? 'FAILED') + ' · zero input',
        };
    }
    catch (error) {
        return {
            truncate: true,
            note: '[fast-click] 执行结果未知 · ' + (error instanceof Error ? error.message : String(error)),
        };
    }
}
async function* closeAndFinish(open, maxIndex, note) {
    let textIndex;
    for (const [index, block] of open) {
        if (block.type === 'text') {
            textIndex = index;
            break;
        }
    }
    if (textIndex === undefined) {
        const index = maxIndex + 1;
        yield { type: 'block-start', index, blockType: 'text' };
        yield { type: 'text-delta', index, text: note };
        yield { type: 'block-end', index, block: { type: 'text', text: note } };
    }
    else {
        const block = open.get(textIndex);
        if (block !== undefined) {
            block.text += note;
            yield { type: 'text-delta', index: textIndex, text: note };
        }
    }
    for (const [index, block] of open) {
        yield { type: 'block-end', index, block: { type: block.type, text: block.text } };
    }
    yield { type: 'finish', reason: { kind: 'stop' } };
}
async function* intercept(stream, sessionId, target, deps, agent) {
    const open = new Map();
    const text = [];
    let maxIndex = -1;
    let sawText = false;
    let sawToolCall = false;
    let handled = false;
    for await (const chunk of stream) {
        yield chunk;
        if (chunk.type === 'block-start') {
            const index = typeof chunk.index === 'number' ? chunk.index : maxIndex + 1;
            maxIndex = Math.max(maxIndex, index);
            const blockType = chunk.blockType;
            if (blockType === 'text' || blockType === 'reasoning')
                open.set(index, { type: blockType, text: '' });
            else
                sawToolCall = true;
            continue;
        }
        if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
            const index = typeof chunk.index === 'number' ? chunk.index : -1;
            const block = open.get(index);
            if (block !== undefined && typeof chunk.text === 'string')
                block.text += chunk.text;
            if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
                text.push(chunk.text);
                sawText = true;
            }
            if (sawText && !sawToolCall && !handled) {
                const match = findSignal(text.join(''));
                if (match !== undefined) {
                    const result = await handleSignal(match, target, sessionId, deps, agent);
                    if (result.truncate) {
                        yield* closeAndFinish(open, maxIndex, result.note);
                        return;
                    }
                    handled = true;
                }
            }
            continue;
        }
        if (chunk.type === 'tool-call-delta') {
            sawToolCall = true;
            continue;
        }
        if (chunk.type === 'block-end') {
            const index = typeof chunk.index === 'number' ? chunk.index : -1;
            open.delete(index);
            continue;
        }
        if (chunk.type === 'finish')
            return;
    }
}
/**
 * Wraps one llm/stream call. If the session has a cached observation and a
 * signal appears in the assistant text, the harness stops consuming the model
 * stream, asks for approval, invokes the element and synthesizes a stop finish.
 * Anything unexpected falls back to the untouched stream.
 */
export function createFastListener(deps) {
    return (options, next) => {
        const stream = next();
        if (typeof options !== 'object' || options === null)
            return stream;
        const call = options;
        if (typeof call.sessionId !== 'string' || call.purpose !== undefined)
            return stream;
        const target = deps.targets.get(call.sessionId);
        if (target === undefined)
            return stream;
        const agent = deps.agent();
        if (agent === undefined || agent === null)
            return stream;
        deps.warm(call.sessionId, target.hwnd);
        return intercept(stream, call.sessionId, target, deps, agent);
    };
}
