"use client";

export function IncompleteReplyNotice({ message, partialContent, busy, onRetry }: {
    message: string;
    partialContent: string;
    busy: boolean;
    onRetry: () => void;
}) {
    return (
        <div className="flex flex-col gap-2">
            <span>{message}</span>
            {partialContent && (
                <details>
                    <summary>查看本次回复草稿（未作为正式回复保存）</summary>
                    <textarea className="ui-textarea mt-1" aria-label="本次回复草稿" readOnly value={partialContent} rows={5} />
                </details>
            )}
            <button
                className="ui-btn ui-btn-outline"
                disabled={busy}
                onClick={event => { event.stopPropagation(); onRetry(); }}
            >重新生成</button>
        </div>
    );
}
