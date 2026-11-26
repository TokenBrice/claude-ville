// Wave 6-B — The Loom of Days (`ChronicleLoom.js`).
//
// Pure, deterministic Bayeux-style hourly frieze weaver and zero-text pixel
// renderer for ClaudeVille's Chronicle. Works identically in browsers (vanilla
// ES modules, zero runtime dependencies) and pure Node (RGBA pixel buffers +
// lossless PNG encoding) so determinism and byte-identity are verified without
// a browser.
//
// Spec authority: 04-diegetic-ui-audio-spec.md §5.4 (The Loom of Days) & §4.11
// (Tapestry Loom band y 1124-1340, 1152 x 216 px, 12 panels x 2 rows).

import {
    ChronicleEventKind,
    chronicleDateKey,
} from '../../application/ChronicleLog.js';
import {
    ART_RAMPS,
    EFFECT_COLORS,
    PENNANT_PALETTE,
    WEATHER_SNOW_COLORS,
} from '../../config/artPalette.js';
import { THEME } from '../../config/theme.js';

// --- Canonical Layout & Timing Constants ------------------------------------

export const LOOM_PANEL_WIDTH = 96;
export const LOOM_PANEL_HEIGHT = 72;
export const LOOM_HOURS_PER_DAY = 24;
export const LOOM_QUARTERS_PER_HOUR = 4;
export const LOOM_TOTAL_QUARTERS = LOOM_HOURS_PER_DAY * LOOM_QUARTERS_PER_HOUR; // 96 bits
export const LOOM_QUARTER_WIDTH = 24; // 4 * 24 = 96 px
export const LOOM_WARP_STRIDE = 4;    // vertical warp threads every 4 px

export const LOOM_BANDS = Object.freeze({
    topSelvedge: Object.freeze({ y: 0, height: 2 }),     // rows 0-1
    skyBorder: Object.freeze({ y: 2, height: 10 }),      // rows 2-11
    field: Object.freeze({ y: 12, height: 48 }),         // rows 12-59
    repoPennants: Object.freeze({ y: 60, height: 10 }),  // rows 60-69
    bottomSelvedge: Object.freeze({ y: 70, height: 2 }), // rows 70-71
});

export const LOOM_GRID = Object.freeze({
    cols: 3,
    rows: 2,
    maxCells: 6,
    cellWidth: 28,
    cellHeight: 22,
    gapX: 4,        // 3 * 28 + 2 * 4 = 92 px (+ 2 px left/right margin = 96 px)
    gapY: 4,        // 2 * 22 + 1 * 4 = 48 px (exact fit in rows 12-59)
    marginX: 2,
    marginY: 0,
    actorWidth: 14,
    actorHeight: 16,
    actorGap: 2,
    stampSize: 12,  // 14 + 2 + 12 = 28 px exact
});

// Tapestry Loom band (§4.11): y 1124-1340 -> 216 px tall, 1152 px wide inside
// the 24 px walnut border of the 1200 x 1600 Tapestry (24 + 72 + 24 + 72 + 24).
export const LOOM_TAPESTRY_BAND = Object.freeze({
    y: 1124,
    height: 216,
    width: 1152,
    cols: 12,
    rows: 2,
    padX: 0,
    padY: 24,
    colGap: 0,
    rowGap: 24,
});

// Extended event kinds including the Wave 3/6 additions (`compacted`, `release`)
// without mutating `ChronicleLog.js`.
export const LOOM_EVENT_KIND = Object.freeze({
    ...ChronicleEventKind,
    COMPACTED: 'compacted',
    RELEASE: 'release',
});

// Exact event weights (§5.4):
//   release 6 · push 5 · mended 4 · errored (still open) 4 · commit 3 ·
//   waiting (>= 5 min) 3 · compacted 2 · rate_limited 2 · completed 1.
//   A resolved/mended `errored` event drops from weight 4 to weight 2 so open
//   incidents remain dominant while historical resolved errors remain visible.
//   `arrived` and `departed` are border ticks on the selvedge only, never cells.
export const LOOM_EVENT_WEIGHTS = Object.freeze({
    release: 6,
    push: 5,
    mended: 4,
    errored: 4,
    erroredResolved: 2,
    commit: 3,
    waiting: 3,
    compacted: 2,
    rate_limited: 2,
    completed: 1,
});

export const LOOM_WAIT_UNIT_MS = 5 * 60 * 1000; // 300_000 ms (5 minutes)
export const LOOM_MAX_PIPS = 5;
export const LOOM_MAX_WAIT_KNOTS = 6;

export const ERROR_RESOLVING_KINDS = Object.freeze([
    LOOM_EVENT_KIND.MENDED,
    LOOM_EVENT_KIND.RESOLVED,
    LOOM_EVENT_KIND.COMPLETED,
    LOOM_EVENT_KIND.DEPARTED,
]);

const ERROR_RESOLVING_KIND_SET = new Set(ERROR_RESOLVING_KINDS);

const CELL_ELIGIBLE_KINDS = new Set([
    LOOM_EVENT_KIND.RELEASE,
    LOOM_EVENT_KIND.PUSH,
    LOOM_EVENT_KIND.MENDED,
    LOOM_EVENT_KIND.ERRORED,
    LOOM_EVENT_KIND.COMMIT,
    LOOM_EVENT_KIND.WAITING,
    LOOM_EVENT_KIND.COMPACTED,
    LOOM_EVENT_KIND.RATE_LIMITED,
    LOOM_EVENT_KIND.COMPLETED,
]);

// --- Pure Color Helpers (Derived from artPalette.js & theme.js) -------------

function parseHexRgba(hex, alpha = 255) {
    const clean = String(hex || '#000000').replace('#', '').trim();
    const full = clean.length === 3
        ? clean[0] + clean[0] + clean[1] + clean[1] + clean[2] + clean[2]
        : clean.slice(0, 6);
    const value = Number.parseInt(full, 16);
    if (!Number.isFinite(value)) return [0, 0, 0, alpha];
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255, alpha];
}

function mixRgba(a, b, t) {
    return [
        Math.round(a[0] + (b[0] - a[0]) * t),
        Math.round(a[1] + (b[1] - a[1]) * t),
        Math.round(a[2] + (b[2] - a[2]) * t),
        255,
    ];
}

// House tapestry palette — strictly anchored on ART_RAMPS, EFFECT_COLORS, and
// THEME tokens (no private status hex tables).
const PALETTE = Object.freeze({
    ink: parseHexRgba(ART_RAMPS.ashlar[0]),               // #050302
    inkWarm: parseHexRgba(ART_RAMPS.timber[0]),           // #2a1c14
    warpBg: parseHexRgba(ART_RAMPS.void[1]),              // #101418
    warpBgAlt: parseHexRgba(ART_RAMPS.void[2]),           // #171d21
    warpLight: parseHexRgba(ART_RAMPS.plaza[3]),          // #a79984
    warpMid: parseHexRgba(ART_RAMPS.plaza[2]),            // #928473
    linenBase: parseHexRgba(ART_RAMPS.sand[2]),           // #c5b086
    linenLight: parseHexRgba(ART_RAMPS.sand[3]),          // #d2bd93
    linenRib: parseHexRgba(ART_RAMPS.sand[1]),            // #b7a279
    linenSeam: parseHexRgba(ART_RAMPS.plaza[1]),          // #7c6e69
    undyedBase: parseHexRgba(ART_RAMPS.plaza[2]),         // #928473
    undyedLight: parseHexRgba(ART_RAMPS.plaza[3]),        // #a79984
    undyedSeam: parseHexRgba(ART_RAMPS.plaza[1]),         // #7c6e69
    selvedgeDark: parseHexRgba(ART_RAMPS.timber[1]),      // #45301f
    selvedgeMid: parseHexRgba(ART_RAMPS.timber[2]),       // #654629
    selvedgeStitch: parseHexRgba(ART_RAMPS.clothOchre[0]), // #987638
    pennantBg: parseHexRgba(ART_RAMPS.sand[0]),           // #a8936c
    pennantBgAlt: parseHexRgba(ART_RAMPS.plaza[2]),       // #928473
    pennantPole: parseHexRgba(ART_RAMPS.timber[0]),       // #2a1c14
    arrivalTick: parseHexRgba(ART_RAMPS.trimGold[3]),     // #fae174
    arrivalTickCore: parseHexRgba(ART_RAMPS.trimGold[1]), // #d4984e
    departureTick: parseHexRgba(ART_RAMPS.ashlar[6]),     // #a99f9a
    departureTickCore: parseHexRgba(ART_RAMPS.ashlar[4]), // #7f767f
    plateFill: parseHexRgba(ART_RAMPS.timber[0]),         // #2a1c14
    plateInner: parseHexRgba(ART_RAMPS.timber[1]),        // #45301f
    plateRim: parseHexRgba(ART_RAMPS.trimGold[1]),        // #d4984e
    platePin: parseHexRgba(ART_RAMPS.trimGold[3]),        // #fae174
    plateInk: parseHexRgba(ART_RAMPS.blossomIvory[3]),    // #d8d1bb
    beamDark: parseHexRgba(ART_RAMPS.timber[0]),          // #2a1c14
    beamMid: parseHexRgba(ART_RAMPS.timber[1]),           // #45301f
    beamLit: parseHexRgba(ART_RAMPS.timber[2]),           // #654629
    beamBrass: parseHexRgba(ART_RAMPS.clothOchre[1]),     // #c9a04a
    // Plain slate pawn colors (V8 honest fallback when no model sheet resolves).
    pawnOutline: parseHexRgba(ART_RAMPS.ashlar[0]),       // #050302
    pawnDark: parseHexRgba(ART_RAMPS.slate[0]),           // #1e2433
    pawnMid: parseHexRgba(ART_RAMPS.slate[2]),            // #3e4d6c
    pawnLight: parseHexRgba(ART_RAMPS.slate[3]),          // #5a6c8c
    pawnPlinth: parseHexRgba(ART_RAMPS.stone[2]),         // #4d4f5a
    // Sky & weather colors (aligned with GradeEvaluator & artPalette).
    skyNightTop: parseHexRgba('#080e1d'),
    skyNightMid: parseHexRgba('#0f1729'),
    skyNightBot: parseHexRgba('#162033'),
    skyDawnTop: parseHexRgba('#2e4a7a'),
    skyDawnMid: parseHexRgba('#847888'),
    skyDawnBot: parseHexRgba('#e2a98a'),
    skyDayTop: parseHexRgba('#4a86c0'),
    skyDayMid: parseHexRgba('#7fb0d6'),
    skyDayBot: parseHexRgba('#b8d6e6'),
    skyGoldenTop: parseHexRgba('#3f6ea0'),
    skyGoldenMid: parseHexRgba('#9a908c'),
    skyGoldenBot: parseHexRgba('#f0b27a'),
    skyDuskTop: parseHexRgba('#13234d'),
    skyDuskMid: parseHexRgba('#423e68'),
    skyDuskBot: parseHexRgba('#785c84'),
    cloudLight: parseHexRgba(ART_RAMPS.snow[3]),          // #d9dfe1
    cloudMid: parseHexRgba(ART_RAMPS.snow[1]),            // #b0bcc7
    cloudDark: parseHexRgba(ART_RAMPS.roofSlate[3]),      // #37436a
    stormTop: parseHexRgba(ART_RAMPS.roofSlate[0]),       // #1c2139
    stormMid: parseHexRgba(ART_RAMPS.roofSlate[2]),       // #2f355e
    stormBot: parseHexRgba(ART_RAMPS.stone[2]),           // #4d4f5a
    rainStreak: parseHexRgba(ART_RAMPS.wetSlate[2]),      // #7d91b0
    snowFlake: parseHexRgba(WEATHER_SNOW_COLORS.body),    // #eef6ff
    starBright: parseHexRgba(ART_RAMPS.snow[2]),          // #c7d0d6
    moonBright: parseHexRgba(ART_RAMPS.snow[4]),          // #e6e9e6
    moonShade: parseHexRgba(ART_RAMPS.roofSlate[1]),      // #272b4f
    lightning: parseHexRgba(EFFECT_COLORS.peak),          // #fff3bf
    fogBand: parseHexRgba(ART_RAMPS.snow[1]),             // #b0bcc7
    // Pip / knot colors.
    pipFill: parseHexRgba(ART_RAMPS.timber[0]),           // #2a1c14
    pipLit: parseHexRgba(ART_RAMPS.trimGold[2]),          // #ebb754
    knotFill: parseHexRgba(THEME.waitingOnUser),          // status authority
    knotShadow: parseHexRgba(ART_RAMPS.timber[0]),        // #2a1c14
    numeralInk: parseHexRgba(ART_RAMPS.timber[0]),        // #2a1c14
    numeralHi: parseHexRgba(ART_RAMPS.blossomIvory[3]),   // #d8d1bb
});

const PENNANT_RGBA_TABLE = Object.freeze(PENNANT_PALETTE.map((hex) => {
    const base = parseHexRgba(hex);
    return Object.freeze({
        hex,
        base,
        light: mixRgba(base, PALETTE.plateInk, 0.28),
        dark: mixRgba(base, PALETTE.inkWarm, 0.36),
    });
}));

