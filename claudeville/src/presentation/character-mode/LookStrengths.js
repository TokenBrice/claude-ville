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
