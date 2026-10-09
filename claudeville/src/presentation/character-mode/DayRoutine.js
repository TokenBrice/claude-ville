// W4.9 (PL-P10) — the town keeps a schedule. This is the one daypart weight
// table: every chooser that biases an *undirected* destination by the time of
// day reads it here (the idle stroll, the working errand, the night rest seat,
// the no-signal home district). It never overrides a real intent: weights only
// tilt picks the world already makes when the session gives no signal.
//
// Pure and deterministic: the only input is the local hour (fractional, from
// AtmosphereState's clock, so `setHour` pins it). No agent state flows the
// other way; sky, weather and grade never read anything here (V3).
//
//   morning (05–10)  muster near Command and the Task board
//   midday  (10–17)  spread out to the workshops
//   golden  (17–21)  drift toward the harbour rail and the lighthouse shore
//   night   (21–05)  fewer strollers, longer sits, idles gather at the lit
//                    braziers on Command's steps

export const DAYPARTS = Object.freeze(['morning', 'midday', 'golden', 'night']);

// Score delta per doubling of a scenic weight. The renderer's scenic scorer
// spreads candidates over ~0‥36 by seed plus 1.4 per tile of distance, so a
// ×2 weight is worth about eight tiles of walking: a tilt, never a mandate.
export const SCENIC_BIAS_PER_DOUBLING = 12;

// Night: the seats by Command's lit braziers count this many walk steps
// nearer, so a villager across the plaza takes the brazier step over its own
// green, and one across the water still sits on its own side.
export const BRAZIER_SEAT_STEPS = 18;
export const BRAZIER_SEAT_IDS = Object.freeze(['command-east-step-n', 'command-east-step-s', 'command-west-step']);

const freezeEntry = (entry) => Object.freeze({
    ...entry,
    buildings: Object.freeze({ ...entry.buildings }),
    districts: Object.freeze({ ...entry.districts }),
    tags: Object.freeze({ ...entry.tags }),
});

// buildings: errand and home-district weights by building type (missing = 1).
// districts / tags: scenic-point weights by AMBIENT_SCENIC_POINTS district and
// tag (a point's weight is its district weight times each of its tags').
// strollCap: concurrent idle strollers. sitScale: multiplies the seeded sit.
export const DAYPART_TABLE = Object.freeze({
    morning: freezeEntry({
        buildings: { command: 2, taskboard: 1.8, harbor: 0.8, mine: 0.8 },
        districts: { civic: 2, harbor: 0.8 },
        tags: { command: 1.6, taskboard: 1.4 },
        strollCap: 6,
        sitScale: 1,
    }),
    midday: freezeEntry({
        buildings: { forge: 1.6, mine: 1.4, archive: 1.3, observatory: 1.2, portal: 1.2, command: 0.8 },
        districts: { workshop: 1.8, resource: 1.6, knowledge: 1.4, arcane: 1.3, civic: 0.8 },
        tags: { forge: 1.3, mine: 1.3 },
        strollCap: 6,
        sitScale: 1,
    }),
    golden: freezeEntry({
        buildings: { harbor: 2, watchtower: 1.6, command: 0.9, mine: 0.8 },
        districts: { harbor: 2.2, civic: 0.9, resource: 0.7 },
        tags: { water: 1.4, watchtower: 1.6 },
        strollCap: 6,
        sitScale: 1,
    }),
    night: freezeEntry({
        buildings: { command: 1.6, harbor: 0.8, mine: 0.7, portal: 0.8 },
        districts: { civic: 1.8, harbor: 0.7, resource: 0.5, arcane: 0.6, knowledge: 0.7, workshop: 0.7 },
        tags: { command: 1.6 },
        strollCap: 3,
        sitScale: 1.6,
    }),
});

/** The hour folded into [0, 24); a missing or non-finite hour reads as midday. */
export function normalizeHour(hour) {
    if (hour == null || hour === '') return 12;
    const value = Number(hour);
    if (!Number.isFinite(value)) return 12;
    return ((value % 24) + 24) % 24;
}

export function daypartForHour(hour) {
    const h = normalizeHour(hour);
    if (h >= 5 && h < 10) return 'morning';
    if (h >= 10 && h < 17) return 'midday';
    if (h >= 17 && h < 21) return 'golden';
    return 'night';
}

export function daypartEntry(hour) {
    return DAYPART_TABLE[daypartForHour(hour)];
}

/** Frozen { [buildingType]: weight } for errands and home districts; missing types weigh 1. */
export function buildingWeightsForHour(hour) {
    return daypartEntry(hour).buildings;
}

export function buildingWeightForHour(hour, buildingType) {
    const weight = buildingWeightsForHour(hour)[buildingType];
    return Number.isFinite(weight) ? weight : 1;
}

export function scenicWeightForHour(hour, point) {
    const entry = daypartEntry(hour);
    let weight = entry.districts[point?.district] ?? 1;
    for (const tag of point?.tags || []) weight *= entry.tags[tag] ?? 1;
    return weight;
}

/** Score delta for the renderer's scenic scorer (lower wins): negative for a favoured point. */
export function scenicScoreBias(hour, point) {
    const weight = scenicWeightForHour(hour, point);
    return weight > 0 ? -Math.round(Math.log2(weight) * SCENIC_BIAS_PER_DOUBLING) : 0;
}

export function strollCapForHour(hour) {
    return daypartEntry(hour).strollCap;
}

export function sitScaleForHour(hour) {
    return daypartEntry(hour).sitScale;
}

/** Walk-step delta for a rest seat (negative = preferred): the brazier steps at night. */
export function restSeatStepBias(hour, seat) {
    if (daypartForHour(hour) !== 'night' || !seat) return 0;
    return BRAZIER_SEAT_IDS.includes(seat.id) ? -BRAZIER_SEAT_STEPS : 0;
}