// Stamp palettes derived strictly from THEME / ART_RAMPS / EFFECT_COLORS.
const STAMP_PALETTES = Object.freeze({
    release: Object.freeze({
        k: PALETTE.inkWarm,
        p: parseHexRgba(ART_RAMPS.trimGold[2]),
        h: parseHexRgba(ART_RAMPS.trimGold[3]),
        s: parseHexRgba(ART_RAMPS.trimGold[0]),
        a: parseHexRgba(ART_RAMPS.clothCrimson[1]),
    }),
    push: Object.freeze({
        k: PALETTE.inkWarm,
        p: parseHexRgba(ART_RAMPS.shallowWater[2]),
        h: parseHexRgba(ART_RAMPS.snow[4]),
        s: parseHexRgba(ART_RAMPS.deepWater[2]),
        a: parseHexRgba(ART_RAMPS.timber[2]),
    }),
    pushFailed: Object.freeze({
        k: PALETTE.inkWarm,
        p: parseHexRgba(THEME.error),
        h: parseHexRgba(ART_RAMPS.blossomIvory[3]),
        s: parseHexRgba(ART_RAMPS.clothCrimson[0]),
        a: parseHexRgba(ART_RAMPS.timber[2]),
    }),
    mended: Object.freeze({
        k: PALETTE.inkWarm,
        p: parseHexRgba(THEME.working),
        h: parseHexRgba(ART_RAMPS.trimGold[3]),
        s: parseHexRgba(ART_RAMPS.grass[1]),
        a: parseHexRgba(ART_RAMPS.trimGold[2]),
    }),
    errored: Object.freeze({
        k: parseHexRgba(EFFECT_COLORS.failureOutline),
        p: parseHexRgba(THEME.error),
        h: parseHexRgba(EFFECT_COLORS.peak),
        s: parseHexRgba(ART_RAMPS.clothCrimson[0]),
        a: parseHexRgba(ART_RAMPS.blossomIvory[3]),
    }),
    erroredResolved: Object.freeze({
        k: PALETTE.inkWarm,
        p: parseHexRgba(ART_RAMPS.clothCrimson[1]),
        h: parseHexRgba(ART_RAMPS.plaza[4]),
        s: parseHexRgba(ART_RAMPS.clothCrimson[0]),
        a: parseHexRgba(THEME.working),
    }),
    commit: Object.freeze({
        k: PALETTE.inkWarm,
        p: parseHexRgba(ART_RAMPS.trimGold[1]),
        h: parseHexRgba(ART_RAMPS.trimGold[3]),
        s: parseHexRgba(ART_RAMPS.trimGold[0]),
        a: parseHexRgba(ART_RAMPS.clothCrimson[1]),
    }),
    waiting: Object.freeze({
        k: PALETTE.inkWarm,
        p: parseHexRgba(THEME.waitingOnUser),
        h: parseHexRgba(EFFECT_COLORS.peak),
        s: parseHexRgba(ART_RAMPS.clothOchre[0]),
        a: parseHexRgba(EFFECT_COLORS.bell),
    }),
    compacted: Object.freeze({
        k: PALETTE.inkWarm,
        p: parseHexRgba(ART_RAMPS.domeSlate[4]),
        h: parseHexRgba(ART_RAMPS.domeSlate[5]),
        s: parseHexRgba(ART_RAMPS.domeSlate[2]),
        a: parseHexRgba(ART_RAMPS.trimGold[2]),
    }),
    rate_limited: Object.freeze({
        k: PALETTE.inkWarm,
        p: parseHexRgba(THEME.rateLimited),
        h: parseHexRgba(ART_RAMPS.snow[4]),
        s: parseHexRgba(ART_RAMPS.slate[1]),
        a: parseHexRgba(ART_RAMPS.slate[3]),
    }),
    completed: Object.freeze({
        k: PALETTE.inkWarm,
        p: parseHexRgba(THEME.completed),
        h: parseHexRgba(ART_RAMPS.snow[4]),
        s: parseHexRgba(ART_RAMPS.plaza[1]),
        a: parseHexRgba(ART_RAMPS.trimGold[2]),
    }),
});

// --- Pixel-Art Bitmaps (12x12 Event Stamps, 14x16 Pawn, 3x5 & 5x7 Numerals) -

// Each 12x12 stamp uses: '.' transparent, 'k' outline, 'p' primary, 'h' light,
// 's' shadow, 'a' accent. Every kind has a distinct, readable silhouette.
const RAW_EVENT_STAMPS = Object.freeze({
    // Royal crown with crimson jewel
    release: [
        '.....kk.....',
        '.kk.khhk.kk.',
        'khhkkhhkkhhk',
        'kpppkpppkppk',
        '.kppappappk.',
        '.kppphhpppk.',
        '.kppppppppk.',
        '..kssssssk..',
        '..khhpphhk..',
        '..kkkkkkkk..',
        '...kppppk...',
        '...kkkkkk...',
    ],
    // Hoisted pennant sail over hull (Harbor push)
    push: [
        '.....kk.....',
        '....khhk....',
        '...khhppk...',
        '..khhppppk..',
        '.khhppppppk.',
        '.kppppppppk.',
        '..kssssssk..',
        '.....ka.....',
        '.kkkaaaakkk.',
        '.kaaaaaaaak.',
        '..kaaaaaak..',
        '...kkkkkk...',
    ],
    // Split billet stitched whole with golden thread (mended)
    mended: [
        '...kkkkkk...',
        '..khhppphk..',
        '.khhppppppk.',
        '.kppkaakppk.',
        '.kppkhhkppk.',
        '.kppkaakppk.',
        '.kppkhhkppk.',
        '.kppkaakppk.',
        '.ksspppppsk.',
        '..kssssssk..',
        '...kppppk...',
        '....kkkk....',
    ],
    // Urgent heraldic shield with bright exclamation mark (open error)
    errored: [
        '..kkkkkkkk..',
        '.kppppppppk.',
        'kppphhhhpppk',
        'kppphhhhpppk',
        'kpppphhppppk',
        'kpppphhppppk',
        'ksssshhssssk',
        '.ksssppsssk.',
        '.kssshhsssk.',
        '..ksshhssk..',
        '...kssssk...',
        '....kkkk....',
    ],
    // Muted shield with green mend check (resolved error)
    erroredResolved: [
        '..kkkkkkkk..',
        '.kppppppppk.',
        'kpppppppaapk',
        'kppppppaappk',
        'kppaaappaapk',
        'kpppaaaapppk',
        'kssssasssssk',
        '.kssssssssk.',
        '..kssssssk..',
        '...kssssk...',
        '....kssk....',
        '.....kk.....',
    ],
    // Faceted diamond seal (commit)
    commit: [
        '.....kk.....',
        '....khhk....',
        '...khhppk...',
        '..khhppppk..',
        '.khhpaapppk.',
        'khhpaaaapppk',
        'ksspaaaapssk',
        '.ksspaapssk.',
        '..ksspppsk..',
        '...kssssk...',
        '....kssk....',
        '.....kk.....',
    ],
    // Watchtower bell with clapper (waiting >= 5 min)
    waiting: [
        '.....kk.....',
        '....khhk....',
        '...khhppk...',
        '..khhppppk..',
        '..khhppppk..',
        '.khhppppppk.',
        '.kppppppppk.',
        'khhpppppppsk',
        'kssssssssssk',
        '.kkkkkkkkkk.',
        '....kaak....',
        '.....kk.....',
    ],
    // Bound folio with brass clasp (compacted)
    compacted: [
        '..kkkkkkkk..',
        '.khhppppppk.',
        '.khhppppppk.',
        '.kppppppppk.',
        '.kpppaaaapk.',
        '.kpppaaahpk.',
        '.kppppppppk.',
        '.kppppppppk.',
        '.kssssssssk.',
        '..khhhhhhk..',
        '..kssssssk..',
        '..kkkkkkkk..',
    ],
    // Latticed portcullis gate (rate_limited)
    rate_limited: [
        'kk.kk..kk.kk',
        'kkkkkkkkkkkk',
        'kppkppkkppkk',
        'khhkhhkkhhkk',
        'kkkkkkkkkkkk',
        'kppkppkkppkk',
        'kkkkkkkkkkkk',
        'kppkppkkppkk',
        'kssksskksskk',
        'kssksskksskk',
        'k..k..kk..kk',
        'k..k..kk..kk',
    ],
    // Quiet four-point star (completed)
    completed: [
        '.....kk.....',
        '....khhk....',
        '....kppk....',
        '...khhppk...',
        '.kkhhppppkk.',
        'khhppaaapppk',
        'kssppaaapssk',
        '.kksssssskk.',
        '...kssppk...',
        '....kssk....',
        '....kssk....',
        '.....kk.....',
    ],
});

// Plain slate pawn miniature (14x16) — deterministic honest fallback whenever
// a model sheet / resolveMiniature callback is unavailable.
const RAW_SLATE_PAWN = Object.freeze([
    '.....kkkk.....',
    '....kllmmk....',
    '...kllmmmmk...',
    '...klmmddmk...',
    '...kmmddddk...',
    '....kddddk....',
    '....kkddkk....',
    '...kllmmmmk...',
    '...klmmddmk...',
    '..kllmmddddk..',
    '..klmmmddddk..',
    '..kmmmdddddk..',
    '.kllmmddddddk.',
    '.kppmmmmddddk.',
    '.kppppppppppk.',
    '.kkkkkkkkkkkk.',
]);

// Compact 3x5 pixel numerals (for cell pip counts > 5 and wait knots > 6).
const GLYPHS_3X5 = Object.freeze({
    '0': ['111', '101', '101', '101', '111'],
    '1': ['010', '110', '010', '010', '111'],
    '2': ['111', '001', '111', '100', '111'],
    '3': ['111', '001', '111', '001', '111'],
    '4': ['101', '101', '111', '001', '001'],
    '5': ['111', '100', '111', '001', '111'],
    '6': ['111', '100', '111', '101', '111'],
    '7': ['111', '001', '010', '010', '010'],
    '8': ['111', '101', '111', '101', '111'],
    '9': ['111', '101', '111', '001', '111'],
    '+': ['000', '010', '111', '010', '000'],
});

// Crisp 5x7 pixel numerals (for the 28x22 `+N` overflow plate).
const GLYPHS_5X7 = Object.freeze({
    '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
    '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
    '3': ['01110', '10001', '00001', '00110', '00001', '10001', '01110'],
    '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
    '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
    '6': ['01110', '10000', '11110', '10001', '10001', '10001', '01110'],
    '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
    '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
    '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
    '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
});

// Pre-compile ASCII stamps into flat pixel lists `[dx, dy, r, g, b, a]` once.
function compileIndexedStamp(rows, colorMap) {
    const pixels = [];
    for (let y = 0; y < rows.length; y++) {
        const row = rows[y];
        for (let x = 0; x < row.length; x++) {
            const ch = row[x];
            if (ch === '.' || ch === ' ') continue;
            const rgba = colorMap[ch];
            if (!rgba) continue;
            pixels.push(x, y, rgba[0], rgba[1], rgba[2], rgba[3]);
        }
    }
    return new Uint8Array(pixels);
}

function compileBinaryGlyphs(table) {
    const out = {};
    for (const [ch, rows] of Object.entries(table)) {
        const coords = [];
        for (let y = 0; y < rows.length; y++) {
            const row = rows[y];
            for (let x = 0; x < row.length; x++) {
                if (row[x] === '1') coords.push(x, y);
            }
        }
        out[ch] = new Uint8Array(coords);
    }
    return Object.freeze(out);
}

const COMPILED_STAMPS = Object.freeze({
    release: compileIndexedStamp(RAW_EVENT_STAMPS.release, STAMP_PALETTES.release),
    push: compileIndexedStamp(RAW_EVENT_STAMPS.push, STAMP_PALETTES.push),
    pushFailed: compileIndexedStamp(RAW_EVENT_STAMPS.push, STAMP_PALETTES.pushFailed),
    mended: compileIndexedStamp(RAW_EVENT_STAMPS.mended, STAMP_PALETTES.mended),
    errored: compileIndexedStamp(RAW_EVENT_STAMPS.errored, STAMP_PALETTES.errored),
    erroredResolved: compileIndexedStamp(RAW_EVENT_STAMPS.erroredResolved, STAMP_PALETTES.erroredResolved),
    commit: compileIndexedStamp(RAW_EVENT_STAMPS.commit, STAMP_PALETTES.commit),
    waiting: compileIndexedStamp(RAW_EVENT_STAMPS.waiting, STAMP_PALETTES.waiting),
    compacted: compileIndexedStamp(RAW_EVENT_STAMPS.compacted, STAMP_PALETTES.compacted),
    rate_limited: compileIndexedStamp(RAW_EVENT_STAMPS.rate_limited, STAMP_PALETTES.rate_limited),
    completed: compileIndexedStamp(RAW_EVENT_STAMPS.completed, STAMP_PALETTES.completed),
});

const COMPILED_PAWN = compileIndexedStamp(RAW_SLATE_PAWN, {
    k: PALETTE.pawnOutline,
    d: PALETTE.pawnDark,
    m: PALETTE.pawnMid,
    l: PALETTE.pawnLight,
    p: PALETTE.pawnPlinth,
});

const COMPILED_GLYPHS_3X5 = compileBinaryGlyphs(GLYPHS_3X5);
const COMPILED_GLYPHS_5X7 = compileBinaryGlyphs(GLYPHS_5X7);

// --- Pure Deterministic Hashing & Repo Pennant Resolution -------------------

// Matches RepoColor.js's chronicle-history fallback (FNV-1a + murmur3 fmix32)
// without touching RepoColor's mutable live-session registry, keeping weaveDay
// strictly pure and deterministic.
function stableHash(input) {
    const text = String(input || '');
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x85ebca6b);
    hash ^= hash >>> 13;
    hash = Math.imul(hash, 0xc2b2ae35);
    hash ^= hash >>> 16;
    return hash >>> 0;
}

export function loomRepoPennant(repoKey) {
    const key = String(repoKey || '').trim();
    if (!key) return null;
    const index = stableHash(key) % PENNANT_PALETTE.length;
    return Object.freeze({
        repo: key,
        pennantIndex: index,
        color: PENNANT_PALETTE[index],
    });
}

function compareStrings(a, b) {
    const sa = String(a ?? '');
    const sb = String(b ?? '');
    return sa < sb ? -1 : sa > sb ? 1 : 0;
}

// --- Coverage Mask Codec (96-bit Quarter-Hour Mask) -------------------------

/**
 * Build a 12-byte (96-bit) quarter-hour coverage mask.
 * Accepts `{ all: true }`, `{ hours: [9, 10] }`, `{ quarters: [0, 1, ...] }`,
 * or an iterable of quarter indices `0..95`.
 */
