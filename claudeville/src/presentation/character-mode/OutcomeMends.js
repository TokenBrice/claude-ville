// D2 — the Mended Mark. One agent runs one shell command, it fails with a
// real process exit code, and later the very same command passes: that is
// the honest success signal coding work produces, so the world marks it once.
//
// Pure ledger, fed the `tool:result` events in the order they were observed.
// It never guesses: a provider error flag (`exitCodeSource: 'flag'`: harness
// guard blocks, permission denials, Edit misses) still draws its red chit but
// never opens a mend, an unknown exit neither opens nor closes one, and a
// different tool, command or agent passing never closes one.

import { classifyShellInput } from '../../domain/services/ToolIdentity.js';

// A failure older than this when its command passes is history, not a mend.
export const MEND_WINDOW_MS = 30 * 60_000;
// After a mend, the same command by the same agent is quiet for this long: a
// flaky fail/pass loop is one beat, never a repeating celebration.
export const MEND_QUIET_MS = 10 * 60_000;
// Open failures held at once (oldest dropped first).
export const MEND_OPEN_LIMIT = 64;
// Adapters cut a result's command summary at 80 characters without a marker
// (`adapters/toolResults.js`), so a summary this long may be a prefix shared
// by two different commands: it never opens or closes a mend.
export const MEND_DETAIL_MAX = 79;

// Shell tools whose result is the command's own exit (not a stdin write).
const SHELL_TOOLS = new Set([
    'Bash',
    'shell',
    'exec',
    'exec_command',
    'functions.exec_command',
    'command_execution',
]);
// A check or a program run can be mended; a search (`rg` exits 1 on no
// match), a read, a web fetch or a git command (the Harbor owns those) cannot.
const MENDABLE_REASONS = new Set(['verify', 'run-shell']);

const ENV_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/;
const STDERR_MERGE = /\s+2>&1(?=\s|$)/g;

/**
 * The normalized command a result ran, or null when it cannot take part in a
 * mend: not a shell tool, a possibly truncated summary, or not a check or a
 * program run. Leading `VAR=value` assignments, `2>&1` and runs of spaces are
 * dropped; pipes and arguments are kept, since they change what the exit
 * code reports.
 */
export function commandSignature(tool, detail) {
    if (!SHELL_TOOLS.has(String(tool || ''))) return null;
    const raw = typeof detail === 'string' ? detail.trim() : '';
    if (!raw || raw.length > MEND_DETAIL_MAX) return null;
    const text = raw.replace(ENV_PREFIX, '').replace(STDERR_MERGE, '').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    const classified = classifyShellInput(text);
    return classified && MENDABLE_REASONS.has(classified.reason) ? text : null;
}

function finiteExit(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

export class MendLedger {
    constructor({
        windowMs = MEND_WINDOW_MS,
        quietMs = MEND_QUIET_MS,
        openLimit = MEND_OPEN_LIMIT,
    } = {}) {
        this.windowMs = windowMs;
        this.quietMs = quietMs;
        this.openLimit = openLimit;
        this._open = new Map();
        this._quietUntil = new Map();
    }

    /**
     * Fold one `tool:result`. Returns the mend `{ agentId, tool, signature,
     * failedId, failedExit, resultId, building, failedAt, at }` when this
     * result closes an open failure, else null.
     */
    observe(event) {
        const agentId = event?.agentId == null ? '' : String(event.agentId);
        const exitCode = finiteExit(event?.exitCode);
        if (!agentId || exitCode === null) return null;
        const signature = commandSignature(event.tool, event.detail);
        if (!signature) return null;
        const at = Number(event.completedAt);
        if (!Number.isFinite(at)) return null;
        const key = `${agentId}\u001f${event.tool}\u001f${signature}`;

        if (exitCode !== 0) {
            // Only a real process exit opens a mend; a flag-only failure is
            // a chit, not evidence the command itself failed.
            if (event.exitCodeSource !== 'exit') return null;
            if (at < (this._quietUntil.get(key) ?? -Infinity)) return null;
            // The newest failure stands for its command.
            this._open.delete(key);
            this._open.set(key, { at, id: event.id ?? null, exitCode });
            while (this._open.size > this.openLimit) this._open.delete(this._open.keys().next().value);
            return null;
        }

        const failure = this._open.get(key);
        if (!failure) return null;
        this._open.delete(key);
        if (at < failure.at || at - failure.at > this.windowMs) return null;
        this._quietUntil.set(key, at + this.quietMs);
        while (this._quietUntil.size > this.openLimit) this._quietUntil.delete(this._quietUntil.keys().next().value);
        return {
            agentId,
            tool: String(event.tool),
            signature,
            failedId: failure.id,
            failedExit: failure.exitCode,
            failedAt: failure.at,
            resultId: event.id ?? null,
            building: event.building ?? null,
            at,
        };
    }

    /** Forget a departed agent's open failures. */
    forgetAgent(agentId) {
        const prefix = `${agentId}\u001f`;
        for (const key of [...this._open.keys()]) if (key.startsWith(prefix)) this._open.delete(key);
        for (const key of [...this._quietUntil.keys()]) if (key.startsWith(prefix)) this._quietUntil.delete(key);
    }

    get openCount() {
        return this._open.size;
    }

    clear() {
        this._open.clear();
        this._quietUntil.clear();
    }
}
