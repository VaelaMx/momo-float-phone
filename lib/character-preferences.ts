import { hydrateKvDb, isKvHydrated, kvGet, kvSetConfirmedAsync, registerDynamicPrefix } from "./kv-db";

/** Per-character user preferences; separate from automatically summarized memories. */
export type CharacterPreferences = {
    version: 1;
    enabled: boolean;
    preferredNames: string[];
    forbiddenNames: string[];
    instructions: string;
    checkReplies: boolean;
    updatedAt: string;
};

export const CHARACTER_PREFERENCES_PREFIX = "ai_phone_character_preferences_v1:";
export const CHARACTER_PREFERENCES_UPDATED_EVENT = "character-preferences-updated";
export const CHARACTER_PREFERENCES_LIMITS = {
    namesPerList: 8,
    nameLength: 32,
    instructionsLength: 600,
} as const;

export const DEFAULT_CHARACTER_PREFERENCES: CharacterPreferences = {
    version: 1,
    enabled: false,
    preferredNames: [],
    forbiddenNames: [],
    instructions: "",
    checkReplies: true,
    updatedAt: "",
};

registerDynamicPrefix(CHARACTER_PREFERENCES_PREFIX);

function normalizeText(value: string): string {
    return value.normalize("NFKC").replace(/[\u200B-\u200D\u2060\uFEFF]/g, "");
}

function cleanText(value: unknown): string {
    return typeof value === "string"
        ? normalizeText(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim()
        : "";
}

function normalizeNames(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const names = value
        .map(item => cleanText(item).slice(0, CHARACTER_PREFERENCES_LIMITS.nameLength))
        .filter(Boolean);
    return [...new Set(names)].slice(0, CHARACTER_PREFERENCES_LIMITS.namesPerList);
}

/** Normalize untrusted persisted/imported values without writing anything. */
export function normalizeCharacterPreferences(value: unknown): CharacterPreferences {
    const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
    return {
        version: 1,
        enabled: input.enabled === true,
        preferredNames: normalizeNames(input.preferredNames),
        forbiddenNames: normalizeNames(input.forbiddenNames),
        instructions: cleanText(input.instructions).slice(0, CHARACTER_PREFERENCES_LIMITS.instructionsLength),
        checkReplies: input.checkReplies !== false,
        updatedAt: typeof input.updatedAt === "string" && Number.isFinite(Date.parse(input.updatedAt))
            ? new Date(input.updatedAt).toISOString()
            : "",
    };
}

export function loadCharacterPreferences(characterId: string): CharacterPreferences {
    if (!characterId) return normalizeCharacterPreferences(null);
    try {
        const raw = kvGet(CHARACTER_PREFERENCES_PREFIX + characterId);
        return normalizeCharacterPreferences(raw ? JSON.parse(raw) : null);
    } catch {
        return normalizeCharacterPreferences(null);
    }
}

export async function saveCharacterPreferences(
    characterId: string,
    input: Partial<CharacterPreferences>,
): Promise<CharacterPreferences> {
    if (typeof window === "undefined" || !characterId.trim()) {
        throw new Error("无法保存此角色的固定偏好，请返回角色页面重试。");
    }
    await hydrateKvDb();
    if (!isKvHydrated()) throw new Error("本地资料尚未读取成功，请稍后重试，避免覆盖已有偏好。");
    const preferences = normalizeCharacterPreferences({
        ...loadCharacterPreferences(characterId),
        ...input,
        updatedAt: new Date().toISOString(),
    });
    const conflictingNames = preferences.preferredNames.filter(name => preferences.forbiddenNames.includes(name));
    if (conflictingNames.length) {
        throw new Error(`同一称呼不能同时允许和禁用：${conflictingNames.join("、")}`);
    }
    await kvSetConfirmedAsync(CHARACTER_PREFERENCES_PREFIX + characterId, JSON.stringify(preferences));
    window.dispatchEvent(new CustomEvent(CHARACTER_PREFERENCES_UPDATED_EVENT, { detail: { characterId } }));
    return preferences;
}

function escapeXml(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function formatCharacterPreferencesPrompt(characterId: string, prefs: CharacterPreferences): string {
    const current = normalizeCharacterPreferences(prefs);
    if (!current.enabled || (!current.preferredNames.length && !current.forbiddenNames.length && !current.instructions)) return "";
    const lines = [
        `<characterPreferences characterId="${escapeXml(characterId)}">`,
        "以下为用户为本角色明确保存的当前偏好。若旧聊天、旧记忆或旧设定中的称呼与此冲突，以这里的新约定为准；其余人设和世界观保持原样。",
    ];
    if (current.preferredNames.length) lines.push(`可用称呼：${current.preferredNames.map(escapeXml).join("、")}。只使用用户已提供的姓名，不编造姓名。`);
    if (current.forbiddenNames.length) lines.push(`不要用以下称呼称呼用户：${current.forbiddenNames.map(escapeXml).join("、")}。不要因旧对话出现这些称呼而恢复使用。`);
    if (current.instructions) lines.push(`补充约定：${escapeXml(current.instructions)}`);
    lines.push("</characterPreferences>");
    return lines.join("\n");
}

/** Explicit string matching only; a quotation can also match and should be reviewed. */
export function findForbiddenAddressTerms(text: string, prefs: CharacterPreferences): string[] {
    const current = normalizeCharacterPreferences(prefs);
    if (!current.enabled || !current.checkReplies) return [];
    const normalized = normalizeText(text);
    return current.forbiddenNames.filter(term => normalized.includes(term));
}