export function createCoverageMask(spec = null) {
    const mask = new Uint8Array(12);
    if (!spec) return mask;
    if (spec === true || spec.all === true) {
        mask.fill(0xff);
        return mask;
    }
    if (Array.isArray(spec.hours)) {
        for (const h of spec.hours) {
            const hour = Math.floor(Number(h));
            if (hour < 0 || hour >= LOOM_HOURS_PER_DAY) continue;
            for (let q = 0; q < LOOM_QUARTERS_PER_HOUR; q++) {
                const bit = hour * LOOM_QUARTERS_PER_HOUR + q;
                mask[bit >> 3] |= (1 << (bit & 7));
            }
        }
    }
    const quarters = Array.isArray(spec.quarters)
        ? spec.quarters
        : (Array.isArray(spec) ? spec : null);
    if (quarters) {
        for (const qIndex of quarters) {
            const bit = Math.floor(Number(qIndex));
            if (bit < 0 || bit >= LOOM_TOTAL_QUARTERS) continue;
            mask[bit >> 3] |= (1 << (bit & 7));
        }
    }
    return mask;
}

function isTruthyCoverageFlag(value) {
    if (value === null || value === undefined || value === false || value === 0) return false;
    if (typeof value === 'string') {
        const trimmed = value.trim().toLowerCase();
        return trimmed !== '' && trimmed !== '0' && trimmed !== 'false';
    }
    return Boolean(value);
}

/**
 * Canonical 96-bit quarter-hour coverage mask decoder shared by ChronicleLoom,
 * ChroniclePanel, and ChronicleTapestry.
 *
 * Accepts 24-char big-endian hex (with optional `0x`), 96-char bitstring,
 * BigInt, 12-byte Uint8Array/Array, 3-word Uint32Array/Array, 96-quarter
 * arrays/views, 24-hour arrays/views (boolean or 4-bit quarter nibbles), or
 * container objects (`{ bits | mask | quarters | hours | value }`).
 * Returns `Uint8Array(96)` of 0/1 flags, or `null` when missing/unrecognized.
 */
export function decodeCoverageBits(coverage) {
    if (coverage == null) return null;

    // Unwrap meta-store container objects (`{ bits }`, `{ mask }`, `{ quarters }`, `{ hours }`, `{ value }`).
    if (typeof coverage === 'object'
        && !Array.isArray(coverage)
        && !ArrayBuffer.isView(coverage)) {
        const inner = coverage.bits ?? coverage.mask ?? coverage.quarters ?? coverage.hours ?? coverage.value ?? null;
        return inner == null ? null : decodeCoverageBits(inner);
    }

    const bits = new Uint8Array(LOOM_TOTAL_QUARTERS);

    if (typeof coverage === 'bigint') {
        for (let i = 0; i < LOOM_TOTAL_QUARTERS; i++) {
            bits[i] = Number((coverage >> BigInt(i)) & 1n);
        }
        return bits;
    }

    if (typeof coverage === 'string') {
        const trimmed = coverage.trim();
        if (/^[01]{96}$/.test(trimmed)) {
            for (let i = 0; i < LOOM_TOTAL_QUARTERS; i++) {
                bits[i] = trimmed.charCodeAt(i) === 49 ? 1 : 0;
            }
            return bits;
        }
        const hex = trimmed.replace(/^0x/i, '');
        if (/^[0-9a-fA-F]{1,24}$/.test(hex)) {
            const value = BigInt(`0x${hex}`);
            for (let i = 0; i < LOOM_TOTAL_QUARTERS; i++) {
                bits[i] = Number((value >> BigInt(i)) & 1n);
            }
            return bits;
        }
        return null;
    }

    if ((coverage instanceof Uint32Array || Array.isArray(coverage)) && coverage.length === 3) {
        for (let i = 0; i < LOOM_TOTAL_QUARTERS; i++) {
            bits[i] = ((Number(coverage[i >>> 5]) >>> 0) >>> (i & 31)) & 1;
        }
        return bits;
    }

    if ((Array.isArray(coverage) || ArrayBuffer.isView(coverage)) && coverage.length === LOOM_TOTAL_QUARTERS) {
        for (let i = 0; i < LOOM_TOTAL_QUARTERS; i++) {
            bits[i] = isTruthyCoverageFlag(coverage[i]) ? 1 : 0;
        }
        return bits;
    }

    if ((Array.isArray(coverage) || ArrayBuffer.isView(coverage)) && coverage.length === LOOM_HOURS_PER_DAY) {
        const nibbleMode = Array.isArray(coverage) && coverage.some(v => typeof v === 'number' && v > 1);
        for (let h = 0; h < LOOM_HOURS_PER_DAY; h++) {
            const entry = coverage[h];
            if (nibbleMode) {
                const nibble = Number(entry) || 0;
                for (let q = 0; q < LOOM_QUARTERS_PER_HOUR; q++) {
                    bits[h * LOOM_QUARTERS_PER_HOUR + q] = (nibble >> q) & 1;
                }
            } else {
                const covered = isTruthyCoverageFlag(entry) ? 1 : 0;
                for (let q = 0; q < LOOM_QUARTERS_PER_HOUR; q++) {
                    bits[h * LOOM_QUARTERS_PER_HOUR + q] = covered;
                }
            }
        }
        return bits;
    }

    if ((coverage instanceof Uint8Array || coverage instanceof Uint8ClampedArray || Array.isArray(coverage))
        && coverage.length === 12) {
        for (let i = 0; i < LOOM_TOTAL_QUARTERS; i++) {
            bits[i] = ((Number(coverage[i >> 3]) & 0xff) >> (i & 7)) & 1;
        }
        return bits;
    }

    return null;
}

/**
 * Normalize any 96-bit coverage representation into a 96-element `Uint8Array`
 * of 0/1 flags (one per quarter-hour `0..95`). Missing/null coverage yields
 * all zeroes (all uncovered -> bare warp, V8 honesty).
 */
export function normalizeCoverageBits(coverage) {
    return decodeCoverageBits(coverage) || new Uint8Array(LOOM_TOTAL_QUARTERS);
}

// --- Sky Code Normalization -------------------------------------------------

function defaultPhaseForHour(hour) {
    if (hour >= 5 && hour <= 6) return 'dawn';
    if (hour >= 7 && hour <= 16) return 'day';
    if (hour >= 17 && hour <= 18) return 'golden';
    if (hour >= 19 && hour <= 20) return 'dusk';
    return 'night';
}

function parseMoonPhaseToken(token) {
    if (token === 'new' || token === 'new-moon' || token === 'm0') return 0;
    if (token === 'crescent' || token === 'waxing-crescent' || token === 'm1') return 1;
    if (token === 'quarter' || token === 'first-quarter' || token === 'm2') return 2;
    if (token === 'gibbous' || token === 'waxing-gibbous' || token === 'm3') return 3;
    if (token === 'full' || token === 'full-moon' || token === 'm4') return 4;
    if (token === 'waning-gibbous' || token === 'm5') return 5;
    if (token === 'last-quarter' || token === 'm6') return 6;
    if (token === 'waning-crescent' || token === 'm7') return 7;
    const match = /^moon:?([0-7])$/.exec(token);
    return match ? Number(match[1]) : null;
}

function normalizeMoonOctant(value, { isFraction = false } = {}) {
    if (value == null) return null;
    if (typeof value === 'string') return parseMoonPhaseToken(value.trim().toLowerCase());
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (isFraction && n >= 0 && n <= 1) return Math.round(n * 8) & 7;
    if (!isFraction && n > 0 && n < 1) return Math.round(n * 8) & 7;
    return ((Math.round(n) % 8) + 8) % 8;
}

export function normalizeSkyEntry(entry, hour) {
    if (entry == null) {
        return Object.freeze({ known: false, phase: null, weather: null, cloud: 0, moonOctant: null, code: null });
    }
    if (typeof entry === 'string') {
        const raw = entry.trim();
        const lower = raw.toLowerCase();
        if (!lower || lower === 'unknown' || lower === 'missing' || lower === 'none') {
            return Object.freeze({ known: false, phase: null, weather: null, cloud: 0, moonOctant: null, code: null });
        }
        const tokens = lower.split(/[\s:,/|]+/).filter(Boolean);
        let phase = null;
        let weather = null;
        let cloud = 0;
        let moonOctant = null;
        let recognized = false;
        for (const token of tokens) {
            if (token === 'night' || token === 'deep-night' || token === 'deep_night') { phase = 'night'; recognized = true; }
            else if (token === 'dawn' || token === 'sunrise' || token === 'pre-dawn' || token === 'pre_dawn') { phase = 'dawn'; recognized = true; }
            else if (token === 'day' || token === 'morning' || token === 'noon' || token === 'afternoon') { phase = 'day'; recognized = true; }
            else if (token === 'golden' || token === 'golden-hour' || token === 'golden_hour' || token === 'afterglow') { phase = 'golden'; recognized = true; }
            else if (token === 'dusk' || token === 'blue-hour' || token === 'blue_hour' || token === 'twilight') { phase = 'dusk'; recognized = true; }
            else if (token === 'clear' || token === 'sunny' || token === 'fair') { weather = 'clear'; recognized = true; }
            else if (token === 'partly' || token === 'partly-cloudy' || token === 'partly_cloudy') { weather = 'cloud'; cloud = 1; recognized = true; }
            else if (token === 'cloud' || token === 'cloudy' || token === 'clouds') { weather = 'cloud'; cloud = 2; recognized = true; }
            else if (token === 'overcast') { weather = 'overcast'; cloud = 3; recognized = true; }
            else if (token === 'fog' || token === 'mist') { weather = 'fog'; cloud = 2; recognized = true; }
            else if (token === 'rain' || token === 'drizzle' || token === 'shower' || token === 'showers') { weather = 'rain'; cloud = 3; recognized = true; }
            else if (token === 'storm' || token === 'thunder' || token === 'squall') { weather = 'storm'; cloud = 3; recognized = true; }
            else if (token === 'snow' || token === 'sleet' || token === 'blizzard') { weather = 'snow'; cloud = 2; recognized = true; }
            else {
                const moon = parseMoonPhaseToken(token);
                if (moon !== null) { moonOctant = moon; recognized = true; }
            }
        }
        if (!recognized) {
            return Object.freeze({ known: false, phase: null, weather: null, cloud: 0, moonOctant: null, code: null });
        }
        return Object.freeze({
            known: true,
            phase: phase || defaultPhaseForHour(hour),
            weather: weather || 'clear',
            cloud,
            moonOctant,
            code: raw,
        });
    }

    if (typeof entry === 'object') {
        if (entry.known === false) {
            return Object.freeze({ known: false, phase: null, weather: null, cloud: 0, moonOctant: null, code: null });
        }
        const finiteField = (value) => {
            if (value === null || value === undefined || value === '') return null;
            const n = Number(value);
            return Number.isFinite(n) ? n : null;
        };
        const phaseRaw = String(entry.phase || entry.timeBand || '').trim().toLowerCase();
        const weatherRaw = String(entry.weather || entry.condition || '').trim().toLowerCase();
        const cloudNum = finiteField(entry.cloud);
        const rainNum = finiteField(entry.rain);
        const snowNum = finiteField(entry.snow);
        const moonNum = finiteField(entry.moon);
        const isCompactStoreCode = !phaseRaw && !weatherRaw
            && ('rain' in entry || 'snow' in entry || 'moon' in entry);
        const hasCloud = cloudNum !== null;
        const hasRain = rainNum !== null && rainNum > 0;
        const hasSnow = snowNum !== null && snowNum > 0;
        const hasStorm = Boolean(entry.storm) || (rainNum !== null && rainNum >= 2);
        const hasFog = Boolean(entry.fog);
        let moonOctant = null;
        if (entry.moonOctant != null) {
            moonOctant = normalizeMoonOctant(entry.moonOctant, { isFraction: false });
        } else if (entry.moonPhase != null) {
            moonOctant = normalizeMoonOctant(entry.moonPhase, { isFraction: true });
        } else if (entry.moon != null) {
            if (typeof entry.moon === 'string') {
                moonOctant = parseMoonPhaseToken(entry.moon.trim().toLowerCase());
            } else if (isCompactStoreCode && moonNum !== null && Number.isInteger(moonNum) && moonNum >= 0 && moonNum <= 3) {
                // ChronicleStore compact moon code (0..3 illumination steps): 0=new, 1=crescent, 2=quarter, 3=full (octant 4).
                moonOctant = [0, 1, 2, 4][moonNum];
            } else {
                moonOctant = normalizeMoonOctant(entry.moon, { isFraction: true });
            }
        }
        const hasAny = Boolean(
            phaseRaw || weatherRaw || hasCloud || rainNum !== null || snowNum !== null
            || hasStorm || hasFog || moonOctant !== null,
        );
        if (!hasAny) {
            return Object.freeze({ known: false, phase: null, weather: null, cloud: 0, moonOctant: null, code: null });
        }
        const compactCloudScale = isCompactStoreCode || (cloudNum !== null && cloudNum > 1);
        let weather = weatherRaw || 'clear';
        if (hasStorm) weather = 'storm';
        else if (hasSnow) weather = 'snow';
        else if (hasRain) weather = 'rain';
        else if (hasFog) weather = 'fog';
        else if (!weatherRaw && hasCloud) {
            weather = compactCloudScale
                ? (cloudNum >= 3 ? 'overcast' : cloudNum >= 1 ? 'cloud' : 'clear')
                : (cloudNum >= 0.75 ? 'overcast' : cloudNum >= 0.25 ? 'cloud' : 'clear');
        }
        const cloud = hasCloud
            ? Math.max(0, Math.min(3, Math.round(compactCloudScale ? cloudNum : cloudNum * 3)))
            : (weather === 'overcast' || weather === 'rain' || weather === 'storm' ? 3
                : weather === 'cloud' || weather === 'snow' || weather === 'fog' ? 2 : 0);
        const phase = phaseRaw
            ? (normalizeSkyEntry(phaseRaw, hour).phase || defaultPhaseForHour(hour))
            : defaultPhaseForHour(hour);
        return Object.freeze({
            known: true,
            phase,
            weather,
            cloud,
            moonOctant,
            code: `${phase}:${weather}`,
        });
    }

    return Object.freeze({ known: false, phase: null, weather: null, cloud: 0, moonOctant: null, code: null });
}

