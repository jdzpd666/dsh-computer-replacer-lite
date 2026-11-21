import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalGate, DEFAULT_APPROVAL_TIMEOUT_MS } from '../../dist/approval/gate.js';

const input = (extra = {}) => ({ toolName: 'replacer_click_by_id', agent: { id: 'a' }, callId: 'c1', reason: 'click r:[1,2]', displayReason: { en: 'en', zh: 'zh' }, ...extra });
const answerer = (outcome) => { const seen = []; return { seen, request: async (request) => { seen.push(request); return outcome; } }; };

test('a grant is the only outcome that allows injection', async () => {
  const answer = answerer('allowed-once');
  const gate = new ApprovalGate({ approval: answer });
  const decision = await gate.ask(input());
  assert.equal(decision.allowed, true);
  assert.equal(decision.outcome, 'allowed-once');
  assert.equal(decision.code, undefined);
  assert.equal(answer.seen.length, 1);
  assert.equal(answer.seen[0].displayReason.zh, 'zh');
  assert.equal(answer.seen[0].callId, 'c1');
  assert.ok(answer.seen[0].signal instanceof AbortSignal);
  const [entry] = gate.recent(1);
  assert.equal(entry.outcome, 'allowed-once');
  assert.equal(entry.toolName, 'replacer_click_by_id');
});

test('every non-grant path refuses and stays auditable', async () => {
  const cases = [
    ['rejected', 'rejected', 'REJECTED'],
    ['cancelled', 'cancelled', 'CANCELLED'],
    ['unavailable', 'unavailable', 'APPROVAL_UNAVAILABLE'],
    ['nonsense', 'unavailable', 'APPROVAL_UNAVAILABLE'],
  ];
  for (const [answer, outcome, code] of cases) {
    const gate = new ApprovalGate({ approval: answerer(answer) });
    const decision = await gate.ask(input());
    assert.equal(decision.allowed, false, answer);
    assert.equal(decision.outcome, outcome, answer);
    assert.equal(decision.code, code, answer);
    assert.equal(gate.recent(1)[0].outcome, outcome);
  }
});

test('a missing channel, missing agent or throwing answerer fails closed', async () => {
  assert.equal((await new ApprovalGate().ask(input())).code, 'APPROVAL_UNAVAILABLE');
  assert.equal((await new ApprovalGate({ approval: answerer('allowed-once') }).ask(input({ agent: undefined }))).code, 'APPROVAL_UNAVAILABLE');
  const failing = new ApprovalGate({ approval: { request: async () => { throw new Error('no open turn'); } } });
  const decision = await failing.ask(input());
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'APPROVAL_UNAVAILABLE');
});

test('a deadline refuses even when the answerer grants late', async () => {
  let release;
  const gate = new ApprovalGate({ approval: { request: () => new Promise((resolve) => { release = resolve; }) }, timeoutMs: 25 });
  const pending = gate.ask(input());
  await new Promise((resolve) => setTimeout(resolve, 60));
  release('allowed-once');
  const decision = await pending;
  assert.equal(decision.allowed, false);
  assert.equal(decision.outcome, 'timeout');
  assert.equal(decision.code, 'TIMEOUT');
  assert.ok(decision.waitedMs >= 20);
});

test('an aborted turn reports cancellation', async () => {
  const controller = new AbortController();
  const gate = new ApprovalGate({ approval: { request: ({ signal }) => new Promise((resolve) => { signal.addEventListener('abort', () => resolve('cancelled'), { once: true }); }) } });
  const pending = gate.ask(input({ signal: controller.signal }));
  controller.abort();
  const decision = await pending;
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'CANCELLED');
});

test('the explicit test switch settles as bypassed and stays auditable', async () => {
  const answer = answerer('rejected');
  const gate = new ApprovalGate({ approval: answer, bypass: true });
  assert.equal(gate.bypassed, true);
  const decision = await gate.ask(input());
  assert.equal(decision.allowed, true);
  assert.equal(decision.outcome, 'bypassed');
  assert.equal(decision.code, undefined);
  assert.equal(answer.seen.length, 0, 'a bypassed ask must not reach the approval channel');
  assert.equal(gate.recent(1)[0].outcome, 'bypassed');
  assert.equal(new ApprovalGate().bypassed, false);
});

test('the environment switch is read at construction and defaults off', async () => {
  delete process.env.REPLACER_BYPASS_APPROVAL;
  assert.equal(new ApprovalGate().bypassed, false);
  process.env.REPLACER_BYPASS_APPROVAL = '1';
  assert.equal(new ApprovalGate().bypassed, false, 'only the exact string true enables it');
  process.env.REPLACER_BYPASS_APPROVAL = 'true';
  try { assert.equal(new ApprovalGate().bypassed, true); } finally { delete process.env.REPLACER_BYPASS_APPROVAL; }
});

test('the audit trail is bounded and newest-first', async () => {
  const gate = new ApprovalGate({ approval: answerer('rejected') });
  for (let index = 0; index < 40; index += 1) await gate.ask(input());
  const entries = gate.recent(100);
  assert.equal(entries.length, 32);
  assert.equal(DEFAULT_APPROVAL_TIMEOUT_MS, 30_000);
});
