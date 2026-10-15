import { findForbiddenAddressTerms, loadCharacterPreferences } from "./character-preferences";
import { IncompleteReplyError } from "./llm-stream-completion";
import { cleanStreamText } from "./stream-preview";

/** A local validation failure, never a network failure or an automatic retry request. */
export class PreferenceViolationError extends IncompleteReplyError {
    constructor(public readonly forbiddenTerms: string[], draft: string) {
        super(`这次回复包含已禁用的称呼（${forbiddenTerms.join("、")}），未作为正式回复保存，草稿已保留。可以手动重新生成。`, draft, "preference_violation");
        this.name = "PreferenceViolationError";
    }
}

/** Call after stripping action blocks, before persisting prose or executing any actions/tools.
 * Checks local visible conversation text only; native tool arguments and reasoning are not
 * passed here. This is an exact configured-term safeguard, not semantic address detection. */
export function assertCharacterReplyPreferences(text: string, characterId: string): void {
    const preferences = loadCharacterPreferences(characterId);
    if (!preferences.enabled || !preferences.checkReplies || preferences.forbiddenNames.length === 0) return;
    const visible = cleanStreamText(
        // A voice transcript is visible/replayable conversation text, not a tool argument.
        text.replace(/\[语音条\s*[:：]([^\]\r\n]*)\]/g, "$1")
            .replace(/[\[【]\s*(?:接受|拒绝)头像推荐\s*[\]】]/g, "")
            .replace(/[\[【]\s*(?:给用户备注|给你备注|用户备注)\s*[：:]\s*[^\]】\n]{1,40}\s*[\]】]/g, ""),
        { stripXmlTags: ["thinking", "thought", "think"] },
    );
    const terms = findForbiddenAddressTerms(visible, preferences);
    if (terms.length > 0) throw new PreferenceViolationError(terms, visible);
}
