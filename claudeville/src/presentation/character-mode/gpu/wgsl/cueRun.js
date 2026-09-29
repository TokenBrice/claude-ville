// Wave 10 (10.1 Stage A) — the WGSL twin of GroundCueRecords CUE_RUN_GLSL
// (B.3, a ground-cue dot run expanded in the vertex stage): the same word
// layout, step window and swatch texel, interpolated from the same
// GroundCueRecords constants. The atlas size GL reads with
// textureSize(u_albedo, 0) is `batch.albedoSize` (contract §2.4); GLSL
// `inout` parameters are `ptr<function, T>`. Scene module (vertex stage).
import { BAND_HEIGHT, CUE_RUN_DOTS, CUE_RUN_STEP_MIN, SWATCH_X } from '../../GroundCueRecords.js';
import { GPU_RECORD_FLAGS } from '../GpuWorldPolicy.js';

export const CUE_RUN_WGSL = /* wgsl */ `
fn cueRunVertex(vertexId: i32, flags: u32, corner: ptr<function, i32>, rect: ptr<function, vec4f>, uvRect: ptr<function, vec4f>) {
    let index = vertexId / 6;
    let tri = vertexId - index * 6;
    // A strip's triangles are (0, 1, 2) then (2, 1, 3).
    if (tri < 3) { *corner = tri; } else if (tri == 3) { *corner = 2; } else if (tri == 4) { *corner = 1; } else { *corner = 3; }
    if ((flags & ${GPU_RECORD_FLAGS.cueRun}u) == 0u) {
        if (index > 0) { *rect = vec4f((*rect).xy, 0.0, 0.0); }
        return;
    }
    // Exact integers below 2^24: no +0.5 (at 2^23 and up it rounds to even).
    let words = vec4u(*uvRect);
    let head = words.x;
    if (index > i32((head >> 10u) & 15u)) {
        *rect = vec4f((*rect).xy, 0.0, 0.0);
        return;
    }
    let base = vec2i(i32((head >> 14u) & 15u), i32((head >> 18u) & 15u)) + ${CUE_RUN_STEP_MIN};
    var at = vec2i(i32(words.y & 255u), i32((words.y >> 8u) & 255u));
    for (var j = 0; j < ${CUE_RUN_DOTS - 1}; j++) {
        if (j >= index) { break; }
        var word = words.w;
        if (j < 2) { word = words.y; } else if (j < 8) { word = words.z; }
        var shift = 4 * (j - 8);
        if (j < 2) { shift = 16 + 4 * j; } else if (j < 8) { shift = 4 * (j - 2); }
        let bits = (word >> u32(shift)) & 15u;
        at += base + vec2i(i32(bits & 3u), i32(bits >> 2u));
    }
    *rect = vec4f((*rect).xy + vec2f(at), f32(((head >> 6u) & 3u) + 1u), f32(((head >> 8u) & 3u) + 1u));
    let atlas = batch.albedoSize;
    let swatch = vec2f(${SWATCH_X}.25, f32(head & 63u) * ${BAND_HEIGHT}.0 + 0.25);
    *uvRect = vec4f(swatch / atlas, (swatch + 0.5) / atlas);
}
`;
