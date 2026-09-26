export const THEME = {
    bg: '#090a0c',
    panel: 'rgba(29, 21, 17, 0.96)',
    text: '#f6da82',
    textSecondary: '#bda27a',
    accent: '#7ac8d8',
    working: '#79d975',
    idle: '#86bfe0',
    waiting: '#df8c3f',
    error: '#e06c5b',
    // Magenta-orchid: Tier A (HSL S 0.82) and 105° from idle sky, so a quota
    // hold never reads as "nothing is happening"; OKLab dE >= 0.09 from every
    // tool, accent and pennant hue.
    rateLimited: '#f06ae0',
    waitingOnUser: '#e8d44d',
    chatting: '#f2d36b',
    // 0.4 — completed is a first-class status: soft-gold "small victory" tone.
    completed: '#ffd873',
    ally: '#f0b27a',
    border: 'rgba(214, 169, 81, 0.48)',
    grass: ['#2c542d', '#315b31', '#386337', '#335a2f', '#3b6838'],
    path: ['#755f3c', '#866d45', '#987f54', '#624d32'],
    plaza: ['#8a7656', '#988362', '#796748', '#a08b68'],
    water: ['#103a55', '#174f70', '#216984'],
    deepWater: ['#0a2336', '#0e2c44', '#103456'],
    // Phase-coupled water tint mix weights. The renderer multiplies each by
    // `atmosphere.reactions.warmGlint` / `nightReflection` to blend the base
    // teal water toward the active phase palette's horizon/zenith.
    waterTint: {
        horizonMix: 0.55,
        zenithMix: 0.45,
        alphaCap: 0.22,
    },
    bridgeWood: {
        deck: '#5a3f24',
        deckLight: '#74532f',
        plankLine: 'rgba(28, 18, 8, 0.42)',
        rail: '#3a2917',
        railLight: '#553b21',
    },
    treeFoliage: ['#1f4a26', '#28552d', '#316336', '#264e29', '#2d5a32'],
    treeTrunk: '#3b2715',
    treeTrunkLight: '#52391f',
    bushFoliage: ['#2d5a30', '#345f33', '#3a6b3a', '#2c5429'],
    rock: {
        base: '#52524a',
        light: '#6c6c63',
        dark: '#36352f',
        moss: 'rgba(54, 84, 38, 0.55)',
    },
};

// Companion/body face for mixed-case world canvas text (names, bubbles,
// ledgers, overlay pills, debug readouts). Departure Mono is narrower per
// glyph than Press Start 2P, so labels pack tighter when dezoomed.
// Single-weight face: never request "bold" (synthetic bold smears the pixels).
export const WORLD_BODY_FONT = '"Departure Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
export const WORLD_DISPLAY_FACE = '"Press Start 2P", monospace';

// C5 type grid (plan 5.4). Both faces are bitmap fonts on fixed grids — Press
// Start 2P is 8 px/em, Departure Mono 11 px/em — so every canvas `ctx.font`
// uses one of these four tokens: native size or its exact double, never bold,
// never world-scaled. Anything else drops or doubles glyph rows.
export const WORLD_DISPLAY_FONT_8 = `8px ${WORLD_DISPLAY_FACE}`;
export const WORLD_DISPLAY_FONT_16 = `16px ${WORLD_DISPLAY_FACE}`;
export const WORLD_BODY_FONT_11 = `11px ${WORLD_BODY_FONT}`;
export const WORLD_BODY_FONT_22 = `22px ${WORLD_BODY_FONT}`;

// --- House Palette (item #1): one tokenized color authority --------------
// Every surface imports from here instead of keeping a private RGB/hex table,
// so World and Dashboard read as two windows onto the same town.