function readSkyArray(sky) {
    if (!sky) return null;
    if (Array.isArray(sky)) return sky;
    if (typeof sky === 'object') {
        if (Array.isArray(sky.hours)) return sky.hours;
        if (Array.isArray(sky.codes)) return sky.codes;
        if (Array.isArray(sky.sky)) return sky.sky;
    }
    return null;
}

// --- Pure Data Weaver: weaveDay(events, coverage, sky, options) -------------

function normalizeKind(raw) {
    return String(raw || '').trim().toLowerCase();
}

function extractWaitDurationMs(event) {
    const candidate = event?.waitedMs ?? event?.waitMs ?? event?.durationMs;
    if (candidate == null) return null;
    const value = Number(candidate);
    return Number.isFinite(value) && value >= 0 ? value : null;
}

function extractRepoKey(event) {
    const raw = event?.repoRoot || event?.projectPath || event?.project || event?.repo || null;
    if (!raw) return null;
    const clean = String(raw).trim();
    return clean || null;
}

function extractExplicitAgentKey(event) {
    const id = String(event?.agentId ?? '').trim();
    if (id) return id;
    const identityKey = String(event?.identityKey ?? '').trim();
    if (identityKey) return identityKey;
    const name = String(event?.agentName ?? '').trim();
    if (name) return name;
    return null;
}

function extractAgentKey(event) {
    return extractExplicitAgentKey(event) || 'unknown';
}

function extractEventTimestamp(event) {
    for (const candidate of [event?.ts, event?.at, event?.timestamp]) {
        if (candidate === null || candidate === undefined || candidate === '') continue;
        const ts = Number(candidate);
        if (Number.isFinite(ts)) return ts;
    }
    if (Number.isInteger(event?.hour) && event.hour >= 0 && event.hour < LOOM_HOURS_PER_DAY) {
        const minute = Number.isFinite(Number(event.minute))
            ? Math.max(0, Math.min(59, Math.floor(Number(event.minute))))
            : 0;
        return event.hour * 3_600_000 + minute * 60_000;
    }
    return null;
}

/**
 * Canonical pure open-error evaluator shared by ChronicleLoom and Evensong.
 *
 * Evaluates Chronicle events up to `endTs` (default `Infinity`) in deterministic
 * chronological order and returns the array of `errored` event records that are
 * still unresolved at `endTs`. An agent's open error(s) are closed by any later
 * event of kind in `ERROR_RESOLVING_KINDS` (`mended`, `resolved`, `completed`,
 * `departed`).
 */
export function openErrorsAt(events = [], endTs = Infinity) {
    const list = Array.isArray(events) ? events : [];
    const hasCutoff = endTs !== null && endTs !== undefined && endTs !== ''
        && Number.isFinite(Number(endTs));
    const cutoff = hasCutoff ? Number(endTs) : Infinity;

    const ordered = [];
    for (let i = 0; i < list.length; i++) {
        const raw = list[i];
        if (!raw || typeof raw !== 'object') continue;
        const kind = normalizeKind(raw.kind ?? raw.type);
        if (!kind) continue;
        const ts = extractEventTimestamp(raw);
        if (hasCutoff && ts !== null && ts > cutoff) continue;
        const explicitAgent = extractExplicitAgentKey(raw);
        const agentKey = explicitAgent || 'unknown';
        ordered.push({
            raw,
            index: i,
            id: String(raw.id ?? ''),
            kind,
            ts: ts !== null ? ts : 0,
            hasExplicitAgent: explicitAgent !== null,
            agentKey,
            repoKey: extractRepoKey(raw),
            explicitResolved: raw.explicitResolved === true
                || raw.resolved === true
                || raw.open === false
                || raw.mended === true,
        });
    }

    ordered.sort((a, b) => (a.ts - b.ts)
        || compareStrings(a.agentKey, b.agentKey)
        || compareStrings(a.kind, b.kind)
        || compareStrings(a.id, b.id)
        || (a.index - b.index));

    const open = [];
    for (const ev of ordered) {
        if (ev.kind === LOOM_EVENT_KIND.ERRORED) {
            if (!ev.explicitResolved) open.push(ev);
            continue;
        }
        if (!ERROR_RESOLVING_KIND_SET.has(ev.kind) || open.length === 0) continue;

        if (ev.hasExplicitAgent) {
            for (let i = open.length - 1; i >= 0; i--) {
                if (open[i].agentKey === ev.agentKey) open.splice(i, 1);
            }
        } else if (ev.repoKey) {
            let matched = false;
            for (let i = open.length - 1; i >= 0; i--) {
                if (open[i].repoKey === ev.repoKey) {
                    open.splice(i, 1);
                    matched = true;
                }
            }
            if (!matched) {
                for (let i = open.length - 1; i >= 0; i--) {
                    if (!open[i].hasExplicitAgent) open.splice(i, 1);
                }
            }
        } else {
            open.length = 0;
        }
    }

    return open.map(entry => entry.raw);
}

function resolveHourAndMinute(event, options) {
    if (Number.isInteger(event?.hour) && event.hour >= 0 && event.hour < LOOM_HOURS_PER_DAY) {
        const minute = Number.isFinite(Number(event.minute))
            ? Math.max(0, Math.min(59, Math.floor(Number(event.minute))))
            : 0;
        return { hour: event.hour, minute };
    }
    const ts = Number(event?.ts);
    if (!Number.isFinite(ts)) return null;
    if (Number.isFinite(options?.dayStartMs)) {
        const offset = ts - options.dayStartMs;
        if (offset < 0 || offset >= LOOM_HOURS_PER_DAY * 3_600_000) return null;
        const hour = Math.floor(offset / 3_600_000);
        const minute = Math.floor((offset % 3_600_000) / 60_000);
        return { hour, minute };
    }
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return null;
    if (options?.utc === true) {
        return { hour: date.getUTCHours(), minute: date.getUTCMinutes() };
    }
    return { hour: date.getHours(), minute: date.getMinutes() };
}

function deriveDateKey(events, coverage, sky, options) {
    if (typeof options?.dateKey === 'string' && options.dateKey.trim()) {
        return options.dateKey.trim();
    }
    for (const event of events) {
        if (typeof event?.localDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(event.localDate)) {
            return event.localDate;
        }
    }
    if (typeof coverage?.dateKey === 'string' && coverage.dateKey.trim()) return coverage.dateKey.trim();
    if (typeof sky?.dateKey === 'string' && sky.dateKey.trim()) return sky.dateKey.trim();
    let earliestTs = null;
    for (const event of events) {
        const ts = Number(event?.ts);
        if (Number.isFinite(ts) && (earliestTs === null || ts < earliestTs)) earliestTs = ts;
    }
    if (earliestTs !== null) {
        if (options?.utc === true) {
            const d = new Date(earliestTs);
            const y = d.getUTCFullYear();
            const m = String(d.getUTCMonth() + 1).padStart(2, '0');
            const day = String(d.getUTCDate()).padStart(2, '0');
            return `${y}-${m}-${day}`;
        }
        return chronicleDateKey(earliestTs);
    }
    return null;
}

function compareNormalizedEvents(a, b) {
    return (a.ts - b.ts)
        || compareStrings(a.agentId, b.agentId)
        || compareStrings(a.kind, b.kind)
        || compareStrings(a.id, b.id)
        || (a.index - b.index);
}

function compareCellsByWeight(a, b) {
    return (b.weight - a.weight)
        || (a.ts - b.ts)
        || compareStrings(a.agentId, b.agentId)
        || compareStrings(a.kind, b.kind);
}

function compareCellsByTime(a, b) {
    return (a.ts - b.ts)
        || (b.weight - a.weight)
        || compareStrings(a.agentId, b.agentId)
        || compareStrings(a.kind, b.kind);
}

/**
 * Pure, deterministic day weaver.
 *
 * Turns Chronicle events, a 96-bit quarter-hour coverage mask, and 24 hourly
 * sky codes into 24 immutable 96x72 panel descriptors plus day statistics.
 * Never reads wall-clock time (`Date.now()`) or randomness (`Math.random()`).
 */
