// 0.3 — the World container holds the frame's own colour. While the world
// canvases are transparent (boot, a return from Dashboard) `#characterMode`
// shows a few stepped horizontal bands of the World's own presented frame,
// with a 2×2 ordered dither on the art-texel grid at each seam: never black,
// never a sky the scene does not show, never a colour it does not contain.
//
// Bands are the scene's materials, not row averages: each is the dominant
// colour of point samples (no filtering), so a band over mostly sea is that
// sea, over mostly island that island, and seams fall where the frame's rows
// change material (Ward merging of row colours), with one always on the sea
// horizon. Averaging sea, grass and roofs into one colour reads as mud.
//
// Sampling must run in the same task as a render: the WebGL surface does not
// preserve its drawing buffer, so outside that task it reads as transparent.

// The point-sample grid; a surface already this size is drawn 1:1 (the
// WebGPU HDR canvas's SDR readout, GpuWorldRendererWebGPU.readoutSurface).
export const REVEAL_SAMPLE_W = 96;
export const REVEAL_SAMPLE_H = 64;
const SAMPLE_W = REVEAL_SAMPLE_W;
const SAMPLE_H = REVEAL_SAMPLE_H;
// A band is at least 4 sample rows (1/16 of the height) unless the horizon
// pins a thinner sky.
const MIN_BAND_ROWS = 4;
// 2×2 Bayer thresholds in [0, 4).
const BAYER2 = [0, 2, 3, 1];
// Each seam is three dither courses (1/4, 2/4, 3/4 of the lower band) of
// about 1 % of the height each, never more than a third of either neighbour.
const SEAM_COURSES = 3;
const SEAM_COURSE_SHARE = 0.01;

let scratch = null;

function hex(rgb) {
    return `#${rgb.map(channel => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0')).join('')}`;
}

// Point samples (sRGB bytes) of the surfaces as the compositor stacks them,
// on an opaque black base: nearest-neighbour, so every sample is a real
// scene pixel. One GPU downsample and a 96×64 readback.
function samplePixels(surfaces) {
    const live = surfaces.filter(surface => (
        surface
        && surface.width > 0
        && surface.height > 0
        && surface.style?.display !== 'none'
    ));
    if (!live.length || typeof document === 'undefined') return null;
    scratch ||= document.createElement('canvas');
    scratch.width = SAMPLE_W;
    scratch.height = SAMPLE_H;
    const ctx = scratch.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, SAMPLE_W, SAMPLE_H);
    for (const surface of live) ctx.drawImage(surface, 0, 0, SAMPLE_W, SAMPLE_H);
    return ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
}

// The dominant material of rows [from, to): the samples split into water
// (blue at least green and above red: sea, shallows, sky) and land; land is
// grass (green leading) or ground (paths, walls, roofs, fire). The band is
// the mean of the fuller of water and land; on land, of grass once it holds
// a third of the land samples (the island reads green even where its paths,
// roofs and autumn crowns together out-count the grass), else of ground. A
// mean over everything mixes sea, grass and stone into a colour the frame
// does not contain.
function materialColour(data, from, to) {
    const water = [0, 0, 0, 0];
    const grass = [0, 0, 0, 0];
    const ground = [0, 0, 0, 0];
    for (let offset = from * SAMPLE_W * 4; offset < to * SAMPLE_W * 4; offset += 4) {
        const r = data[offset];
        const g = data[offset + 1];
        const b = data[offset + 2];
        const family = b >= g && b > r ? water : g >= r && g > b ? grass : ground;
        family[0] += r;
        family[1] += g;
        family[2] += b;
        family[3]++;
    }
    const land = grass[3] * 3 >= grass[3] + ground[3] ? grass : ground;
    const dominant = water[3] >= grass[3] + ground[3] ? water : land;
    return dominant.slice(0, 3).map(value => value / Math.max(1, dominant[3]));
}

/**
 * Measure the presented World frame as at most `count` stepped bands of its
 * own materials (`[{ top, color }]`, `top` a fraction of the height; one seam
 * on the sea horizon when it is on screen) plus `sea`, the frame's colour
 * below the horizon. Returns null when nothing can be read.
 */
