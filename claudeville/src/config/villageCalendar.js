// W6.10 (AW-P10) — the village's date-keyed table: the occasions a year of
// always-on viewing can notice, and the static dressing each one lays out.
// Pure data, read by `presentation/character-mode/VillageCalendar.js`, which
// resolves it against the local date (the same local day `localDateKey`
// keys the weather timeline and the ambient schedule on) and rebakes at most
// once a local midnight. W7.8's dusk ledger keys its day stone on the same
// local date.
//
// Occasion windows are inclusive local calendar days, month 1-based. Every
// window is a fixed date range, so a pinned clock (`page.clock.install`)
// gives the same dressing on every run.
export const VILLAGE_OCCASIONS = Object.freeze({
    // The winter-solstice week: Dec 21 +/- 3.
    'winter-solstice': Object.freeze({ from: Object.freeze([12, 18]), to: Object.freeze([12, 24]) }),
    // Late December: the door wreaths stay up through the year's end.
    'late-december': Object.freeze({ from: Object.freeze([12, 15]), to: Object.freeze([12, 31]) }),
    // The spring-equinox week: Mar 20 +/- 3.
    'spring-equinox': Object.freeze({ from: Object.freeze([3, 17]), to: Object.freeze([3, 23]) }),
    // Midsummer week: Jun 21 +/- 3.
    midsummer: Object.freeze({ from: Object.freeze([6, 18]), to: Object.freeze([6, 24]) }),
    // Harvest: the whole of October.
    harvest: Object.freeze({ from: Object.freeze([10, 1]), to: Object.freeze([10, 31]) }),
    // The one acknowledgement that a week exists (Date#getDay: 6 Sat, 0 Sun).
    weekend: Object.freeze({ weekdays: Object.freeze([6, 0]) }),
});

// The anchors the Chronicle dressing owns (ChronicleDressingLedger:
// `harbor.bunting`, `forge.billetRack`, `archive.lectern`, plus the W7.8 day
// stone beside the lectern). A calendar dressing never claims one.
export const CHRONICLE_DRESSING_ANCHORS = Object.freeze([
    'harbor.bunting',
    'forge.billetRack',
    'archive.lectern',
    'archive.dayStone',
]);

// One row per placed dressing. `sprite` names the authored manifest prop a
// row draws (W8.4b, PixelLab art); `stamp` names a code-drawn pixel stamp
// (VillageCalendar.js) for the dressings no sprite-sized art fits: the gate
// garland tied to the gatehouse lanterns and the 7-texel door wreaths.
// `variant` is a stamp's colourway, `anchor` the one place a row claims.
// `part` rows dress a landmark (drawn by BuildingSprite at a sprite-local
// texel); every other row is a sorted prop at its tile. `light` marks the one
// dressing that lights at night: a fixture on the `lamps` clock gate, never
// occupancy (its static flame is code-drawn over the laid logs). `glow`
// marks a stamp whose bulbs burn on the same `lamps` gate (lit tones plus an
// emissive channel) without casting a fixture light.
export const VILLAGE_CALENDAR_DRESSINGS = Object.freeze([
    // Solstice lantern garland swung between the gatehouse's wall lanterns,
    // over the head of the gate avenue; in the equinox week the same swag
    // carries blossom.
    Object.freeze({ id: 'gate-garland-lights', occasion: 'winter-solstice', stamp: 'gateGarland', variant: 'lights', anchor: 'gate.arch', glow: true }),
    Object.freeze({ id: 'gate-garland-blossom', occasion: 'spring-equinox', stamp: 'gateGarland', variant: 'blossom', anchor: 'gate.arch' }),
    // A small decorated pine on the open green at the plaza's east end, in
    // front of the Observatory's west steps: between the skywatch lamp and
    // its runestone, clear of the watermill, the visit places and paving.
    Object.freeze({ id: 'plaza-pine', occasion: 'winter-solstice', sprite: 'prop.festival.pine', anchor: 'plaza.green', tileX: 24.0, tileY: 17.4 }),
    // Late-December wreaths on the Command and Archive doors (sprite texels).
    Object.freeze({ id: 'command-wreath', occasion: 'late-december', stamp: 'wreath', anchor: 'command.door', part: 'command', at: Object.freeze([131, 132]) }),
    Object.freeze({ id: 'archive-wreath', occasion: 'late-december', stamp: 'wreath', anchor: 'archive.door', part: 'archive', at: Object.freeze([243, 150]) }),
    // Midsummer: a laid bonfire on the open green below the mine path, where
    // the south wildwood meets the gate meadow, lit at night.
    Object.freeze({ id: 'midsummer-bonfire', occasion: 'midsummer', sprite: 'prop.festival.bonfire', anchor: 'forest.south-edge', tileX: 15.3, tileY: 34.0, light: true }),
    // Harvest: pumpkins at both market stalls' feet and a stook at the field
    // edge beside the mine path.
    Object.freeze({ id: 'harvest-pumpkins-avenue', occasion: 'harvest', sprite: 'prop.festival.pumpkins', anchor: 'stall.avenue.foot', tileX: 16.48, tileY: 30.92 }),
    Object.freeze({ id: 'harvest-pumpkins-civic', occasion: 'harvest', sprite: 'prop.festival.pumpkins', anchor: 'stall.civic.foot', tileX: 12.75, tileY: 21.15 }),
    Object.freeze({ id: 'harvest-stook', occasion: 'harvest', sprite: 'prop.festival.stook', anchor: 'field.edge', tileX: 14.2, tileY: 33.6 }),
    // Weekend: the avenue stall runs a side awning out on its west flank,
    // over a produce table, its east post a hand's width off the stall's west
    // post so neither covers the other (in October the stall's pumpkins sit
    // at the table's foot).
    Object.freeze({ id: 'weekend-awning', occasion: 'weekend', sprite: 'prop.festival.produceAwning', anchor: 'stall.avenue.side', tileX: 16.43, tileY: 30.62 }),
]);
