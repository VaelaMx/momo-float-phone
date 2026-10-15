// Run real TypeScript functions with isolated in-memory storage and HTTP fixtures.
// This check never reads browser/user data or calls an external model or cloud.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const ts = require("typescript");
const JSZip = require("jszip");
const root = path.resolve(__dirname, "..");
let checks = 0;
const quietConsole = { log() {}, warn() {}, error() {} };

function evaluate(source, file, bindings = {}, dependencies = {}) {
    const compiled = ts.transpileModule(source, { fileName: file, compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    } }).outputText;
    const module = { exports: {} };
    const mockedRequire = name => {
        if (Object.hasOwn(dependencies, name)) return dependencies[name];
        throw new Error(`Unexpected dependency in ${file}: ${name}`);
    };
    new Function("require", "module", "exports", ...Object.keys(bindings), compiled)(
        mockedRequire, module, module.exports, ...Object.values(bindings),
    );
    return module.exports;
}
function load(file, dependencies = {}) {
    return evaluate(fs.readFileSync(path.join(root, file), "utf8"), file, { console: quietConsole }, dependencies);
}
function extract(file, names, bindings = {}) {
    const source = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), "utf8"), ts.ScriptTarget.Latest, true);
    const nodes = source.statements.filter(node => node.name && names.includes(node.name.text));
    assert.equal(nodes.length, names.length, `All test targets must exist in ${file}`);
    return evaluate(nodes.map(node => node.getText(source)).join("\n") + `\nexports.targets = {${names.join(",")}};`, file, bindings).targets;
}
async function check(name, fn) {
    await fn();
    checks++;
    console.log(`✓ ${name}`);
}
const kv = new Map();
const kvMock = {
    kvGet: key => kv.get(key) ?? null, kvSet: (key, value) => kv.set(key, value),
    kvSetAsync: async (key, value) => { kv.set(key, value); }, kvRemove: key => kv.delete(key),
    kvEntries: () => [...kv], registerKvMigration() {}, registerDynamicPrefix() {},
};
const local = new Map();
global.window = { localStorage: { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value) } };
const memory = (id, type, content = id, characterId = "c") => ({ id, type, content, characterId, sourceApp: "chat", importance: 0.8, createdAt: `2026-01-${id === "old-core" ? "01" : "02"}`, updatedAt: "2026-01-03" });
const memoryTypes = load("lib/memory-types.ts");
const hashing = load("lib/sha256-stream.ts");
const serializers = load("lib/data-management/serializers.ts", { "../sha256-stream": hashing });
const idb = load("lib/data-management/idb.ts", { "./serializers": serializers, "../kv-db": kvMock });
const backup = load("lib/data-management/backup.ts", {
    jszip: JSZip, "../download-utils": {}, "../sha256-stream": hashing,
    "./modules": { DATA_MODULES: [], CLOUD_CREDENTIAL_KV_KEYS: [] }, "./idb": idb, "./serializers": serializers,
});
const audit = load("lib/memory-backup-audit.ts", { "./data-management/backup": backup });
const completion = load("lib/llm-stream-completion.ts");
const sse = load("lib/sse-json.ts");
const adapter = load("lib/llm-provider-adapter.ts", { "./api-helpers": { stripHallucinatedTimestamps: text => text }, "./generation-parameters": {} });
const { extractFinishReason } = extract("lib/api-helpers.ts", ["extractFinishReason"]);
let responseFactory;
let networkCalls = 0;
const net = extract("lib/chat-engine.ts", [
    "ChatEngineError", "apiLogChannelFor", "attachExternalAbort", "parseSseEvents", "createStreamingTimestampStripper",
    "emptyResponseDetails", "readSseStream", "sendLLMStreamRequest", "mergeToolCallDelta", "finalizeStreamToolCalls",
    "sendLLMToolStreamRequest", "sendLLMRequest", "sendLLMToolRequest",
], {
    console: quietConsole, ...completion, ...sse, extractFinishReason,
    stripHallucinatedTimestamps: text => text,
    parseProviderStreamDelta: adapter.parseProviderStreamDelta, parseProviderResponse: adapter.parseProviderResponse,
    applyChatPluginLlmRequest: async (preset, messages) => ({ preset, messages }),
    applyChatPluginLlmResponse: async text => text, publishDebugPromptSnapshot() {},
    toLlmRequestMessages: messages => messages,
    buildProviderRequest: (config, _preset, messages) => ({ providerKind: config.fixtureKind || "openai-compatible", messagesForLog: messages, body: { messages }, url: "https://fixture.invalid", headers: {} }),
    fetchLlmPayload: async (_request, options) => { networkCalls++; options?.signal?.throwIfAborted(); return responseFactory(); },
    pushApiLog() {}, emitChatPluginEvent() {}, throwIfAborted: signal => signal?.throwIfAborted(),
    MacroEngine: class {}, getActiveAppTags: () => [], applyOutputRegex: text => text,
    applyWithProtectedAvatarDecisionMarkers: (text, fn) => fn(text),
});
const event = value => `data: ${JSON.stringify(value)}\n\n`;
const openDelta = text => event({ choices: [{ delta: { content: text }, finish_reason: null }] });
const openEnd = reason => event({ choices: [{ delta: {}, finish_reason: reason }] });
const config = { provider: "Custom", defaultModel: "fixture" };
const textCall = (kind, callbacks, options) => net.sendLLMStreamRequest({ ...config, fixtureKind: kind }, null, [], [], undefined, { skipOutputRegex: true, ...options }, callbacks);
const toolCall = (kind, callbacks, options) => net.sendLLMToolStreamRequest({ ...config, fixtureKind: kind }, null, [], [], [], undefined, options, callbacks);
const expectIncomplete = async (promise, partial, pattern) => assert.rejects(promise, error => {
    assert.ok(error instanceof completion.IncompleteReplyError);
    assert.equal(error.partialContent, partial);
    if (pattern) assert.match(error.message, pattern);
    return true;
});
const manifest = { format: "ai-phone-backup", version: 2, createdAt: "2026-01-01T00:00:00.000Z", totalBytes: 100, totalRecords: 1, modules: [{ id: "memory", label: "memory", records: 1, bytes: 100 }] };
async function memoryZip(entries, version = 2, pathName = "modules/memory/000.json") {
    const zip = new JSZip();
    zip.file("manifest.json", JSON.stringify({ ...manifest, version }));
    zip.file(pathName, JSON.stringify({ moduleId: "memory", sources: [{ type: "indexeddb", dbName: "ai_phone_memory_db_v1", stores: [{ name: "memories", records: entries.map(value => ({ key: value.id, value })) }] }] }));
    // A corrupt unrelated module must remain unopened in the read-only memory check.
    zip.file("modules/chat/000.json", "not valid JSON");
    return zip.generateAsync({ type: "nodebuffer" });
}

