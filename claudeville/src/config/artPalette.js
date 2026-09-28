// Master palette and value ladder (contract C1 of
// agents/plans/claudeville-opus55-aesthetic-plan.md).
//
// Plain data, importable from the browser and from Node scripts. Ramps run
// dark -> light and shift hue as they climb: shadows lean cool (blue/teal),
// highlights lean warm (gold). Authoring, terrain bakes, accents and the
// offline analyzer (`npm run art:analyze`) read these values instead of
// inventing private colours. Export names are stable; values may be tuned.
//
// Metrics used in every comment and threshold below:
//   S  = HSV saturation (max-min)/max, the measure the evidence notes use.
//   L  = sRGB relative luminance (the value-ladder "luma").
//   okL / okC = OKLab lightness / chroma (ramp spacing, nearest-stop checks).
//
// Brightest-thing rule (value budget):
//   Tier A  L > 0.70 or S > 0.65  unresolved status marks, the selected-agent
//                                 ring, authored emissive light at dusk/night.
//   Tier B  L 0.45-0.70           lit building faces, faces/hands, label text,
//                                 foam.
//   Tier C  L 0.15-0.45           shadow faces, roofs, props, foliage.
//   Tier D  L < 0.15              ground body, water body, void.
// No ramp below reaches Tier A except `emissive`; status hues live in theme.js.
// At night Tier A belongs to authored emitters and unresolved action-needed
// marks only: a lit receiver (ground, wall or prop under a light pool, a wet
// or water reflection) stays at or below RECEIVER_LUMA_CEILING, encoded
// Rec.709 luma 0.74 (okL 0.80): above it a receiver keeps a quarter of the
// excess, easing into a small headroom, and no lit receiver passes okL 0.836
// (the V5 receiver knee and okL cap in GpuWorldPolicy `stepPool`; they take
// value, not colour). A warm pool lands each course on its `emissive` stop
// (rim #ff9d4a, core #ffcf7a) at the receiver's own value, so pools stay warm
// on grass and stone alike. A lamp always reads brighter than the ground it
// lights, and pool cores keep their texture.
//
// Ramp roles:
//   void          Beyond the sea at the frame edge. Darkest plane, cool slate;
//                 never lighter than deepWater[1] (okL 0.17-0.23, S <= 0.35).
//   deepWater     Open sea body, 3 depth stops, teal-slate (S <= 0.40).
//   shallowWater  Lagoon/shore band -> foam. Foam is the only Tier-B water.
//   grass         Ground base. The LOWEST land value so the floor recedes, but
//                 kept green and alive (D5 moderate mute: S 0.46-0.51, okL
//                 0.36-0.60). Shadow step leans teal, highlight leans olive.
//   dirt          Worn earth paths and road shoulders: about +1.5 grass steps
//                 brighter (mid okL 0.57 vs 0.48), so paths read by value, not
//                 hue alone. S 0.39-0.47.
//   road          Avenue cobble: warm neutral grey at the dirt value, no blue
//                 cast (S <= 0.11).
//   plaza         Dressed plaza stone: the lightest paved land, the focal floor
//                 around Command (mid okL 0.67).
//   sand          Beach and dry shore; lighter than plaza, low chroma.
//   foliage       Tree/bush sprites (sage family): wider value range than
//                 grass so canopies model form; S <= 0.47.
//   stone         Building masonry and props: cool blue-grey shadow to neutral
//                 lit face (S <= 0.19).
//   timber        Beams, planks, hulls, bridge decks.
//   slate         Roof slate, blue-violet shadow family.
//   clothCrimson  Banners and awnings; the only red allowed on buildings.
//   clothOchre    Awnings, pennant fringes, brass-toned cloth (S <= 0.63).
//   emissive      RESERVED: authored lamp/fire/window light (Tier A allowed).
//   seaPath       The sun and moon path on the water (3.2, M7): the sky
//                 body's specular reflection, three (lo, hi) pairs: gold at
//                 sunrise and golden hour, pale by day, silver under a moon
//                 at least half full. The only water above S 0.40 (gold
//                 S 0.56); graded, and held at HSL L <= 0.70 on screen.
//   lampBeam      The Lighthouse lamp (2.7): cool white, never the seaPath
//                 gold. Its three low stops are the beam's courses on the
//                 water (far, mid, near; a receiver, okL <= 0.83, ungraded
//                 like an emitter's own light); the two high stops are the
//                 lantern's flash and halo (an emitter).
//
// Ground (grass+dirt+road+plaza as they cover the island, grass-majority)
// lands at median S ~0.46-0.50: inside GROUND_SATURATION.

