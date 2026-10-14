import type { ChatMessage } from "./chat-storage";
import { IncompleteReplyError } from "./llm-stream-completion";
import { cleanStreamText } from "./stream-preview";

export function createIncompleteReplyNotice(
    error: unknown,
    options?: Parameters<typeof cleanStreamText>[1],
): Pick<ChatMessage, "content" | "mediaType" | "generationFailure"> | null {
    if (!(error instanceof IncompleteReplyError)) return null;
    return {
        content: `⚠️ 回复未完成：${error.message}`,
        // Existing prompt/timeline filters exclude tool_notice, including its partial text.
        mediaType: "tool_notice",
        generationFailure: { partialContent: cleanStreamText(error.partialContent, options), reason: error.reason },
    };
}
