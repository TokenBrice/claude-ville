// NL-2 (look `nl2`) firelight on people and NL-1 (look `nl1`) the tuned
// palette-ramp landing: the one frame uniform both scene programs read
// (`u_firelight` in GpuWorldRenderer's SCENE_FRAGMENT, `frame.firelight` in
// wgsl/scene.js). x is the nl2 strength in [0, 1]; y is 1 while nl1 > 0 (the
// tuned ramp is a switch, as the per-landmark ramp itself is). Both zero is
// today's frame exactly.
import { lookStrength } from '../LookStrengths.js';

// The albedo-free share of the pool a dark receiver takes (darkness:
// 1 - smoothstep(0.04, 0.18, albedo luma)), so the strongest fire lays at
// least its first course on dark cloth (x nl2) and dark earth (tuned ramp).
export const FIRELIGHT_DARK_SHARE = 0.06;

// GPU_LANDMARK_IDS.command: the 3.5 pilot keeps its authored ground landing
// (the gate threshold) when the tuned ramp hands other landmarks' ground
// texels to the pools.
export const FIRELIGHT_PILOT_LANDMARK = 1;

export function resolveFirelight(out = new Float32Array(2)) {
    out[0] = Math.min(1, Math.max(0, lookStrength('nl2')));
    out[1] = lookStrength('nl1') > 0 ? 1 : 0;
    return out;
}
