"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { downloadFile } from "@/lib/download-utils";

type RecoveryEntry = {
    id: string;
    sessionId: string;
    createdAt: string;
    rawText: string;
    state: "pending" | "orphaned";
};

const DISPLAY_LIMIT = 20;
const JOURNAL_UPDATED_EVENT = "push-outbox-journal-updated";

async function readRecoveryEntries(): Promise<RecoveryEntry[]> {
    const [{ listRecoverablePushOutboxEntries }, kv] = await Promise.all([
        import("@/lib/push-outbox-journal"),
        import("@/lib/kv-db"),
    ]);
    await kv.hydrateKvDb();
    if (!kv.isKvHydrated() || kv.getKvHydrationError()) {
        throw new Error("Push outbox local storage is not ready");
    }
    // Keep the export limited to the read-only public journal fields.
    return listRecoverablePushOutboxEntries().map(entry => ({
        id: entry.id,
        sessionId: entry.sessionId,
        createdAt: entry.createdAt,
        rawText: entry.rawText,
        state: entry.state,
    }));
}

function formatCreatedAt(createdAt: string): string {
    const date = new Date(createdAt);
    return Number.isFinite(date.getTime())
        ? date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
        : "时间未知";
}

export function PushOutboxRecovery() {
    const [entries, setEntries] = useState<RecoveryEntry[] | null>(null);
    const [loading, setLoading] = useState(true);
    const [readFailed, setReadFailed] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [exportError, setExportError] = useState("");
    const mounted = useRef(false);
    const readVersion = useRef(0);

    const refresh = useCallback(async () => {
        const version = ++readVersion.current;
        setLoading(true);
        try {
            const nextEntries = await readRecoveryEntries();
            if (!mounted.current || version !== readVersion.current) return;
            setEntries(nextEntries);
            setReadFailed(false);
        } catch {
            if (!mounted.current || version !== readVersion.current) return;
            setEntries(null);
            setReadFailed(true);
        } finally {
            if (mounted.current && version === readVersion.current) setLoading(false);
        }
    }, []);

    useEffect(() => {
        mounted.current = true;
        void refresh();
        const onUpdated = () => { void refresh(); };
        window.addEventListener(JOURNAL_UPDATED_EVENT, onUpdated);
        return () => {
            mounted.current = false;
            readVersion.current += 1;
            window.removeEventListener(JOURNAL_UPDATED_EVENT, onUpdated);
        };
    }, [refresh]);

    const exportOriginals = async () => {
        setExporting(true);
        setExportError("");
        try {
            // Re-read so an account/cloud change cannot export an old UI snapshot.
            const currentEntries = await readRecoveryEntries();
            const exportedAt = new Date().toISOString();
            const blob = new Blob([JSON.stringify({
                format: "ai-phone-push-outbox-recovery",
                version: 1,
                exportedAt,
                entries: currentEntries,
            }, null, 2)], { type: "application/json;charset=utf-8" });
            await downloadFile(blob, `离线消息原文-${exportedAt.slice(0, 10)}.json`);
        } catch {
            if (mounted.current) setExportError("未能读取或导出原文，请刷新后重试；手机上请确认系统分享可用。");
        } finally {
            if (mounted.current) setExporting(false);
        }
    };

    const displayedEntries = (entries ?? []).slice().sort((a, b) =>
        (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)
    ).slice(0, DISPLAY_LIMIT);

    return (
        <>
            <p className="menu-group-desc mx-2">离线消息原文</p>
            <div className="menu-group">
                <div className="menu-item" style={{ alignItems: "stretch", flexDirection: "column", gap: 10 }}>
                    <div className="flex items-center gap-2">
                        <span className="menu-label flex-1" aria-live="polite">
                            {loading ? "正在读取本机原文…" : readFailed ? "暂时无法读取" : `${entries?.length ?? 0} 条已保留原文`}
                        </span>
                        <button type="button" className="ui-btn ui-btn-outline py-1 px-3 ts-12" onClick={() => void refresh()} disabled={loading}>
                            刷新
                        </button>
                        <button type="button" className="ui-btn ui-btn-outline py-1 px-3 ts-12" onClick={() => void exportOriginals()} disabled={loading || exporting || readFailed || !entries?.length}>
                            {exporting ? "导出中…" : "导出全部"}
                        </button>
                    </div>
                    <span className="menu-desc !mt-0">这里保留新版接收到、等待合并或需要留档的推送原文，供查看和复制。旧版已收取的消息不一定能找回。</span>
                    {readFailed && <span className="menu-desc !mt-0" role="alert">本机记录暂时无法读取，无法确认是否有待合并或留存的原文。请稍后刷新重试。</span>}
                    {!loading && !readFailed && entries?.length === 0 && <span className="menu-desc !mt-0">本机暂时没有待合并或留存的原文。</span>}
                    {exportError && <span className="menu-desc !mt-0" role="alert">{exportError}</span>}
                    {!readFailed && displayedEntries.map(entry => (
                        <details key={entry.id} className="rounded-lg border border-[var(--c-border)] p-3">
                            <summary className="cursor-pointer ts-13 text-[var(--c-text)]">
                                {formatCreatedAt(entry.createdAt)} · {entry.state === "orphaned" ? "已保留原文" : "等待合并"}
                            </summary>
                            <p className="menu-desc mt-2 mb-2">
                                {entry.state === "orphaned" ? "这条原文已留存，可展开查看或复制；它可能需要核对原聊天，也可能是已处理事件的留档。" : "等待同步到原聊天；你也可以先复制原文留存。"}
                            </p>
                            <textarea
                                className="w-full rounded-lg border border-[var(--c-border)] bg-transparent p-2 ts-13 text-[var(--c-text)]"
                                aria-label={`${formatCreatedAt(entry.createdAt)}的离线消息原文`}
                                value={entry.rawText}
                                readOnly
                                rows={6}
                                onFocus={event => event.currentTarget.select()}
                            />
                        </details>
                    ))}
                    {!readFailed && (entries?.length ?? 0) > DISPLAY_LIMIT && <span className="menu-desc !mt-0">仅显示最近 {DISPLAY_LIMIT} 条；导出全部可查看其余原文。</span>}
                </div>
            </div>
        </>
    );
}
