export const THEME = {
    bg: '#090a0c',
    panel: 'rgba(29, 21, 17, 0.96)',
    text: '#f6da82',
    textSecondary: '#bda27a',
    accent: '#7ac8d8',
    working: '#79d975',
    idle: '#86bfe0',
    waiting: '#df8c3f',
    error: '#ef4444',
    rateLimited: '#8fa6bd',
    waitingOnUser: '#facc15',
    chatting: '#f2d36b',
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

// --- House Palette (item #1): one tokenized color authority --------------
// Every surface imports from here instead of keeping a private RGB/hex table,
// so World and Dashboard read as two windows onto the same town.

// The 5-status set + chatting, with sprite-glow tints. AgentSprite consumes
// the full record; flat color is available via the THEME.* status keys above.
export const STATUS_VISUALS = Object.freeze({
    working: { color: THEME.working, glow: 'rgba(121, 217, 117, 0.32)', label: 'WORK' },
    waiting: { color: THEME.waiting, glow: 'rgba(223, 140, 63, 0.34)', label: 'WAIT' },
    idle: { color: THEME.idle, glow: 'rgba(134, 191, 224, 0.22)', label: 'IDLE' },
    errored: { color: THEME.error, glow: 'rgba(239, 68, 68, 0.40)', label: 'ERROR' },
    rate_limited: { color: THEME.rateLimited, glow: 'rgba(143, 166, 189, 0.24)', label: 'RATELIMIT' },
    waiting_on_user: { color: THEME.waitingOnUser, glow: 'rgba(250, 204, 21, 0.34)', label: 'INPUT' },
    chatting: { color: THEME.chatting, glow: 'rgba(242, 211, 107, 0.30)', label: 'CHAT' },
});

// Nine building accents (hex), one per village building. `*_RGB` mirrors are
// the `'r, g, b'` form the world-overlay `rgba()` helper expects.
export const BUILDING_ACCENTS = Object.freeze({
    command: '#f4c45d',
    taskboard: '#7dd3fc',
    archive: '#c084fc',
    mine: '#fb923c',
    forge: '#f87171',
    harbor: '#5eead4',
    watchtower: '#facc15',
    observatory: '#818cf8',
    portal: '#c084fc',
});
export const BUILDING_ACCENTS_RGB = Object.freeze({
    command: '244, 196, 93',
    taskboard: '125, 211, 252',
    archive: '192, 132, 252',
    mine: '251, 146, 60',
    forge: '248, 113, 113',
    harbor: '94, 234, 212',
    watchtower: '250, 204, 21',
    observatory: '129, 140, 248',
    portal: '192, 132, 252',
});

// Incident signal hues (`'r, g, b'` form for world overlays).
export const INCIDENT_COLORS_RGB = Object.freeze({
    quota: '251, 146, 60',
    'failed-push': '248, 113, 113',
    rate_limited: '250, 204, 21',
    waiting_on_user: '250, 204, 21',
    errored: '248, 113, 113',
});

// One hue per provider CLI: trim (world sprite accent), badge (UI chip), and
// the dashboard/sidebar chip background.
export const PROVIDER_HUES = Object.freeze({
    claude: { trim: '#c7a6ff', badge: '#a78bfa', badgeBg: 'rgba(167,139,250,0.15)' },
    codex: { trim: '#67f29a', badge: '#4ade80', badgeBg: 'rgba(74,222,128,0.15)' },
    gemini: { trim: '#7fc7ff', badge: '#60a5fa', badgeBg: 'rgba(96,165,250,0.15)' },
    git: { trim: '#f6cf60', badge: '#f6cf60', badgeBg: 'rgba(246,207,96,0.15)' },
    grok: { trim: '#7df9ff', badge: '#7df9ff', badgeBg: 'rgba(125,249,255,0.15)' },
    kimi: { trim: '#ff8da8', badge: '#ff9f7a', badgeBg: 'rgba(255,159,122,0.15)' },
    opencode: { trim: '#7cf4c8', badge: '#7cf4c8', badgeBg: 'rgba(124,244,200,0.15)' },
    deepseek: { trim: '#7cf4c8', badge: '#7cf4c8', badgeBg: 'rgba(124,244,200,0.15)' },
    default: { trim: '#f2d36b', badge: '#8b8b9e', badgeBg: 'rgba(139,139,158,0.15)' },
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
});
