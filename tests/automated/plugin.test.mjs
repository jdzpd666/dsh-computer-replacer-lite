import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, SCHEMAS, TOOL_NAMES } from '../../dist/index.js';
import { sharedPanicLatch } from '../../dist/panic-gate.js';

const context = (register = () => () => {}) => ({ tools: { view: () => ({ knownNames: new Set() }), register }, on: () => {} });

test('plugin registers every truthful tool and unloads', async () => {
  const definitions = new Map(); let dispose;
  apply({ ...context((definition) => { definitions.set(definition.name, definition); return () => definitions.delete(definition.name); }), on: (event, callback) => { if (event === 'dispose') dispose = callback; } });
  try {
    assert.deepEqual([...definitions.keys()], TOOL_NAMES);
    for (const [name, definition] of definitions) {
      const result = await definition.execute({});
      assert.equal(result.inputImplemented, true);
      assert.equal(result.l3Enabled, false);
      if (name === 'replacer_status') { assert.equal(result.ok, true); assert.deepEqual(result.approvals, []); continue; }
      // Windows takes no arguments: it either answers from a live worker or reports no worker yet.
      if (name === 'replacer_windows') { assert.ok(result.ok || ['WORKER_UNAVAILABLE', 'TIMEOUT'].includes(result.code), result.code); continue; }
      // read_screen takes no required arguments either (full screen by default): the
      // call reaches the approval/policy layer instead of failing normalization. It is
      // read-only, so its failure modes exclude injection semantics entirely.
      if (name === 'replacer_read_screen') {
        assert.equal(result.ok, false);
        assert.ok(['APPROVAL_UNAVAILABLE', 'WORKER_UNAVAILABLE', 'TIMEOUT', 'VISION_UNAVAILABLE', 'VISION_TIMEOUT'].includes(result.code), result.code);
        continue;
      }
      assert.equal(result.ok, false);
      assert.equal(result.code, 'INVALID_ARGUMENT');
    }
  } finally { await dispose(); }
  assert.equal(definitions.size, 0);
});

test('a click with valid arguments needs a live worker before any approval is shown', async () => {
  const definitions = new Map(); let dispose; const asked = [];
  apply({ ...context((definition) => { definitions.set(definition.name, definition); return () => definitions.delete(definition.name); }), get: () => ({ request: async () => { asked.push(1); return 'allowed-once'; } }), on: (_event, callback) => { dispose = callback; } });
  try {
    const result = await definitions.get('replacer_click_by_id').execute({ hwnd: '1234', elementId: 'r:[1,2]' }, { agent: { id: 'a' }, callId: 'c' });
    assert.equal(result.ok, false);
    // Absent worker or an unknown target both stop before any card is shown.
    assert.ok(['WORKER_UNAVAILABLE', 'STALE_STATE'].includes(result.code), result.code);
    assert.equal(result.approval, undefined);
    assert.equal(asked.length, 0);
  } finally { await dispose(); }
});

test('type, scroll and key validate before any approval card', async () => {
  const definitions = new Map(); let dispose; const asked = [];
  apply({ ...context((definition) => { definitions.set(definition.name, definition); return () => definitions.delete(definition.name); }), get: () => ({ request: async () => { asked.push(1); return 'allowed-once'; } }), on: (_event, callback) => { dispose = callback; } });
  try {
    for (const [name, args] of [
      ['replacer_type', {}],
      ['replacer_type', { hwnd: '1234', elementId: 'r:[1,2]', text: '' }],
      ['replacer_scroll', { hwnd: '1234', elementId: 'r:[1,2]' }],
      ['replacer_scroll', { hwnd: '1234', elementId: 'r:[1,2]', vertical: 'sideways' }],
      ['replacer_scroll', { hwnd: '1234', elementId: 'r:[1,2]', vertical: 'down', steps: 11 }],
      ['replacer_key', {}],
      ['replacer_key', { hwnd: '1234' }],
      ['replacer_key', { hwnd: '1234', combo: 'ctrl + s' }],
      ['replacer_key', { hwnd: '1234', combo: 'ctrl+foo' }],
      ['replacer_key', { hwnd: '1234', combo: 'alt+ctrl+shift+enter' }],
    ]) {
      const result = await definitions.get(name).execute(args, { agent: { id: 'a' }, callId: 'c' });
      assert.equal(result.ok, false, name);
      assert.equal(result.code, 'INVALID_ARGUMENT', name);
      assert.equal(result.approval, undefined, name);
    }
    const key = await definitions.get('replacer_key').execute({ hwnd: '1234', combo: 'ctrl+s,v' }, { agent: { id: 'a' }, callId: 'c' });
    assert.equal(key.ok, false);
    assert.equal(key.code, 'INVALID_ARGUMENT');
    assert.match(key.message, /combo/);
    assert.equal(asked.length, 0);
  } finally { await dispose(); }
});

test('collision preflight fails before any registration', () => {
  let calls = 0;
  assert.throws(() => apply({ tools: { view: () => ({ knownNames: new Set(['replacer_key']) }), register: () => { calls += 1; } }, on: () => {} }), /TOOL_NAME_COLLISION/);
  assert.equal(calls, 0);
});