export function weaveDay(events = [], coverage = null, sky = null, options = {}) {
    const rawList = Array.isArray(events) ? events : [];
    const dateKey = deriveDateKey(rawList, coverage, sky, options);
    const coverageBits = normalizeCoverageBits(coverage);
    const skyArray = readSkyArray(sky);
    const resolveRepo = typeof options?.resolveRepoColor === 'function'
        ? options.resolveRepoColor
        : loomRepoPennant;

    // 1. Normalize and deterministically sort input events.
    const normalized = [];
    for (let i = 0; i < rawList.length; i++) {
        const raw = rawList[i];
        if (!raw || typeof raw !== 'object') continue;
        if (options?.dateKey && typeof raw.localDate === 'string' && raw.localDate !== options.dateKey) {
            continue;
        }
        const kind = normalizeKind(raw.kind);
        if (!kind) continue;
        const clock = resolveHourAndMinute(raw, options);
        if (!clock) continue;
        const ts = Number.isFinite(Number(raw.ts))
            ? Number(raw.ts)
            : (clock.hour * 3_600_000 + clock.minute * 60_000);
        const agentId = extractAgentKey(raw);
        normalized.push({
            index: i,
            id: String(raw.id ?? ''),
            kind,
            ts,
            hour: clock.hour,
            minute: clock.minute,
            quarter: Math.floor(clock.minute / 15),
            agentId,
            actor: Object.freeze({
                agentId,
                identityKey: raw.identityKey || null,
                provider: raw.provider || null,
                model: raw.model || null,
                effort: raw.effort || null,
                spriteId: raw.spriteId || null,
                paletteKey: raw.paletteKey || null,
                trim: raw.trim || null,
                accent: raw.accent || null,
            }),
            repo: extractRepoKey(raw),
            waitedMs: extractWaitDurationMs(raw),
            outcome: raw.outcome ? String(raw.outcome).toLowerCase() : null,
            explicitResolved: raw.resolved === true || raw.open === false || raw.mended === true,
            explicitOpen: raw.open === true,
        });
    }
    normalized.sort(compareNormalizedEvents);

    // 2. Chronological cross-hour resolution pass:
    //    - Determine open vs resolved `errored` events via the canonical
    //      `openErrorsAt(events, endTs)` helper (`mended`, `resolved`,
    //      `completed`, `departed`).
    //    - Pair `waiting` events with subsequent `resolved` events for wait
    //      durations when `waitedMs` was not stamped directly on `waiting`,
    //      and measure ongoing unresolved waits up to `endTs` (or `now`).
    const rawEndTs = options?.endTs ?? options?.now ?? null;
    const hasEndTs = rawEndTs !== null && rawEndTs !== undefined && rawEndTs !== ''
        && Number.isFinite(Number(rawEndTs));
    const endTs = hasEndTs ? Number(rawEndTs) : null;
    const openErrorSet = new Set(openErrorsAt(normalized, endTs ?? Infinity));

    const openWaitByAgent = new Map();    // agentId -> pending normalized waiting event
    const eventWaitMs = new Map();        // event -> number (ms)
    const orphanWaitResolves = [];        // resolved events with waitedMs >= 5m and no prior waiting

    for (const ev of normalized) {
        if (hasEndTs && ev.ts > endTs) continue;

        if (ev.kind === LOOM_EVENT_KIND.WAITING) {
            if (ev.waitedMs !== null) {
                eventWaitMs.set(ev, ev.waitedMs);
                // Already carries its own duration; still track so a matching
                // resolved row right after doesn't spawn a duplicate orphan wait.
                openWaitByAgent.set(ev.agentId, { event: ev, hasDuration: true });
            } else {
                eventWaitMs.set(ev, 0);
                openWaitByAgent.set(ev.agentId, { event: ev, hasDuration: false });
            }
            continue;
        }

        if (ev.kind === LOOM_EVENT_KIND.RESOLVED) {
            const pendingWait = openWaitByAgent.get(ev.agentId);
            if (pendingWait) {
                openWaitByAgent.delete(ev.agentId);
                if (!pendingWait.hasDuration) {
                    const duration = ev.waitedMs !== null && ev.waitedMs > 0
                        ? ev.waitedMs
                        : Math.max(0, ev.ts - pendingWait.event.ts);
                    eventWaitMs.set(pendingWait.event, duration);
                }
            } else if (ev.waitedMs !== null && ev.waitedMs >= LOOM_WAIT_UNIT_MS) {
                orphanWaitResolves.push(ev);
            }
            continue;
        }

        if (ev.kind === LOOM_EVENT_KIND.DEPARTED || ev.kind === LOOM_EVENT_KIND.COMPLETED) {
            const pendingWait = openWaitByAgent.get(ev.agentId);
            if (pendingWait) {
                openWaitByAgent.delete(ev.agentId);
                if (!pendingWait.hasDuration) {
                    eventWaitMs.set(pendingWait.event, Math.max(0, ev.ts - pendingWait.event.ts));
                }
            }
        }
    }

    if (hasEndTs) {
        for (const pendingWait of openWaitByAgent.values()) {
            if (pendingWait.hasDuration) continue;
            eventWaitMs.set(pendingWait.event, Math.max(0, endTs - pendingWait.event.ts));
        }
    }

    // 3. Bucket events into 24 hour panels.
    const hourBuckets = Array.from({ length: LOOM_HOURS_PER_DAY }, () => ({
        coalesced: new Map(), // `${agentId}\0${kind}` -> mutable cell draft
        arrivals: [],
        departures: [],
        reposMap: new Map(),  // repoKey -> { repo, pennantIndex, color, firstTs }
    }));

    const dayReposMap = new Map();
    const byKind = {
        release: 0,
        push: 0,
        mended: 0,
        errored: 0,
        erroredOpen: 0,
        erroredResolved: 0,
        commit: 0,
        waiting: 0,
        compacted: 0,
        rate_limited: 0,
        completed: 0,
        arrived: 0,
        departed: 0,
    };

    function noteRepo(bucket, repoKey, ts) {
        if (!repoKey) return;
        if (!bucket.reposMap.has(repoKey)) {
            const pennant = resolveRepo(repoKey) || loomRepoPennant(repoKey);
            if (pennant) {
                bucket.reposMap.set(repoKey, Object.freeze({
                    repo: repoKey,
                    pennantIndex: pennant.pennantIndex ?? (stableHash(repoKey) % PENNANT_PALETTE.length),
                    color: pennant.color || PENNANT_PALETTE[stableHash(repoKey) % PENNANT_PALETTE.length],
                    firstTs: ts,
                }));
            }
        }
        if (!dayReposMap.has(repoKey)) {
            const entry = bucket.reposMap.get(repoKey);
            if (entry) dayReposMap.set(repoKey, entry);
        }
    }

    function addCellEvent(bucket, ev, kind, weight, extra = {}) {
        const key = `${ev.agentId}\u0000${kind}`;
        const existing = bucket.coalesced.get(key);
        if (existing) {
            existing.count += 1;
            if (weight > existing.weight) existing.weight = weight;
            if (ev.ts < existing.ts) existing.ts = ev.ts;
            if (ev.ts > existing.lastTs) existing.lastTs = ev.ts;
            if (extra.waitMs) existing.waitMs += extra.waitMs;
            if (extra.open) existing.open = true;
            if (extra.failed !== undefined) existing.failed = existing.failed && extra.failed;
            if (!existing.repo && ev.repo) existing.repo = ev.repo;
            return;
        }
        bucket.coalesced.set(key, {
            type: 'event',
            kind,
            agentId: ev.agentId,
            actor: ev.actor,
            weight,
            ts: ev.ts,
            lastTs: ev.ts,
            count: 1,
            waitMs: extra.waitMs || 0,
            open: Boolean(extra.open),
            failed: Boolean(extra.failed),
            repo: ev.repo || null,
        });
    }

    let wovenEvents = 0;

    for (const ev of normalized) {
        const bucket = hourBuckets[ev.hour];
        noteRepo(bucket, ev.repo, ev.ts);

        if (ev.kind === LOOM_EVENT_KIND.ARRIVED) {
            byKind.arrived += 1;
            const x = Math.max(1, Math.min(LOOM_PANEL_WIDTH - 2, Math.floor((ev.minute / 60) * LOOM_PANEL_WIDTH)));
            bucket.arrivals.push(Object.freeze({
                ts: ev.ts,
                minute: ev.minute,
                quarter: ev.quarter,
                x,
                agentId: ev.agentId,
                provider: ev.actor.provider,
            }));
            continue;
        }

        if (ev.kind === LOOM_EVENT_KIND.DEPARTED) {
            byKind.departed += 1;
            const x = Math.max(1, Math.min(LOOM_PANEL_WIDTH - 2, Math.floor((ev.minute / 60) * LOOM_PANEL_WIDTH)));
            bucket.departures.push(Object.freeze({
                ts: ev.ts,
                minute: ev.minute,
                quarter: ev.quarter,
                x,
                agentId: ev.agentId,
                provider: ev.actor.provider,
            }));
            continue;
        }

        if (!CELL_ELIGIBLE_KINDS.has(ev.kind)) continue;

        if (ev.kind === LOOM_EVENT_KIND.WAITING) {
            const waitMs = eventWaitMs.get(ev) || 0;
            if (waitMs < LOOM_WAIT_UNIT_MS) continue;
            byKind.waiting += 1;
            wovenEvents += 1;
            addCellEvent(bucket, ev, LOOM_EVENT_KIND.WAITING, LOOM_EVENT_WEIGHTS.waiting, { waitMs });
            continue;
        }

        if (ev.kind === LOOM_EVENT_KIND.ERRORED) {
            const isOpen = openErrorSet.has(ev);
            const weight = isOpen ? LOOM_EVENT_WEIGHTS.errored : LOOM_EVENT_WEIGHTS.erroredResolved;
            byKind.errored += 1;
            if (isOpen) byKind.erroredOpen += 1;
            else byKind.erroredResolved += 1;
            wovenEvents += 1;
            addCellEvent(bucket, ev, LOOM_EVENT_KIND.ERRORED, weight, { open: isOpen });
            continue;
        }

        if (ev.kind === LOOM_EVENT_KIND.PUSH) {
            const failed = Boolean(ev.outcome && ev.outcome !== 'landed' && ev.outcome !== 'success');
            byKind.push += 1;
            wovenEvents += 1;
            addCellEvent(bucket, ev, LOOM_EVENT_KIND.PUSH, LOOM_EVENT_WEIGHTS.push, { failed });
            continue;
        }

        const weight = LOOM_EVENT_WEIGHTS[ev.kind];
        if (!weight) continue;
        byKind[ev.kind] = (byKind[ev.kind] || 0) + 1;
        wovenEvents += 1;
        addCellEvent(bucket, ev, ev.kind, weight);
    }

    // Include orphan resolved waits (>= 5 min without a same-day `waiting` opener).
    for (const ev of orphanWaitResolves) {
        const bucket = hourBuckets[ev.hour];
        noteRepo(bucket, ev.repo, ev.ts);
        byKind.waiting += 1;
        wovenEvents += 1;
        addCellEvent(bucket, ev, LOOM_EVENT_KIND.WAITING, LOOM_EVENT_WEIGHTS.waiting, { waitMs: ev.waitedMs });
    }

    // 4. Finalize 24 hour panels: select 6 heaviest (or 5 + overflow plate),
    //    then order chosen cells chronologically left-to-right, top-to-bottom.
    const panels = [];
    let totalCoalescedCells = 0;
    let totalDrawnCells = 0;
    let totalOverflowCells = 0;
    let totalOverflowEvents = 0;
    let coveredQuarters = 0;
    let coveredHours = 0;
    let knownSkyHours = 0;
    let activeHours = 0;

    for (let hour = 0; hour < LOOM_HOURS_PER_DAY; hour++) {
        const bucket = hourBuckets[hour];
        const qBase = hour * LOOM_QUARTERS_PER_HOUR;
        const quarterFlags = Object.freeze([
            Boolean(coverageBits[qBase]),
            Boolean(coverageBits[qBase + 1]),
            Boolean(coverageBits[qBase + 2]),
            Boolean(coverageBits[qBase + 3]),
        ]);
        const coveredCount = (quarterFlags[0] ? 1 : 0)
            + (quarterFlags[1] ? 1 : 0)
            + (quarterFlags[2] ? 1 : 0)
            + (quarterFlags[3] ? 1 : 0);
        coveredQuarters += coveredCount;
        if (coveredCount > 0) coveredHours += 1;

        const skyEntry = normalizeSkyEntry(skyArray ? skyArray[hour] : null, hour);
        if (skyEntry.known) knownSkyHours += 1;

        const candidates = [...bucket.coalesced.values()];
        const totalCoalesced = candidates.length;
        totalCoalescedCells += totalCoalesced;

        candidates.sort(compareCellsByWeight);

        let overflowCells = 0;
        let overflowEvents = 0;
        let chosen;
        if (totalCoalesced > LOOM_GRID.maxCells) {
            chosen = candidates.slice(0, LOOM_GRID.maxCells - 1);
            const hidden = candidates.slice(LOOM_GRID.maxCells - 1);
            overflowCells = hidden.length;
            for (const draft of hidden) overflowEvents += draft.count;
        } else {
            chosen = candidates;
        }
        totalOverflowCells += overflowCells;
        totalOverflowEvents += overflowEvents;

        // Chosen cells are laid out strictly in chronological time order.
        chosen.sort(compareCellsByTime);

        const eventCells = chosen.map((draft, slot) => {
            const isWait = draft.kind === LOOM_EVENT_KIND.WAITING;
            const waitKnots = isWait ? Math.floor(draft.waitMs / LOOM_WAIT_UNIT_MS) : 0;
            let pipMode;
            let pips = 0;
            let numeral = null;
            if (isWait) {
                if (waitKnots > LOOM_MAX_WAIT_KNOTS) {
                    pipMode = 'knot-numeral';
                    numeral = waitKnots;
                } else {
                    pipMode = 'knots';
                }
            } else if (draft.count > LOOM_MAX_PIPS) {
                pipMode = 'numeral';
                numeral = draft.count;
            } else {
                pipMode = 'pips';
                pips = draft.count;
            }

            return Object.freeze({
                type: 'event',
                slot,
                col: slot % LOOM_GRID.cols,
                row: Math.floor(slot / LOOM_GRID.cols),
                kind: draft.kind,
                agentId: draft.agentId,
                actor: draft.actor,
                weight: draft.weight,
                ts: draft.ts,
                lastTs: draft.lastTs,
                count: draft.count,
                open: draft.open,
                failed: draft.failed,
                repo: draft.repo,
                waitMs: draft.waitMs,
                waitKnots,
                pipMode,
                pips,
                numeral,
            });
        });

        const cells = [...eventCells];
        if (overflowCells > 0) {
            const slot = LOOM_GRID.maxCells - 1;
            cells.push(Object.freeze({
                type: 'overflow',
                slot,
                col: slot % LOOM_GRID.cols,
                row: Math.floor(slot / LOOM_GRID.cols),
                count: overflowCells,
                overflowCells,
                overflowEvents,
                label: `+${overflowCells}`,
            }));
        }

        totalDrawnCells += eventCells.length;
        if (totalCoalesced > 0 || bucket.arrivals.length > 0 || bucket.departures.length > 0) {
            activeHours += 1;
        }

        panels.push(Object.freeze({
            hour,
            width: LOOM_PANEL_WIDTH,
            height: LOOM_PANEL_HEIGHT,
            coverage: quarterFlags,
            coveredCount,
            fullyUncovered: coveredCount === 0,
            sky: skyEntry,
            cells: Object.freeze(cells),
            eventCells: Object.freeze(eventCells),
            overflowCells,
            overflowCount: overflowCells,
            overflowEvents,
            totalCoalesced,
            arrivals: Object.freeze(bucket.arrivals),
            departures: Object.freeze(bucket.departures),
            repos: Object.freeze([...bucket.reposMap.values()]),
        }));
    }

    return Object.freeze({
        dateKey,
        panels: Object.freeze(panels),
        stats: Object.freeze({
            totalEvents: normalized.length,
            wovenEvents,
            coalescedCells: totalCoalescedCells,
            drawnCells: totalDrawnCells,
            overflowCells: totalOverflowCells,
            overflowEvents: totalOverflowEvents,
            arrivals: byKind.arrived,
            departures: byKind.departed,
            coveredQuarters,
            uncoveredQuarters: LOOM_TOTAL_QUARTERS - coveredQuarters,
            coveredHours,
            knownSkyHours,
            activeHours,
            byKind: Object.freeze(byKind),
            repos: Object.freeze([...dayReposMap.values()]),
        }),
    });
}

// --- Pure RGBA Pixel Surface Primitives (Zero Anti-Aliasing, Zero Text) -----

function setPx(data, stride, x, y, width, height, r, g, b, a = 255) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const o = (y * stride + x) * 4;
    if (a >= 255) {
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
        data[o + 3] = 255;
        return;
    }
    if (a <= 0) return;
    const inv = 255 - a;
    data[o] = (r * a + data[o] * inv + 127) >> 8;
    data[o + 1] = (g * a + data[o + 1] * inv + 127) >> 8;
    data[o + 2] = (b * a + data[o + 2] * inv + 127) >> 8;
    data[o + 3] = Math.min(255, a + ((data[o + 3] * inv + 127) >> 8));
}

function fillRectRgba(data, width, height, x0, y0, w, h, rgba) {
    const startX = Math.max(0, x0);
    const startY = Math.max(0, y0);
    const endX = Math.min(width, x0 + w);
    const endY = Math.min(height, y0 + h);
    if (startX >= endX || startY >= endY) return;
    const [r, g, b, a] = rgba;
    for (let y = startY; y < endY; y++) {
        let o = (y * width + startX) * 4;
        for (let x = startX; x < endX; x++) {
            data[o] = r;
            data[o + 1] = g;
            data[o + 2] = b;
            data[o + 3] = a;
            o += 4;
        }
    }
}

function stampCompiled(data, width, height, compiled, ox, oy) {
    for (let i = 0; i < compiled.length; i += 6) {
        const px = ox + compiled[i];
        const py = oy + compiled[i + 1];
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        const o = (py * width + px) * 4;
        data[o] = compiled[i + 2];
        data[o + 1] = compiled[i + 3];
        data[o + 2] = compiled[i + 4];
        data[o + 3] = compiled[i + 5];
    }
}

function stampPixelText(data, width, height, text, ox, oy, font, rgba, shadowRgba = null) {
    const isLarge = font === '5x7';
    const glyphs = isLarge ? COMPILED_GLYPHS_5X7 : COMPILED_GLYPHS_3X5;
    const glyphW = isLarge ? 5 : 3;
    const stepX = glyphW + 1;
    let cursorX = ox;
    for (let i = 0; i < text.length; i++) {
        const coords = glyphs[text[i]];
        if (coords) {
            if (shadowRgba) {
                for (let j = 0; j < coords.length; j += 2) {
                    setPx(data, width, cursorX + coords[j] + 1, oy + coords[j + 1] + 1, width, height,
                        shadowRgba[0], shadowRgba[1], shadowRgba[2], shadowRgba[3]);
                }
            }
            for (let j = 0; j < coords.length; j += 2) {
                setPx(data, width, cursorX + coords[j], oy + coords[j + 1], width, height,
                    rgba[0], rgba[1], rgba[2], rgba[3]);
            }
        }
        cursorX += stepX;
    }
}

function measurePixelTextWidth(text, font) {
    if (!text.length) return 0;
    const glyphW = font === '5x7' ? 5 : 3;
    return text.length * glyphW + (text.length - 1);
}

// --- Panel Layer Painters ---------------------------------------------------

