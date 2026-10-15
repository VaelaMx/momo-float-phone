/* Actual consumer+journal regression tests. Fixture-only: no user DB/network.
 * Run from any directory: node scripts/check-push-outbox-delivery.cjs
 * Parser's deterministic writes/IDB helper are boundary mocks; their actual
 * implementations have a separate parser/storage regression suite. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const fixtureEntry = (id, meta = {}, sessionId = 's1') => ({
  id, session_id: sessionId, trigger_key: 'reused-trigger',
  raw_text: `original ${id}`, meta, created_at: '2026-10-15T11:00:00.000Z',
});
function harness(options = {}) {
  const state = {
    cloud: 'https://fixture-a.invalid', active: true, hydrated: true, kvHydrated: true,
    queue: [], chat: [], diskChat: new Map(), kv: new Map(), diskKv: new Map(),
    sessions: [{ id: 's1' }], ackFails: 0, chatFails: 0, kvFails: 0,
    parseFailsAfterFirstPart: false, readFails: false, readGate: null,
    events: [], reads: 0, acks: [], parses: [], flushes: 0, scheduled: null,
    timers: new Map(), nextTimer: 0, listeners: {}, ...options,
    requestTimers: new Map(), nextRequestTimer: 0,
  };
  const modules = new Map();
  const record = (...event) => state.events.push(event);
  const window = {
    location: { origin: 'https://phone.fixture.invalid' },
    dispatchEvent: event => record('event', event.type),
    addEventListener: (name, handler) => { state.listeners[name] = handler; },
    setTimeout: (fn, delay) => { const id = ++state.nextTimer; state.timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => state.timers.delete(id),
  };
  const document = { hidden: false, addEventListener: (name, handler) => { state.listeners[name] = handler; } };
  const deps = {
    './kv-db': {
      hydrateKvDb: async () => {}, isKvHydrated: () => state.kvHydrated,
      registerDynamicPrefix: prefix => record('register', prefix),
      kvGet: key => state.kv.get(key) ?? null,
      kvKeysWithPrefix: prefix => [...state.kv.keys()].filter(key => key.startsWith(prefix)),
      kvSetAsync: async (key, value) => {
        state.kv.set(key, value); // mirrors real helper's cache-before-IDB contract
        if (state.kvFails > 0) { state.kvFails--; throw new Error('kv_commit_failed'); }
        state.diskKv.set(key, value); record('journal-commit', JSON.parse(value).state);
        state.onJournalCommit?.(JSON.parse(value));
      },
    },
    './personal-push-cloud': {
      isPersonalPushCloudActive: () => state.active,
      loadPersonalPushCloudState: () => ({ url: state.cloud }),
      personalPushFetch: async (_action, init) => {
        if (init?.method === 'POST') {
          const ids = JSON.parse(init.body).ids;
          state.acks.push(ids); record('ack', ids);
          if (state.ackFails > 0) {
            state.ackFails--; return { ok: false, json: async () => ({ ok: false }) };
          }
          state.queue = state.queue.filter(entry => !ids.includes(entry.id));
          return { ok: true, json: async () => ({ ok: true }) };
        }
        state.reads++; record('read');
        if (state.readFails) throw new Error('read_failed');
        const snapshot = clone(state.queue.slice(0, 20));
        if (state.readGate) { const gate = state.readGate; state.readGate = null; await gate; }
        return { ok: true, json: async () => {
          if (state.stallReadBody) return new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('body_timeout')), { once: true });
          });
          return { ok: true, entries: snapshot };
        } };
      },
    },
    './chat-storage': {
      hydrateChatStorage: async () => {}, isChatStorageHydrated: () => state.hydrated,
      loadChatSessions: () => state.sessions,
      loadChatMessages: id => state.chat.filter(message => message.sessionId === id),
      reindexSessionMessageOrdersByTime: () => {},
      loadFollowUpSchedule: () => state.scheduled,
      clearFollowUpSchedule: () => { record('clear-followup'); state.scheduled = null; },
      persistChatMessagesByBatch: async (sessionId, batchId) => {
        state.flushes++; record('chat-flush');
        if (state.chatFails > 0) { state.chatFails--; throw new Error('chat_commit_failed'); }
        const messages = state.chat.filter(message => message.sessionId === sessionId && message.responseBatchId === batchId);
        for (const message of messages) state.diskChat.set(message.id, clone(message));
        record('chat-commit');
        return messages;
      },
    },
    './follow-up-service': {
      parseAndSaveResponse: async (text, sessionId, _count, followUpIndex, _context, opts) => {
        state.parses.push({ text, opts }); record('parse');
        const parts = text ? text.split('\n') : [];
        for (let i = 0; i < parts.length; i++) {
          const id = `${opts.messageIdPrefix}:part_${i}`;
          if (!state.chat.some(message => message.id === id)) state.chat.push({
            id, sessionId, role: 'assistant', content: parts[i], followUpIndex,
            responseBatchId: opts.responseBatchId, createdAt: opts.createdAt,
          });
          if (state.parseFailsAfterFirstPart) {
            state.parseFailsAfterFirstPart = false; throw new Error('parser_interrupted');
          }
        }
        return { hasVisible: Boolean(parts.length), newCount: 10, stateValues: [] };
      },
      scheduleFollowUp: () => record('schedule-followup'),
    },
    './llm-prompt-assembler': { applyOutputRegex: text => text },
    './llm-provider-adapter': { stripHallucinatedTimestamps: text => text },
    './macro-engine': { MacroEngine: class {} },
    './content-tag-utils': { getActiveAppTags: () => [] },
    './timed-wake-storage': { removeTimedWakeSchedule: id => record('clear-timed', id) },
    './reality-bridge/storage': { loadBridgeFeed: () => [], appendBridgeFeed: () => record('bridge-feed'), saveScreenChatAck: () => record('screen-ack') },
    './reality-bridge/engine': { applyServerBridgeEntry: async () => ({ sessionId: 's1' }) },
    './menstrual-storage': { hasMenstrualPeriodCareTriggered: () => state.events.some(event => event[0] === 'period-care'), saveMenstrualPeriodCareTrigger: () => record('period-care') },
    './idle-reconnect-storage': { markIdleReconnectFired: () => record('idle-reconnect') },
  };
  function load(name) {
    if (deps[name]) return deps[name];
    if (modules.has(name)) return modules.get(name).exports;
    if (!['./push-outbox-client', './push-outbox-journal'].includes(name)) throw new Error(`Unexpected require ${name}`);
    const module = { exports: {} }; modules.set(name, module);
    const sourceFile = path.join(root, 'lib', `${name.slice(2)}.ts`);
    const source = fs.readFileSync(sourceFile, 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText;
    vm.runInNewContext(code, {
      module, exports: module.exports, require: load, window, document, Event,
      navigator: { serviceWorker: { addEventListener: (_name, fn) => { state.listeners.sw = fn; } } },
      AbortController,
      setTimeout: (fn, delay) => { const id = ++state.nextRequestTimer; state.requestTimers.set(id, { fn, delay }); return id; },
      clearTimeout: id => state.requestTimers.delete(id), console: { warn() {} },
      fetch: () => { throw new Error('External network forbidden'); },
    }, { filename: sourceFile });
    return module.exports;
  }
  return { state, client: load('./push-outbox-client'), journal: load('./push-outbox-journal'), document };
}
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
test('preserves notification despite unrelated assistant, reused round and trigger', async () => {
  const h = harness({ queue: [fixtureEntry('a', { armAt: '2026-10-01', followUpIndex: 1 }), fixtureEntry('b', { followUpIndex: 1 })],
    chat: [{ id: 'old', sessionId: 's1', role: 'assistant', followUpIndex: 1, createdAt: '2026-10-14' }] });
  assert.equal((await h.client.consumeServerOutbox({ force: true })).ok, true);
  assert.equal(h.state.parses.length, 2); assert.equal(h.state.queue.length, 0);
  assert.equal(h.state.diskChat.size, 2);
  assert.equal(h.state.parses[0].opts.rawResponseText, 'original a');
  assert.equal(h.state.parses[0].opts.createdAt, '2026-10-15T11:00:00.000Z');
});
test('durable raw then chat then receipt before ACK; compact only after ACK', async () => {
  const h = harness({ queue: [fixtureEntry('a')] });
  await h.client.consumeServerOutbox({ force: true });
  const events = h.state.events.map(event => event[0]);
  assert.ok(events.indexOf('journal-commit') < events.indexOf('parse'));
  assert.ok(events.indexOf('chat-commit') < events.indexOf('ack'));
  const record = [...h.state.diskKv.values()].map(JSON.parse)[0];
  assert.equal(record.state, 'completed'); assert.equal(record.entry, undefined);
  assert.equal(record.receipt.messageIds.length, 1);
});
test('failed journal cache write is not treated as durable and is retried', async () => {
  const h = harness({ queue: [fixtureEntry('a')], kvFails: 1 });
  assert.equal((await h.client.consumeServerOutbox({ force: true })).ok, false);
  assert.equal(h.state.acks.length, 0); assert.equal(h.state.parses.length, 0);
  assert.equal((await h.client.consumeServerOutbox({ force: true })).ok, true);
  assert.equal(h.state.diskChat.size, 1);
});
test('failed chat commit leaves raw pending; reload recovers original', async () => {
  const h = harness({ queue: [fixtureEntry('a')], chatFails: 1 });
  assert.equal((await h.client.consumeServerOutbox({ force: true })).ok, false);
  assert.equal(h.state.acks.length, 0);
  assert.equal(h.journal.listRecoverablePushOutboxEntries()[0].rawText, 'original a');
  h.state.chat = []; // emulate loss of uncommitted cache on reload
  assert.equal((await h.client.consumeServerOutbox({ force: true })).ok, true);
  assert.equal(h.state.diskChat.size, 1);
});
test('failed ACK retries real batch commit without duplicate parsing', async () => {
  const h = harness({ queue: [fixtureEntry('a')], ackFails: 1 });
  assert.equal((await h.client.consumeServerOutbox({ force: true })).ok, false);
  assert.equal(h.journal.listRecoverablePushOutboxEntries().length, 1);
  assert.equal((await h.client.consumeServerOutbox({ force: true })).ok, true);
  assert.equal(h.state.parses.length, 1); assert.equal(h.state.flushes, 2);
  assert.equal(h.state.chat.length, 1);
});
test('partial parser replay completes deterministic parts exactly once', async () => {
  const entry = fixtureEntry('a'); entry.raw_text = 'first\nsecond';
  const h = harness({ queue: [entry], parseFailsAfterFirstPart: true });
  assert.equal((await h.client.consumeServerOutbox({ force: true })).ok, false);
  assert.equal(h.state.chat.length, 1); assert.equal(h.state.acks.length, 0);
  assert.equal((await h.client.consumeServerOutbox({ force: true })).ok, true);
  assert.equal(h.state.chat.length, 2); assert.equal(h.state.diskChat.size, 2);
});
test('20 missing sessions archive safely and unblock valid next page; exact session can recover', async () => {
  const h = harness({ queue: [...Array.from({ length: 20 }, (_, i) => fixtureEntry(`missing-${i}`, {}, 'old-session')), fixtureEntry('valid')] });
  assert.equal((await h.client.consumeServerOutbox({ force: true })).ok, true);
  assert.equal(h.state.queue.length, 0); assert.equal(h.state.diskChat.size, 1);
  assert.equal(h.journal.listRecoverablePushOutboxEntries().length, 20);
  h.state.sessions.push({ id: 'old-session' });
  assert.equal((await h.client.consumeServerOutbox({ force: true })).ok, true);
  assert.equal(h.state.diskChat.size, 21);
  assert.equal(h.journal.listRecoverablePushOutboxEntries().length, 0);
});
test('hydrate failure never archives/ACKs and UI read never pretends empty', async () => {
  const h = harness({ queue: [fixtureEntry('a', {}, 'missing')], hydrated: false });
  assert.equal((await h.client.consumeServerOutbox({ force: true })).ok, false);
  assert.equal(h.state.acks.length, 0); assert.equal(h.state.diskKv.size, 0);
  h.state.kvHydrated = false;
  assert.throws(() => h.journal.listRecoverablePushOutboxEntries());
});
test('corrupt scoped journal is reported instead of ignored', async () => {
  const h = harness();
  const key = 'ai_phone_push_outbox_journal_v1:' + encodeURIComponent(h.state.cloud) + ':broken';
  h.state.kv.set(key, '{bad JSON');
  assert.throws(() => h.journal.listRecoverablePushOutboxEntries());
  assert.equal((await h.client.consumeServerOutbox({ force: true })).ok, false);
  assert.equal(h.state.acks.length, 0);
});
test('journal and success throttle isolate personal cloud projects', async () => {
  const h = harness({ queue: [fixtureEntry('orphan', {}, 'missing')] });
  await h.client.consumeServerOutbox({ force: true });
  assert.equal(h.journal.listRecoverablePushOutboxEntries().length, 1);
  const reads = h.state.reads;
  h.state.cloud = 'https://fixture-b.invalid';
  assert.equal(h.journal.listRecoverablePushOutboxEntries().length, 0);
  assert.equal((await h.client.consumeServerOutbox()).ok, true);
  assert.equal(h.state.reads, reads + 1);
});
test('forced request during in-flight GET performs trailing pass', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ readGate: gate });
  const first = h.client.consumeServerOutbox({ force: true });
  await tick();
  h.state.queue.push(fixtureEntry('just-arrived'));
  const second = h.client.consumeServerOutbox({ force: true });
  assert.equal(first, second);
  release();
  assert.equal((await first).ok, true); assert.equal(h.state.reads, 2);
  assert.equal(h.state.diskChat.size, 1);
});
test('failed sync remains failed under default throttle', async () => {
  const h = harness({ readFails: true });
  assert.equal((await h.client.consumeServerOutbox({ force: true })).ok, false);
  h.state.readFails = false;
  assert.equal((await h.client.consumeServerOutbox()).ok, false);
  assert.equal(h.state.reads, 1);
});
test('response-body deadline remains armed after headers arrive', async () => {
  const h = harness({ stallReadBody: true });
  const pending = h.client.consumeServerOutbox({ force: true });
  await tick();
  assert.equal(h.state.requestTimers.size, 1);
  const deadline = [...h.state.requestTimers.values()][0];
  assert.equal(deadline.delay, 30000);
  deadline.fn();
  assert.equal((await pending).ok, false);
  assert.equal(h.state.requestTimers.size, 0);
  assert.equal(h.state.acks.length, 0);
});
test('cloud changed during raw commit leaves original staged without parsing or ACK', async () => {
  const h = harness({ queue: [fixtureEntry('a')] });
  h.state.onJournalCommit = () => { h.state.cloud = 'https://fixture-b.invalid'; };
  assert.equal((await h.client.consumeServerOutbox({ force: true })).ok, false);
  assert.equal(h.state.diskKv.size, 1);
  assert.equal(h.state.parses.length, 0);
  assert.equal(h.state.acks.length, 0);
});
test('only matching follow-up schedule clears and metadata waits for commit', async () => {
  const h = harness({ scheduled: { sessionId: 's1', fireAt: 999, count: 0 }, queue: [fixtureEntry('a', {
    followUpIndex: 1, followUpScheduleKey: 's1:998:0', periodCare: { characterId: 'c', cycleKey: 'cycle' },
  })] });
  await h.client.consumeServerOutbox({ force: true });
  assert.ok(h.state.scheduled);
  const events = h.state.events.map(event => event[0]);
  assert.ok(events.indexOf('period-care') > events.indexOf('chat-commit'));
  h.state.queue.push(fixtureEntry('b', { followUpScheduleKey: 's1:999:0' }));
  await h.client.consumeServerOutbox({ force: true });
  assert.equal(h.state.scheduled, null);
});
test('ACK retry does not duplicate period-care trigger records', async () => {
  const h = harness({ ackFails: 1, queue: [fixtureEntry('a', { periodCare: { characterId: 'c', cycleKey: 'cycle' } })] });
  assert.equal((await h.client.consumeServerOutbox({ force: true })).ok, false);
  assert.equal((await h.client.consumeServerOutbox({ force: true })).ok, true);
  assert.equal(h.state.events.filter(event => event[0] === 'period-care').length, 1);
});
test('bridge and zero-message raw remain recoverable after ACK', async () => {
  const empty = fixtureEntry('empty'); empty.raw_text = '';
  const h = harness({ queue: [fixtureEntry('bridge', { kind: 'bridge', reply: { sessionId: 's1' }, screenChat: true,
    screenChatCharacterId: 'c', screenChatSequence: 1 }), empty] });
  assert.equal((await h.client.consumeServerOutbox({ force: true })).ok, true);
  assert.equal(h.state.queue.length, 0);
  assert.equal(h.journal.listRecoverablePushOutboxEntries().length, 2);
  assert.ok(h.state.events.some(event => event[0] === 'screen-ack'));
});
test('startup/focus/pageshow/online/SW hooks and hidden polling guard exist', async () => {
  const h = harness(); h.client.installServerOutboxConsumer();
  assert.equal(h.state.timers.size, 1);
  for (const name of ['visibilitychange', 'focus', 'pageshow', 'online', 'sw']) assert.equal(typeof h.state.listeners[name], 'function');
  h.document.hidden = true;
  for (const { fn } of h.state.timers.values()) fn();
  await tick(); assert.equal(h.state.reads, 0);
});
(async () => {
  for (const { name, fn } of tests) { await fn(); console.log(`PASS ${name}`); }
  console.log(`PASS ${tests.length} push outbox delivery scenarios (actual source, fixture-only)`);
})().catch(error => { console.error(error); process.exitCode = 1; });