// The status set (incl. sprite-only chatting and terminal completed), with
// sprite-glow tints and the one-char `mark` the compact badge draws
// (AgentSprite._drawCompactAgentBadge). Flat colors are available via the
// THEME.* status keys above.
export const STATUS_VISUALS = Object.freeze({
    working: { color: THEME.working, glow: 'rgba(121, 217, 117, 0.32)', label: 'WORK', mark: 'W' },
    waiting: { color: THEME.waiting, glow: 'rgba(223, 140, 63, 0.34)', label: 'WAIT', mark: '~' },
    idle: { color: THEME.idle, glow: 'rgba(134, 191, 224, 0.22)', label: 'IDLE', mark: 'I' },
    errored: { color: THEME.error, glow: 'rgba(239, 68, 68, 0.40)', label: 'ERROR', mark: '!' },
    rate_limited: { color: THEME.rateLimited, glow: 'rgba(240, 106, 224, 0.30)', label: 'RATELIMIT', mark: 'R' },
    waiting_on_user: { color: THEME.waitingOnUser, glow: 'rgba(250, 204, 21, 0.34)', label: 'INPUT', mark: '?' },
    chatting: { color: THEME.chatting, glow: 'rgba(242, 211, 107, 0.30)', label: 'CHAT', mark: 'C' },
    completed: { color: THEME.completed, glow: 'rgba(255, 216, 115, 0.30)', label: 'DONE', mark: '*' },
});

// Canonical CSS custom-property name per STATUS_VISUALS key. The boot bridge
// (App.js) and the token smoke script (scripts/smoke/theme-tokens.mjs) both
// consume this map so the CSS-facing names can never fork from the JS
// authority (plan 1.1/1.4). Note waiting_on_user's legacy CSS name.
export const STATUS_CSS_VARS = Object.freeze({
    working: '--cv-status-working',
    waiting: '--cv-status-waiting',
    idle: '--cv-status-idle',
    errored: '--cv-status-errored',
    rate_limited: '--cv-status-rate-limited',
    waiting_on_user: '--cv-status-waiting-user',
    chatting: '--cv-status-chatting',
    completed: '--cv-status-completed',
});

// Tool-category colours (tool history chips; plan 7.10). Status-free hues:
// every entry is OKLab dE >= 0.07 from every STATUS_VISUALS colour and
// >= 0.045 from its siblings, and keeps >= 4.5:1 on every chrome surface
// (--bg-0..3), so a tool chip never reads as working, idle, waiting or
// errored. reset.css mirrors these as --cv-tool-<key> for its CSS-only
// consumers; scripts/smoke/theme-tokens.mjs keeps the two equal.
export const TOOL_CATEGORY_COLORS = Object.freeze({
    read: '#6db3a5',   // sea teal
    write: '#d0879f',  // dusty rose
    exec: '#9d8fe3',   // violet
    search: '#c27fcc', // plum
    task: '#608cc0',   // deep azure
});

// --- Accent palette v2 (plan 4.3, contract C1) -----------------------------
// Building, provider and team accents are painted colours from the same
// earthy world as the ramps in config/artPalette.js, not screen neons. They
// sit at OKLab lightness 0.58-0.76 and chroma <= 0.105 (HSV S <= 0.55), so
// only the status hues (STATUS_VISUALS: okL 0.67-0.90, mostly chroma >= 0.13)
// ever reach Tier A (L > 0.70 or S > 0.65). Status stays the loudest colour on
// every chip, ring and plaque. Every accent keeps >= 4.5:1 contrast on the
// chrome's --bg-1 (#15100d), so painted never means illegible.
//
// De-collision contract (check with OKLab distance dE when editing):
//   - every building/provider/team accent is dE >= 0.07 from every status
//     hue, and red/orange/yellow/green/sky families are either absent or held
//     well below status lightness (forge brick, mine umber, command gilt,
//     watchtower lichen, taskboard steel);
//   - accents inside one table are dE >= 0.045 apart (no duplicates: Archive
//     violet and Portal orchid are split);
//   - team hues stay dE >= 0.04 from every provider hue because a team badge
//     and a provider pill can sit on the same row.
// `npm run art:analyze` reports Tier-A pixels in sprites; this table is the
// hand-checked half of the same rule.

// 'r, g, b' form the world-overlay `rgba()` helpers expect.
const rgbTriplet = (hex) => {
    const value = parseInt(String(hex).slice(1), 16);
    return `${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}`;
};

// Nine building accents (hex), one per village building. `*_RGB` mirrors are
// derived, so the two forms cannot fork.
export const BUILDING_ACCENTS = Object.freeze({
    command: '#bfb17e', // pale gilt limestone (the hero, not status gold)
    taskboard: '#568599', // steel blue, darker than idle sky
    archive: '#a08abb', // lavender violet
    mine: '#a27459', // raw umber, not waiting orange
    forge: '#b86765', // brick rose, darker and cooler than error coral
    harbor: '#589a95', // sea teal
    watchtower: '#8d9062', // lichen olive, not needs-you yellow
    observatory: '#7978b7', // night indigo
    portal: '#ac678b', // orchid, split from archive
});
export const BUILDING_ACCENTS_RGB = Object.freeze(Object.fromEntries(
    Object.entries(BUILDING_ACCENTS).map(([key, hex]) => [key, rgbTriplet(hex)]),
));

