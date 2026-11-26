#!/usr/bin/env node
// ClaudeVille's app icon: Fable's head, cut from her south-facing idle frame
// and scaled only by whole numbers, so every block is a sprite pixel.
//
//   node scripts/sprites/bake-app-icons.mjs
//
// Rerun after Fable's sheet is regenerated. Outputs:
//   claudeville/favicon.svg        browser tab (32 x 32 pixel grid)
//   claudeville/favicon-alert.svg  the same with the attention dot
//                                  (AttentionService swaps the two)
//   claudeville/icon-192.png       x5, apple-touch-icon and web manifests
//   claudeville/icon-512.png       x14, web manifests
//   favicon.svg                    repo root copy, for tools that look for a
//                                  project icon there (T3 Code, ...)
// The PNGs are opaque with the art inside the maskable safe zone, so the
// manifests' "any maskable" purpose holds.
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SHEET = 'claudeville/assets/sprites/characters/agent.claude.fable/sheet.png';
const CELL = 92;
const FRAME = { col: 0, row: 6 }; // DIRECTIONS[0] = 's', first breathing-idle row
const WINDOW = { x: 29, y: 9, size: 32 }; // cell-local, crown to shoulders
const BG = [0x1b, 0x12, 0x0d];
const ALERT = { cx: 25, cy: 7, ring: 5.5, dot: 4.5, color: [0xe0, 0x55, 0x3c] };
const PNG_SIZES = [{ file: 'icon-192.png', scale: 5, pad: 16 }, { file: 'icon-512.png', scale: 14, pad: 32 }];

const hex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');

function readPortrait() {
    const sheet = PNG.sync.read(fs.readFileSync(path.join(ROOT, SHEET)));
    const n = WINDOW.size;
    const grid = [];
    for (let y = 0; y < n; y++) {
        const row = [];
        for (let x = 0; x < n; x++) {
            const sx = FRAME.col * CELL + WINDOW.x + x;
            const sy = FRAME.row * CELL + WINDOW.y + y;
            const i = (sy * sheet.width + sx) * 4;
            const a = sheet.data[i + 3] / 255;
            row.push([0, 1, 2].map((c) => Math.round(sheet.data[i + c] * a + BG[c] * (1 - a))));
        }
        grid.push(row);
    }
    return grid;
}

function withAlertDot(grid) {
    return grid.map((row, y) => row.map((rgb, x) => {
        const d = Math.hypot(x + 0.5 - ALERT.cx, y + 0.5 - ALERT.cy);
        if (d <= ALERT.dot) return ALERT.color;
        if (d <= ALERT.ring) return BG;
        return rgb;
    }));
}

// One path per colour, one horizontal run per subpath.
function toSvg(grid) {
    const n = grid.length;
    const runs = new Map();
    const bg = hex(BG);
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n;) {
            const color = hex(grid[y][x]);
            let end = x + 1;
            while (end < n && hex(grid[y][end]) === color) end++;
            if (color !== bg) runs.set(color, (runs.get(color) || '') + `M${x} ${y}h${end - x}v1H${x}z`);
            x = end;
        }
    }
    const paths = [...runs].map(([color, d]) => `    <path fill="${color}" d="${d}"/>`).join('\n');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">
  <clipPath id="r"><rect width="${n}" height="${n}" rx="4"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${n}" height="${n}" fill="${bg}"/>
${paths}
  </g>
</svg>
`;
}

function toPng(grid, scale, pad) {
    const size = grid.length * scale + pad * 2;
    const png = new PNG({ width: size, height: size });
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const gx = Math.floor((x - pad) / scale);
            const gy = Math.floor((y - pad) / scale);
            const inside = x >= pad && y >= pad && gx < grid.length && gy < grid.length;
            const rgb = inside ? grid[gy][gx] : BG;
            const i = (y * size + x) * 4;
            png.data[i] = rgb[0]; png.data[i + 1] = rgb[1]; png.data[i + 2] = rgb[2]; png.data[i + 3] = 255;
        }
    }
    return PNG.sync.write(png, { colorType: 2 });
}

const portrait = readPortrait();
const outputs = {
    'claudeville/favicon.svg': toSvg(portrait),
    'claudeville/favicon-alert.svg': toSvg(withAlertDot(portrait)),
    'favicon.svg': toSvg(portrait),
};
for (const { file, scale, pad } of PNG_SIZES) outputs[`claudeville/${file}`] = toPng(portrait, scale, pad);
for (const [file, data] of Object.entries(outputs)) {
    fs.writeFileSync(path.join(ROOT, file), data);
    console.log(`wrote ${file} (${data.length} bytes)`);
}
