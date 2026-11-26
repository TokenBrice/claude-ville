// W3.1 — shadow-theatre windows (spec 04 §1.5). A lit room pane carries the
// shadow of the worker or patron who holds it: one of thirteen code-drawn
// archetype silhouettes, never a downsampled pose cell (§1.3: at pane scale an
// arm becomes 0.9 texel and crawls between frames). Rows follow the
// CarriedLantern grammar: `#` is ink (the pane's own unlit albedo, written by
// RoomGlass), `.` is glass that stays lit. The stamp is identity-free: one
// bit, no trim colour.
//
// Sizes name the clean glass width a pane offers (`shadowClassFor`, RoomGlass):
// S4 and S5 heads are 2 x 2 and 3 x 3, S6 heads 3 x 3; shoulders run jamb to
// jamb and the torso stands on the sill. Pure and Node-safe (no DOM).

// The largest stamp a pane may ever carry.
export const SHADOW_STAMP_MAX_W = 6;
export const SHADOW_STAMP_MAX_H = 10;
// A full bust may stand at most this share of the clean glass height; a taller
// stamp drops to its four-row head-and-shoulders cut.
export const SHADOW_BUST_MAX_SHARE = 0.6;
export const SHADOW_CUT_ROWS = 4;

const rows = (...lines) => Object.freeze(lines);

// family -> size -> frames (each frame a list of equal-width row strings).
export const ROOM_SHADOW_STAMPS = Object.freeze({
    // `think`, idle stand, `scan`, anything unlisted. One frame; the body's
    // real pacing slides it one texel (`dx`, BuildingSprite).
    upright: Object.freeze({
        S4: Object.freeze([rows(
            '.##.',
            '.##.',
            '####',
            '####',
            '####',
            '####',
        )]),
        S5: Object.freeze([rows(
            '.###.',
            '.###.',
            '.###.',
            '#####',
            '#####',
            '#####',
            '#####',
        )]),
        S6: Object.freeze([rows(
            '.###..',
            '.###..',
            '.###..',
            '######',
            '######',
            '######',
        )]),
    }),
    // `read`, `gaze`: the head one texel lower and one toward the lectern side;
    // frame 2 lights one texel at the book (the turned page catches the lamp).
    bowed: Object.freeze({
        S4: Object.freeze([
            rows(
                '....',
                '..##',
                '.###',
                '####',
                '####',
                '####',
            ),
            rows(
                '....',
                '..##',
                '.###',
                '###.',
                '####',
                '####',
            ),
        ]),
        S5: Object.freeze([
            rows(
                '.....',
                '..###',
                '..###',
                '.####',
                '#####',
                '#####',
                '#####',
            ),
            rows(
                '.....',
                '..###',
                '..###',
                '.####',
                '####.',
                '#####',
                '#####',
            ),
        ]),
    }),
    // `tinker`, `strike` outside the Forge: `upright`, plus a 1 x 2 arm column
    // beside the head on frame 2.
    arm: Object.freeze({
        S4: Object.freeze([
            rows(
                '.##.',
                '.##.',
                '####',
                '####',
                '####',
                '####',
            ),
            rows(
                '.###',
                '.###',
                '####',
                '####',
                '####',
                '####',
            ),
        ]),
        S5: Object.freeze([
            rows(
                '.###.',
                '.###.',
                '.###.',
                '#####',
                '#####',
                '#####',
                '#####',
            ),
            rows(
                '.####',
                '.####',
                '.###.',
                '#####',
                '#####',
                '#####',
                '#####',
            ),
        ]),
    }),
    // `sit`, `drink` (Tavern patrons): a low bust at the sill; frame 2 lifts the
    // tankard texel from the shoulder row to the head row on the real seeded sip.
    seated: Object.freeze({
        S6: Object.freeze([
            rows(
                '.###..',
                '.###..',
                '.###..',
                '######',
                '######',
            ),
            rows(
                '.###..',
                '.###..',
                '.###.#',
                '#####.',
                '######',
            ),
        ]),
    }),
});

export const SHADOW_FAMILIES = Object.freeze(Object.keys(ROOM_SHADOW_STAMPS));
export const SHADOW_SIZES = Object.freeze(['S4', 'S5', 'S6']);

const FAMILY_BY_POSE = Object.freeze({
    read: 'bowed',
    gaze: 'bowed',
    tinker: 'arm',
    strike: 'arm',
    sit: 'seated',
    drink: 'seated',
});

