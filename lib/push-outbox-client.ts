// The notification and chat must use the SAME server response. Keep a durable
// local copy before interpreting it, and acknowledge only after chat commits.
import { parseAndSaveResponse, scheduleFollowUp } from "./follow-up-service";
import { applyOutputRegex } from "./llm-prompt-assembler";
import type { RegexConfig } from "./settings-types";
import { stripHallucinatedTimestamps } from "./llm-provider-adapter";
import { MacroEngine } from "./macro-engine";
import { getActiveAppTags } from "./content-tag-utils";
import {
    clearFollowUpSchedule, hydrateChatStorage, isChatStorageHydrated,
    loadChatMessages, loadChatSessions, loadFollowUpSchedule,
    persistChatMessagesByBatch, reindexSessionMessageOrdersByTime,
} from "./chat-storage";
import { hydrateKvDb, isKvHydrated } from "./kv-db";
import { loadPersonalPushCloudState, personalPushFetch } from "./personal-push-cloud";
import { removeTimedWakeSchedule } from "./timed-wake-storage";
import { appendBridgeFeed, loadBridgeFeed, saveScreenChatAck } from "./reality-bridge/storage";
import {
    archiveOrphanedPushOutboxEntry, compactAcknowledgedPushOutboxEntry,
    getPushOutboxCloudScope, listPushOutboxJournalRecords, loadPushOutboxJournalRecord,
    savePushOutboxReceipt, stagePushOutboxEntry,
    type PushOutboxRawEntry,
} from "./push-outbox-journal";
export { listRecoverablePushOutboxEntries, ensurePushOutboxJournalAvailable } from "./push-outbox-journal";

type OutboxMeta = {
    sessionId?: string; followUpIndex?: number; prevCount?: number;
    regexes?: RegexConfig[]; characterName?: string; userName?: string;
    appId?: string; appTags?: string[]; followUpCount?: number;
    replyAfterLocalMessageId?: string; followUpScheduleKey?: string;
    shortcutDeliveryError?: string;
};
export type PushOutboxConsumeResult = { ok: boolean; reason?: string };

let inFlight: Promise<PushOutboxConsumeResult> | null = null;
let trailingRequest: { silent?: boolean; force?: boolean } | null = null;
let lastConsumeAt = 0;
let lastConsumeScope: string | null | undefined;
let lastResult: PushOutboxConsumeResult = { ok: false, reason: "not_synced" };
let consumerInstalled = false;
let consumeRequestTimer: number | null = null;
let pollTimer: number | null = null;
let retryDelayMs = 5_000;
const OUTBOX_BATCH_SIZE = 20;
const MAX_OUTBOX_BATCHES_PER_PASS = 10;
const OUTBOX_FOREGROUND_CHECK_INTERVAL_MS = 60_000;

function sameCloud(scope: string): void {
    if (getPushOutboxCloudScope() !== scope) throw new Error("personal_cloud_changed");
}

async function fetchOutbox(init?: RequestInit): Promise<{ response: Response; data: unknown }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
        const response = await personalPushFetch("outbox", { ...init, signal: controller.signal });
        // Keep the deadline until the response body is read, not just headers.
        const data: unknown = await response.json();
        return { response, data };
    } finally { clearTimeout(timeout); }
}

function readEntry(value: unknown): PushOutboxRawEntry | null {
    if (!value || typeof value !== "object") return null;
    const entry = value as Partial<PushOutboxRawEntry>;
    if (typeof entry.id !== "string" || !entry.id || typeof entry.raw_text !== "string"
        || typeof entry.created_at !== "string") return null;
    return {
        id: entry.id,
        session_id: typeof entry.session_id === "string" ? entry.session_id : null,
        trigger_key: typeof entry.trigger_key === "string" ? entry.trigger_key : null,
        raw_text: entry.raw_text,
        meta: entry.meta && typeof entry.meta === "object" ? entry.meta : null,
        created_at: entry.created_at,
    };
}

function resolveSessionId(entry: PushOutboxRawEntry): string {
    const reply = entry.meta?.reply as { sessionId?: unknown } | undefined;
    return typeof entry.meta?.sessionId === "string" ? entry.meta.sessionId
        : entry.session_id || (typeof reply?.sessionId === "string" ? reply.sessionId : "");
}

