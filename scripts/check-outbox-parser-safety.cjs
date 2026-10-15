// Real parser/storage/scheduler functions with isolated fixtures; no user data,
// IndexedDB instance, model request, or cloud request is accessed.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const quietConsole = { log() {}, warn() {}, error() {} };
let checks = 0;
function evaluate(source, file, bindings = {}, dependencies = {}) {
    const compiled = ts.transpileModule(source, { fileName: file, compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    } }).outputText;
    const module = { exports: {} };
    const requireFixture = name => {
        if (Object.hasOwn(dependencies, name)) return dependencies[name];
        throw new Error(`Unexpected dependency in ${file}: ${name}`);
    };
    new Function("require", "module", "exports", ...Object.keys(bindings), compiled)(
        requireFixture, module, module.exports, ...Object.values(bindings),
    );
    return module.exports;
}
function load(file, dependencies = {}) {
    return evaluate(fs.readFileSync(path.join(root, file), "utf8"), file, {}, dependencies);
}
function extract(file, names, bindings = {}, dependencies = {}, prefix = "", suffix = "") {
    const source = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), "utf8"), ts.ScriptTarget.Latest, true);
    const nodes = source.statements.filter(node => node.name && names.includes(node.name.text));
    assert.equal(nodes.length, names.length, `Missing test target in ${file}`);
    return evaluate(prefix + nodes.map(node => node.getText(source)).join("\n")
        + `\nexports.targets = {${names.join(",")}};\n` + suffix, file, bindings, dependencies);
}
async function check(name, fn) { await fn(); checks++; console.log(`✓ ${name}`); }
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const stateParser = load("lib/state-value-parser.ts");
const richParser = load("lib/rich-message-parser.ts", {
    "./state-value-parser": stateParser,
    "./action-parser": { stripActionShells: text => text },
    "./text-tool-protocol": { stripTextToolDirectives: text => text },
    "./custom-app-chat-directives": { loadCustomAppChatDirectives: () => [] },
});

function parserFixture() {
    const rows = [];
    const events = [];
    let generated = 0, actionEffects = 0, imageRequests = 0;
    const backgroundWrites = [];
    let imageResult = Promise.resolve(null);
    const sessions = [{ id: "s", contactId: "c" }];
    const { targets: imported } = extract("lib/chat-storage.ts", ["upsertImportedChatMessage"], {
        _messagesCache: rows, dbPutMessage: message => backgroundWrites.push(message.id), getNextMessageOrder: () => rows.length,
        isSessionPreviewCandidate: () => false,
    });
    const { targets: mediaUpdates } = extract("lib/chat-storage.ts", ["updateMessageMediaStatus", "updateMessageMediaData"], {
        _messagesCache: rows, dbPutMessage: message => backgroundWrites.push(message.id),
    });
    const bindings = {
        console: quietConsole,
        loadChatSessions: () => sessions,
        loadChatMessages: id => rows.filter(row => row.sessionId === id),
        resolveFollowUpSenderName: () => "角色",
        createResponseBatchId: () => `random_batch_${++generated}`,
        pushChatMessage: msg => { const record = { ...msg, id: `random_${++generated}`, createdAt: msg.createdAt || new Date().toISOString(), status: "sent" }; rows.push(record); return record; },
        upsertImportedChatMessage: imported.upsertImportedChatMessage,
        getLatestCharacterStateValues: () => [],
        parseAIResponse: richParser.parseAIResponse,
        getStatusRegionConfig: () => ({}), isCustomStatusRegionActive: () => false,
        isKnownStickerLabel: () => false,
        updateMessageMediaStatus: (...args) => { mediaUpdates.updateMessageMediaStatus(...args); actionEffects++; },
        updateMessageMediaData: (...args) => { mediaUpdates.updateMessageMediaData(...args); actionEffects++; },
        settleShoppingPaymentRequest: () => { actionEffects++; },
        createPendingChatGeneratedImageData: (data, description) => ({ ...data, description, generationStatus: "pending" }),
        isPendingChatGeneratedImageMessage: msg => msg.mediaType === "image" && msg.mediaData?.generationStatus === "pending",
        generateAndApplyChatGeneratedImage: () => { imageRequests++; return imageResult; },
        dispatchBackgroundMessagesOneByOne: async () => {},
        MAX_FOLLOW_UPS: 10,
        window: { dispatchEvent: event => events.push(event) },
        CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    };
    const { targets } = extract("lib/follow-up-service.ts", [
        "handleFollowUpMediaAction", "buildGeneratedFollowUpImageMessage", "canCarryFollowUpPanel", "parseAndSaveResponse",
    ], bindings);
    const options = { silent: true, responseBatchId: "push_outbox:row1", messageIdPrefix: "push_outbox:row1", createdAt: "2026-10-15T12:00:00.000Z" };
    return {
        rows, events, options, sessions, backgroundWrites,
        parse: (text, overrides = {}) => targets.parseAndSaveResponse(text, "s", 0, 1, rows, { ...options, ...overrides }),
        normal: text => targets.parseAndSaveResponse(text, "s", 0, undefined, rows, { silent: true }),
        imagePending: promise => { imageResult = promise; },
        counts: () => ({ actionEffects, imageRequests }),
    };
}

