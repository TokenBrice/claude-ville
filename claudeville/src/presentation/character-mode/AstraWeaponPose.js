// Wrist centers authored against Astra's 92px cells: six walk frames, then
// four idle frames. Keep these in sheet coordinates so capes and effort crests
// cannot move the grip. Follow the same hand around the body; E/NE hide the
// far forearm behind the torso instead of switching to the nearer hand.
const WRISTS = {
    s:  [[63,56], [63,53], [63,54], [64,56], [64,55], [63,57], [63,56], [63,56], [62,55], [63,56]],
    se: [[59,52], [58,56], [58,52], [60,53], [67,52], [64,51], [59,50], [58,54], [59,52], [59,52]],
    e:  [[55,55], [57,58], [56,56], [53,55], [56,48], [55,50], [54,55], [54,58], [54,55], [54,56]],
    ne: [[26,45], [26,44], [26,44], [26,45], [26,46], [26,46], [30,46], [30,46], [30,46], [30,46]],
    n:  [[27,51], [27,49], [27,46], [27,46], [27,47], [27,49], [30,51], [30,51], [30,51], [30,51]],
    nw: [[30,55], [32,53], [31,54], [27,54], [26,54], [27,54], [36,60], [36,60], [36,60], [36,60]],
    w:  [[44,65], [52,63], [50,64], [47,64], [42,59], [44,59], [46,63], [46,63], [47,63], [46,64]],
    sw: [[62,61], [64,61], [62,62], [59,61], [56,59], [58,60], [60,59], [60,60], [60,60], [60,60]],
};

export function astraWeaponPose({ cell, dx, dy, drawScale = 1 }, direction, equipment) {
    const wrist = WRISTS[direction]?.[cell?.sy / 92];
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
