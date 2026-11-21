import assert from 'node:assert/strict';
import test from 'node:test';

import { PolicyGate, levelOfPreset } from '../../dist/policy/gate.js';

const logger = () => {};

function services(state) {
  return {
    permissionPresets: { current: () => state.preset },
    sandboxPolicy: { resolve: () => ({ mode: state.sandbox }) },
    ...(state.approval === undefined ? {} : { approval: { effectivePolicy: () => state.approval } }),
  };
}

const session = { id: 'session-a' };

// The preset name is a label only: both the preset selector and the live
// knobs resolve through the same (sandbox, approval) mapping.
test('preset names and live knobs share one level mapping', () => {
  assert.equal(levelOfPreset('danger-full-access', 'never'), 'FullAccess');
  assert.equal(levelOfPreset('workspace-write', 'never'), 'Never');
  assert.equal(levelOfPreset('workspace-write', 'ask'), 'WorkspaceWrite');
  assert.equal(levelOfPreset('danger-full-access', 'ask'), 'Unknown');
  assert.equal(levelOfPreset('read-only', 'ask'), 'Unknown');
});

test('full access allows without a card and logs enabled then allow', () => {
  const state = { preset: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never' };
  const gate = new PolicyGate({ services: services(state), logger });
  const first = gate.check({ session, tool: 'replacer_click_by_id', summary: 'click 确定 in hwnd=1' });
  assert.equal(first.allow, true);
  assert.equal(first.bypassed, true);
  assert.equal(first.expected, 'FullAccess');
  assert.equal(first.observed, 'FullAccess');
  assert.equal(first.anomaly, false);
  const second = gate.check({ session, tool: 'replacer_click_xy', summary: 'click 10,20' });
  assert.equal(second.allow, true);
  assert.deepEqual(gate.recent().map(entry => entry.kind), ['enabled', 'allow']);
});

test('a policy change clears the grant and restores the approval path', () => {
  const state = { preset: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never' };
  const gate = new PolicyGate({ services: services(state), logger });
  assert.equal(gate.check({ session, tool: 'replacer_click_by_id' }).allow, true);
  state.preset = 'workspace-write-ask';
  state.sandbox = 'workspace-write';
  state.approval = 'ask';
  const switched = gate.check({ session, tool: 'replacer_click_by_id' });
  assert.equal(switched.allow, false);
  assert.equal(switched.expected, 'WorkspaceWrite');
  assert.equal(switched.observed, 'WorkspaceWrite');
  const invalidation = gate.recent().find(entry => entry.kind === 'invalidated');
  assert.ok(invalidation !== undefined);
  assert.equal(invalidation.previous.expected, 'FullAccess');
  assert.equal(invalidation.previous.generation.length, 16);
  assert.match(invalidation.reason ?? '', /PolicyGate 失效/);
});

test('expected FullAccess with observed Never is a logged anomaly, never an allow', () => {
  const state = { preset: 'danger-full-access', sandbox: 'workspace-write', approval: 'never' };
  const gate = new PolicyGate({ services: services(state), logger });
  const decision = gate.check({ session, tool: 'replacer_click_by_id' });
  assert.equal(decision.allow, false);
  assert.equal(decision.expected, 'FullAccess');
  assert.equal(decision.observed, 'Never');
  assert.equal(decision.anomaly, true);
  assert.match(decision.reason, /策略接口返回与预期不符：expected=FullAccess, observed=Never/);
  assert.ok(gate.recent().some(entry => entry.kind === 'anomaly'));
});

test('a missing approval service is Unknown and fails closed', () => {
  const state = { preset: 'danger-full-access', sandbox: 'danger-full-access', approval: undefined };
  const gate = new PolicyGate({ services: services(state), logger });
  const decision = gate.check({ session, tool: 'replacer_click_by_id' });
  assert.equal(decision.allow, false);
  assert.equal(decision.observed, 'Unknown');
  assert.equal(decision.anomaly, true);
});

test('approval never without full access is denied with a normal log', () => {
  const state = { preset: 'workspace-write-never', sandbox: 'workspace-write', approval: 'never' };
  const gate = new PolicyGate({ services: services(state), logger });
  const decision = gate.check({ session, tool: 'replacer_click_by_id' });
  assert.equal(decision.allow, false);
  assert.equal(decision.expected, 'Never');
  assert.equal(decision.observed, 'Never');
  assert.equal(decision.anomaly, false);
  assert.match(decision.reason, /policy is Never/);
});

test('a custom never policy reports expected and observed as Never', () => {
  const state = { preset: 'custom', sandbox: 'workspace-write', approval: 'never' };
  const gate = new PolicyGate({ services: services(state), logger });
  const decision = gate.check({ session, tool: 'replacer_click_by_id' });
  assert.equal(decision.allow, false);
  assert.equal(decision.expected, 'Never');
  assert.equal(decision.observed, 'Never');
  assert.equal(decision.anomaly, false);
  assert.match(decision.reason, /用户切换至 never，正常拒绝/);
});

test('a new gate does not inherit a grant from a previous gate', () => {
  const state = { preset: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never' };
  const first = new PolicyGate({ services: services(state), logger });
  assert.equal(first.check({ session, tool: 'replacer_click_by_id' }).allow, true);
  const second = new PolicyGate({ services: services(state), logger });
  const decision = second.check({ session, tool: 'replacer_click_by_id' });
  assert.equal(decision.allow, true);
  assert.deepEqual(second.recent().map(entry => entry.kind), ['enabled']);
});

test('a call without a session identity cannot be allowed', () => {
  const state = { preset: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never' };
  const gate = new PolicyGate({ services: services(state), logger });
  const decision = gate.check({ tool: 'replacer_click_by_id' });
  assert.equal(decision.allow, false);
  assert.equal(decision.expected, 'Unknown');
  assert.match(decision.reason, /no session identity/);
});

test('inspect reports the live state without granting anything', () => {
  const state = { preset: 'workspace-write-ask', sandbox: 'workspace-write', approval: 'ask' };
  const gate = new PolicyGate({ services: services(state), logger });
  const view = gate.inspect(session);
  assert.equal(view.summary.expected, 'WorkspaceWrite');
  assert.equal(view.summary.cacheValid, false);
  state.preset = 'danger-full-access';
  state.sandbox = 'danger-full-access';
  state.approval = 'never';
  const refreshed = gate.inspect(session);
  assert.equal(refreshed.summary.expected, 'FullAccess');
  assert.equal(refreshed.summary.cacheValid, false);
  assert.ok(refreshed.audit.some(entry => entry.kind === 'invalidated'));
});

test('recorded results are visible in the allow audit', () => {
  const state = { preset: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never' };
  const gate = new PolicyGate({ services: services(state), logger });
  const decision = gate.check({ session, tool: 'replacer_click_by_id' });
  gate.recordResult(decision, true);
  gate.recordResult(decision, false, 'STALE_STATE');
  const kinds = gate.recent().map(entry => entry.kind);
  assert.deepEqual(kinds, ['enabled', 'result', 'result']);
  assert.match(gate.recent().at(-1).reason, /STALE_STATE/);
});

test('audit summaries are flattened and truncated', () => {
  const state = { preset: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never' };
  const gate = new PolicyGate({ services: services(state), logger });
  const decision = gate.check({ session, tool: 'replacer_type', summary: 'line one\nline two ' + 'x'.repeat(500) });
  const allow = gate.recent().find(entry => entry.kind === 'enabled');
  assert.ok(allow !== undefined);
  assert.equal(allow.summary.includes('\n'), false);
  assert.ok(allow.summary.length <= 200);
  assert.equal(decision.allow, true);
});