// Bare warp across a 24 px quarter-hour band: vertical warp threads every 4 px,
// strictly zero horizontal weft.
function paintBareWarpQuarter(data, surfW, surfH, px, py, quarterIndex) {
    const x0 = px + quarterIndex * LOOM_QUARTER_WIDTH;
    const bgColor = PALETTE.warpBg;
    for (let ry = 0; ry < LOOM_PANEL_HEIGHT; ry++) {
        const wy = py + ry;
        if (wy < 0 || wy >= surfH) continue;
        const threadColor = ((ry >> 1) & 1) === 0 ? PALETTE.warpLight : PALETTE.warpMid;
        for (let rx = 0; rx < LOOM_QUARTER_WIDTH; rx++) {
            const wx = x0 + rx;
            if (wx < 0 || wx >= surfW) continue;
            const c = (rx % LOOM_WARP_STRIDE === 0) ? threadColor : bgColor;
            const o = (wy * surfW + wx) * 4;
            data[o] = c[0];
            data[o + 1] = c[1];
            data[o + 2] = c[2];
            data[o + 3] = 255;
        }
    }
}

// Solid woven linen weft backing patch behind an event cell's 28x22 footprint so
// miniatures and stamps never sit over near-black bare warp in partly covered hours.
function paintCellLinenBacking(data, surfW, surfH, px, py, cx, cy) {
    for (let dy = 0; dy < LOOM_GRID.cellHeight; dy++) {
        const wy = cy + dy;
        if (wy < 0 || wy >= surfH) continue;
        const ry = wy - py;
        for (let dx = 0; dx < LOOM_GRID.cellWidth; dx++) {
            const wx = cx + dx;
            if (wx < 0 || wx >= surfW) continue;
            const rx = wx - px;
            const c = (rx % LOOM_WARP_STRIDE === 0 && (ry & 1) === 0)
                ? PALETTE.linenRib
                : (((rx + ry) & 1) === 0 ? PALETTE.linenBase : PALETTE.linenLight);
            const o = (wy * surfW + wx) * 4;
            data[o] = c[0];
            data[o + 1] = c[1];
            data[o + 2] = c[2];
            data[o + 3] = 255;
        }
    }
}

// Covered quarter woven fabric: selvedge (rows 0-1, 70-71), woven linen field
// (rows 12-59), and pennant footer cloth (rows 60-69).
function paintCoveredFabricQuarter(data, surfW, surfH, px, py, quarterIndex) {
    const qx0 = quarterIndex * LOOM_QUARTER_WIDTH;
    const qx1 = qx0 + LOOM_QUARTER_WIDTH;

    for (let ry = 0; ry < LOOM_PANEL_HEIGHT; ry++) {
        const wy = py + ry;
        if (wy < 0 || wy >= surfH) continue;
        for (let rx = qx0; rx < qx1; rx++) {
            const wx = px + rx;
            if (wx < 0 || wx >= surfW) continue;
            let c;
            if (ry === 0 || ry === 71) {
                c = (rx & 1) === 0 ? PALETTE.selvedgeDark : PALETTE.selvedgeMid;
            } else if (ry === 1 || ry === 70) {
                c = (rx & 3) === 0 ? PALETTE.selvedgeStitch : PALETTE.selvedgeDark;
            } else if (ry >= 12 && ry <= 59) {
                if (rx === 0 || rx === LOOM_PANEL_WIDTH - 1) {
                    c = (ry & 1) === 0 ? PALETTE.linenSeam : PALETTE.linenRib;
                } else if (rx % LOOM_WARP_STRIDE === 0 && (ry & 1) === 0) {
                    c = PALETTE.linenRib;
                } else {
                    c = ((rx + ry) & 1) === 0 ? PALETTE.linenBase : PALETTE.linenLight;
                }
            } else if (ry >= 60 && ry <= 69) {
                if (ry === 60 || ry === 69) {
                    c = (rx & 1) === 0 ? PALETTE.linenSeam : PALETTE.pennantBg;
                } else {
                    c = ((rx + ry) & 1) === 0 ? PALETTE.pennantBg : PALETTE.pennantBgAlt;
                }
            } else {
                continue; // sky border (rows 2-11) painted in paintSkyBorder
            }
            const o = (wy * surfW + wx) * 4;
            data[o] = c[0];
            data[o + 1] = c[1];
            data[o + 2] = c[2];
            data[o + 3] = 255;
        }
    }
}

function skyBandColors(sky) {
    if (sky.weather === 'storm') {
        return [PALETTE.stormTop, PALETTE.stormMid, PALETTE.stormBot];
    }
    if (sky.weather === 'overcast' || sky.weather === 'rain') {
        const isNight = sky.phase === 'night' || sky.phase === 'dusk';
        return isNight
            ? [PALETTE.skyNightTop, PALETTE.stormTop, PALETTE.stormMid]
            : [PALETTE.cloudDark, PALETTE.cloudMid, PALETTE.fogBand];
    }
    switch (sky.phase) {
        case 'dawn': return [PALETTE.skyDawnTop, PALETTE.skyDawnMid, PALETTE.skyDawnBot];
        case 'golden': return [PALETTE.skyGoldenTop, PALETTE.skyGoldenMid, PALETTE.skyGoldenBot];
        case 'dusk': return [PALETTE.skyDuskTop, PALETTE.skyDuskMid, PALETTE.skyDuskBot];
        case 'night': return [PALETTE.skyNightTop, PALETTE.skyNightMid, PALETTE.skyNightBot];
        default: return [PALETTE.skyDayTop, PALETTE.skyDayMid, PALETTE.skyDayBot];
    }
}

function paintSkyBorder(data, surfW, surfH, px, py, panel) {
    const { sky, coverage, hour } = panel;
    const yTop = LOOM_BANDS.skyBorder.y;
    const yEnd = yTop + LOOM_BANDS.skyBorder.height;

    if (!sky.known) {
        // V8 honesty: missing/unknown sky draws an undyed flax linen border.
        for (let q = 0; q < LOOM_QUARTERS_PER_HOUR; q++) {
            if (!coverage[q]) continue;
            const qx0 = q * LOOM_QUARTER_WIDTH;
            for (let ry = yTop; ry < yEnd; ry++) {
                const wy = py + ry;
                if (wy < 0 || wy >= surfH) continue;
                for (let rx = qx0; rx < qx0 + LOOM_QUARTER_WIDTH; rx++) {
                    const wx = px + rx;
                    if (wx < 0 || wx >= surfW) continue;
                    const c = (ry === yEnd - 1)
                        ? PALETTE.undyedSeam
                        : (((rx + ry) & 1) === 0 ? PALETTE.undyedBase : PALETTE.undyedLight);
                    const o = (wy * surfW + wx) * 4;
                    data[o] = c[0];
                    data[o + 1] = c[1];
                    data[o + 2] = c[2];
                    data[o + 3] = 255;
                }
            }
        }
        return;
    }

    const [topC, midC, botC] = skyBandColors(sky);

    // 1. Stepped 3-course sky backdrop across covered quarters only.
    for (let q = 0; q < LOOM_QUARTERS_PER_HOUR; q++) {
        if (!coverage[q]) continue;
        const qx0 = q * LOOM_QUARTER_WIDTH;
        for (let ry = yTop; ry < yEnd; ry++) {
            const wy = py + ry;
            if (wy < 0 || wy >= surfH) continue;
            const relY = ry - yTop; // 0..9
            const rowC = relY === 9
                ? PALETTE.linenSeam
                : relY <= 2 ? topC : relY <= 5 ? midC : botC;
            for (let rx = qx0; rx < qx0 + LOOM_QUARTER_WIDTH; rx++) {
                const wx = px + rx;
                if (wx < 0 || wx >= surfW) continue;
                const o = (wy * surfW + wx) * 4;
                data[o] = rowC[0];
                data[o + 1] = rowC[1];
                data[o + 2] = rowC[2];
                data[o + 3] = 255;
            }
        }
    }

    const plotSkyPx = (rx, relY, rgba) => {
        if (rx < 0 || rx >= LOOM_PANEL_WIDTH || relY < 0 || relY >= 9) return;
        const q = Math.floor(rx / LOOM_QUARTER_WIDTH);
        if (!coverage[q]) return;
        setPx(data, surfW, px + rx, py + yTop + relY, surfW, surfH, rgba[0], rgba[1], rgba[2], rgba[3]);
    };

    // 2. Night/dusk stars & stepped pixel moon (deterministic by hour).
    if ((sky.phase === 'night' || sky.phase === 'dusk') && sky.weather !== 'overcast' && sky.weather !== 'storm' && sky.weather !== 'rain') {
        const starPositions = [
            [7, 1], [19, 3], [31, 1], [45, 2], [58, 1], [71, 3], [84, 1], [91, 4],
        ];
        for (let i = 0; i < starPositions.length; i++) {
            const sx = (starPositions[i][0] + hour * 3) % (LOOM_PANEL_WIDTH - 4) + 2;
            const sy = starPositions[i][1];
            plotSkyPx(sx, sy, PALETTE.starBright);
        }
    }

    if (sky.moonOctant !== null && sky.moonOctant > 0 && sky.weather !== 'overcast' && sky.weather !== 'storm') {
        // 5x5 pixel moon disc shaded by octant (1..7; 4 = full moon).
        const mx = 76;
        const my = 2;
        const litMask = [
            '01110',
            '11111',
            '11111',
            '11111',
            '01110',
        ];
        for (let dy = 0; dy < 5; dy++) {
            for (let dx = 0; dx < 5; dx++) {
                if (litMask[dy][dx] !== '1') continue;
                let lit = true;
                if (sky.moonOctant === 1) lit = dx >= 3;
                else if (sky.moonOctant === 2) lit = dx >= 2;
                else if (sky.moonOctant === 3) lit = dx >= 1;
                else if (sky.moonOctant === 5) lit = dx <= 3;
                else if (sky.moonOctant === 6) lit = dx <= 2;
                else if (sky.moonOctant === 7) lit = dx <= 1;
                plotSkyPx(mx + dx, my + dy, lit ? PALETTE.moonBright : PALETTE.moonShade);
            }
        }
    }

    // 3. Clouds (stepped pixel puffs).
    if (sky.cloud >= 1 && sky.weather !== 'fog') {
        const cloudColor = (sky.weather === 'storm' || sky.phase === 'night')
            ? PALETTE.cloudDark
            : PALETTE.cloudLight;
        const cloudShade = (sky.weather === 'storm' || sky.phase === 'night')
            ? PALETTE.stormTop
            : PALETTE.cloudMid;
        const puffStarts = sky.cloud === 1 ? [14, 54] : sky.cloud === 2 ? [6, 36, 66] : [2, 24, 48, 72];
        for (let i = 0; i < puffStarts.length; i++) {
            const cx = puffStarts[i];
            const cy = (i & 1) === 0 ? 1 : 2;
            for (let dx = 3; dx <= 11; dx++) plotSkyPx(cx + dx, cy, cloudColor);
            for (let dx = 1; dx <= 14; dx++) plotSkyPx(cx + dx, cy + 1, cloudColor);
            for (let dx = 0; dx <= 15; dx++) plotSkyPx(cx + dx, cy + 2, cloudShade);
        }
    }

    // 4. Fog horizontal stepped ribbons.
    if (sky.weather === 'fog') {
        for (let rx = 2; rx < LOOM_PANEL_WIDTH - 2; rx++) {
            if ((rx % 10) < 7) plotSkyPx(rx, 4, PALETTE.fogBand);
            if (((rx + 5) % 12) < 8) plotSkyPx(rx, 7, PALETTE.cloudLight);
        }
    }

    // 5. Diagonal 1 px rain streaks & storm lightning jag.
    if (sky.weather === 'rain' || sky.weather === 'storm') {
        for (let rx = 4; rx < LOOM_PANEL_WIDTH - 2; rx += 6) {
            plotSkyPx(rx, 5, PALETTE.rainStreak);
            plotSkyPx(rx - 1, 6, PALETTE.rainStreak);
            plotSkyPx(rx - 2, 7, PALETTE.rainStreak);
            plotSkyPx(rx - 3, 8, PALETTE.rainStreak);
        }
        if (sky.weather === 'storm') {
            const lx = 46;
            plotSkyPx(lx, 3, PALETTE.lightning);
            plotSkyPx(lx - 1, 4, PALETTE.lightning);
            plotSkyPx(lx, 5, PALETTE.lightning);
            plotSkyPx(lx + 1, 6, PALETTE.lightning);
            plotSkyPx(lx, 7, PALETTE.lightning);
        }
    }

    // 6. Crisp pixel snowflakes.
    if (sky.weather === 'snow') {
        for (let i = 0; i < 12; i++) {
            const sx = (i * 8 + ((hour * 5) % 7) + 3) % (LOOM_PANEL_WIDTH - 4) + 2;
            const sy = 4 + (i % 4);
            plotSkyPx(sx, sy, PALETTE.snowFlake);
        }
    }
}

function paintSelvedgeTicks(data, surfW, surfH, px, py, panel) {
    // Arrivals: top selvedge (rows 0-1).
    for (const arrival of panel.arrivals) {
        if (!panel.coverage[arrival.quarter]) continue;
        const wx = px + arrival.x;
        setPx(data, surfW, wx, py + 0, surfW, surfH, ...PALETTE.arrivalTick);
        setPx(data, surfW, wx + 1, py + 0, surfW, surfH, ...PALETTE.arrivalTickCore);
        setPx(data, surfW, wx, py + 1, surfW, surfH, ...PALETTE.arrivalTickCore);
    }
    // Departures: bottom selvedge (rows 70-71).
    for (const dep of panel.departures) {
        if (!panel.coverage[dep.quarter]) continue;
        const wx = px + dep.x;
        setPx(data, surfW, wx, py + 70, surfW, surfH, ...PALETTE.departureTickCore);
        setPx(data, surfW, wx, py + 71, surfW, surfH, ...PALETTE.departureTick);
        setPx(data, surfW, wx + 1, py + 71, surfW, surfH, ...PALETTE.departureTickCore);
    }
}

