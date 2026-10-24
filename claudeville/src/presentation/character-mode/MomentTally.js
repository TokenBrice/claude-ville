// D qw — how often each one-shot moment actually fired since this page
// loaded, so a review can read real fire rates instead of inferring them.
// Diagnostic only (Shift-D's `moments` row);
// nothing in the world reads it.

const tally = new Map();
let since = Date.now();

/** Count one fired moment of `kind` (`arrival`, `celebrate`, `mend`, …). */
export function noteMoment(kind) {
    const key = String(kind || '');
    if (!key) return;
    tally.set(key, (tally.get(key) || 0) + 1);
}

/** `{ since, counts: { kind: n } }`, kinds sorted by name. */
export function momentTally() {
    const counts = {};
    for (const key of [...tally.keys()].sort()) counts[key] = tally.get(key);
    return { since, counts };
}

export function resetMomentTally(now = Date.now()) {
    tally.clear();
    since = now;
}