// Incident signal hues (`'r, g, b'` form for world overlays). These are the
// status tokens themselves, never private copies: quota and rate limits read
// as the rate-limit orchid, needs-you as the beacon yellow, failures as error coral.
export const INCIDENT_COLORS_RGB = Object.freeze({
    quota: rgbTriplet(THEME.rateLimited),
    'failed-push': rgbTriplet(THEME.error),
    rate_limited: rgbTriplet(THEME.rateLimited),
    waiting_on_user: rgbTriplet(THEME.waitingOnUser),
    errored: rgbTriplet(THEME.error),
});

// One hue per provider CLI, shared by trim (world sprite accent), badge (UI
// chip), and the dashboard/sidebar glyph (plan 1.5). Trim may be a lighter
// tint of the badge hue for sprite legibility; both stay painted (v2). Hues
// are de-collided from STATUS_VISUALS (plan 1.3): codex is sea teal and
// opencode jade, both far below working green; gemini indigo and deepseek
// deep blue sit well below idle sky and rate-limit slate; git is brass, not
// needs-you yellow; zai keeps its vermilion identity as a darker terracotta,
// clear of error coral; omp is lichen instead of chatting gold.
export const PROVIDER_HUES = Object.freeze({
    claude: { trim: '#977bb5', badge: '#977bb5', badgeBg: 'rgba(151,123,181,0.15)' },
    codex: { trim: '#5ba49c', badge: '#5ba49c', badgeBg: 'rgba(91,164,156,0.15)' },
    gemini: { trim: '#868ec3', badge: '#868ec3', badgeBg: 'rgba(134,142,195,0.15)' },
    git: { trim: '#bba66c', badge: '#bba66c', badgeBg: 'rgba(187,166,108,0.15)' },
    grok: { trim: '#4f8e9b', badge: '#4f8e9b', badgeBg: 'rgba(79,142,155,0.15)' },
    kimi: { trim: '#b9758c', badge: '#b9758c', badgeBg: 'rgba(185,117,140,0.15)' },
    omp: { trim: '#829063', badge: '#829063', badgeBg: 'rgba(130,144,99,0.15)' },
    opencode: { trim: '#589271', badge: '#589271', badgeBg: 'rgba(88,146,113,0.15)' },
    deepseek: { trim: '#5781ac', badge: '#5781ac', badgeBg: 'rgba(87,129,172,0.15)' },
    zai: { trim: '#b36b51', badge: '#b36b51', badgeBg: 'rgba(179,107,81,0.15)' },
    default: { trim: '#b9ad96', badge: '#8a857e', badgeBg: 'rgba(138,133,126,0.15)' },
});

// Mood bubble tones and model-tier crest hues.
export const MOOD_ACCENTS = Object.freeze({
    distressed: '#ff8a7a',
    proud: '#ffd87a',
    tired: '#9fb4c8',
});
export const MODEL_TIER_COLORS = Object.freeze({
    mythic: '#ffd6f0',
    apex: '#f6d27a',
    balanced: '#cfd6df',
    senior: '#cfd6df',
    light: '#c47b46',
    swift: '#c47b46',
    // DeepSeek V4 Pro's tier (plan 1.5): icy long-haul blue.
    'long-context': '#9ee7ff',
});

// Categorical team ramp (dashboard team badge, sidebar grouping, world
// council ring) folded in from TeamColor.js (plan 1.11). Painted v2 set under
// the accent de-collision contract above: no yellow, green or orange that
// could read as needs-you, working or waiting. Order is the hash order.
// rose-plum, olive, rosewater, deep jade, orchid, ochre, umber clay, slate
// indigo, linen, sandstone.
export const TEAM_HUES = Object.freeze([
    '#a26e88', '#8a814f', '#da9fa5', '#4d897e', '#c294b4',
    '#b38e5c', '#9c775e', '#7b7ba6', '#bcab92', '#bb9587',
]);