function paintRepoPennants(data, surfW, surfH, px, py, panel) {
    const repos = panel.repos;
    if (!repos.length) return;
    const y0 = LOOM_BANDS.repoPennants.y + 1; // rows 61..67 (7 px tall pennant)
    const count = repos.length;
    const pennantW = count <= 6 ? 12 : count <= 10 ? 8 : Math.max(4, Math.floor(92 / count) - 1);
    const gap = count <= 10 ? 2 : 1;
    let rx = 2;

    for (let i = 0; i < count; i++) {
        if (rx + 2 >= LOOM_PANEL_WIDTH - 1) break;
        const entry = repos[i];
        const idx = ((entry.pennantIndex ?? 0) % PENNANT_RGBA_TABLE.length + PENNANT_RGBA_TABLE.length) % PENNANT_RGBA_TABLE.length;
        const swatch = entry.color && entry.color !== PENNANT_RGBA_TABLE[idx].hex
            ? (() => {
                const base = parseHexRgba(entry.color);
                return { base, light: mixRgba(base, PALETTE.plateInk, 0.28), dark: mixRgba(base, PALETTE.inkWarm, 0.36) };
            })()
            : PENNANT_RGBA_TABLE[idx];

        const w = Math.min(pennantW, LOOM_PANEL_WIDTH - 2 - rx);
        for (let dy = 0; dy < 7; dy++) {
            const isNotch = w >= 6 && (dy === 3 || dy === 4);
            const rowEnd = isNotch ? w - 2 : (w >= 6 && (dy === 2 || dy === 5) ? w - 1 : w);
            for (let dx = 0; dx < rowEnd; dx++) {
                const localX = rx + dx;
                const q = Math.floor(localX / LOOM_QUARTER_WIDTH);
                if (!panel.coverage[q]) continue;
                let c;
                if (dx === 0) c = PALETTE.pennantPole;
                else if (dy === 0) c = swatch.light;
                else if (dy === 6) c = swatch.dark;
                else c = swatch.base;
                setPx(data, surfW, px + localX, py + y0 + dy, surfW, surfH, c[0], c[1], c[2], 255);
            }
        }
        rx += w + gap;
    }
}

function blitCustomMiniature(data, surfW, surfH, custom, ox, oy) {
    const srcW = Math.floor(Number(custom?.width) || 0);
    const srcH = Math.floor(Number(custom?.height) || 0);
    const src = custom?.data;
    if (!srcW || !srcH || !src || src.length < srcW * srcH * 4) return false;

    const dstW = LOOM_GRID.actorWidth;
    const dstH = LOOM_GRID.actorHeight;
    // Nearest-neighbor fit into 14x16 box preserving aspect ratio (bottom-aligned).
    const scale = Math.min(dstW / srcW, dstH / srcH);
    const drawW = Math.max(1, Math.min(dstW, Math.round(srcW * scale)));
    const drawH = Math.max(1, Math.min(dstH, Math.round(srcH * scale)));
    const padX = Math.floor((dstW - drawW) / 2);
    const padY = dstH - drawH;

    for (let dy = 0; dy < drawH; dy++) {
        const sy = Math.min(srcH - 1, Math.floor((dy * srcH) / drawH));
        for (let dx = 0; dx < drawW; dx++) {
            const sx = Math.min(srcW - 1, Math.floor((dx * srcW) / drawW));
            const so = (sy * srcW + sx) * 4;
            const a = src[so + 3];
            if (a <= 0) continue;
            setPx(data, surfW, ox + padX + dx, oy + padY + dy, surfW, surfH, src[so], src[so + 1], src[so + 2], a);
        }
    }
    return true;
}

function resolveEventStamp(cell) {
    if (cell.kind === LOOM_EVENT_KIND.ERRORED) {
        return cell.open ? COMPILED_STAMPS.errored : COMPILED_STAMPS.erroredResolved;
    }
    if (cell.kind === LOOM_EVENT_KIND.PUSH && cell.failed) {
        return COMPILED_STAMPS.pushFailed;
    }
    return COMPILED_STAMPS[cell.kind] || COMPILED_STAMPS.completed;
}

function paintEventCell(data, surfW, surfH, cx, cy, cell, resolveMiniature) {
    // 1. Actor miniature (left 14x16, vertically centered at cy + 3).
    const actorX = cx;
    const actorY = cy + 3;
    let drewCustom = false;
    if (typeof resolveMiniature === 'function') {
        try {
            const mini = resolveMiniature(cell.actor, {
                width: LOOM_GRID.actorWidth,
                height: LOOM_GRID.actorHeight,
            });
            if (mini) drewCustom = blitCustomMiniature(data, surfW, surfH, mini, actorX, actorY);
        } catch {
            drewCustom = false;
        }
    }
    if (!drewCustom) {
        stampCompiled(data, surfW, surfH, COMPILED_PAWN, actorX, actorY);
    }

    // 2. 12x12 event stamp (right column: cx + 14 + 2 = cx + 16, y = cy + 1..12).
    const stampX = cx + LOOM_GRID.actorWidth + LOOM_GRID.actorGap;
    const stampY = cy + 1;
    stampCompiled(data, surfW, surfH, resolveEventStamp(cell), stampX, stampY);

    // 3. Pip row / wait knots / pixel numeral underneath the stamp (y = cy + 15..20).
    const subY = cy + 15;
    if (cell.pipMode === 'knots') {
        // 1..6 knots at 2 px pitch across 12 px (centered).
        const knots = Math.max(1, Math.min(LOOM_MAX_WAIT_KNOTS, cell.waitKnots));
        const totalW = knots * 2 - 1;
        const startX = stampX + Math.floor((LOOM_GRID.stampSize - totalW) / 2);
        for (let i = 0; i < knots; i++) {
            const kx = startX + i * 2;
            setPx(data, surfW, kx, subY + 1, surfW, surfH, ...PALETTE.knotShadow);
            setPx(data, surfW, kx, subY + 2, surfW, surfH, ...PALETTE.knotFill);
            setPx(data, surfW, kx, subY + 3, surfW, surfH, ...PALETTE.knotShadow);
        }
    } else if (cell.pipMode === 'knot-numeral') {
        const text = String(cell.numeral);
        const tw = measurePixelTextWidth(text, '3x5');
        const tx = stampX + Math.floor((LOOM_GRID.stampSize - tw) / 2);
        stampPixelText(data, surfW, surfH, text, tx, subY, '3x5', PALETTE.knotFill, PALETTE.knotShadow);
    } else if (cell.pipMode === 'pips') {
        // 1..5 pips at 2 px pitch across 12 px (centered).
        const pips = Math.max(1, Math.min(LOOM_MAX_PIPS, cell.pips));
        const totalW = pips * 2 - 1;
        const startX = stampX + Math.floor((LOOM_GRID.stampSize - totalW) / 2);
        for (let i = 0; i < pips; i++) {
            const kx = startX + i * 2;
            setPx(data, surfW, kx, subY + 1, surfW, surfH, ...PALETTE.pipFill);
            setPx(data, surfW, kx, subY + 2, surfW, surfH, ...PALETTE.pipLit);
            setPx(data, surfW, kx, subY + 3, surfW, surfH, ...PALETTE.pipFill);
        }
    } else if (cell.pipMode === 'numeral') {
        const text = String(cell.numeral);
        const tw = measurePixelTextWidth(text, '3x5');
        const tx = stampX + Math.floor((LOOM_GRID.stampSize - tw) / 2);
        stampPixelText(data, surfW, surfH, text, tx, subY, '3x5', PALETTE.numeralInk, PALETTE.numeralHi);
    }
}

function paintOverflowPlate(data, surfW, surfH, cx, cy, cell) {
    // Framed 26x18 woodcut walnut & brass plate centered in the 28x22 cell.
    const x0 = cx + 1;
    const y0 = cy + 2;
    const w = 26;
    const h = 18;
    fillRectRgba(data, surfW, surfH, x0, y0, w, h, PALETTE.plateRim);
    fillRectRgba(data, surfW, surfH, x0 + 1, y0 + 1, w - 2, h - 2, PALETTE.plateFill);
    fillRectRgba(data, surfW, surfH, x0 + 2, y0 + 2, w - 4, h - 4, PALETTE.plateInner);
    // Corner brass pins.
    setPx(data, surfW, x0 + 1, y0 + 1, surfW, surfH, ...PALETTE.platePin);
    setPx(data, surfW, x0 + w - 2, y0 + 1, surfW, surfH, ...PALETTE.platePin);
    setPx(data, surfW, x0 + 1, y0 + h - 2, surfW, surfH, ...PALETTE.platePin);
    setPx(data, surfW, x0 + w - 2, y0 + h - 2, surfW, surfH, ...PALETTE.platePin);

    const text = `+${cell.count}`;
    const font = measurePixelTextWidth(text, '5x7') <= w - 4 ? '5x7' : '3x5';
    const glyphH = font === '5x7' ? 7 : 5;
    const tw = measurePixelTextWidth(text, font);
    const tx = x0 + Math.floor((w - tw) / 2);
    const ty = y0 + Math.floor((h - glyphH) / 2);
    stampPixelText(data, surfW, surfH, text, tx, ty, font, PALETTE.plateInk, PALETTE.ink);
}

function paintClosingHem(data, surfW, surfH, px, py) {
    // Evensong close (§5.5): a 2 px finished walnut-and-brass lockstitch along
    // the panel's right edge sealing the day's last panel (pure pixels, zero text).
    const edgeX = LOOM_PANEL_WIDTH - 2;
    for (let ry = 0; ry < LOOM_PANEL_HEIGHT; ry++) {
        const inner = (ry & 3) === 0 ? PALETTE.plateRim : PALETTE.selvedgeDark;
        const outer = (ry & 1) === 0 ? PALETTE.selvedgeDark : PALETTE.selvedgeStitch;
        setPx(data, surfW, px + edgeX, py + ry, surfW, surfH, inner[0], inner[1], inner[2], 255);
        setPx(data, surfW, px + edgeX + 1, py + ry, surfW, surfH, outer[0], outer[1], outer[2], 255);
    }
}

function paintPanelOntoRgba(data, surfW, surfH, px, py, panel, options = {}) {
    // Fully uncovered hour: 100% pure bare warp (vertical threads every 4 px,
    // zero weft, zero fabricated sky/events).
    if (panel.fullyUncovered && !options.ignoreCoverage) {
        for (let q = 0; q < LOOM_QUARTERS_PER_HOUR; q++) {
            paintBareWarpQuarter(data, surfW, surfH, px, py, q);
        }
        if (options.closed === true) paintClosingHem(data, surfW, surfH, px, py);
        return;
    }

    const effectivePanel = options.ignoreCoverage
        ? { ...panel, coverage: [true, true, true, true], fullyUncovered: false }
        : panel;

    // 1. Quarter-hour fabric pass: covered quarters get woven linen/selvedge;
    //    uncovered quarters get bare warp across their 24 px band.
    for (let q = 0; q < LOOM_QUARTERS_PER_HOUR; q++) {
        if (effectivePanel.coverage[q]) {
            paintCoveredFabricQuarter(data, surfW, surfH, px, py, q);
        } else {
            paintBareWarpQuarter(data, surfW, surfH, px, py, q);
        }
    }

    // 2. Sky border (rows 2-11) on covered quarters.
    paintSkyBorder(data, surfW, surfH, px, py, effectivePanel);

    // 3. Repo pennants (rows 60-69) on covered quarters.
    paintRepoPennants(data, surfW, surfH, px, py, effectivePanel);

    // 4. Arrival/departure border ticks on selvedge (rows 0-1, 70-71).
    paintSelvedgeTicks(data, surfW, surfH, px, py, effectivePanel);

    // 5. Event cells & optional +N overflow plate inside field (rows 12-59).
    const fieldY = py + LOOM_BANDS.field.y;
    for (const cell of effectivePanel.cells) {
        const cx = px + LOOM_GRID.marginX + cell.col * (LOOM_GRID.cellWidth + LOOM_GRID.gapX);
        const cy = fieldY + LOOM_GRID.marginY + cell.row * (LOOM_GRID.cellHeight + LOOM_GRID.gapY);
        if (cell.type === 'overflow') {
            paintOverflowPlate(data, surfW, surfH, cx, cy, cell);
        } else {
            paintCellLinenBacking(data, surfW, surfH, px, py, cx, cy);
            paintEventCell(data, surfW, surfH, cx, cy, cell, options.resolveMiniature);
        }
    }

    if (options.closed === true) paintClosingHem(data, surfW, surfH, px, py);
}

// --- Public RGBA Renderers --------------------------------------------------

/**
 * Select the hourly panel to hang on the Archive's rear-wall Loom frame (§5.2):
 * explicit `hour` if provided, otherwise the latest active hour (with cells or
 * selvedge ticks), otherwise the latest covered hour. Returns `null` when the
 * day has neither observed coverage nor recorded events (V8 honesty: no empty
 * placeholder panel).
 */
export function selectArchiveLoomPanel(dayModelInput, { hour = null } = {}) {
    const dayModel = dayModelInput?.panels ? dayModelInput : weaveDay(dayModelInput);
    if (Number.isInteger(hour) && hour >= 0 && hour < LOOM_HOURS_PER_DAY) {
        return dayModel.panels[hour];
    }
    for (let h = LOOM_HOURS_PER_DAY - 1; h >= 0; h--) {
        const p = dayModel.panels[h];
        if (p.cells.length > 0 || p.arrivals.length > 0 || p.departures.length > 0) return p;
    }
    for (let h = LOOM_HOURS_PER_DAY - 1; h >= 0; h--) {
        if (!dayModel.panels[h].fullyUncovered) return dayModel.panels[h];
    }
    return null;
}

function resolveSinglePanel(panelOrDay, options = {}) {
    if (panelOrDay && typeof panelOrDay.hour === 'number' && Array.isArray(panelOrDay.cells)) {
        return panelOrDay;
    }
    const dayModel = panelOrDay?.panels ? panelOrDay : weaveDay(panelOrDay);
    return selectArchiveLoomPanel(dayModel, options) || dayModel.panels[LOOM_HOURS_PER_DAY - 1];
}

