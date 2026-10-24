// Pure helpers for parsing the recipient alias out of a summarized
// agent-messaging tool-input string (Claude `SendMessage`, Codex
// `send_message` / `send_input`, OMP `send_message`). Returns the alias unchanged so callers
// can compare against agent name/agentName/agentId directly.
//
// Heuristic order:
//   1. JSON parse for `{ "recipient_name": "..." }`.
//   2. `recipient_name: <alias>` / `recipient_name = <alias>` (with optional quotes).
//   3. Fallback: trimmed single-token input that looks like a plausible name.

// `target` is Codex `send_message`'s addressee (a sub-agent's task path leaf);
// `to` is Claude `SendMessage`'s.
const RECIPIENT_KEYS = ['recipient_name', 'recipientName', 'recipient', 'target', 'to'];

/**
 * The last segment of a Codex sub-agent's `agent_path` ("/root/composition"
 * -> "composition"): the name its orchestrator addresses it by.
 */
export function agentPathAlias(agent) {
    const value = typeof agent?.agentPath === 'string' ? agent.agentPath : '';
    return value.split('/').filter(Boolean).pop() || null;
}

function stripQuotes(value) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    if ((text.startsWith('"') && text.endsWith('"'))
        || (text.startsWith("'") && text.endsWith("'"))) {
        return text.slice(1, -1).trim();
    }
    return text;
}

function tryJsonRecipient(text) {
    if (!text || !/^[\[{]/.test(text)) return null;
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of candidates) {
        if (!item || typeof item !== 'object') continue;
        for (const key of RECIPIENT_KEYS) {
            const value = item[key];
            if (typeof value === 'string' && value.trim()) return value.trim();
        }
    }
    return null;
}

function tryFieldPattern(text) {
    const match = text.match(
        /^recipient[_ ]?name\s*[:=]\s*["']?([^,"'\n]+?)["']?\s*(?:,|$)/i,
    );
    if (match?.[1]) return match[1].trim();
    return null;
}

function tryPlainAlias(text) {
    if (!text) return null;
    if (/[\s,:={}\[\]"']/.test(text)) return null;
    if (text.length > 64) return null;
    return text;
}

export function extractRecipientName(rawInput) {
    if (rawInput == null) return null;
    const text = typeof rawInput === 'string' ? rawInput.trim() : String(rawInput).trim();
    if (!text) return null;

    const fromJson = tryJsonRecipient(text);
    if (fromJson) return stripQuotes(fromJson) || null;

    const fromField = tryFieldPattern(text);
    if (fromField) return stripQuotes(fromField) || null;

    const fromAlias = tryPlainAlias(text);
    if (fromAlias) return stripQuotes(fromAlias) || null;

    return null;
}