function clearHandledSchedules(entry: PushOutboxRawEntry, sessionId: string): void {
    const triggerKey = entry.trigger_key;
    if (triggerKey?.startsWith("timedwake:")) {
        const exactId = triggerKey.slice("timedwake:".length).trim();
        if (exactId) removeTimedWakeSchedule(exactId);
    }
    const key = entry.meta?.followUpScheduleKey;
    const schedule = loadFollowUpSchedule(sessionId);
    if (typeof key === "string" && schedule
        && key === `${schedule.sessionId}:${schedule.fireAt}:${schedule.count}`) {
        clearFollowUpSchedule(sessionId);
    }
}

async function applyImportedMetadata(scope: string, entry: PushOutboxRawEntry, sessionId: string): Promise<void> {
    const periodCare = entry.meta?.periodCare as { characterId?: string; cycleKey?: string } | undefined;
    if (periodCare?.characterId && periodCare.cycleKey) {
        const { hasMenstrualPeriodCareTriggered, saveMenstrualPeriodCareTrigger } = await import("./menstrual-storage");
        sameCloud(scope);
        if (!hasMenstrualPeriodCareTriggered(periodCare.characterId, periodCare.cycleKey)) {
            saveMenstrualPeriodCareTrigger({ characterId: periodCare.characterId, sessionId, cycleKey: periodCare.cycleKey });
        }
    }
    const idleMeta = entry.meta?.idleReconnect as { ruleId?: string; firedAt?: number } | undefined;
    if (idleMeta?.ruleId) {
        const { markIdleReconnectFired } = await import("./idle-reconnect-storage");
        sameCloud(scope);
        markIdleReconnectFired(idleMeta.ruleId, typeof idleMeta.firedAt === "number" ? idleMeta.firedAt : Date.now());
    }
    sameCloud(scope);
    clearHandledSchedules(entry, sessionId);
}

async function importEntry(scope: string, entry: PushOutboxRawEntry, silent: boolean): Promise<void> {
    sameCloud(scope);
    const previous = loadPushOutboxJournalRecord(scope, entry.id);
    // Always wait for the write, including a retry after a failed cached write.
    await stagePushOutboxEntry(scope, entry);
    sameCloud(scope);
    const batchId = `push_outbox:${entry.id}`;
    let sessionId = resolveSessionId(entry);
    let parseResult: Awaited<ReturnType<typeof parseAndSaveResponse>> | undefined;

    if (entry.meta?.kind === "shortcut_delivery_error") {
        if (!loadBridgeFeed().some(item => item.id === `shortcut_fail_${entry.id}`)) appendBridgeFeed({
            id: `shortcut_fail_${entry.id}`, type: "快捷动作",
            payload: typeof entry.meta.shortcutDeliveryError === "string" ? entry.meta.shortcutDeliveryError : entry.raw_text,
            rules: [], actions: [],
            error: typeof entry.meta.shortcutDeliveryError === "string" ? entry.meta.shortcutDeliveryError : entry.raw_text,
            receivedAt: entry.created_at,
        });
        await savePushOutboxReceipt(scope, entry, {
            id: entry.id, sessionId, batchId, messageIds: [], savedAt: new Date().toISOString(),
        });
        return;
    }

    const bridge = entry.meta?.kind === "bridge";
    if (bridge && previous?.receipt) sessionId = previous.receipt.sessionId;
    const cachedSession = loadChatSessions().find(session => session.id === sessionId);
    // Bridge application may create its target session. Ordinary missing
    // sessions are recoverably archived after verified hydration, never dropped.
    if (!bridge && !cachedSession) {
        await archiveOrphanedPushOutboxEntry(scope, entry);
        return;
    }

    if (bridge && !previous?.receipt) {
        const engine = await import("./reality-bridge/engine");
        sameCloud(scope);
        const applied = await engine.applyServerBridgeEntry(entry.meta as Parameters<typeof engine.applyServerBridgeEntry>[0]);
        sameCloud(scope);
        sessionId = applied.sessionId || sessionId;
    }
    if (!sessionId || !loadChatSessions().some(session => session.id === sessionId)) {
        await archiveOrphanedPushOutboxEntry(scope, entry);
        return;
    }

    const existing = loadChatMessages(sessionId);
    const receipt = previous?.receipt;
    const previouslyComplete = receipt?.batchId === batchId && receipt.sessionId === sessionId
        && receipt.messageIds.every(id => existing.some(message => message.id === id));
    if (!previouslyComplete) {
        const replyMeta = bridge ? (entry.meta?.reply || {}) as OutboxMeta : (entry.meta || {}) as OutboxMeta;
        let text = stripHallucinatedTimestamps(entry.raw_text.trim());
        const regexes = Array.isArray(replyMeta.regexes) ? replyMeta.regexes : [];
        if (regexes.length > 0) {
            const macroEngine = new MacroEngine(replyMeta.characterName ?? "", replyMeta.userName ?? "用户");
            const activeTags = getActiveAppTags(replyMeta.appId ?? "chat", {
                appTags: replyMeta.appTags, followUpCount: replyMeta.followUpCount,
            });
            text = applyOutputRegex(text, regexes, { macroEngine, activeTags });
        }
        const rawMarker = entry.meta?.shortcutMarker as { text?: unknown; insertAt?: unknown; name?: unknown } | undefined;
        const shortcutMarker = rawMarker && typeof rawMarker.text === "string" && rawMarker.text
            && typeof rawMarker.name === "string" && rawMarker.name
            ? {
                text: rawMarker.text,
                insertAt: typeof rawMarker.insertAt === "number" && Number.isFinite(rawMarker.insertAt)
                    ? rawMarker.insertAt : Number.MAX_SAFE_INTEGER,
                name: rawMarker.name,
            } : undefined;
        parseResult = await parseAndSaveResponse(text, sessionId, replyMeta.prevCount ?? 0,
            typeof replyMeta.followUpIndex === "number" ? replyMeta.followUpIndex : undefined,
            existing, {
                silent, responseBatchId: batchId, messageIdPrefix: batchId,
                createdAt: bridge && typeof entry.meta?.screenChatAssistantAt === "string"
                    ? entry.meta.screenChatAssistantAt : entry.created_at,
                replyAfterLocalMessageId: replyMeta.replyAfterLocalMessageId,
                rawResponseText: entry.raw_text,
                ...(shortcutMarker ? { shortcutMarker } : {}),
            });
        sameCloud(scope);
        reindexSessionMessageOrdersByTime(sessionId);
    }
    // Cached messages and even a cached receipt do not prove an IDB commit.
    const persisted = await persistChatMessagesByBatch(sessionId, batchId);
    sameCloud(scope);
    await savePushOutboxReceipt(scope, entry, {
        id: entry.id, sessionId, batchId,
        messageIds: persisted.map(message => message.id), savedAt: new Date().toISOString(),
    });
    sameCloud(scope);
    await applyImportedMetadata(scope, entry, sessionId);
    sameCloud(scope);
    if (bridge && entry.meta?.screenChat === true
        && typeof entry.meta.screenChatCharacterId === "string"
        && Number.isSafeInteger(entry.meta.screenChatSequence)) {
        saveScreenChatAck(entry.meta.screenChatCharacterId, Number(entry.meta.screenChatSequence));
    }
    // Do not replace a newer local follow-up schedule with an old cloud reply.
    const latest = loadChatMessages(sessionId).at(-1);
    if (parseResult?.hasVisible && parseResult.newCount < 10
        && !loadFollowUpSchedule(sessionId) && latest?.responseBatchId === batchId) {
        scheduleFollowUp(sessionId, parseResult.newCount, parseResult.stateValues);
    }
}

