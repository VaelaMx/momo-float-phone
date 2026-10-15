"use client";

import { useRef, useState } from "react";
import { loadMemoryEntries } from "@/lib/memory-storage";
import type { CoreMemoryBackupAudit } from "@/lib/memory-backup-audit";

export function MemoryBackupCheck({ characterId }: { characterId: string }) {
    const fileRef = useRef<HTMLInputElement>(null);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<CoreMemoryBackupAudit | null>(null);
    const [error, setError] = useState("");
    const [exporting, setExporting] = useState(false);

    const checkBackup = async (file: File) => {
        setBusy(true);
        setResult(null);
        setError("");
        try {
            const { auditCoreMemoriesFromBackup } = await import("@/lib/memory-backup-audit");
            const current = await loadMemoryEntries(characterId, { requireAvailable: true });
            setResult(await auditCoreMemoriesFromBackup(file, current, characterId));
        } catch (err) {
            setError(err instanceof Error ? err.message : "对照失败，请稍后重试。");
        } finally {
            setBusy(false);
        }
    };

    const exportResult = async () => {
        if (!result || exporting) return;
        setExporting(true);
        try {
            const { downloadFile } = await import("@/lib/download-utils");
            await downloadFile(new Blob([JSON.stringify({ ...result, checkedOrigin: window.location.origin }, null, 2)], { type: "application/json" }), "core-memory-backup-check.json");
        } catch (err) {
            setError(err instanceof Error ? err.message : "导出失败，请稍后重试。");
        } finally {
            setExporting(false);
        }
    };

    return (
        <div className="g-card p-3 ts-12 leading-relaxed">
            <p className="font-medium">对照旧备份检查核心记忆</p>
            <p className="text-secondary mt-1">旧版没有删除日志。选择一份旧备份，与当前角色的核心记忆逐条比较；只读取文件，不会恢复或覆盖数据。</p>
            <p className="text-secondary mt-1">请在平时聊天的同一个小手机入口检查。换网址、换浏览器或打开预览站，读到的可能是另一个空数据库。</p>
            <input
                ref={fileRef}
                type="file"
                accept=".zip,.aiphone,application/zip"
                hidden
                onChange={event => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    if (file) void checkBackup(file);
                }}
            />
            <button className="ui-btn ui-btn-outline mt-2" disabled={busy} onClick={() => fileRef.current?.click()}>
                {busy ? "正在对照..." : "选择旧备份对照"}
            </button>
            {error && <p className="mt-2" role="alert">{error}</p>}
            {result && (
                <div className="mt-2" aria-live="polite">
                    <p>备份时间：{new Date(result.backupCreatedAt).toLocaleString()}</p>
                    <p>备份中 {result.backupCount} 条，当前 {result.currentCount} 条；相同编号仍在 {result.sameIdCount} 条，相同内容以其他编号保留 {result.sameContentCount} 条。</p>
                    <p>当前缺失 {result.missing.length} 条，内容有修改 {result.changed.length} 条。</p>
                    <p className="text-secondary mt-1">缺失不等于被程序误删，也可能是手动删除或更换了角色。无缺失仅说明这份备份中的记录仍在，不能排除备份之前或之后发生过删除。</p>
                    {result.backupCount === 0 && <p className="mt-1">备份里没有这个角色的核心记忆；请核对是否为同一角色，或换一份备份。</p>}
                    {result.missing.slice(0, 20).map(entry => (
                        <details key={entry.id} className="mt-2">
                            <summary>备份中存在、当前缺失：{entry.content.slice(0, 45)}{entry.content.length > 45 ? "…" : ""}</summary>
                            <textarea aria-label="备份中的核心记忆" className="ui-textarea mt-1" value={entry.content} readOnly rows={5} />
                        </details>
                    ))}
                    {result.missing.length > 20 && <p className="mt-2">此处展示前 20 条，完整内容可导出查看。</p>}
                    <button className="ui-btn ui-btn-outline mt-2" disabled={exporting} onClick={() => void exportResult()}>
                        {exporting ? "导出中..." : "导出完整对照结果"}
                    </button>
                </div>
            )}
        </div>
    );
}