import { THEME } from './theme.js';

export const ART_RAMPS = Object.freeze({
    void: ['#0c0f12', '#101418', '#171d21'],
    deepWater: ['#222d33', '#31424a', '#3f585e'],
    shallowWater: ['#4a6c70', '#669190', '#91b2a8'],
    grass: ['#26572d', '#346e30', '#4f823b', '#689146', '#7f9e51'],
    dirt: ['#6a5038', '#7c6043', '#8e7050', '#9f805d', '#ae8f6a'],
    road: ['#545353', '#666461', '#78746e', '#8a857c', '#9b958a'],
    plaza: ['#7a7164', '#8c8274', '#9e9484', '#afa594', '#bdb2a0'],
    sand: ['#a8936c', '#b7a279', '#c5b086', '#d2bd93', '#dcc9a1'],
    foliage: ['#1c2b24', '#2a3e2c', '#3e5634', '#5a723d', '#86944f'],
    stone: ['#25262d', '#373944', '#4d4f5a', '#686a72', '#8c8b8a'],
    timber: ['#2a1c14', '#45301f', '#654629', '#8a6337'],
    slate: ['#1e2433', '#2c3650', '#3e4d6c', '#5a6c8c'],
    // 6.6 wet slate: the 1-art-px wet course on upper-left-facing slate
    // edges, one stop per wetness quantum (dry-most first), and the eave drips.
    wetSlate: ['#5a6c8c', '#6b7ea0', '#7d91b0', '#8fa3c0'],
    clothCrimson: ['#732a31', '#a4463f'],
    clothOchre: ['#987638', '#c9a04a'],
    emissive: ['#ff9d4a', '#ffcf7a', '#ffe9b8'],
    seaPath: ['#c48054', '#ecb068', '#969d8f', '#c0bea4', '#849ab0', '#c4d6e2'],
    lampBeam: ['#7a929c', '#98adb3', '#b8c8c8', '#d2dcd8', '#f4f1e2'],
    // Seasonal and per-tree ramps (plan items 5.1 and 5.3 of
    // agents/plans/claudeville-opus55-xhigh-visual-plan.md). FoliageRenderer
    // remaps canopy pixels onto them by luminance rank, dark -> light; the
    // eight-stop canopy ramps follow the authored tree value ladder (lum
    // 34-170), so a remap keeps the painted form. `npm run art:analyze`
    // checks their rules and that every remapped canopy pixel is on-ramp.
    //   snow         5.2 ground and roof snow (achromatic; its top stops are
    //                the M9 winter exception to Tier A).
    //   leafAutumn   baked leaf litter under deciduous crowns (S <= 0.65).
    //   canopyRusset autumn oak, plum shadow -> rust -> amber.
    //   canopyOchre  autumn oak and the turning crown, brown -> burnt amber,
    //                lifted a step (turning leaves read lighter than summer
    //                green). Its lit stops stay under hue 36 (S <= 0.62).
    //   willowGold   autumn willow, olive -> muted straw, lifted like ochre;
    //                its lit stops keep S <= 0.43.
    //   Both leave the 40-60 deg high-S / high-V band (S >= 0.45 at V > 0.55)
    //   to the status hues: a NEEDS YOU plate never competes with a crown.
    //   blossom      spring blossom speckle and fallen petals.
    //   foliageDeep  variant 1: the authored ladder one value step darker,
    //                hue +8 deg (mid hue 90-110, S <= 0.5).
    //   foliageSun   variant 2: one value step lighter, hue -8 deg.
    snow: ['#98a5b4', '#b0bcc7', '#c7d0d6', '#d9dfe1', '#e6e9e6'],
    leafAutumn: ['#5a2a1c', '#7a3b22', '#a4563a', '#987638', '#c9a04a'],
    canopyRusset: ['#311b20', '#4a2125', '#652f26', '#7b412c', '#945535', '#ab6c41', '#c38650', '#d7a461'],
    canopyOchre: ['#40251b', '#573721', '#6f4e28', '#896830', '#ad7f42', '#c79554', '#dbac69', '#efc386'],
    willowGold: ['#293119', '#3e4420', '#585a28', '#767230', '#918852', '#aa9e64', '#c1b376', '#d8c98d'],
    blossom: ['#9c5a78', '#b76f8c', '#c98aa3', '#dcb4c0'],
    foliageDeep: ['#121e19', '#17291c', '#203822', '#2c4828', '#3c5932', '#526e3d', '#6b8448', '#899c54'],
    foliageSun: ['#213627', '#2a482b', '#3a5a33', '#506f3e', '#698548', '#869d53', '#abb85f', '#cfcf68'],
});