async function importAndAcknowledge(scope: string, entries: PushOutboxRawEntry[], silent: boolean): Promise<void> {
    const consumedIds: string[] = [];
    let failed: unknown;
    for (const entry of entries) {
        try {
            await importEntry(scope, entry, silent);
            consumedIds.push(entry.id);
        } catch (error) {
            console.warn("[PushOutbox] merge remains recoverable:", entry.id, error);
            failed = error;
            if (entry.meta?.screenChat === true) break;
        }
    }
    if (consumedIds.length > 0) {
        sameCloud(scope);
        const { response, data } = await fetchOutbox({
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids: consumedIds }),
        });
        const result = data as { ok?: boolean } | null;
        if (!response.ok || result?.ok !== true) throw new Error("outbox_ack_failed");
        for (const id of consumedIds) await compactAcknowledgedPushOutboxEntry(scope, id);
        sameCloud(scope);
    }
    if (failed) throw failed;
}

async function consumePass(options?: { silent?: boolean; force?: boolean }): Promise<PushOutboxConsumeResult> {
    if (typeof window === "undefined") return { ok: true, reason: "not_in_browser" };
    try {
        await Promise.all([hydrateKvDb(), hydrateChatStorage()]);
        if (!isKvHydrated() || !isChatStorageHydrated()) throw new Error("storage_not_hydrated");
        const scope = getPushOutboxCloudScope();
        if (scope !== lastConsumeScope) {
            lastConsumeAt = 0;
            lastConsumeScope = scope;
            lastResult = { ok: false, reason: "not_synced" };
        }
        if (options?.force !== true && Date.now() - lastConsumeAt < OUTBOX_FOREGROUND_CHECK_INTERVAL_MS) return lastResult;
        lastConsumeAt = Date.now();
        if (!scope) return { ok: true, reason: "personal_cloud_inactive" };
        const silent = options?.silent !== false;
        // First recover raw responses saved locally before an interrupted ACK.
        // Archived orphans replay only if their exact original session returns.
        const sessions = new Set(loadChatSessions().map(session => session.id));
        const recoverable = listPushOutboxJournalRecords(scope).flatMap(record =>
            record.entry && (record.state === "pending"
                || (record.state === "orphaned" && record.orphanReason === "missing_session"
                    && sessions.has(resolveSessionId(record.entry))))
                ? [record.entry] : []);
        for (let start = 0; start < recoverable.length; start += OUTBOX_BATCH_SIZE) {
            await importAndAcknowledge(scope, recoverable.slice(start, start + OUTBOX_BATCH_SIZE), silent);
        }
        for (let batch = 0; batch < MAX_OUTBOX_BATCHES_PER_PASS; batch++) {
            sameCloud(scope);
            const { response, data: body } = await fetchOutbox();
            sameCloud(scope);
            const data = body as { ok?: boolean; entries?: unknown[] } | null;
            if (!response.ok || data?.ok !== true || !Array.isArray(data.entries)) throw new Error("outbox_read_failed");
            if (data.entries.length === 0) return { ok: true };
            const entries = data.entries.map(readEntry);
            if (entries.some(entry => !entry)) throw new Error("outbox_invalid_entry");
            await importAndAcknowledge(scope, entries as PushOutboxRawEntry[], silent);
            if (entries.length < OUTBOX_BATCH_SIZE) return { ok: true };
        }
        return { ok: false, reason: "outbox_more_pending" };
    } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
}

