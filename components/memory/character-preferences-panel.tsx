"use client";

import { useEffect, useId, useState } from "react";
import { Toggle } from "@/components/ui/form";
import { hydrateKvDb, isKvHydrated } from "@/lib/kv-db";
import {
    CHARACTER_PREFERENCES_LIMITS,
    loadCharacterPreferences,
    normalizeCharacterPreferences,
    saveCharacterPreferences,
} from "@/lib/character-preferences";

function splitNames(value: string): string[] {
    return [...new Set(value.split(/[\n,，、]+/).map(name => name.trim()).filter(Boolean))];
}

export function CharacterPreferencesPanel({ characterId }: { characterId: string }) {
    const id = useId();
    const [saved, setSaved] = useState(() => normalizeCharacterPreferences(null));
    const [enabled, setEnabled] = useState(saved.enabled);
    const [preferredNames, setPreferredNames] = useState(saved.preferredNames.join("\n"));
    const [forbiddenNames, setForbiddenNames] = useState(saved.forbiddenNames.join("\n"));
    const [instructions, setInstructions] = useState(saved.instructions);
    const [checkReplies, setCheckReplies] = useState(saved.checkReplies);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState("");
    const [loadAttempt, setLoadAttempt] = useState(0);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setLoadError("");
        setError("");
        setMessage("");
        void (async () => {
            try {
                await hydrateKvDb();
                if (!isKvHydrated()) throw new Error("本地资料尚未读取成功，请重试后再编辑固定偏好。");
                const current = loadCharacterPreferences(characterId);
                if (cancelled) return;
                setSaved(current);
                setEnabled(current.enabled);
                setPreferredNames(current.preferredNames.join("\n"));
                setForbiddenNames(current.forbiddenNames.join("\n"));
                setInstructions(current.instructions);
                setCheckReplies(current.checkReplies);
            } catch (err) {
                if (!cancelled) setLoadError(err instanceof Error ? err.message : "固定偏好读取失败，请重试。");
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [characterId, loadAttempt]);

    const preferred = splitNames(preferredNames);
    const forbidden = splitNames(forbiddenNames);
    const lists = [preferred, forbidden];
    const overLimit = lists.some(names => names.length > CHARACTER_PREFERENCES_LIMITS.namesPerList
        || names.some(name => name.length > CHARACTER_PREFERENCES_LIMITS.nameLength))
        || instructions.trim().length > CHARACTER_PREFERENCES_LIMITS.instructionsLength;
    const normalizedDraft = normalizeCharacterPreferences({ preferredNames: preferred, forbiddenNames: forbidden });
    const conflictingNames = normalizedDraft.preferredNames.filter(name => normalizedDraft.forbiddenNames.includes(name));
    const hasContent = preferred.length > 0 || forbidden.length > 0 || Boolean(instructions.trim());
    const dirty = enabled !== saved.enabled || checkReplies !== saved.checkReplies
        || JSON.stringify(preferred) !== JSON.stringify(saved.preferredNames)
        || JSON.stringify(forbidden) !== JSON.stringify(saved.forbiddenNames)
        || instructions.trim() !== saved.instructions;

    const fillExample = () => {
        setEnabled(true);
        setCheckReplies(true);
        setPreferredNames("老婆\n宝宝");
        setForbiddenNames("弥长官");
        setInstructions("其他自然亲昵的爱称也可以，或直接使用我已经明确提供的名字；不要使用“长官”类称呼，不要自行编造我的姓名。");
        setMessage("称呼示例已填入草稿，请按自己的偏好修改，再点保存。");
        setError("");
    };

    const save = async () => {
        if (loading || loadError || busy || overLimit || conflictingNames.length || (enabled && !hasContent)) return;
        setBusy(true);
        setMessage("");
        setError("");
        try {
            const result = await saveCharacterPreferences(characterId, {
                enabled, preferredNames: preferred, forbiddenNames: forbidden, instructions, checkReplies,
            });
            setSaved(result);
            setPreferredNames(result.preferredNames.join("\n"));
            setForbiddenNames(result.forbiddenNames.join("\n"));
            setInstructions(result.instructions);
            setMessage(result.enabled ? "固定偏好已保存，将从下一次生成开始使用。" : "固定偏好已保存并关闭，内容会保留。");
        } catch (err) {
            setError(err instanceof Error ? `未能确认保存成功：${err.message}` : "未能确认保存成功，请稍后重试。");
        } finally {
            setBusy(false);
        }
    };

    const renderNamesField = (label: string, value: string, onChange: (next: string) => void, names: string[], suffix: string) => (
        <div className="mt-3">
            <label className="font-medium" htmlFor={`${id}-${suffix}`}>{label}</label>
            <textarea
                id={`${id}-${suffix}`}
                className="ui-textarea mt-1 w-full"
                rows={3}
                value={value}
                disabled={busy}
                onChange={event => onChange(event.target.value)}
                placeholder="每行一个，也可用顿号或逗号分隔"
                style={{ minHeight: 80, resize: "vertical" }}
            />
            <p className="text-secondary">{names.length}/{CHARACTER_PREFERENCES_LIMITS.namesPerList} 个，每个最多 {CHARACTER_PREFERENCES_LIMITS.nameLength} 字</p>
        </div>
    );

    if (loading || loadError) {
        return (
            <details className="g-card p-3 ts-12 leading-relaxed" open>
                <summary className="font-medium">固定偏好</summary>
                {loading ? <p className="text-secondary mt-2" role="status">正在读取固定偏好...</p> : (
                    <>
                        <p className="mt-2" role="alert">{loadError}</p>
                        <button type="button" className="ui-btn ui-btn-outline mt-2" onClick={() => setLoadAttempt(attempt => attempt + 1)}>
                            重新读取
                        </button>
                    </>
                )}
            </details>
        );
    }

    return (
        <details className="g-card p-3 ts-12 leading-relaxed">
            <summary className="font-medium" style={{ cursor: "pointer" }}>
                固定偏好 · {saved.enabled ? "已开启" : "未开启"}{dirty ? " · 有未保存修改" : ""}
            </summary>
            <p className="text-secondary mt-2">保存这个角色应该持续遵守的称呼和约定。开启后每轮聊天单独带入，新的称呼约定优先于旧聊天中的用法。</p>
            <fieldset disabled={busy} className="border-0 p-0 m-0 min-w-0">
                <label className="flex items-center justify-between gap-3 mt-3">
                    <span>启用固定偏好</span>
                    <Toggle checked={enabled} disabled={busy} onChange={setEnabled} />
                </label>
                <button type="button" className="ui-btn ui-btn-outline mt-3" onClick={fillExample}>
                    填入称呼示例
                </button>
                <p className="text-secondary mt-1">示例只填入草稿，不会自动保存。已有内容会被示例替换。</p>
                {renderNamesField("可以叫我的称呼", preferredNames, setPreferredNames, preferred, "preferred")}
                {renderNamesField("不要叫我的称呼", forbiddenNames, setForbiddenNames, forbidden, "forbidden")}
                <div className="mt-3">
                    <label className="font-medium" htmlFor={`${id}-instructions`}>补充约定</label>
                    <textarea
                        id={`${id}-instructions`}
                        className="ui-textarea mt-1 w-full"
                        rows={4}
                        value={instructions}
                        onChange={event => setInstructions(event.target.value)}
                        placeholder="例如：其他亲昵的爱称也可以；不使用长官类称呼。"
                        style={{ minHeight: 110, resize: "vertical" }}
                    />
                    <p className="text-secondary">{instructions.trim().length}/{CHARACTER_PREFERENCES_LIMITS.instructionsLength} 字</p>
                </div>
                <label className="flex items-center justify-between gap-3 mt-3">
                    <span>检查回复中的禁用称呼</span>
                    <Toggle checked={checkReplies} disabled={busy} onChange={setCheckReplies} />
                </label>
                <p className="text-secondary mt-1">检查当前页面内生成的私聊和群聊回复。线下模式会带入偏好提醒；后台推送与微信独立运行暂不支持这项检查。</p>
                <p className="text-secondary mt-1">按上面填写的词检查并提醒，不自动替换消息；引用或讨论这个词也可能触发。补充约定中的泛称不会自动加入检查。</p>
                {overLimit && <p className="mt-2" role="alert">内容超过限制，请缩短后再保存。</p>}
                {conflictingNames.length > 0 && <p className="mt-2" role="alert">同一称呼不能同时允许和禁用：{conflictingNames.join("、")}</p>}
                {enabled && !hasContent && <p className="text-secondary mt-2">请先填写至少一项偏好，再开启保存。</p>}
                <button
                    type="button"
                    className="ui-btn ui-btn-primary mt-3 w-full"
                    disabled={busy || !dirty || overLimit || Boolean(conflictingNames.length) || (enabled && !hasContent)}
                    onClick={() => void save()}
                >
                    {busy ? "保存中..." : "保存固定偏好"}
                </button>
            </fieldset>
            {message && <p className="mt-2" role="status">{message}</p>}
            {error && <p className="mt-2" role="alert">{error}</p>}
        </details>
    );
}
