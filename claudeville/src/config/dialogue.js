/**
 * Display policy for provenance-tagged villager speech.
 *
 * Extraction, sanitation, the source gate, and candidate selection all happen
 * server-side in `claudeville/adapters/dialogue.js`. This module owns only the
 * questions the client must answer on its own: is the line still current, and
 * does it render as speech or as a status chip.
 *
 * `DIALOGUE_STALE_MS` intentionally mirrors `DIALOGUE_MAX_AGE_MS` in
 * `adapters/dialogue.js`. The two module systems (CommonJS server, ES modules
 * client) cannot share a constant without a build step, so the value is
 * duplicated deliberately — change both together.
 */

// A line older than this no longer describes what the agent is doing now, so
// the villager falls silent rather than presenting stale work as current.
export const DIALOGUE_STALE_MS = 90_000;

// Long-form reasoning renders as a tailless chip, never as a speech bubble: an
// excerpt of a 200-character thought is not a quote, and quote styling would
// claim more fidelity than the text has.
const CHIP_KINDS = new Set(['thinking']);

export const DIALOGUE_SHAPE = Object.freeze({ BUBBLE: 'bubble', CHIP: 'chip' });

export function dialogueShape(kind) {
    return CHIP_KINDS.has(String(kind)) ? DIALOGUE_SHAPE.CHIP : DIALOGUE_SHAPE.BUBBLE;
}

const KIND_LABELS = Object.freeze({
    intent: 'Model-authored intent',
    plan: 'Model plan step',
    thinking: 'Model reasoning',
    assistant: 'Assistant message',
});

/**
 * Human-readable origin for the bubble tooltip, derived from the dotted
 * `source` id the adapter emitted, so it can never claim a source that was not
 * actually read. Trimming and redaction are always disclosed.
 */
export function dialogueSourceLabel({ kind, source, fidelity, redacted } = {}) {
    const base = KIND_LABELS[String(kind)] || 'Session text';
    const origin = String(source || '').trim();
    const notes = [];
    if (fidelity === 'excerpt') notes.push('excerpt');
    if (redacted) notes.push('redacted');
    const suffix = notes.length ? ` (${notes.join(', ')})` : '';
    return origin ? `${base} — ${origin}${suffix}` : `${base}${suffix}`;
}
