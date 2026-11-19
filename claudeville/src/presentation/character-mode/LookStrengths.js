// Enchant plan D5, D6 and D10 (2026-11-03): every new light, weather and
// phenomenon look ships behind one strength in [0, 1]. At 0 the look is off
// and the frame is today's; at 1 it is the look as proposed. The user picks
// each final value from a capture board of 0, 0.5 and 1, and the picks become
// the defaults below.
//
// Consumers read `lookStrength(id)` while they build their state. A consumer
// that memoizes keys its cache on `lookStrengthsVersion()`, so an override
// lands on the next build. `setLookStrength` is the capture board's and the
// tests' hook (a page evaluate imports this module); product code never calls
// it.

export const DEFAULT_LOOK_STRENGTHS = Object.freeze({
    la1b: 1, // LA-1b: fog dims the sun's road
    la3: 1, // LA-3: the golden-hour sea lift
    la4: 1, // LA-4: the moon's road on every moonlit night
    la5: 1, // LA-5: pearl overcast
    la6a: 1, // LA-6a: the after-rain bow over the far sea
    la6b: 1, // LA-6b: the aurora sheen on the far sea
    la7: 1, // LA-7: sea fret
    bi8: 1, // BI-8: the summer surf glow
    nl1: 1, // NL-1: the firelight palette ramp on every landmark (a switch: > 0 is on)
    nl2: 0.5, // NL-2: firelight on people (lamp-side and top rim, firmer lit side; scales both)
    nl3: 1, // NL-3: a lamp throws the villager's own silhouette instead of the stepped trail (scales its density)
    nl4: 1, // NL-4: a lantern carried by villagers abroad after lamp-lighting (scales the pool)
    ms1: 1, // MS-1: low mist the town rises out of (> 0 replaces the GPU fog banks; scales the mist's top)
    ms2: 1, // MS-2: lamps glow in the mist, the mist burns off land-first (needs ms1 > 0; scales halos and burn)
    sea1: 0.5, // SEA-1: cloud light and shade on the plane, sunlit water lifts (> 0 shape on; a ceiling on the lift: 0.5 one stop, 1 two)
    sea2: 1, // SEA-2: lit swell and caps take the sky's hue (scales the share)
    sea3: 1, // SEA-3: the wind sets the sea state, calm to fresh (scales the ladder's reach and streaks)
    gw1: 0.5, // GW-1: wet ground read from the weather field: dry aprons, streets dry sun side first (scales the sheen; retires that share of the uniform darkening)
    gw2: 1, // GW-2: puddles and wet paving tops mirror the lamps (scales the mirror columns)
    gw3: 1, // GW-3: frost lies in solid low-frequency patches (> 0 on; scales grain and crease fill)
    wx1: 1, // WX-1: night takes its extra fog from overcast, so rain can start at night (a switch: >= 0.5 is on)
    sd1: 1, // SD-1: shape-true sun shade on the ground from the shade field (> 0 retires the sun trails; scales the shade's density)
    sd1len: 0.5, // SD-1: how long a low sun's shade may grow (0 = 1.0, 1 = 3.5 times a caster's height)
    sd2: 1, // SD-2: walls, roofs, props and villagers take the sun's shade (needs sd1 > 0; scales the step they drop)
    sd3: 0.5, // SD-3: the sun lifts the land and the surfaces it reaches, one stepped course before the grade (needs sd1 > 0; scales the lift)
    ey4: 1, // EY-4: falling snow wears a pearl grade, lighter and softer than rain's (the share of the rain row that blends toward the snow row)
    rn1: 1, // RN-1: rain falls in the world, depth-sorted on the GPU paths (the share of streaks and splashes moved off the overlay)
});

export const LOOK_IDS = Object.freeze(Object.keys(DEFAULT_LOOK_STRENGTHS));

const overrides = new Map();
let version = 0;

function assertLookId(id) {
    if (!Object.hasOwn(DEFAULT_LOOK_STRENGTHS, id)) throw new RangeError(`unknown look id: ${id}`);
}

export function lookStrength(id) {
    assertLookId(id);
    return overrides.has(id) ? overrides.get(id) : DEFAULT_LOOK_STRENGTHS[id];
}

export function setLookStrength(id, value) {
    assertLookId(id);
    const number = Number(value);
    if (!Number.isFinite(number)) throw new RangeError(`look strength must be a number: ${value}`);
    overrides.set(id, Math.min(1, Math.max(0, number)));
    version += 1;
    return overrides.get(id);
}

export function resetLookStrengths() {
    overrides.clear();
    version += 1;
}

export function lookStrengthsVersion() {
    return version;
}