export function sampleRevealBands(surfaces, { count = 4, horizonY = 0 } = {}) {
    const data = samplePixels(surfaces);
    if (!data) return null;
    const h = Number(horizonY);
    const horizonRow = h > 0 && h < 1 ? Math.max(1, Math.min(SAMPLE_H - 1, Math.round(h * SAMPLE_H))) : 0;
    const segments = [];
    for (let row = 0; row < SAMPLE_H; row++) {
        segments.push({ from: row, to: row + 1, rgb: materialColour(data, row, row + 1) });
    }
    // Ward merging: join the adjacent pair whose union adds the least colour
    // variance, never across the horizon, until `count` bands remain and none
    // is a sliver (a stray stripe, not a material).
    const limit = Math.max(1, Math.floor(count));
    const sliver = segment => segment.to - segment.from < MIN_BAND_ROWS;
    for (;;) {
        const over = segments.length > limit;
        let best = -1;
        let bestCost = Infinity;
        let bestSliver = false;
        for (let index = 0; index < segments.length - 1; index++) {
            const a = segments[index];
            const b = segments[index + 1];
            if (horizonRow && b.from === horizonRow) continue;
            const pairSliver = sliver(a) || sliver(b);
            if (!over && !pairSliver) continue;
            const na = a.to - a.from;
            const nb = b.to - b.from;
            const distance = (a.rgb[0] - b.rgb[0]) ** 2 + (a.rgb[1] - b.rgb[1]) ** 2 + (a.rgb[2] - b.rgb[2]) ** 2;
            const cost = ((na * nb) / (na + nb)) * distance;
            if (pairSliver !== bestSliver ? pairSliver : cost < bestCost) {
                bestCost = cost;
                bestSliver = pairSliver;
                best = index;
            }
        }
        if (best < 0) break;
        const a = segments[best];
        const b = segments[best + 1];
        const na = a.to - a.from;
        const nb = b.to - b.from;
        segments.splice(best, 2, {
            from: a.from,
            to: b.to,
            rgb: a.rgb.map((channel, k) => (channel * na + b.rgb[k] * nb) / (na + nb)),
        });
    }
    const bands = segments.map(segment => ({
        top: horizonRow && segment.from === horizonRow ? h : segment.from / SAMPLE_H,
        color: hex(materialColour(data, segment.from, segment.to)),
    }));
    return { bands, sea: hex(materialColour(data, horizonRow, SAMPLE_H)) };
}

function rgbOf(color) {
    const match = /^#([0-9a-f]{6})$/i.exec(String(color || ''));
    if (!match) return null;
    const value = parseInt(match[1], 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/**
 * Paint `bands` (`[{ top, color }]`, top as a fraction of the height) as the
 * container's stepped background: flat bands on a `cell`-CSS-px texel grid,
 * each seam three 2×2 ordered-dither courses (1/4, 2/4, 3/4 of the lower
 * band) centred on the edge. `heightPx` is the container's CSS height (it may
 * be `display: none` when this runs). The strip is one Bayer period wide,
 * tiles sideways, and is baked at device resolution, so the browser draws it
 * 1:1 with no resampling. One small PNG per paint.
 */
export function paintRevealBands(root, bands, { heightPx = 0, cell = 1 } = {}) {
    if (!root || typeof document === 'undefined') return false;
    const colours = (Array.isArray(bands) ? bands : [])
        .map(band => ({ top: Number(band?.top) || 0, rgb: rgbOf(band?.color) }))
        .filter(band => band.rgb);
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    // Device px per dither cell: one art texel (`cell` CSS px) on this display.
    const texel = Math.max(1, Math.round(Math.max(1, Math.round(Number(cell) || 1)) * dpr));
    const rows = Math.ceil(((Number(heightPx) || 0) * dpr) / texel);
    if (!colours.length || rows <= 0) return false;
    const edges = colours.map((band, index) => (index ? Math.round(band.top * rows) : 0));
    const preferred = Math.max(1, Math.round(rows * SEAM_COURSE_SHARE));
    // Seam i (between bands i-1 and i): its first row and course height.
    const seams = edges.map((edge, index) => {
        if (!index) return null;
        const thinner = Math.min(edge - edges[index - 1], (edges[index + 1] ?? rows) - edge);
        const course = Math.min(preferred, Math.floor(thinner / SEAM_COURSES));
        return course > 0 ? { start: edge - Math.floor((SEAM_COURSES * course) / 2), course } : null;
    });
    const canvas = document.createElement('canvas');
    canvas.width = 2 * texel;
    canvas.height = rows * texel;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    const image = ctx.createImageData(canvas.width, canvas.height);
    const pixels = image.data;
    let band = 0;
    for (let y = 0; y < rows; y++) {
        while (band < colours.length - 1 && y >= edges[band + 1]) band++;
        // The seam this row falls in: the band's own top seam, or the next one.
        let seam = null;
        let upper = band - 1;
        for (const index of [band, band + 1]) {
            const candidate = seams[index];
            if (candidate && y >= candidate.start && y < candidate.start + SEAM_COURSES * candidate.course) {
                seam = candidate;
                upper = index - 1;
            }
        }
        for (let x = 0; x < 2; x++) {
            let rgb = colours[band].rgb;
            if (seam) {
                const lowerShare = Math.floor((y - seam.start) / seam.course) + 1;
                rgb = BAYER2[(y % 2) * 2 + x] < lowerShare ? colours[upper + 1].rgb : colours[upper].rgb;
            }
            for (let dy = 0; dy < texel; dy++) {
                for (let dx = 0; dx < texel; dx++) {
                    const offset = (((y * texel + dy) * canvas.width) + x * texel + dx) * 4;
                    pixels[offset] = rgb[0];
                    pixels[offset + 1] = rgb[1];
                    pixels[offset + 2] = rgb[2];
                    pixels[offset + 3] = 255;
                }
            }
        }
    }
    ctx.putImageData(image, 0, 0);
    root.style.setProperty('--cv-reveal-image', `url("${canvas.toDataURL('image/png')}")`);
    root.style.setProperty('--cv-reveal-size', `${(2 * texel) / dpr}px ${(rows * texel) / dpr}px`);
    root.style.setProperty('--cv-reveal-base', hex(colours.at(-1).rgb));
    root.dataset.revealBands = String(colours.length);
    canvas.width = 0;
    canvas.height = 0;
    return true;
}
