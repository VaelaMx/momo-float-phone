import type { LlmProviderKind } from "./llm-provider-adapter";

export class IncompleteReplyError extends Error {
    constructor(message: string, public readonly partialContent: string, public readonly reason: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "IncompleteReplyError";
    }
}

export function finishReasonFailure(reason: unknown): string | undefined {
    if (typeof reason !== "string" || !reason.trim()) return undefined;
    const normalized = reason.trim().toLowerCase();
    if (["length", "max_tokens", "max_output_tokens", "max_completion_tokens"].includes(normalized)) {
        return "模型达到输出长度上限，回复未完成。可调整输出上限后重新生成。";
    }
    if (["stop", "tool_calls", "function_call", "end_turn", "stop_sequence", "tool_use"].includes(normalized)) return undefined;
    return `供应商以 ${reason} 结束生成，回复可能未完成，请检查后重试。`;
}

/** Completion is a provider signal, never merely a successful HTTP EOF. */
export function createStreamCompletionTracker(provider: LlmProviderKind) {
    let terminal = false;
    let failure: string | undefined;
    const finish = (reason: unknown) => {
        if (typeof reason !== "string" || !reason.trim()) return;
        if (reason.toLowerCase() === "finish_reason_unspecified") return;
        failure ||= finishReasonFailure(reason);
        // Anthropic sends message_stop after message_delta's stop_reason.
        if (provider !== "anthropic") terminal = true;
    };
    return {
        observeEvent(event: string) {
            if (event.split("\n").some(line => /^data:\s*\[DONE\]\s*$/.test(line))) terminal = true;
            if (/^event:\s*error\s*$/m.test(event)) failure ||= "供应商在生成过程中返回错误，回复未完成。";
        },
        observeValue(value: unknown) {
            if (!value || typeof value !== "object") return;
            const data = value as Record<string, any>;
            if (data.error || data.type === "error") failure ||= "供应商在生成过程中返回错误，回复未完成。";
            if (provider === "anthropic") {
                if (data.type === "message_delta") finish(data.delta?.stop_reason);
                if (data.type === "message_stop") terminal = true;
            } else if (provider === "gemini") {
                finish(data.candidates?.[0]?.finishReason);
            } else {
                finish(data.choices?.[0]?.finish_reason);
            }
        },
        failure() {
            return failure || (terminal ? undefined : "连接已结束，但没有收到完整结束标记，回复可能中断。可重新生成。");
        },
    };
}
