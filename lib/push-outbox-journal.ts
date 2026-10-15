import { hydrateKvDb, isKvHydrated, kvGet, kvKeysWithPrefix, kvSetAsync, registerDynamicPrefix } from "./kv-db";
import { isPersonalPushCloudActive, loadPersonalPushCloudState } from "./personal-push-cloud";

// One key per immutable server entry: retries never replace another entry with
// the same schedule/round. Dynamic registration also covers legacy migration.
const JOURNAL_PREFIX = "ai_phone_push_outbox_journal_v1:";
registerDynamicPrefix(JOURNAL_PREFIX);

export type PushOutboxRawEntry = {
    id: string;
    session_id: string | null;
    trigger_key: string | null;
    raw_text: string;
    meta: Record<string, unknown> | null;
    created_at: string;
};

export type PushOutboxReceipt = {
    id: string;
    sessionId: string;
    batchId: string;
    messageIds: string[];
    savedAt: string;
};

export type PushOutboxJournalRecord = {
    state: "pending" | "orphaned" | "completed";
    entry?: PushOutboxRawEntry;
    receipt?: PushOutboxReceipt;
    orphanReason?: "missing_session" | "retained_effects";
};

export async function ensurePushOutboxJournalAvailable(): Promise<void> {
    await hydrateKvDb();
    if (!isKvHydrated()) throw new Error("离线消息保全记录暂时无法读取，请重试。");
}

function requireHydrated(): void {
    if (!isKvHydrated()) throw new Error("离线消息保全记录尚未完成加载。");
}

function parseRecord(raw: string): PushOutboxJournalRecord {
    const record = JSON.parse(raw) as PushOutboxJournalRecord;
    if (!record || !["pending", "orphaned", "completed"].includes(record.state)
        || (!record.entry && !record.receipt)
        || (record.entry && (typeof record.entry.id !== "string" || typeof record.entry.raw_text !== "string"
            || typeof record.entry.created_at !== "string"))
        || (record.receipt && (typeof record.receipt.id !== "string"
            || typeof record.receipt.batchId !== "string" || typeof record.receipt.sessionId !== "string"
            || !Array.isArray(record.receipt.messageIds)
            || !record.receipt.messageIds.every(id => typeof id === "string")))) {
        throw new Error("离线消息保全记录格式损坏，请保留备份后排查。");
    }
    return record;
}

export function getPushOutboxCloudScope(): string | null {
    if (!isPersonalPushCloudActive()) return null;
    const state = loadPersonalPushCloudState();
    return state?.url ? state.url.replace(/\/+$/, "") : null;
}

function scopePrefix(scope: string): string {
    return `${JOURNAL_PREFIX}${encodeURIComponent(scope)}:`;
}

function entryKey(scope: string, id: string): string {
    return `${scopePrefix(scope)}${encodeURIComponent(id)}`;
}

export function loadPushOutboxJournalRecord(scope: string, id: string): PushOutboxJournalRecord | null {
    requireHydrated();
    const raw = kvGet(entryKey(scope, id));
    if (!raw) return null;
    return parseRecord(raw);
}

export function listPushOutboxJournalRecords(scope: string): PushOutboxJournalRecord[] {
    requireHydrated();
    return kvKeysWithPrefix(scopePrefix(scope)).flatMap(key => {
        const raw = kvGet(key);
        return raw ? [parseRecord(raw)] : [];
    });
}

async function saveRecord(scope: string, id: string, record: PushOutboxJournalRecord): Promise<void> {
    // Unlike kvSet, this rejects when the IndexedDB transaction fails. A cached
    // value (kvSetAsync updates it before committing) is never a delivery proof.
    await kvSetAsync(entryKey(scope, id), JSON.stringify(record));
    if (typeof window !== "undefined") window.dispatchEvent(new Event("push-outbox-journal-updated"));
}

export async function stagePushOutboxEntry(scope: string, entry: PushOutboxRawEntry): Promise<void> {
    const existing = loadPushOutboxJournalRecord(scope, entry.id);
    await saveRecord(scope, entry.id, {
        state: "pending",
        entry,
        ...(existing?.receipt ? { receipt: existing.receipt } : {}),
    });
}

export async function archiveOrphanedPushOutboxEntry(scope: string, entry: PushOutboxRawEntry): Promise<void> {
    await saveRecord(scope, entry.id, { state: "orphaned", entry, orphanReason: "missing_session" });
}

export async function savePushOutboxReceipt(
    scope: string, entry: PushOutboxRawEntry, receipt: PushOutboxReceipt,
): Promise<void> {
    // Keep the raw response until the server actually confirms acknowledgement.
    const retainEffects = entry.meta?.kind === "bridge" || entry.meta?.kind === "shortcut_delivery_error"
        || receipt.messageIds.length === 0;
    await saveRecord(scope, entry.id, {
        state: retainEffects ? "orphaned" : "pending", entry, receipt,
        ...(retainEffects ? { orphanReason: "retained_effects" as const } : {}),
    });
}

export async function compactAcknowledgedPushOutboxEntry(scope: string, id: string): Promise<void> {
    const record = loadPushOutboxJournalRecord(scope, id);
    if (record?.receipt && record.state !== "orphaned") {
        await saveRecord(scope, id, { state: "completed", receipt: record.receipt });
    }
    // Orphans intentionally retain their complete raw response for recovery.
}

/** Safe for the settings UI: no cloud key, request header, or other project. */
export function listRecoverablePushOutboxEntries(): Array<{
    id: string; sessionId: string; createdAt: string; rawText: string; state: "pending" | "orphaned";
}> {
    requireHydrated();
    const scope = getPushOutboxCloudScope();
    if (!scope) return [];
    return listPushOutboxJournalRecords(scope).flatMap(record => {
        if (!record.entry || (record.state !== "pending" && record.state !== "orphaned")) return [];
        const entry = record.entry;
        return [{
            id: entry.id,
            sessionId: typeof entry.meta?.sessionId === "string" ? entry.meta.sessionId : entry.session_id || "",
            createdAt: entry.created_at,
            rawText: entry.raw_text,
            state: record.state,
        }];
    }).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
