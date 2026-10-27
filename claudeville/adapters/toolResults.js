/**
 * Bounded provider-reported command results.
 *
 * A result record exists only where a provider explicitly reported the outcome
 * of a call it already finished: Codex `item_completed.CommandExecution`, Kimi
 * Code `tool.result` with an exit code or an error flag, OpenCode tool
 * state with a numeric `metadata.exit`, OMP paired `toolResult` records, and
 * Claude paired `tool_result` blocks carrying an explicit `is_error`.
 * Invocation is not a result, and a tool call disappearing from a transcript
 * tail is not a result either. Providers without such a record (Gemini, Grok)
 * carry no `lastResults`, and nothing downstream may synthesize one.
 *
 * The id is derived from provider, session, and call identity so the same
 * finished command keeps one identity across polls; consumers deduplicate on it
 * instead of on receipt time.
 */

const { shellLocationOf } = require('./shared');

const TOOL_RESULT_LIMIT = 5;
const TOOL_RESULT_ID_MAX_LENGTH = 256;
const TOOL_NAME_MAX_LENGTH = 64;
const TOOL_RESULT_DETAIL_MAX_LENGTH = 80;
// Where `exitCode` came from: `'exit'` is a process exit status the provider
// wrote down; `'flag'` is derived from a boolean error flag (error -> 1,
// explicit success -> 0). Null when the exit code is unknown or the producer
// does not say.
const EXIT_CODE_SOURCES = new Set(['exit', 'flag']);

function fingerprint(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Stable identity for one finished call. Provider call ids are preferred; when
 * a provider does not expose one, the observed completion time and the call's
 * own shape stand in, which is still stable across re-reads of the same
 * transcript because both are read from the record, never from receipt time.
 */
function toolResultId({ provider, sessionId, callId, tool, detail, completedAt }) {
  const scope = `${provider || ''}:${sessionId || ''}`;
  const call = String(callId || '').trim();
  if (call) return `${scope}:${call}`.slice(0, TOOL_RESULT_ID_MAX_LENGTH);
  const at = Number.isFinite(Number(completedAt)) ? Math.trunc(Number(completedAt)) : 0;
  return `${scope}:${at}:${fingerprint(`${tool || ''}\u001f${detail || ''}`)}`.slice(0, TOOL_RESULT_ID_MAX_LENGTH);
}

/**
 * Where a call ran, as a short fingerprint (RG-10): the working directory the
 * provider recorded for it, plus the `cd <dir>` hops and `git -C <dir>` flags
 * its command summary drops. One summary run in two directories is two
 * different commands. Null when the call names no location at all.
 */
function toolResultLocation({ cwd = null, command = null } = {}) {
  const parts = [typeof cwd === 'string' ? cwd.trim() : '', shellLocationOf(command)].filter(Boolean);
  return parts.length ? fingerprint(parts.join('\u001f')) : null;
}

function boundedInteger(value, { nonnegative = false } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const truncated = Math.trunc(numeric);
  return nonnegative ? Math.max(0, truncated) : truncated;
}

/**
 * Validate, deduplicate and cap a producer's result list. Newest first, at most
 * `TOOL_RESULT_LIMIT` entries, so a busy session cannot grow the list payload.
 * An entry without an id, a tool name, an observation source, or an observed
 * completion time is dropped rather than repaired: an unattributable outcome is
 * worse than a missing one.
 */
function normalizeToolResults(value) {
  if (!Array.isArray(value)) return [];
  const byId = new Map();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' ? item.id.trim().slice(0, TOOL_RESULT_ID_MAX_LENGTH) : '';
    const tool = typeof item.tool === 'string' ? item.tool.trim().slice(0, TOOL_NAME_MAX_LENGTH) : '';
    const source = item.source === 'hook' || item.source === 'transcript' ? item.source : null;
    const completedAt = boundedInteger(item.completedAt, { nonnegative: true });
    if (!id || !tool || !source || !completedAt) continue;
    if (byId.has(id)) continue;
    const exitCode = boundedInteger(item.exitCode);
    byId.set(id, {
      id,
      tool,
      detail: typeof item.detail === 'string'
        ? item.detail.trim().slice(0, TOOL_RESULT_DETAIL_MAX_LENGTH)
        : '',
      exitCode,
      exitCodeSource: exitCode !== null && EXIT_CODE_SOURCES.has(item.exitCodeSource) ? item.exitCodeSource : null,
      durationMs: boundedInteger(item.durationMs, { nonnegative: true }),
      completedAt,
      source,
      location: typeof item.location === 'string' && /^[0-9a-f]{8}$/.test(item.location) ? item.location : null,
      // True when the call printed nothing, false when it printed something,
      // null when the provider record does not say (RG-2).
      noOutput: typeof item.noOutput === 'boolean' ? item.noOutput : null,
    });
  }
  return [...byId.values()]
    .sort((a, b) => b.completedAt - a.completedAt)
    .slice(0, TOOL_RESULT_LIMIT);
}

module.exports = {
  TOOL_RESULT_LIMIT,
  normalizeToolResults,
  toolResultId,
  toolResultLocation,
};
