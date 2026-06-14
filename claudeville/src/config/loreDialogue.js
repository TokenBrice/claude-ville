/**
 * Lore dialogue pool — short village-flavored bubble lines keyed by
 * building type, mood, and time of day.
 *
 * Lines without a `mood`/`time` tag are always eligible; tagged lines are
 * eligible only when the agent's mood or the local time-of-day phase
 * matches, and carry a higher weight so they dominate when they apply.
 *
 * Selection is deterministic: agents roll once per LORE_BUBBLE_WINDOW_MS
 * bucket from a hash of their id, matching the seeded-randomness patterns
 * used elsewhere (Appearance.fromHash, AtmosphereState's seeded weather).
 * Keep every line at or under 24 characters (the bubble text cap).
 */

// Share of time buckets in which an agent speaks lore instead of its
// tool label (0..1).
export const LORE_BUBBLE_CHANCE = 0.25;
// How long a single lore pick (or its absence) stays stable.
export const LORE_BUBBLE_WINDOW_MS = 45_000;

// Building keys match `buildingForTool` outputs (domain/services/ToolIdentity.js).
// `village` is the fallback pool for agents with no known building.
export const LORE_DIALOGUE = {
    forge: [
        { text: 'Sparks are flying.' },
        { text: 'Hammering it out.' },
        { text: 'Hot iron, true code.' },
        { text: 'This metal fights me.', mood: 'distressed', weight: 3 },
        { text: 'Finest steel today!', mood: 'proud', weight: 3 },
        { text: 'Arms ache, anvil sings.', mood: 'tired', weight: 3 },
        { text: 'Forge lit before sun.', time: 'dawn', weight: 2 },
        { text: 'Embers light the work.', time: 'night', weight: 2 },
    ],
    archive: [
        { text: 'So many scrolls…' },
        { text: 'The lore runs deep.' },
        { text: 'A page is missing!', mood: 'distressed', weight: 3 },
        { text: 'Found the old text!', mood: 'proud', weight: 3 },
        { text: 'Ink blurs together.', mood: 'tired', weight: 3 },
        { text: 'First light on vellum.', time: 'dawn', weight: 2 },
        { text: 'Candle and codex.', time: 'night', weight: 2 },
    ],
    command: [
        { text: 'Council is gathered.' },
        { text: 'Orders from the keep.' },
        { text: 'Our lines are crossed!', mood: 'distressed', weight: 3 },
        { text: 'The plan holds!', mood: 'proud', weight: 3 },
        { text: 'Long war-table talks.', mood: 'tired', weight: 3 },
        { text: 'Early muster today.', time: 'dawn', weight: 2 },
        { text: 'Late council tonight.', time: 'night', weight: 2 },
    ],
    taskboard: [
        { text: 'Pinning new notices.' },
        { text: 'The board fills up.' },
        { text: 'Too many notices!', mood: 'distressed', weight: 3 },
        { text: 'Another task done!', mood: 'proud', weight: 3 },
        { text: 'So much left to post.', mood: 'tired', weight: 3 },
    ],
    observatory: [
        { text: 'Charting far stars.' },
        { text: 'The lens shows much.' },
        { text: 'Clouds block the sky!', mood: 'distressed', weight: 3 },
        { text: 'A new star is named!', mood: 'proud', weight: 3 },
        { text: 'Eyes tired of stars.', mood: 'tired', weight: 3 },
        { text: 'Stars fade at dawn.', time: 'dawn', weight: 2 },
        { text: 'Clear skies tonight.', time: 'night', weight: 2 },
    ],
    mine: [
        { text: 'Reading token seams.' },
        { text: 'Deep vein, low quota.' },
        { text: 'Ore carts need count.' },
        { text: 'Quota shaft is tight!', mood: 'distressed', weight: 3 },
        { text: 'Rich vein uncovered!', mood: 'proud', weight: 3 },
        { text: 'Pick arms are spent.', mood: 'tired', weight: 3 },
        { text: 'Dawn shift in the pit.', time: 'dawn', weight: 2 },
        { text: 'Lanterns on the seam.', time: 'night', weight: 2 },
    ],
    portal: [
        { text: 'The gate hums softly.' },
        { text: 'Far lands answer.' },
        { text: 'The portal flickers!', mood: 'distressed', weight: 3 },
        { text: 'A clean crossing!', mood: 'proud', weight: 3 },
        { text: 'Gate-lag sets in.', mood: 'tired', weight: 3 },
        { text: 'Dawn thins the veil.', time: 'dawn', weight: 2 },
        { text: 'Stars tune the gate.', time: 'night', weight: 2 },
    ],
    harbor: [
        { text: 'Ships in the bay.' },
        { text: 'Cargo for the main.' },
        { text: 'Rough seas today!', mood: 'distressed', weight: 3 },
        { text: 'Shipment delivered!', mood: 'proud', weight: 3 },
        { text: 'Docks never sleep.', mood: 'tired', weight: 3 },
        { text: 'Tide turns at dawn.', time: 'dawn', weight: 2 },
        { text: 'Lanterns on the pier.', time: 'night', weight: 2 },
    ],
    village: [
        { text: 'Just passing through.' },
        { text: 'Fine day in the ville.' },
        { text: 'Something feels off…', mood: 'distressed', weight: 3 },
        { text: 'Good work all round!', mood: 'proud', weight: 3 },
        { text: 'A rest would be nice.', mood: 'tired', weight: 3 },
        { text: 'Morning, neighbor.', time: 'dawn', weight: 2 },
        { text: 'Busy streets today.', time: 'day', weight: 2 },
        { text: 'Lanterns soon.', time: 'dusk', weight: 2 },
        { text: 'The village sleeps.', time: 'night', weight: 2 },
    ],
};

