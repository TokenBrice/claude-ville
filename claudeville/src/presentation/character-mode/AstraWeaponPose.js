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
// Run-strip wrists measured with scripts/sprites/measure-wrists.mjs --strip-group=run
// (E#0–1 and NE#3–4 adjusted off trailing cape onto the far-hand track).
const ASTRA_RUN_WRISTS = {
    s:  [[67,48], [64,39], [63,51], [66,57], [62,54], [67,54]],
    se: [[58,46], [55,52], [64,51], [76,50], [75,44], [67,48]],
    e:  [[49,49], [48,50], [50,53], [68,43], [69,40], [54,52]],
    ne: [[25,42], [23,44], [28,45], [33,47], [34,46], [31,41]],
    n:  [[24,48], [27,48], [27,53], [28,48], [23,40], [26,51]],
    nw: [[34,57], [38,56], [29,55], [16,44], [19,41], [23,56]],
    w:  [[51,57], [59,53], [44,57], [22,54], [21,53], [39,59]],
    sw: [[65,51], [68,45], [58,53], [46,56], [40,57], [56,60]],
};
const ASTRA_B_RUN_WRISTS = {
    s:  [[66,46], [61,33], [63,49], [62,54], [60,51], [66,52]],
    se: [[55,50], [54,53], [59,47], [73,48], [73,42], [67,47]],
    e:  [[48,50], [47,50], [49,56], [67,43], [69,40], [54,50]],
    ne: [[26,42], [23,44], [31,45], [33,45], [34,44], [33,45]],
    n:  [[25,50], [28,51], [28,55], [27,45], [25,41], [28,54]],
    nw: [[34,63], [41,55], [29,57], [17,48], [18,45], [23,58]],
    w:  [[52,58], [58,55], [45,59], [23,55], [22,52], [36,64]],
    sw: [[65,51], [67,46], [57,55], [43,54], [41,55], [57,59]],
};
export const ASTRA_WRIST_TABLES = Object.freeze({
    'agent.codex.gpt6astra': ASTRA_WRISTS,
    'agent.codex.gpt6astra.b': ASTRA_B_WRISTS,
});
export const ASTRA_POSE_WRIST_TABLES = Object.freeze({
    'agent.codex.gpt6astra': { run: ASTRA_RUN_WRISTS },
    'agent.codex.gpt6astra.b': { run: ASTRA_B_RUN_WRISTS },
});

export function astraWeaponPose({ cell, dx, dy, drawScale = 1, poseGroup = null, poseFrame = null }, direction, equipment, spriteId = 'agent.codex.gpt6astra') {
    const wrist = poseGroup
        ? ASTRA_POSE_WRIST_TABLES[spriteId]?.[poseGroup]?.[direction]?.[poseFrame]
        : ASTRA_WRIST_TABLES[spriteId]?.[direction]?.[cell?.sy / 92];
    if (!wrist) return null;
    const moving = poseGroup === 'run' || cell?.sy < 6 * 92;
    return {
        x: dx + wrist[0] * drawScale,
        y: dy + wrist[1] * drawScale,
        flipX: ['ne', 'n', 'nw', 'w'].includes(direction),
        behindBody: direction === 'e' || direction === 'ne',
        // Worldsplitter's source shaft leans right. Stand it upright at rest
        // and let it lean outward during walking/running, with no independent sway.
        angle: equipment === 'worldsplitter'
            ? moving ? -0.35 : -0.55
            : equipment === 'polearm'
            ? ['e', 'w'].includes(direction) ? 0.05 : -0.25
            : ['e', 'w'].includes(direction) ? -0.10 : -0.35,
        scale: equipment === 'worldsplitter' ? 1 : equipment === 'polearm' ? 0.82 : 0.80,
    };
}
