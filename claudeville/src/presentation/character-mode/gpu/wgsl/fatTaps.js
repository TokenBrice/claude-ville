// Wave 10 (10.1 Stage A) — the WGSL twin of GpuWorldRenderer FAT_TAPS_GLSL
// (4.6 / PT-2, the fat-pixel coverage of one screen pixel on a texel grid).
// FAT_SNAP and both `step` gates are kept exactly (contract §2.7: the one
// place a "cleaner" rewrite changes pixels). Shared by the scene (albedo,
// terrain chain, atmosphere courses) and the composite (the open sea).
export const FAT_TAPS_WGSL = /* wgsl */ `
const FAT_SNAP: f32 = 1.0 / 64.0;
struct FatTaps { base: vec2f, w: vec2f }
fn fatTaps(pix: vec2f, fw: vec2f) -> FatTaps {
    let seam = floor(pix + 0.5);
    let q = seam + clamp((pix - seam) / fw, vec2f(-0.5), vec2f(0.5)) - 0.5;
    var base = floor(q);
    var w = q - base;
    let up = step(vec2f(1.0 - FAT_SNAP), w);
    base += up;
    w *= (1.0 - up) * step(vec2f(FAT_SNAP), w);
    return FatTaps(base, w);
}
fn fatSeam(t: FatTaps) -> bool { return t.w.x > 0.0 || t.w.y > 0.0; }
fn fatTapOffset(i: i32) -> vec2f { return vec2f(f32(i & 1), f32(i >> 1u)); }
fn fatTapWeight(t: FatTaps, i: i32) -> f32 {
    let o = fatTapOffset(i);
    return mix(1.0 - t.w.x, t.w.x, o.x) * mix(1.0 - t.w.y, t.w.y, o.y);
}
`;