test('B-3 read_screen is registered with its own parameter and output schemas (14-tool build)', () => {
  assert.ok(TOOL_NAMES.includes('replacer_read_screen'), 'replacer_read_screen must be registered');
  assert.equal(TOOL_NAMES.length, 14);
  assert.ok(SCHEMAS.readScreenParameters, 'readScreenParameters exported for the schema-check harness');
  assert.ok(SCHEMAS.readScreenSchema, 'readScreenSchema exported for the schema-check harness');
  const region = SCHEMAS.readScreenParameters.properties.region;
  assert.deepEqual(region.required, ['x', 'y', 'width', 'height']);
  assert.match(String(region.properties.x.description), /physical pixels/);
  assert.ok(!SCHEMAS.readScreenParameters.required, 'region is optional: full screen is the default');
});

test('B-4 replacer_locate is registered as the 14th tool with its own parameter and output schemas', () => {
  assert.ok(TOOL_NAMES.includes('replacer_locate'), 'replacer_locate must be registered');
  assert.equal(TOOL_NAMES.indexOf('replacer_locate'), TOOL_NAMES.indexOf('replacer_read_screen') + 1, 'locate sits right after read_screen');
  assert.ok(SCHEMAS.locateParameters, 'locateParameters exported for the schema-check harness');
  assert.ok(SCHEMAS.locateSchema, 'locateSchema exported for the schema-check harness');
  assert.deepEqual(SCHEMAS.locateParameters.required, ['hwnd']);
  assert.equal(SCHEMAS.locateParameters.additionalProperties, true, 'forward-compatible like worker-facing shapes');
  assert.match(String(SCHEMAS.locateParameters.properties.maxResults.description), /1\.\.50/);
  assert.match(String(SCHEMAS.locateParameters.properties.minScore.description), /0\.5/);
  assert.equal(SCHEMAS.locateSchema.properties.channel.enum.join(','), 'fusion,uia_only');
  assert.equal(SCHEMAS.locateSchema.properties.matches.type, 'array');
  assert.equal(SCHEMAS.locateSchema.properties.capabilities.properties.capture.type, 'boolean');
  assert.equal(SCHEMAS.outputSchema.properties.locate, SCHEMAS.locateSchema, 'outputSchema models locate');
});

test('registration failure rolls back partial tools', () => {
  let active = 0, count = 0;
  assert.throws(() => apply(context(() => { if (++count === 3) throw new Error('registry failure'); active += 1; return () => { active -= 1; }; })), /registry failure/);
  assert.equal(active, 0);
});

test('B-4 locate shows an independent read-only card every call; rejection requests zero locate work', async () => {
  const definitions = new Map(); let dispose; const asked = [];
  apply({
    ...context((definition) => { definitions.set(definition.name, definition); return () => definitions.delete(definition.name); }),
    get: () => ({ request: async (request) => { asked.push(request); return 'rejected'; } }),
    on: (_event, callback) => { dispose = callback; },
  });
  try {
    const first = await definitions.get('replacer_locate').execute({ hwnd: '1234', query: '保存' }, { agent: { id: 'a' }, callId: 'c' });
    assert.equal(first.ok, false);
    assert.equal(first.code, 'REJECTED');
    assert.equal(first.locate, undefined, 'no locate result may exist when the card was rejected');
    assert.equal(first.approval.outcome, 'rejected');
    assert.equal(asked.length, 1);
    const card = asked[0];
    assert.equal(card.toolName, 'replacer_locate');
    assert.equal(card.callId, 'c');
    assert.ok(card.agent, 'the agent routes the card to its session');
    assert.match(card.reason, /read-only/);
    assert.match(card.displayReason.zh, /无鼠标键盘注入/);
    assert.match(card.displayReason.zh, /敏感内容/);
    assert.match(card.displayReason.zh, /另一次审批/);
    assert.match(card.displayReason.en, /not a click/);
    assert.match(card.displayReason.en, /zero image bytes/);
    // Every call asks again: the approval is one-shot, never cached.
    const second = await definitions.get('replacer_locate').execute({ hwnd: '1234' }, { agent: { id: 'a' }, callId: 'c-2' });
    assert.equal(second.code, 'REJECTED');
    assert.equal(asked.length, 2);
  } finally { await dispose(); }
});

test('B-4 locate stays available while the panic latch is tripped (read-only precedent)', async () => {
  const definitions = new Map(); let dispose;
  apply({
    ...context((definition) => { definitions.set(definition.name, definition); return () => definitions.delete(definition.name); }),
    get: () => ({ request: async () => 'rejected' }),
    on: (_event, callback) => { dispose = callback; },
  });
  const latch = sharedPanicLatch();
  try {
    await latch.trip('button');
    assert.equal(latch.latchedNow, true, 'the emergency stop is armed');
    // Control: a gated write path refuses before any worker dependency.
    const write = await definitions.get('replacer_click_by_id').execute({ hwnd: '1234', elementId: 'r:[1,2]' }, { agent: { id: 'a' }, callId: 'c' });
    assert.equal(write.code, 'PANIC_ABORTED');
    assert.equal(write.approval, undefined);
    // read-only locate is not panic-gated: the latch cuts injection, not perception.
    const read = await definitions.get('replacer_locate').execute({ hwnd: '1234' }, { agent: { id: 'a' }, callId: 'c' });
    assert.notEqual(read.code, 'PANIC_ABORTED');
    assert.equal(read.locate, undefined, 'nothing was captured without an approval');
  } finally {
    await latch.recover();
    await dispose();
  }
});