/**
 * Local time-of-day phase. Boundaries mirror the PHASES table in
 * presentation/character-mode/AtmosphereState.js (dawn 5:30–7:00,
 * day 7:00–17:30, dusk 17:30–20:00, night otherwise); keep them in sync.
 */
export function timeOfDayPhase(date = new Date()) {
    const minute = date.getHours() * 60 + date.getMinutes();
    if (minute >= 330 && minute < 420) return 'dawn';
    if (minute >= 420 && minute < 1050) return 'day';
    if (minute >= 1050 && minute < 1200) return 'dusk';
    return 'night';
}

// FNV-1a string hash mapped to [0, 1) for seeded, stable rolls.
function hashToUnit(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0) / 0x100000000;
}

/**
 * Deterministically pick a lore line, or null when this agent's current
 * time bucket is not a lore bucket (most buckets are not).
 *
 * @param {object} options
 * @param {string} options.seedKey       stable per-agent key (agent id)
 * @param {string|null} options.buildingType  building from tool classification
 * @param {string} [options.mood]        agent mood type (AgentMood)
 * @param {Date}   [options.date]        local clock, injectable for tests
 * @returns {string|null}
 */
export function pickLoreLine({ seedKey, buildingType, mood, date = new Date() } = {}) {
    if (!seedKey) return null;
    const bucket = Math.floor(date.getTime() / LORE_BUBBLE_WINDOW_MS);
    if (hashToUnit(`${seedKey}|lore-gate|${bucket}`) >= LORE_BUBBLE_CHANCE) return null;

    const pool = LORE_DIALOGUE[buildingType] || LORE_DIALOGUE.village;
    const phase = timeOfDayPhase(date);
    const candidates = pool.filter(line =>
        (!line.mood || line.mood === mood) &&
        (!line.time || line.time === phase));
    if (!candidates.length) return null;

    const totalWeight = candidates.reduce((sum, line) => sum + (line.weight || 1), 0);
    let roll = hashToUnit(`${seedKey}|lore-pick|${bucket}`) * totalWeight;
    for (const line of candidates) {
        roll -= line.weight || 1;
        if (roll < 0) return line.text;
    }
    return candidates[candidates.length - 1].text;
}