// Ramps that make up the ground plane (terrain bakes, off-ramp analysis).
export const GROUND_RAMP_KEYS = Object.freeze(['grass', 'dirt', 'road', 'plaza', 'sand']);

// Tier A (L > 0.70 or S > 0.65) is reserved for these roles only. Values are
// the live status authority (theme.js THEME), not copies, so the palette
// checks measure exactly what the renderer draws.
export const RESERVED_STATUS = Object.freeze({
    working: THEME.working,
    needsYou: THEME.waitingOnUser,
    error: THEME.error,
    waiting: THEME.waiting,
    idle: THEME.idle,
    rateLimited: THEME.rateLimited,
});

// Maintainer decision D5: moderate mute. Ground median saturation target band.
export const GROUND_SATURATION = Object.freeze({ min: 0.45, max: 0.50 });
export const GROUND_LOCAL_CONTRAST_MAX_RATIO = 0.6;
export const WATER_VOID_SATURATION_MAX = 0.40;
// V5 receiver ceiling (see the brightest-thing rule above). Attention
// courses are exempt: they are always the brightest pool.
export const RECEIVER_LUMA_CEILING = 0.74;

// Status-free identity hues (repo pennants, Harbor ships, Sidebar rails).
// None may read as a status colour: every entry sits at okL 0.54-0.62,
// okC <= 0.106 and HSV S <= 0.55 (status is okL 0.67-0.90, mostly okC >=
// 0.13), at OKLab distance >= 0.10 from every RESERVED_STATUS hue and >= 0.085
// from each other. HSL hues are >= 35° apart (340 18 62 100 155 192 227 265);
// the widest gap (265-340) holds the rate-limited orchid (307). Lightness
// alternates so neighbours also split by value. RepoColor.js resolves hash
// collisions among the repos on screen.
// Order: wine, brick, olive, moss, jade, petrol, cornflower, violet.
export const PENNANT_PALETTE = Object.freeze([
    '#b3647e', '#985e45', '#898c3f', '#517c3c',
    '#489877', '#437e8c', '#6f82c6', '#7a5fa1',
]);

// Contract C4: effect language colours.
export const EFFECT_COLORS = Object.freeze({
    magic: ['#5b3fa0', '#a78bfa', '#e6dcff'],
    work: ['#7a2e12', '#e8762b', '#ffd27a'],
    success: '#f2c14e',
    bell: '#ffb347',
    failure: '#d94a3a',
    failureOutline: '#3a1410',
    returnStone: '#b9ad96',
    peak: '#fff3bf',
});