/** The stamp family for an occupant's live pose group (null or unlisted: `upright`). */
export function shadowFamilyForPose(poseGroup) {
    return FAMILY_BY_POSE[poseGroup] || 'upright';
}

/** The family a pane of `size` really draws: a family without that size stands `upright`. */
export function resolveShadowFamily(family, size) {
    return ROOM_SHADOW_STAMPS[family]?.[size] ? family : 'upright';
}

/** Ink texels (`#`) in a stamp's rows. */
export function stampInk(stampRows) {
    let ink = 0;
    for (const row of stampRows || []) {
        for (let i = 0; i < row.length; i++) if (row[i] === '#') ink++;
    }
    return ink;
}

function firstInkRow(stampRows) {
    const index = stampRows.findIndex((row) => row.includes('#'));
    return index < 0 ? 0 : index;
}

function freezeStamp(family, size, frame, stampRows, cut) {
    return Object.freeze({
        family,
        size,
        frame,
        cut,
        rows: stampRows,
        width: stampRows[0]?.length || 0,
        height: stampRows.length,
        ink: stampInk(stampRows),
    });
}

// Every (family, size) frame set, full and cut, built once. The cut starts at
// the first row any frame inks, so both frames of a family share one cut and
// the figure never hops between a full bust and a cut on the frame toggle.
const VARIANTS = new Map();
for (const family of SHADOW_FAMILIES) {
    for (const size of Object.keys(ROOM_SHADOW_STAMPS[family])) {
        const frames = ROOM_SHADOW_STAMPS[family][size];
        const top = Math.min(...frames.map(firstInkRow));
        const full = frames.map((frameRows, frame) => freezeStamp(family, size, frame, frameRows, false));
        const cut = frames.map((frameRows, frame) => freezeStamp(
            family,
            size,
            frame,
            Object.freeze(frameRows.slice(top, top + SHADOW_CUT_ROWS)),
            true,
        ));
        VARIANTS.set(`${family}:${size}`, Object.freeze({
            full: Object.freeze(full),
            cut: Object.freeze(cut),
            fullHeight: Math.max(...full.map((stamp) => stamp.height)),
            fullInk: Math.max(...full.map((stamp) => stamp.ink)),
            cutInk: Math.max(...cut.map((stamp) => stamp.ink)),
        }));
    }
}

/** Number of frames of `family` at `size` (after the `upright` fallback), or 0 for an unknown size. */
export function shadowFrameCount(family, size) {
    if (!SHADOW_SIZES.includes(size)) return 0;
    return VARIANTS.get(`${resolveShadowFamily(family, size)}:${size}`)?.full.length || 0;
}

/**
 * The stamp for `family` on a pane of class `size` ('S4' | 'S5' | 'S6'):
 * `{ rows, width, height, family, size, frame, cut, ink }`, frozen, or null for
 * an unknown size. `frame` wraps over the family's frames. A bust taller than
 * SHADOW_BUST_MAX_SHARE x `cleanHeight`, or heavier than `maxInk` on any of its
 * frames, returns the four-row head-and-shoulders cut; null when even the cut
 * breaks either bound (nothing narrower or shorter ever gets ink).
 */
export function stampForShadow(family, size, frame = 0, cleanHeight = 10, maxInk = Infinity) {
    if (!SHADOW_SIZES.includes(size)) return null;
    const variant = VARIANTS.get(`${resolveShadowFamily(family, size)}:${size}`);
    if (!variant) return null;
    const count = variant.full.length;
    const index = ((Math.trunc(Number(frame) || 0) % count) + count) % count;
    const tallest = SHADOW_BUST_MAX_SHARE * (Number(cleanHeight) || 0);
    const budget = Number.isFinite(Number(maxInk)) ? Number(maxInk) : Infinity;
    if (variant.fullHeight <= tallest && variant.fullInk <= budget) return variant.full[index];
    if (SHADOW_CUT_ROWS > tallest || variant.cutInk > budget) return null;
    return variant.cut[index];
}

/** Every distinct authored stamp (13): `{ family, size, frame, rows }`. */
export function allShadowStamps() {
    const out = [];
    for (const family of SHADOW_FAMILIES) {
        for (const size of Object.keys(ROOM_SHADOW_STAMPS[family])) {
            ROOM_SHADOW_STAMPS[family][size].forEach((stampRows, frame) => out.push({ family, size, frame, rows: stampRows }));
        }
    }
    return out;
}