function schedulerFixture() {
    const wait = deferred();
    const calls = [], timers = [], listeners = new Map();
    let schedules = [{ sessionId: "s", fireAt: 1, count: 0 }];
    let cloud = true;
    const bindings = {
        console: quietConsole,
        isPersonalPushCloudActive: () => cloud,
        loadAllFollowUpSchedules: () => { calls.push("read"); return schedules; },
        loadTimedWakeSchedules: () => [], loadMenstrualConfig: () => ({ periodCareEnabled: false }),
        loadIdleReconnectRules: () => [],
        PERIOD_CARE_POLL_INTERVAL_MS: 60000, IDLE_RECONNECT_POLL_INTERVAL_MS: 60000,
        firingSet: new Set(),
        fireFollowUp: () => calls.push("followup"),
        pollTimedWakeSchedules: () => calls.push("timedwake"),
        pollMenstrualPeriodCare: () => calls.push("period"),
        pollIdleReconnect: () => calls.push("idle"),
        SCHEDULED_OUTBOX_GRACE_MS: 8000,
        POLL_INTERVAL_MS: 3000,
        bgSetInterval: fn => { timers.push(fn); return () => {}; },
        window: { addEventListener: (name, fn) => listeners.set(name, fn) },
        document: { hidden: false, addEventListener: (name, fn) => listeners.set(name, fn) },
    };
    const prefix = `let automaticPollInFlight = null, scheduledOutboxSyncVersion = 0, scheduledOutboxSyncedVersion = -1;
        let scheduledOutboxGraceUntil = 0, stopInterval = null, periodCareUpdateHandler = null, lastPeriodCarePollAt = 0;
        let scheduledOutboxVisibilityHandler = null, scheduledOutboxFocusHandler = null, scheduledOutboxPageShowHandler = null, lastIdleReconnectPollAt = 0;\n`;
    const module = extract("lib/follow-up-service.ts", [
        "extendScheduledOutboxGrace", "startFollowUpService", "pollSchedules", "pollSchedulesAfterOutbox",
    ], bindings, { "./push-outbox-client": { consumeServerOutbox: opts => { calls.push(["pull", opts]); return wait.promise; } } }, prefix);
    return { ...module.targets, calls, listeners, wait,
        setSchedules: value => { schedules = value; }, noCloud: () => { cloud = false; },
    };
}