/**
 * Render one 96x72 hourly Loom panel into a pure RGBA pixel buffer.
 * Used for the Archive rear wall (`single-panel`) and panel-level verification.
 */
export function renderLoomPanel(panelOrDay, options = {}) {
    const panel = resolveSinglePanel(panelOrDay, options);
    const width = LOOM_PANEL_WIDTH;
    const height = LOOM_PANEL_HEIGHT;
    const data = new Uint8ClampedArray(width * height * 4);
    paintPanelOntoRgba(data, width, height, 0, 0, panel, options);
    return {
        width,
        height,
        data,
        layout: 'single-panel',
        hour: panel.hour,
        panelRects: Object.freeze([Object.freeze({ hour: panel.hour, x: 0, y: 0, width, height })]),
    };
}

/**
 * Render the 24x1 horizontal day frieze (2304 x 72 by default) for the
 * Chronicle view.
 */
export function renderLoomFrieze(dayModelInput, options = {}) {
    const dayModel = dayModelInput?.panels ? dayModelInput : weaveDay(dayModelInput);
    const colGap = Math.max(0, Math.floor(Number(options.colGap) || 0));
    const padX = Math.max(0, Math.floor(Number(options.padX) || 0));
    const padY = Math.max(0, Math.floor(Number(options.padY) || 0));
    const width = padX * 2 + LOOM_HOURS_PER_DAY * LOOM_PANEL_WIDTH + (LOOM_HOURS_PER_DAY - 1) * colGap;
    const height = padY * 2 + LOOM_PANEL_HEIGHT;
    const data = new Uint8ClampedArray(width * height * 4);
    if (padX > 0 || padY > 0 || colGap > 0) {
        fillRectRgba(data, width, height, 0, 0, width, height, PALETTE.beamDark);
    }

    const panelRects = [];
    for (let h = 0; h < LOOM_HOURS_PER_DAY; h++) {
        const x = padX + h * (LOOM_PANEL_WIDTH + colGap);
        const y = padY;
        paintPanelOntoRgba(data, width, height, x, y, dayModel.panels[h], options);
        panelRects.push(Object.freeze({ hour: h, x, y, width: LOOM_PANEL_WIDTH, height: LOOM_PANEL_HEIGHT }));
    }

    return {
        width,
        height,
        data,
        layout: 'strip',
        panelRects: Object.freeze(panelRects),
    };
}

function paintTapestryBeam(data, width, height, y0, bandHeight, cols, padX, colGap) {
    if (bandHeight <= 0) return;
    fillRectRgba(data, width, height, 0, y0, width, bandHeight, PALETTE.beamDark);
    if (bandHeight >= 6) {
        const midY = y0 + Math.floor(bandHeight / 2);
        fillRectRgba(data, width, height, 0, midY - 2, width, 4, PALETTE.beamMid);
        fillRectRgba(data, width, height, 0, midY - 2, width, 1, PALETTE.beamLit);
        fillRectRgba(data, width, height, 0, midY + 2, width, 1, PALETTE.ink);
        // Brass hour stitches along the wooden loom rod (zero text).
        for (let c = 0; c <= cols; c++) {
            const bx = Math.min(width - 2, padX + c * (LOOM_PANEL_WIDTH + colGap));
            const major = (c % 6) === 0;
            fillRectRgba(data, width, height, bx, midY - (major ? 2 : 1), major ? 2 : 1, major ? 5 : 3, PALETTE.beamBrass);
        }
    }
}

/**
 * Render the 12x2 Loom Tapestry grid matching §4.11 Tapestry band y 1124-1340
 * (1152 x 216 px by default: 24 px top loom rod, 72 px hours 0-11, 24 px
 * heddle bar, 72 px hours 12-23, 24 px bottom loom rod).
 */
export function renderLoomTapestryGrid(dayModelInput, options = {}) {
    const dayModel = dayModelInput?.panels ? dayModelInput : weaveDay(dayModelInput);
    const cols = LOOM_TAPESTRY_BAND.cols;
    const rows = LOOM_TAPESTRY_BAND.rows;
    const colGap = options.colGap !== undefined ? Math.max(0, Math.floor(Number(options.colGap))) : LOOM_TAPESTRY_BAND.colGap;
    const rowGap = options.rowGap !== undefined ? Math.max(0, Math.floor(Number(options.rowGap))) : LOOM_TAPESTRY_BAND.rowGap;
    const padX = options.padX !== undefined ? Math.max(0, Math.floor(Number(options.padX))) : LOOM_TAPESTRY_BAND.padX;
    const padY = options.padY !== undefined ? Math.max(0, Math.floor(Number(options.padY))) : LOOM_TAPESTRY_BAND.padY;

    const width = padX * 2 + cols * LOOM_PANEL_WIDTH + (cols - 1) * colGap;
    const height = padY * 2 + rows * LOOM_PANEL_HEIGHT + (rows - 1) * rowGap;
    const data = new Uint8ClampedArray(width * height * 4);
    fillRectRgba(data, width, height, 0, 0, width, height, PALETTE.beamDark);

    // Decorative wooden loom beams & brass hour notches (pure pixel art, zero text).
    paintTapestryBeam(data, width, height, 0, padY, cols, padX, colGap);
    paintTapestryBeam(data, width, height, padY + LOOM_PANEL_HEIGHT, rowGap, cols, padX, colGap);
    paintTapestryBeam(data, width, height, padY + LOOM_PANEL_HEIGHT * 2 + rowGap, padY, cols, padX, colGap);

    const panelRects = [];
    for (let h = 0; h < LOOM_HOURS_PER_DAY; h++) {
        const col = h % cols;
        const row = Math.floor(h / cols);
        const x = padX + col * (LOOM_PANEL_WIDTH + colGap);
        const y = padY + row * (LOOM_PANEL_HEIGHT + rowGap);
        paintPanelOntoRgba(data, width, height, x, y, dayModel.panels[h], options);
        panelRects.push(Object.freeze({ hour: h, x, y, width: LOOM_PANEL_WIDTH, height: LOOM_PANEL_HEIGHT }));
    }

    return {
        width,
        height,
        data,
        layout: 'tapestry',
        panelRects: Object.freeze(panelRects),
    };
}

/**
 * Unified pure RGBA renderer supporting all three layouts:
 * - `'strip'` (24x1 horizontal frieze)
 * - `'tapestry'` (12x2 grid for Tapestry band y 1124-1340)
 * - `'single-panel'` (96x72 for Archive rear wall)
 */
export function renderLoomToRgba(dayModelInput, options = {}) {
    const layout = options?.layout || 'strip';
    if (layout === 'tapestry') return renderLoomTapestryGrid(dayModelInput, options);
    if (layout === 'single-panel') return renderLoomPanel(dayModelInput, options);
    return renderLoomFrieze(dayModelInput, options);
}

// --- Canvas2D Renderer (Zero Text, Integer Pixel-Exact) ---------------------

function cssRgbaString(r, g, b, a) {
    if (a >= 255) {
        return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
    }
    return `rgba(${r},${g},${b},${(a / 255).toFixed(4)})`;
}

/**
 * Draw a woven day or pre-rendered RGBA Loom surface onto a 2D Canvas context
 * using integer pixel writes only (`putImageData` or run-length `fillRect`).
 * Never calls `fillText`, `strokeText`, or `measureText`.
 */
export function drawLoomToCanvas(ctx, dayModelOrRgba, options = {}) {
    if (!ctx) throw new TypeError('drawLoomToCanvas requires a 2D canvas context');
    const rgba = dayModelOrRgba?.data && dayModelOrRgba?.width && dayModelOrRgba?.height
        ? dayModelOrRgba
        : renderLoomToRgba(dayModelOrRgba, options);
    const ox = Math.round(Number(options.x) || 0);
    const oy = Math.round(Number(options.y) || 0);
    const scale = Math.max(1, Math.round(Number(options.scale) || 1));

    if ('imageSmoothingEnabled' in ctx) ctx.imageSmoothingEnabled = false;

    if (scale === 1 && !options.preferFillRect && typeof ctx.putImageData === 'function' && typeof ImageData === 'function') {
        const imageData = new ImageData(new Uint8ClampedArray(rgba.data), rgba.width, rgba.height);
        ctx.putImageData(imageData, ox, oy);
        return { width: rgba.width, height: rgba.height, x: ox, y: oy, scale, layout: rgba.layout || options.layout || 'strip' };
    }

    // Run-length horizontal fillRect blit: integer coordinates, works in both
    // browser Canvas2D (at any integer scale) and Node mock 2D contexts.
    const { width, height, data } = rgba;
    let lastFill = null;
    for (let y = 0; y < height; y++) {
        const rowBase = y * width * 4;
        let x = 0;
        while (x < width) {
            const o = rowBase + x * 4;
            const r = data[o];
            const g = data[o + 1];
            const b = data[o + 2];
            const a = data[o + 3];
            let run = 1;
            while (x + run < width) {
                const no = rowBase + (x + run) * 4;
                if (data[no] !== r || data[no + 1] !== g || data[no + 2] !== b || data[no + 3] !== a) break;
                run += 1;
            }
            if (a > 0) {
                const fill = cssRgbaString(r, g, b, a);
                if (fill !== lastFill) {
                    ctx.fillStyle = fill;
                    lastFill = fill;
                }
                ctx.fillRect(ox + x * scale, oy + y * scale, run * scale, scale);
            }
            x += run;
        }
    }

    return {
        width: width * scale,
        height: height * scale,
        x: ox,
        y: oy,
        scale,
        layout: rgba.layout || options.layout || 'strip',
    };
}

// --- Pure-JS Lossless PNG Encoder (Browser + Node, Deterministic) -----------

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[i] = c >>> 0;
    }
    return table;
})();

function crc32(bytes, start = 0, end = bytes.length) {
    let c = 0xffffffff;
    for (let i = start; i < end; i++) {
        c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes) {
    let a = 1;
    let b = 0;
    const len = bytes.length;
    let i = 0;
    while (i < len) {
        const chunkEnd = Math.min(len, i + 5552);
        while (i < chunkEnd) {
            a += bytes[i++];
            b += a;
        }
        a %= 65521;
        b %= 65521;
    }
    return ((b << 16) | a) >>> 0;
}

function writeU32BE(buf, offset, value) {
    buf[offset] = (value >>> 24) & 0xff;
    buf[offset + 1] = (value >>> 16) & 0xff;
    buf[offset + 2] = (value >>> 8) & 0xff;
    buf[offset + 3] = value & 0xff;
}

function zlibStore(raw) {
    const MAX_BLOCK = 65535;
    const blockCount = Math.max(1, Math.ceil(raw.length / MAX_BLOCK));
    const out = new Uint8Array(2 + raw.length + blockCount * 5 + 4);
    // RFC 1950 header: CM=8 (DEFLATE), CINFO=7 (32K), FLG=0x01 (checksum mod 31 = 0).
    out[0] = 0x78;
    out[1] = 0x01;
    let pos = 2;
    let srcOffset = 0;
    for (let b = 0; b < blockCount; b++) {
        const remaining = raw.length - srcOffset;
        const len = Math.min(MAX_BLOCK, remaining);
        const isLast = b === blockCount - 1;
        out[pos++] = isLast ? 0x01 : 0x00; // BFINAL + BTYPE=00 (stored)
        out[pos++] = len & 0xff;
        out[pos++] = (len >>> 8) & 0xff;
        const nlen = (~len) & 0xffff;
        out[pos++] = nlen & 0xff;
        out[pos++] = (nlen >>> 8) & 0xff;
        if (len > 0) {
            out.set(raw.subarray(srcOffset, srcOffset + len), pos);
            pos += len;
            srcOffset += len;
        }
    }
    writeU32BE(out, pos, adler32(raw));
    return out;
}

function makePngChunk(type, payload) {
    const chunk = new Uint8Array(12 + payload.length);
    writeU32BE(chunk, 0, payload.length);
    chunk[4] = type.charCodeAt(0);
    chunk[5] = type.charCodeAt(1);
    chunk[6] = type.charCodeAt(2);
    chunk[7] = type.charCodeAt(3);
    chunk.set(payload, 8);
    writeU32BE(chunk, 8 + payload.length, crc32(chunk, 4, 8 + payload.length));
    return chunk;
}

/**
 * Encode an RGBA surface (`{ width, height, data }`) or woven day model into a
 * spec-compliant, deterministic lossless 8-bit RGBA PNG (`Uint8Array`).
 * Pure JavaScript — identical output in Node and every browser.
 */
export function encodeLoomPng(rgbaOrDayModel, options = {}) {
    const rgba = rgbaOrDayModel?.data && rgbaOrDayModel?.width && rgbaOrDayModel?.height
        ? rgbaOrDayModel
        : renderLoomToRgba(rgbaOrDayModel, options);
    const { width, height, data } = rgba;
    const rowBytes = width * 4;
    const scanlines = new Uint8Array((rowBytes + 1) * height);
    for (let y = 0; y < height; y++) {
        const dst = y * (rowBytes + 1);
        scanlines[dst] = 0; // Filter type 0 (None)
        scanlines.set(data.subarray(y * rowBytes, (y + 1) * rowBytes), dst + 1);
    }

    const ihdr = new Uint8Array(13);
    writeU32BE(ihdr, 0, width);
    writeU32BE(ihdr, 4, height);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // color type RGBA
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // interlace

    const ihdrChunk = makePngChunk('IHDR', ihdr);
    const idatChunk = makePngChunk('IDAT', zlibStore(scanlines));
    const iendChunk = makePngChunk('IEND', new Uint8Array(0));

    const png = new Uint8Array(PNG_SIGNATURE.length + ihdrChunk.length + idatChunk.length + iendChunk.length);
    let offset = 0;
    png.set(PNG_SIGNATURE, offset); offset += PNG_SIGNATURE.length;
    png.set(ihdrChunk, offset); offset += ihdrChunk.length;
    png.set(idatChunk, offset); offset += idatChunk.length;
    png.set(iendChunk, offset);
    return png;
}
