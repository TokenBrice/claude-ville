// Wrist centers authored against Astra's 92px cells: six walk frames, then
// four idle frames. Keep these in sheet coordinates so capes and effort crests
// cannot move the grip. Follow the same hand around the body; E/NE hide the
// far forearm behind the torso instead of switching to the nearer hand.
const ASTRA_WRISTS = {
    s:  [[63,56], [63,53], [63,54], [64,56], [64,55], [63,57], [63,56], [63,56], [62,55], [63,56]],
    se: [[59,52], [58,56], [58,52], [60,53], [67,52], [64,51], [59,50], [58,54], [59,52], [59,52]],
    e:  [[55,55], [57,58], [56,56], [53,55], [56,48], [55,50], [54,55], [54,58], [54,55], [54,56]],
    ne: [[26,45], [26,44], [26,44], [26,45], [26,46], [26,46], [30,46], [30,46], [30,46], [30,46]],
    n:  [[27,51], [27,49], [27,46], [27,46], [27,47], [27,49], [30,51], [30,51], [30,51], [30,51]],
    nw: [[30,55], [32,53], [31,54], [27,54], [26,54], [27,54], [36,60], [36,60], [36,60], [36,60]],
    w:  [[44,65], [52,63], [50,64], [47,64], [42,59], [44,59], [46,63], [46,63], [47,63], [46,64]],
    sw: [[62,61], [64,61], [62,62], [59,61], [56,59], [58,60], [60,59], [60,60], [60,60], [60,60]],
};
// The open-faced second body (models.json `spriteVariants`), measured with
// scripts/sprites/measure-wrists.mjs; same hand, flips and halberd angles.
const ASTRA_B_WRISTS = {
    s:  [[63,56], [62,56], [62,54], [62,55], [63,55], [63,55], [61,55], [61,54], [61,54], [61,55]],
    se: [[59,51], [53,51], [55,51], [60,51], [66,49], [64,50], [56,51], [56,51], [57,51], [56,51]],
    e:  [[50,56], [48,52], [49,52], [48,55], [56,46], [48,54], [48,54], [48,54], [48,54], [47,53]],
    ne: [[35,50], [32,51], [32,52], [35,51], [40,50], [36,49], [39,52], [37,51], [38,52], [38,52]],
    n:  [[28,55], [30,57], [30,56], [29,55], [28,48], [27,51], [30,53], [30,53], [30,53], [30,53]],
    nw: [[29,59], [34,60], [34,60], [28,58], [22,53], [26,56], [35,60], [35,59], [34,59], [35,60]],
    w:  [[46,59], [51,58], [51,59], [44,58], [37,58], [41,59], [49,58], [50,59], [48,59], [49,59]],
    sw: [[59,58], [62,56], [61,57], [57,58], [54,57], [58,57], [59,57], [59,57], [58,56], [59,57]],
};
export const ASTRA_WRIST_TABLES = Object.freeze({
    'agent.codex.gpt6astra': ASTRA_WRISTS,
    'agent.codex.gpt6astra.b': ASTRA_B_WRISTS,
});

export function astraWeaponPose({ cell, dx, dy, drawScale = 1 }, direction, equipment, spriteId = 'agent.codex.gpt6astra') {
    const wrist = ASTRA_WRIST_TABLES[spriteId]?.[direction]?.[cell?.sy / 92];
    if (!wrist) return null;
    return {
        x: dx + wrist[0] * drawScale,
        y: dy + wrist[1] * drawScale,
        flipX: ['ne', 'n', 'nw', 'w'].includes(direction),
        behindBody: direction === 'e' || direction === 'ne',
        // Worldsplitter's source shaft leans right. Stand it upright at rest
        // and let it lean outward during walking, with no independent sway.
        angle: equipment === 'worldsplitter'
            ? cell.sy < 6 * 92 ? -0.35 : -0.55
            : equipment === 'polearm'
            ? ['e', 'w'].includes(direction) ? 0.05 : -0.25
            : ['e', 'w'].includes(direction) ? -0.10 : -0.35,
        scale: equipment === 'worldsplitter' ? 1 : equipment === 'polearm' ? 0.82 : 0.80,
    };
}
