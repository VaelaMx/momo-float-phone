import { readBackupBlob } from "./data-management/backup";
import type { MemoryEntry } from "./memory-types";

export type CoreMemoryBackupAudit = {
    characterId: string;
    backupCreatedAt: string;
    checkedAt: string;
    backupCount: number;
    currentCount: number;
    sameIdCount: number;
    sameContentCount: number;
    changed: MemoryEntry[];
    missing: MemoryEntry[];
};

const normalizedContent = (content: string) => content.replace(/\r\n/g, "\n").trim();

/** Read only: missing means absent today, not proof of an automatic deletion. */
export function compareCoreMemories(
    backupEntries: MemoryEntry[],
    currentEntries: MemoryEntry[],
    characterId: string,
    backupCreatedAt: string,
): CoreMemoryBackupAudit {
    const relevant = (entry: MemoryEntry) => entry.characterId === characterId && entry.type === "core";
    const backup = backupEntries.filter(relevant);
    const current = currentEntries.filter(relevant);
    const currentById = new Map(current.map(entry => [entry.id, entry]));
    const currentContents = new Set(current.map(entry => normalizedContent(entry.content)));
    const audit: CoreMemoryBackupAudit = {
        characterId, backupCreatedAt, checkedAt: new Date().toISOString(),
        backupCount: backup.length, currentCount: current.length,
        sameIdCount: 0, sameContentCount: 0, changed: [], missing: [],
    };
    for (const entry of backup) {
        const existing = currentById.get(entry.id);
        if (existing) {
            audit.sameIdCount += 1;
            if (normalizedContent(existing.content) !== normalizedContent(entry.content)) audit.changed.push(entry);
        } else if (currentContents.has(normalizedContent(entry.content))) {
            audit.sameContentCount += 1;
        } else {
            audit.missing.push(entry);
        }
    }
    return audit;
}

/** Decode only the memory module. No restore, media reads, writes, or model calls. */
export async function auditCoreMemoriesFromBackup(
    file: Blob,
    currentEntries: MemoryEntry[],
    characterId: string,
): Promise<CoreMemoryBackupAudit> {
    const { manifest, modules } = await readBackupBlob(file, ["memory"]);
    const entries = new Map<string, MemoryEntry>();
    let foundMemoryStore = false;
    for (const module of modules) {
        for (const source of module.sources) {
            if (source.type !== "indexeddb" || source.dbName !== "ai_phone_memory_db_v1") continue;
            if (source.error) throw new Error("这份备份的记忆数据库导出不完整，请换另一份备份对照。");
            for (const store of source.stores) {
                if (store.name !== "memories") continue;
                foundMemoryStore = true;
                for (const record of store.records) {
                    const entry = record.value as Partial<MemoryEntry> | null;
                    if (!entry || typeof entry.id !== "string" || typeof entry.characterId !== "string"
                        || (entry.type !== "core" && entry.type !== "long_term") || typeof entry.content !== "string") {
                        throw new Error("备份中有无法识别的记忆记录，已停止对照，不会改动当前数据。");
                    }
                    entries.set(entry.id, entry as MemoryEntry);
                }
            }
        }
    }
    if (!foundMemoryStore) throw new Error("这份备份没有可读取的记忆数据库，请选择包含记忆的备份。");
    return compareCoreMemories([...entries.values()], currentEntries, characterId, manifest.createdAt);
}