/** Concurrent callers share the result; a forced wake during a read gets its
 * own trailing pass, so a just-arrived server row cannot lose its only signal. */
export function consumeServerOutbox(options?: { silent?: boolean; force?: boolean }): Promise<PushOutboxConsumeResult> {
    if (inFlight) {
        if (options?.force) trailingRequest = { ...options, force: true };
        return inFlight;
    }
    inFlight = (async () => {
        let next = options;
        do {
            lastResult = await consumePass(next);
            next = trailingRequest || undefined;
            trailingRequest = null;
        } while (next);
        return lastResult;
    })().finally(() => { inFlight = null; });
    return inFlight;
}

/** Immediate foreground catch-up plus bounded visible retries. Hidden pages
 * don't poll; failures never get mistaken for a successful empty inbox. */
export function installServerOutboxConsumer(): void {
    if (typeof window === "undefined" || consumerInstalled) return;
    consumerInstalled = true;
    const armPoll = (delay: number) => {
        if (pollTimer !== null) window.clearTimeout(pollTimer);
        pollTimer = null;
        if (!document.hidden) pollTimer = window.setTimeout(() => requestConsume(true), delay);
    };
    const requestConsume = (force = true) => {
        if (consumeRequestTimer !== null) window.clearTimeout(consumeRequestTimer);
        consumeRequestTimer = window.setTimeout(() => {
            consumeRequestTimer = null;
            if (document.hidden) return;
            void consumeServerOutbox({ force }).then(result => {
                retryDelayMs = result.ok ? 5_000 : Math.min(retryDelayMs * 2, 60_000);
                armPoll(result.ok ? OUTBOX_FOREGROUND_CHECK_INTERVAL_MS : retryDelayMs);
            });
        }, 150);
    };
    requestConsume(true);
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) requestConsume(true);
        else if (pollTimer !== null) { window.clearTimeout(pollTimer); pollTimer = null; }
    });
    window.addEventListener("focus", () => requestConsume(true));
    window.addEventListener("pageshow", () => requestConsume(true));
    window.addEventListener("online", () => requestConsume(true));
    navigator.serviceWorker?.addEventListener("message", event => {
        if (event.data?.type === "push_outbox_ready") {
            requestConsume(true);
        } else if (event.data?.type === "run_shortcut" && typeof event.data.url === "string") {
            const url: string = event.data.url;
            const personal = loadPersonalPushCloudState();
            const allowed = url.startsWith(`${window.location.origin}/shortcut-run`)
                || url.startsWith(`${window.location.origin}/personal-shortcut-run?`)
                || (personal !== null && url.startsWith(`${personal.url}/functions/v1/ai-phone-push?action=run&`));
            if (allowed) window.location.href = url;
        }
    });
}