async function main() {
    for (const cap of [1, 3, 500]) await check(`core memories survive long-term pruning at cap ${cap}`, async () => {
        let entries = [memory("old-core", "core"), memory("manual-core", "core")];
        entries.push(...Array.from({ length: cap }, (_, i) => memory(`long-${i}`, "long_term")));
        const summarizer = load("lib/memory-summarizer.ts", {
            "./memory-types": memoryTypes,
            "./memory-storage": {
                loadMemoryConfig: () => ({ ...memoryTypes.DEFAULT_MEMORY_CONFIG, vectorRecallEnabled: false, maxLongTermEntries: cap }),
                loadMemoryEntriesByType: async (id, type) => entries.filter(e => e.characterId === id && e.type === type).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
                saveMemoryEntry: async entry => { entries.push(entry); }, deleteMemoryEntries: async ids => { entries = entries.filter(e => !ids.includes(e.id)); },
                getLastSummarizedTimestamp: () => null, resetEventCounter() {}, setLastSummarizedTimestamp() {}, incrementCoreMemoryCounter() {},
            },
            "./settings-storage": { resolveAuxiliaryApiConfig: () => config },
            "./short-term-assembler": { loadNativeTimeline: () => Array.from({ length: 4 }, () => ({ sourceApp: "chat" })), filterTimelineByAllowedSources: e => e, formatTimelineForSummarization: () => ({ eventsText: "fixture", earliest: "2026-01-01", latest: "2026-01-04" }) },
            "./memory-embedding": {}, "./api-helpers": { simpleLLMCall: async () => ({ content: "new summary" }) },
            "./core-memory-builder": { maybeRunCoreMemoryPipeline: async () => {} },
        });
        assert.equal((await summarizer.runSummarizationPipeline("c", "fixture")).success, true);
        assert.equal(entries.filter(e => e.type === "long_term").length, cap);
        assert.deepEqual(entries.filter(e => e.type === "core").map(e => e.id), ["old-core", "manual-core"]);
    });
    await check("audit distinguishes missing, changed and re-IDed memories without cross-character matches", async () => {
        const old = [memory("gone", "core"), memory("edited", "core"), memory("re-id", "core", "same content"), memory("other", "core", "other", "other-character")];
        const now = [memory("edited", "core", "edited content"), memory("new-id", "core", "same content")];
        const snapshot = JSON.stringify({ old, now });
        const result = audit.compareCoreMemories(old, now, "c", manifest.createdAt);
        assert.deepEqual(result.missing.map(e => e.id), ["gone"]);
        assert.deepEqual(result.changed.map(e => e.id), ["edited"]);
        assert.equal(result.sameContentCount, 1);
        assert.equal(JSON.stringify({ old, now }), snapshot);
    });
    for (const [version, file] of [[1, "modules/memory.json"], [2, "modules/memory/000.json"]]) await check(`read-only audit accepts v${version} ZIP and ignores unrelated modules`, async () => {
        const result = await audit.auditCoreMemoriesFromBackup(await memoryZip([memory("gone", "core")], version, file), [], "c");
        assert.equal(result.missing.length, 1);
    });
    await check("audit rejects absent or malformed memory store rather than declaring all memories gone", async () => {
        const zip = new JSZip(); zip.file("manifest.json", JSON.stringify(manifest));
        await assert.rejects(audit.auditCoreMemoriesFromBackup(await zip.generateAsync({ type: "nodebuffer" }), [], "c"), /没有可读取/);
        await assert.rejects(audit.auditCoreMemoriesFromBackup(await memoryZip([{ type: "core" }]), [], "c"), /无法识别/);
    });
    const store = load("lib/memory-storage.ts", { "./memory-types": memoryTypes, "./kv-db": kvMock, "./idb-open": { openIndexedDbAtLeast: async () => { throw new Error("unavailable"); } } });
    await check("audit current-store reads fail closed if IndexedDB is unavailable", async () => {
        await assert.rejects(store.loadMemoryEntries("c", { requireAvailable: true }), /无法读取/);
        assert.deepEqual(await store.loadMemoryEntries("c"), []);
    });
    for (const [kind, wire] of [
        ["openai-compatible", openDelta("完整回复") + openEnd("stop")],
        ["openai-compatible", openDelta("完整回复") + "data: [DONE]\n\n"],
        ["gemini", event({ candidates: [{ content: { parts: [{ text: "完整回复" }] }, finishReason: "STOP" }] })],
        ["anthropic", event({ type: "content_block_delta", delta: { type: "text_delta", text: "完整回复" } }) + event({ type: "message_delta", delta: { stop_reason: "end_turn" } }) + event({ type: "message_stop" })],
    ]) await check(`normal ${kind} completion passes text and native-tool stream paths`, async () => {
        responseFactory = () => new Response(wire);
        assert.equal((await textCall(kind)).content, "完整回复");
        assert.equal((await toolCall(kind)).content, "完整回复");
    });
    await check("clean premature EOF preserves the entire short tail and fails both stream paths", async () => {
        responseFactory = () => new Response(openDelta("我明天会"));
        await expectIncomplete(textCall("openai-compatible"), "我明天会", /结束标记/);
        await expectIncomplete(toolCall("openai-compatible"), "我明天会", /结束标记/);
    });
    await check("network read failure preserves a short buffered reply in both stream paths", async () => {
        responseFactory = () => new Response(new ReadableStream({ start(controller) {
            controller.enqueue(new TextEncoder().encode(openDelta("收到一半")));
            setTimeout(() => controller.error(new TypeError("fixture disconnect")), 0);
        } }));
        await expectIncomplete(textCall("openai-compatible"), "收到一半", /中断/);
        await expectIncomplete(toolCall("openai-compatible"), "收到一半", /中断/);
    });
    await check("length stop remains incomplete even followed by DONE", async () => {
        responseFactory = () => new Response(openDelta("半截") + openEnd("length") + "data: [DONE]\n\n");
        await expectIncomplete(textCall("openai-compatible"), "半截", /长度上限/);
        await expectIncomplete(toolCall("openai-compatible"), "半截", /长度上限/);
    });
    await check("Gemini and Anthropic length limits remain incomplete with terminal events", async () => {
        responseFactory = () => new Response(event({ candidates: [{ content: { parts: [{ text: "半截" }] }, finishReason: "MAX_TOKENS" }] }));
        await expectIncomplete(textCall("gemini"), "半截", /长度上限/);
        responseFactory = () => new Response(event({ type: "content_block_delta", delta: { type: "text_delta", text: "半截" } }) + event({ type: "message_delta", delta: { stop_reason: "max_tokens" } }) + event({ type: "message_stop" }));
        await expectIncomplete(toolCall("anthropic"), "半截", /长度上限/);
    });
    await check("split UTF-8 chunks and a final event without trailing newline preserve text", async () => {
        const bytes = new TextEncoder().encode(openDelta("你好世界") + openEnd("stop").trimEnd());
        responseFactory = () => new Response(new ReadableStream({ start(controller) {
            for (let i = 0; i < bytes.length; i += 2) controller.enqueue(bytes.slice(i, i + 2));
            controller.close();
        } }));
        assert.equal((await textCall("openai-compatible")).content, "你好世界");
        assert.equal((await toolCall("openai-compatible")).content, "你好世界");
    });
    await check("provider error cannot be hidden by a later DONE", async () => {
        responseFactory = () => new Response(openDelta("半截") + event({ error: { message: "fixture error" } }) + "data: [DONE]\n\n");
        await expectIncomplete(textCall("openai-compatible"), "半截", /返回错误/);
    });
    await check("valid native tools pass, but an unterminated tool stream never returns executable calls", async () => {
        const wire = event({ choices: [{ delta: { tool_calls: [{ index: 0, id: "t", function: { name: "fixture_tool", arguments: "{}" } }] } }] });
        responseFactory = () => new Response(wire + openEnd("tool_calls"));
        assert.equal((await toolCall("openai-compatible")).toolCalls[0].name, "fixture_tool");
        responseFactory = () => new Response(wire);
        await expectIncomplete(toolCall("openai-compatible"), "", /结束标记/);
    });
    await check("non-stream length stops are detected for text and native-tool requests", async () => {
        responseFactory = () => Response.json({ choices: [{ message: { content: "半截" }, finish_reason: "length" }] });
        await expectIncomplete(net.sendLLMRequest(config, null, [], []), "半截", /长度上限/);
        await expectIncomplete(net.sendLLMToolRequest(config, null, [], [], []), "半截", /长度上限/);
    });
    await check("user cancellation is not turned into a failed completed reply", async () => {
        const controller = new AbortController(); controller.abort();
        await assert.rejects(textCall("openai-compatible", undefined, { signal: controller.signal }), { name: "AbortError" });
        await assert.rejects(toolCall("openai-compatible", undefined, { signal: controller.signal }), { name: "AbortError" });
    });
    await check("incomplete request is not automatically retried", async () => {
        responseFactory = () => new Response(openDelta("半截")); const before = networkCalls;
        await expectIncomplete(textCall("openai-compatible"), "半截");
        assert.equal(networkCalls - before, 1);
    });
    const streamPreview = load("lib/stream-preview.ts", { "./text-tool-protocol": load("lib/text-tool-protocol.ts") });
    const notices = load("lib/chat-generation-failure.ts", { "./llm-stream-completion": completion, "./stream-preview": streamPreview });
    await check("retained partial is a UI-only notice and hides thinking/directives", async () => {
        const notice = notices.createIncompleteReplyNotice(new completion.IncompleteReplyError("断开", "<thinking>private reasoning</thinking>你好[执行动作:测试({})]", "network"), { stripXmlTags: ["thinking"] });
        assert.equal(notice.mediaType, "tool_notice"); assert.equal(notice.generationFailure.partialContent, "你好");
        assert.equal(notices.createIncompleteReplyNotice(new Error("other")), null);
        const hidden = extract("lib/short-term-assembler.ts", ["isPromptHiddenChatMessage"]).isPromptHiddenChatMessage;
        assert.ok(hidden(notice));
    });
    const ref = "0".repeat(64);
    const marker = { __aiPhoneMediaRef: true, mimeType: "image/png", ref, encoding: "dataurl" };
    for (const overwrite of [true, false]) await check(`missing media preserves KV/localStorage records (overwrite=${overwrite})`, async () => {
        const old = JSON.stringify([{ id: "existing", avatar: "healthy" }]);
        const incoming = JSON.stringify([{ id: "incoming", avatar: marker }]);
        for (const type of ["kv", "localStorage"]) {
            const storage = type === "kv" ? kv : local; storage.set("avatar", old);
            const result = await idb.importSource({ type, records: [{ key: "avatar", value: incoming }, { key: "valid", value: "ok" }] }, overwrite, async () => null);
            assert.equal(storage.get("avatar"), old); assert.equal(storage.get("valid"), "ok");
            assert.equal(result.overwritten, 0);
            // localStorage merge skips existing records before even reading media.
            assert.equal(result.errors.length, type === "localStorage" && !overwrite ? 0 : 1);
        }
    });
    await check("nested missing Blob media fails before an IndexedDB put", async () => {
        let writes = 0;
        const importRecord = extract("lib/data-management/idb.ts", ["importSource"], {
            ...serializers, formatImportError: error => error.message,
            ensureStores: async () => ({ objectStoreNames: { contains: () => true }, close() {}, transaction: () => ({ objectStore: () => ({ get: () => ({ id: "existing" }), put: () => { writes++; } }) }) }),
            transactionDone: async () => {}, runRequest: async value => value,
        }).importSource;
        const result = await importRecord({ type: "indexeddb", dbName: "fixture", stores: [{ name: "assets", records: [{ key: "existing", value: { image: { ...marker, encoding: "blob" } } }] }] }, true, async () => null);
        assert.equal(writes, 0); assert.equal(result.errors.length, 1);
    });
    await check("missing media ZIP cannot overwrite healthy local data", async () => {
        kv.set("avatar", "healthy"); const zip = new JSZip(); zip.file("manifest.json", JSON.stringify(manifest));
        zip.file("modules/characters.json", JSON.stringify({ moduleId: "characters", sources: [{ type: "kv", records: [{ key: "avatar", value: JSON.stringify(marker) }] }] }));
        const result = await backup.importBackupBlob(await zip.generateAsync({ type: "nodebuffer" }), undefined, { overwrite: true });
        assert.equal(kv.get("avatar"), "healthy"); assert.equal(result.overwritten, 0); assert.equal(result.errors.length, 2);
    });
    await check("corrupt media hash is rejected before overwrite", async () => {
        kv.set("avatar", "healthy"); const zip = new JSZip(); zip.file("manifest.json", JSON.stringify(manifest));
        zip.file("modules/characters.json", JSON.stringify({ moduleId: "characters", sources: [{ type: "kv", records: [{ key: "avatar", value: JSON.stringify(marker) }] }] }));
        zip.file(`media/${ref}.bin`, "wrong hash");
        const result = await backup.importBackupBlob(await zip.generateAsync({ type: "nodebuffer" }), undefined, { overwrite: true });
        assert.equal(kv.get("avatar"), "healthy"); assert.equal(result.overwritten, 0); assert.ok(result.errors.length);
    });
    await check("valid media and legacy inline images still restore", async () => {
        const image = "data:image/png;base64,aGVhbHRoeQ==";
        kv.set("avatar", image);
        const result = await idb.importSource({ type: "kv", records: [{ key: "avatar", value: JSON.stringify(marker) }] }, true, async () => new Blob(["healthy"], { type: "image/png" }));
        assert.equal(kv.get("avatar"), image); assert.equal(result.overwritten, 1); assert.equal(result.errors.length, 0);
        assert.equal(await serializers.deserializeStorageString(image, async () => null), image);
    });
    await check("valid content-addressed media ZIP restores through the full import path", async () => {
        const hash = await hashing.sha256BlobHex(new Blob(["healthy"]));
        const zip = new JSZip(); zip.file("manifest.json", JSON.stringify(manifest));
        zip.file("modules/characters.json", JSON.stringify({ moduleId: "characters", sources: [{ type: "kv", records: [{ key: "avatar", value: JSON.stringify({ ...marker, ref: hash }) }] }] }));
        zip.file(`media/${hash}.bin`, "healthy");
        const result = await backup.importBackupBlob(await zip.generateAsync({ type: "nodebuffer" }), undefined, { overwrite: true });
        assert.equal(result.errors.length, 0); assert.equal(result.overwritten, 1);
        assert.equal(kv.get("avatar"), "data:image/png;base64,aGVhbHRoeQ==");
    });
    console.log(`\n${checks} safety scenarios passed.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
