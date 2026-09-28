// Plan 6.1 / V4 — Ferrari colour cycling for authored emitters (OE-1).
//
// `bakeEmitterCycle(baseImg, maskImg, opts)` is pure: it takes the building's
// authored RGBA pixels and a same-size mask (alpha > 0 = a cycled texel) and
// returns an atlas strip of `frames` phase frames cropped to the mask's
// bounding box. The cycled texels' own colours form the ramp (sorted by
// luma), each texel takes a rank, and each phase shifts the rank by a stepped
// wave (+1 / 0 / −1 / 0 in `bandPx` bands) that rises `riseStepPx` per phase
// up the flame; ranks below `fixedBelowRankFrac` of the ramp (the dark embers)
// never move. Every output texel is one of the mask's authored colours: a
// hard index change, never a multiply or a crossfade. The rest frame is the
// authored art itself (callers draw nothing), so banked and reduced-motion
// frames are the base pixels exactly.
//
// Height order: by default a texel's height is its row (flames rise
// straight up). A hand-authored mask may order its texels along a curved or
// leaning flame instead: with `heightFromMask: true` the mask's red channel
// is the height rank (0 at the flame base, 255 at the tip).
//
// Coarse ramp: an emitter painted with many near-identical shades (a
// generated flame, the Portal vortex) would step between invisible
// neighbours. `rampStops: K` bins the authored colours into K luma courses;
// each course is represented by its most-used authored colour, a texel's
// rank is its course, and a lit/dimmed band takes the neighbouring course's
// colour (a band at 0 keeps the texel's own colour). Still only authored
// colours, still a hard index change.

const WAVE = [1, 0, -1, 0];

function luma(r, g, b) {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function bakeEmitterCycle(baseImg, maskImg, {
    frames = 8,
    bandPx = 4,
    riseStepPx = 2,
    fixedBelowRankFrac = 1 / 3,
    shearEveryPx = 5,
    shearPx = 3,
    heightFromMask = false,
    rampStops = 0,
} = {}) {
    const width = baseImg?.width | 0;
    const height = baseImg?.height | 0;
    const base = baseImg?.data;
    const mask = maskImg?.data;
    if (!base || !mask || maskImg.width !== width || maskImg.height !== height) return null;
    const count = Math.max(1, frames | 0);

    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    const colourIndex = new Map();
    const colours = [];
    const usage = new Map();
    const texels = [];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            if (!(mask[i + 3] > 0) || !(base[i + 3] > 0)) continue;
            const key = (base[i] << 16) | (base[i + 1] << 8) | base[i + 2];
            usage.set(key, (usage.get(key) || 0) + 1);
            if (!colourIndex.has(key)) {
                colourIndex.set(key, colours.length);
                colours.push([base[i], base[i + 1], base[i + 2], key]);
            }
            texels.push(x, y, key, heightFromMask ? mask[i] : -1, base[i + 3]);
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        }
    }
    if (maxX < 0) return null;

    const sorted = colours.slice().sort((a, b) => luma(a[0], a[1], a[2]) - luma(b[0], b[1], b[2]) || a[3] - b[3]);
    const { ramp, rankOf } = courseRamp(sorted, usage, rampStops);
    const n = ramp.length;
    const fixedBelow = Math.floor(n * fixedBelowRankFrac);
    const frameW = maxX - minX + 1;
    const frameH = maxY - minY + 1;
    const stripW = frameW * count;
    const data = new Uint8ClampedArray(stripW * frameH * 4);

    for (let t = 0; t < texels.length; t += 5) {
        const x = texels[t];
        const y = texels[t + 1];
        const key = texels[t + 2];
        const rank = rankOf.get(key);
        const ownColour = [(key >> 16) & 255, (key >> 8) & 255, key & 255];
        // Height above the flame base: rows count up from the mask bottom,
        // or the authored order in the mask's red channel.
        const h = texels[t + 3] >= 0 ? texels[t + 3] : maxY - y;
        const shear = shearEveryPx > 0 ? Math.floor((x - minX) / shearEveryPx) * shearPx : 0;
        for (let phase = 0; phase < count; phase++) {
            let colour = ownColour;
            if (rank >= fixedBelow) {
                // The wave travels toward the tip as the phase advances.
                const band = ((Math.floor((h - phase * riseStepPx + shear) / bandPx) % 4) + 4) % 4;
                const next = Math.max(fixedBelow, Math.min(n - 1, rank + WAVE[band]));
                if (next !== rank) colour = ramp[next];
            }
            const o = (((y - minY) * stripW) + phase * frameW + (x - minX)) * 4;
            data[o] = colour[0];
            data[o + 1] = colour[1];
            data[o + 2] = colour[2];
            data[o + 3] = texels[t + 4];
        }
    }
    return {
        data,
        width: stripW,
        height: frameH,
        frames: count,
        frameW,
        frameH,
        offsetX: minX,
        offsetY: minY,
        rampSize: n,
    };
}

// The ramp a cycle steps along: every authored colour (sorted by luma), or
// with `stops > 0` and more colours than stops, K luma courses each shown by
// its most-used authored colour. Returns the ramp and each colour's rank.
function courseRamp(sorted, usage, stops) {
    const count = stops | 0;
    if (!(count > 0) || sorted.length <= count) {
        return { ramp: sorted, rankOf: new Map(sorted.map((c, index) => [c[3], index])) };
    }
    const lo = luma(sorted[0][0], sorted[0][1], sorted[0][2]);
    const hi = luma(sorted[sorted.length - 1][0], sorted[sorted.length - 1][1], sorted[sorted.length - 1][2]);
    const span = Math.max(1e-6, hi - lo);
    const courses = [];
    const courseOf = new Map();
    let current = -1;
    for (const c of sorted) {
        const course = Math.min(count - 1, Math.floor((luma(c[0], c[1], c[2]) - lo) / span * count));
        if (course !== current) {
            courses.push(c);
            current = course;
        } else if ((usage.get(c[3]) || 0) > (usage.get(courses[courses.length - 1][3]) || 0)) {
            courses[courses.length - 1] = c;
        }
        courseOf.set(c[3], courses.length - 1);
    }
    return { ramp: courses, rankOf: courseOf };
}

// The cycle phase for a stepped clock: `hz` phase steps per second.
export function emitterCyclePhase(timeMs, frames, hz = 8) {
    const count = Math.max(1, frames | 0);
    const step = Math.floor(Math.max(0, Number(timeMs) || 0) * hz / 1000);
    return step % count;
}