async function main() {
    await check("stable normal-part IDs survive cloud retry and preserve user edits", async () => {
        const f = parserFixture();
        await f.parse("第一条\n\n第二条");
        assert.deepEqual(f.rows.map(row => row.id), ["push_outbox:row1:part:0", "push_outbox:row1:part:1"]);
        f.rows[0].content = "用户后来编辑的内容";
        await f.parse("第一条\n\n第二条");
        assert.equal(f.rows.length, 2);
        assert.equal(f.rows[0].content, "用户后来编辑的内容");
        assert.ok(f.rows.every(row => row.responseBatchId === f.options.responseBatchId));
    });
    await check("call carrier, shortcut call/notice and rich parts share stable batch and original", async () => {
        const f = parserFixture();
        const text = "[我向你发起了语音通话]\n\n先说一句\n\n后说一句";
        const opts = { rawResponseText: "原始云端全文", shortcutMarker: { text: "【快捷动作：查天气】", name: "查天气", insertAt: text.indexOf("后说一句") } };
        await f.parse(text, opts);
        assert.equal(f.rows.length, 5);
        assert.equal(new Set(f.rows.map(row => row.id)).size, 5);
        assert.ok(f.rows.every(row => row.responseBatchId === f.options.responseBatchId && row.rawResponseText === "原始云端全文"));
        await f.parse(text, opts);
        assert.equal(f.rows.length, 5);
        assert.equal(f.events.filter(event => event.type === "ai-call-trigger").length, 1);
    });
    await check("panel-only plus shortcut-only carriers are idempotent and retain original", async () => {
        const f = parserFixture();
        const text = "[状态栏]状态面板[/状态栏]\n[内心]想你了[/内心]";
        const opts = { rawResponseText: "完整原文", shortcutMarker: { text: "【快捷动作：测试】", name: "测试", insertAt: 0 } };
        await f.parse(text, opts); await f.parse(text, opts);
        assert.equal(f.rows.length, 3);
        assert.deepEqual(f.rows.map(row => row.id), ["push_outbox:row1:panel-only", "push_outbox:row1:shortcut:call", "push_outbox:row1:shortcut:notice"]);
        assert.ok(f.rows.every(row => row.responseBatchId === f.options.responseBatchId && row.rawResponseText === "完整原文"));
    });
    await check("media action retry cannot receive next transfer or shift later message IDs", async () => {
        const f = parserFixture();
        for (const id of ["transfer1", "transfer2"]) f.rows.push({ id, sessionId: "s", role: "user", mediaType: "transfer", mediaData: { status: "pending" }, createdAt: "2026-10-15T11:00:00.000Z" });
        const text = "[接受转账]\n\n已经收到了\n\n谢谢宝宝";
        await f.parse(text, { rawResponseText: text });
        const firstIds = f.rows.map(row => row.id);
        assert.ok(firstIds.includes("push_outbox:row1:part:0:action"));
        assert.ok(firstIds.includes("push_outbox:row1:part:1"));
        await f.parse(text, { rawResponseText: text });
        assert.deepEqual(f.rows.map(row => row.id), firstIds);
        assert.equal(f.counts().actionEffects, 1);
        assert.equal(f.rows.find(row => row.id === "transfer1").mediaData.status, "pending");
        assert.ok(!f.backgroundWrites.includes("transfer1") && !f.backgroundWrites.includes("transfer2"), "target must await durable batch flush");
        assert.equal(f.rows.find(row => row.id === "push_outbox:row1:part:0:action").importedMediaAction.targetMessageId, "transfer2");
    });
    await check("reloaded action record repairs its bound pending target and never accepts another", async () => {
        const f = parserFixture();
        f.rows.push({ id: "older", sessionId: "s", role: "user", mediaType: "transfer", mediaData: { status: "pending" }, createdAt: "2026-10-15T11:00:00.000Z" });
        f.rows.push({ id: "bound", sessionId: "s", role: "user", mediaType: "transfer", mediaData: { status: "pending" }, createdAt: "2026-10-15T11:00:00.000Z" });
        await f.parse("[接受转账]\n\n已经收到了");
        f.rows.find(row => row.id === "bound").mediaData.status = "pending"; // Action durable, target write lost.
        f.rows.push({ id: "newer", sessionId: "s", role: "user", mediaType: "transfer", mediaData: { status: "pending" }, createdAt: "2026-10-15T11:30:00.000Z" });
        await f.parse("[接受转账]\n\n已经收到了");
        assert.equal(f.rows.find(row => row.id === "bound").mediaData.status, "received");
        assert.equal(f.rows.find(row => row.id === "newer").mediaData.status, "pending");
        assert.equal(f.rows.filter(row => row.importedMediaAction).length, 1);
    });
    await check("imported action cannot consume a transfer newer than its causal input", async () => {
        const f = parserFixture();
        for (const [id, time] of [["old", "10:00"], ["input", "11:00"], ["new", "11:30"]]) {
            f.rows.push({ id, sessionId: "s", role: "user", mediaType: id === "input" ? undefined : "transfer", mediaData: { status: "pending" }, createdAt: `2026-10-15T${time}:00.000Z` });
        }
        await f.parse("[接受转账]", { replyAfterLocalMessageId: "input" });
        assert.equal(f.rows.find(row => row.id === "old").mediaData.status, "received");
        assert.equal(f.rows.find(row => row.id === "new").mediaData.status, "pending");
    });
    await check("failed/incomplete first parse resumes absent later parts using original indices", async () => {
        const f = parserFixture();
        f.rows.push({ id: "transfer1", sessionId: "s", role: "user", mediaType: "transfer", mediaData: { status: "pending" }, createdAt: "2026-10-15T11:00:00.000Z" });
        const text = "[接受转账]\n\n第一句\n\n第二句";
        await f.parse(text);
        const second = f.rows.findIndex(row => row.id === "push_outbox:row1:part:2");
        f.rows.splice(second, 1); // Simulate a partial durable batch after restart.
        await f.parse(text);
        assert.equal(f.rows.filter(row => row.id === "push_outbox:row1:part:1").length, 1);
        assert.equal(f.rows.filter(row => row.id === "push_outbox:row1:part:2").length, 1);
        assert.equal(f.counts().actionEffects, 1);
    });
    await check("cloud image placeholder returns before optional generation finishes, no retry duplicate", async () => {
        const f = parserFixture(), image = deferred(); f.imagePending(image.promise);
        await f.parse("[照片：窗外的风景]\n\n给你看看");
        assert.equal(f.rows[0].mediaType, "image");
        assert.equal(f.counts().imageRequests, 1);
        await f.parse("[照片：窗外的风景]\n\n给你看看");
        assert.equal(f.counts().imageRequests, 1);
        image.reject(new Error("isolated optional image failure"));
        await new Promise(resolve => setImmediate(resolve));
    });
    await check("causal anchor protects cloud reply order across clock skew", async () => {
        const f = parserFixture();
        const anchor = { id: "input", sessionId: "s", role: "user", createdAt: "2026-10-15T13:00:00.000Z" };
        f.rows.push(anchor);
        await f.parse("云端回复", { replyAfterLocalMessageId: "input" });
        assert.ok(Date.parse(f.rows[1].createdAt) > Date.parse(anchor.createdAt));
    });
    await check("ordinary non-import parsing still creates separate response records", async () => {
        const f = parserFixture(); await f.normal("普通回复"); await f.normal("普通回复");
        assert.equal(f.rows.length, 2); assert.notEqual(f.rows[0].id, f.rows[1].id);
    });
    await check("durable batch flush rewrites all matching cached rows and awaits actual storage", async () => {
        const cached = [{ id: "a", sessionId: "s", responseBatchId: "b" }, { id: "c", sessionId: "s", responseBatchId: "b" }, { id: "other", sessionId: "other", responseBatchId: "b" }];
        const wait = deferred(); let flushed, settled = false;
        const { targets } = extract("lib/chat-storage.ts", ["persistChatMessagesByBatch"], {
            _messagesCache: cached, _hydrated: true, hydrateChatStorage: async () => {},
            dbBulkPutMessages: rows => { flushed = rows; return wait.promise; },
        });
        const pending = targets.persistChatMessagesByBatch("s", "b").then(rows => { settled = true; return rows; });
        await Promise.resolve(); assert.equal(settled, false);
        assert.deepEqual(flushed.map(row => row.id), ["a", "c"]);
        wait.resolve(); assert.deepEqual((await pending).map(row => row.id), ["a", "c"]);
    });
    await check("durable flush propagates write and hydration failures", async () => {
        for (const hydrated of [false, true]) {
            const { targets } = extract("lib/chat-storage.ts", ["persistChatMessagesByBatch"], {
                _messagesCache: [{ sessionId: "s", responseBatchId: "b" }], _hydrated: hydrated,
                hydrateChatStorage: async () => {}, dbBulkPutMessages: async () => { throw new Error("quota fixture"); },
            });
            await assert.rejects(targets.persistChatMessagesByBatch("s", "b"), hydrated ? /quota fixture/ : /尚未成功加载/);
        }
    });
    await check("durable action flush includes bound target and retries shopping failure without resettling", async () => {
        const target = { id: "pay", sessionId: "s", mediaData: { status: "paid", shoppingOrderId: "order" } };
        const action = { id: "action", sessionId: "s", responseBatchId: "b", importedMediaAction: { targetMessageId: "pay", actionType: "accept_payment_request", resolvedStatus: "paid", payerCharacterName: "角色" } };
        const rows = [target, action]; let written, settleCount = 0, flushCount = 0;
        const state = { orders: [{ id: "order", paymentStatus: "payment_requested" }] };
        const dependencies = {
            "./shopping-storage": {
                loadShoppingState: () => state,
                persistShoppingState: async () => { if (++flushCount === 1) throw new Error("shopping quota fixture"); },
            },
            "./shopping-payment-request": { settleShoppingPaymentRequest: () => { settleCount++; state.orders[0].paymentStatus = "paid_by_character"; } },
        };
        const { targets } = extract("lib/chat-storage.ts", ["persistChatMessagesByBatch"], {
            _messagesCache: rows, _hydrated: true, hydrateChatStorage: async () => {},
            dbBulkPutMessages: async values => { written = values; },
        }, dependencies);
        await assert.rejects(targets.persistChatMessagesByBatch("s", "b"), /shopping quota fixture/);
        assert.deepEqual(written.map(row => row.id), ["action", "pay"]);
        await targets.persistChatMessagesByBatch("s", "b");
        assert.equal(settleCount, 1); assert.equal(flushCount, 2);
        state.orders[0].paymentStatus = "payment_requested"; // Reloaded chat action; old shopping database.
        await targets.persistChatMessagesByBatch("s", "b"); assert.equal(settleCount, 2);
        state.orders[0].paymentStatus = "payment_declined"; // Later user decision stays intact.
        await targets.persistChatMessagesByBatch("s", "b"); assert.equal(settleCount, 2);
    });
    await check("all automatic paths wait for cloud pull then reread schedules", async () => {
        const f = schedulerFixture();
        const pending = f.pollSchedules(); const duplicate = f.pollSchedules();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(f.calls.filter(call => typeof call === "string"), ["read"]); // Freshness decision only.
        assert.equal(f.calls.filter(Array.isArray).length, 1); assert.equal(f.calls.find(Array.isArray)[0], "pull"); assert.equal(f.calls.find(Array.isArray)[1].force, true);
        f.setSchedules([]); f.wait.resolve({ ok: true }); await Promise.all([pending, duplicate]);
        assert.deepEqual(f.calls.slice(2), ["read", "timedwake", "period", "idle"]);
    });
    await check("failed cloud sync defers every automatic due path and retries", async () => {
        const f = schedulerFixture(); f.wait.resolve({ ok: false, reason: "offline fixture" });
        await f.pollSchedules(); await f.pollSchedules();
        assert.equal(f.calls.filter(Array.isArray).length, 2); assert.ok(f.calls.filter(Array.isArray).every(call => call[0] === "pull" && call[1].force));
        assert.ok(!f.calls.includes("followup") && !f.calls.includes("period"));
    });
    await check("resume forces another sync and period-care updates use the same barrier", async () => {
        const f = schedulerFixture(); f.setSchedules([]); f.startFollowUpService(); f.wait.resolve({ ok: true });
        await f.pollSchedules(); await f.pollSchedules();
        assert.equal(f.calls.filter(call => Array.isArray(call)).at(-1)[1].force, false);
        f.listeners.get("visibilitychange")(); await f.pollSchedules();
        assert.equal(f.calls.filter(call => Array.isArray(call)).at(-1)[1].force, true);
        f.calls.length = 0; f.listeners.get("menstrual-period-care-updated")();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(f.calls.find(Array.isArray)[0], "pull"); assert.ok(f.calls.indexOf("period") > 0);
    });
    await check("without personal cloud local automatic scheduling remains available", async () => {
        const f = schedulerFixture(); f.noCloud(); await f.pollSchedules();
        assert.deepEqual(f.calls, ["read", "followup", "timedwake", "period", "idle"]);
    });
    console.log(`\n${checks} outbox parser/storage/scheduler safety checks passed.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
