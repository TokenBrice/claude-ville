#!/usr/bin/env node
// Wave 0.4 — Pure-Node HTML & 1x / 2x / 3x Side-by-Side Contact Board Generator
// (Spec 03 §3.3 — 100% pure Node, ZERO browser)
//
// Emits crisp nearest-neighbor `1x`, `2x`, `3x` side-by-side PNG contact boards
// (`[BASE | HEAD | ΔE > 2.3 HEATMAP]`) + individual `heatmap.png` +
// self-contained `index.html` with ROI metric table and 1-line verdict banner
// into `output/visual-boards/<name>/` (or custom `--out`).
//
// Usage:
//   node scripts/visual/board.mjs --name <name> --base <png> --head <png> [--out <dir>] [--verdict <json>] [--roi <label:x,y,w,h,...>] [--scales 1,2,3]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import {
    JND_DELTA_E,
    comparePngBuffers,
    evaluateVerdict,
    oklabDeltaEJnd,
} from './compare.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIVIDER_PX = 2;
const DIVIDER_RGBA = Object.freeze([20, 14, 10, 255]); // #140e0a Keep keyline

/**
 * Nearest-neighbor integer upscale (exact pixel-art zoom, zero bilinear blur).
 * @param {{ width: number, height: number, data: Uint8Array|Buffer }} png
 * @param {number} scale - positive integer (1, 2, 3, ...)
 * @returns {PNG}
 */
export function scaleNearestPng(png, scale) {
    if (!Number.isInteger(scale) || scale < 1) {
        throw new RangeError(`scale must be a positive integer, got ${scale}`);
    }
    const out = new PNG({ width: png.width * scale, height: png.height * scale });
    const src = png.data;
    const dst = out.data;
    if (scale === 1) {
        dst.set(src);
        return out;
    }
    const w = png.width;
    const h = png.height;
    const dstW = out.width;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const si = (y * w + x) * 4;
            const r = src[si];
            const g = src[si + 1];
            const b = src[si + 2];
            const a = src[si + 3];
            for (let sy = 0; sy < scale; sy++) {
                const rowOff = ((y * scale + sy) * dstW + x * scale) * 4;
                for (let sx = 0; sx < scale; sx++) {
                    const di = rowOff + sx * 4;
                    dst[di] = r;
                    dst[di + 1] = g;
                    dst[di + 2] = b;
                    dst[di + 3] = a;
                }
            }
        }
    }
    return out;
}

/**
 * Render an OKLab ΔE heatmap PNG:
 *   ΔE === 0           : dimmed reference luma (0.3x)
 *   0 < ΔE <= threshold: cool slate-blue tint (sub-JND)
 *   threshold < ΔE <= 5: warm gold (#f0c040)
 *   ΔE > 5             : vivid magenta (#ff2bd6)
 */
export function renderDeltaEHeatmap(basePng, headPng, threshold = JND_DELTA_E) {
    if (basePng.width !== headPng.width || basePng.height !== headPng.height) {
        throw new Error(`Dimension mismatch: base ${basePng.width}x${basePng.height} != head ${headPng.width}x${headPng.height}`);
    }
    const { width, height } = basePng;
    const out = new PNG({ width, height });
    const a = basePng.data;
    const b = headPng.data;
    const dst = out.data;
    let overJndPixels = 0;
    let maxDeltaE = 0;

    for (let p = 0, i = 0; p < width * height; p++, i += 4) {
        const r1 = a[i];
        const g1 = a[i + 1];
        const b1 = a[i + 2];
        const r2 = b[i];
        const g2 = b[i + 1];
        const b2 = b[i + 2];
        const de = oklabDeltaEJnd(r1, g1, b1, r2, g2, b2);
        if (de > maxDeltaE) maxDeltaE = de;
        if (de === 0) {
            const l = Math.round((0.2126 * r1 + 0.7152 * g1 + 0.0722 * b1) * 0.3);
            dst[i] = l;
            dst[i + 1] = l;
            dst[i + 2] = l;
            dst[i + 3] = 255;
        } else if (de <= threshold) {
            dst[i] = 48;
            dst[i + 1] = 104;
            dst[i + 2] = 180;
            dst[i + 3] = 255;
        } else if (de <= 5.0) {
            overJndPixels++;
            dst[i] = 240;
            dst[i + 1] = 192;
            dst[i + 2] = 64;
            dst[i + 3] = 255;
        } else {
            overJndPixels++;
            dst[i] = 255;
            dst[i + 1] = 43;
            dst[i + 2] = 214;
            dst[i + 3] = 255;
        }
    }

    return { png: out, overJndPixels, maxDeltaE };
}

/**
 * Compose a horizontal side-by-side contact strip `[base | head | heatmap]`
 * at exact integer `scale` with 2px Keep keyline dividers.
 */
export function composeSideBySideBoard(basePng, headPng, heatmapPng, scale = 1) {
    const panels = [
        scaleNearestPng(basePng, scale),
        scaleNearestPng(headPng, scale),
        scaleNearestPng(heatmapPng, scale),
    ];
    const pw = panels[0].width;
    const ph = panels[0].height;
    const div = DIVIDER_PX;
    const totalW = pw * 3 + div * 2;
    const out = new PNG({ width: totalW, height: ph });

    // Fill with Keep divider color
    for (let i = 0; i < out.data.length; i += 4) {
        out.data[i] = DIVIDER_RGBA[0];
        out.data[i + 1] = DIVIDER_RGBA[1];
        out.data[i + 2] = DIVIDER_RGBA[2];
        out.data[i + 3] = DIVIDER_RGBA[3];
    }

    for (let idx = 0; idx < panels.length; idx++) {
        const panel = panels[idx];
        const xOff = idx * (pw + div);
        for (let y = 0; y < ph; y++) {
            const srcStart = y * pw * 4;
            const srcEnd = srcStart + pw * 4;
            const dstStart = (y * totalW + xOff) * 4;
            out.data.set(panel.data.subarray(srcStart, srcEnd), dstStart);
        }
    }
    return out;
}

function cropPng(png, { x, y, w, h }) {
    const x0 = Math.max(0, Math.min(png.width - 1, Math.floor(x)));
    const y0 = Math.max(0, Math.min(png.height - 1, Math.floor(y)));
    const cw = Math.max(1, Math.min(png.width - x0, Math.floor(w)));
    const ch = Math.max(1, Math.min(png.height - y0, Math.floor(h)));
    const out = new PNG({ width: cw, height: ch });
    for (let row = 0; row < ch; row++) {
        const srcStart = ((y0 + row) * png.width + x0) * 4;
        out.data.set(png.data.subarray(srcStart, srcStart + cw * 4), row * cw * 4);
    }
    return out;
}

function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function renderBoardHtml({ name, scales, verdict, comparison, roiReports = [] }) {
    const pass = verdict.verdict === 'pass';
    const badgeColor = pass ? '#79d975' : '#e06c5b';
    const regionRows = Object.entries(verdict.perceptualByRegion || {}).map(([region, m]) => `
        <tr>
          <td>${escapeHtml(region)}</td>
          <td class="num">${m.pixels}</td>
          <td class="num">${m.meanDeltaE.toFixed(3)}</td>
          <td class="num">${m.p999DeltaE.toFixed(3)}</td>
          <td class="num">${(m.shareOverJnd * 100).toFixed(3)}%</td>
          <td class="num">${m.ssim.toFixed(5)}</td>
        </tr>`).join('');

    const roiSection = roiReports.length ? `
      <section>
        <h2>Regions of Interest (ROI)</h2>
        <table>
          <thead><tr><th>ROI</th><th>Rect</th><th>Pixels</th><th>Mean ΔE</th><th>p99.9 ΔE</th><th>&gt; JND</th><th>SSIM</th></tr></thead>
          <tbody>
            ${roiReports.map((r) => `
              <tr>
                <td>${escapeHtml(r.label)}</td>
                <td>${r.x},${r.y} (${r.w}×${r.h})</td>
                <td class="num">${r.metrics.pixels}</td>
                <td class="num">${r.metrics.meanDeltaE.toFixed(3)}</td>
                <td class="num">${r.metrics.p999DeltaE.toFixed(3)}</td>
                <td class="num">${(r.metrics.shareOverJnd * 100).toFixed(3)}%</td>
                <td class="num">${r.metrics.ssim.toFixed(5)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </section>` : '';

    const scaleButtons = scales.map((s, idx) =>
        `<button type="button" data-scale="${s}" class="${idx === 0 ? 'active' : ''}">${s}×</button>`,
    ).join('');

    const oneLineVerdict = pass
        ? `PASS — weighted SSIM ${comparison.weightedSsim.toFixed(5)}, unclassified >1 LSB: ${verdict.parityAttribution.unclassifiedNonRimOver1}`
        : `FAIL — ${verdict.failures.join('; ')}`;

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ClaudeVille Visual Board — ${escapeHtml(name)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 20px; background: #140e0a; color: #e8dec8; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding-bottom: 14px; border-bottom: 1px solid #3c2e22; }
  h1 { margin: 0; font-size: 16px; color: #f2d59b; }
  .verdict { padding: 6px 12px; border: 1px solid ${badgeColor}; color: ${badgeColor}; background: rgba(0,0,0,0.35); font-weight: 700; }
  .controls { display: flex; gap: 8px; margin: 14px 0; align-items: center; }
  .controls button { background: #241912; color: #e8dec8; border: 1px solid #6b533b; padding: 4px 10px; cursor: pointer; font: inherit; }
  .controls button.active { background: #d4984e; color: #140e0a; border-color: #fae174; font-weight: 700; }
  .legend { color: #b7ad99; font-size: 12px; }
  .board-wrap { overflow: auto; border: 1px solid #3c2e22; background: #0c0907; padding: 8px; }
  .board-wrap img { display: block; image-rendering: pixelated; image-rendering: crisp-edges; }
  table { border-collapse: collapse; width: 100%; margin-top: 10px; }
  th, td { border: 1px solid #3c2e22; padding: 6px 8px; text-align: left; }
  th { background: #211710; color: #f2d59b; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  section { margin-top: 18px; }
</style>
</head>
<body>
  <header>
    <h1>Visual QA Contact Board · ${escapeHtml(name)}</h1>
    <div class="verdict">${escapeHtml(oneLineVerdict)}</div>
  </header>
  <div class="controls">
    <span>Zoom:</span>
    ${scaleButtons}
    <span class="legend">Panels: [BASE | HEAD | ΔE Heatmap (blue ≤ 2.3, gold 2.3–5.0, magenta &gt; 5.0)]</span>
  </div>
  <div class="board-wrap">
    <img id="boardImg" src="board-${scales[0]}x.png" alt="Side-by-side contact board">
  </div>
  <section>
    <h2>Perceptual Metrics by Region (OKLab ΔE, JND = ${JND_DELTA_E})</h2>
    <table>
      <thead><tr><th>Region</th><th>Pixels</th><th>Mean ΔE</th><th>p99.9 ΔE</th><th>Share &gt; JND</th><th>Luma SSIM</th></tr></thead>
      <tbody>${regionRows}</tbody>
    </table>
  </section>
  ${roiSection}
  <script>
    const img = document.getElementById('boardImg');
    document.querySelectorAll('.controls button[data-scale]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.controls button[data-scale]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        img.src = 'board-' + btn.dataset.scale + 'x.png';
      });
    });
  </script>
</body>
</html>
`;
}

/**
 * Generate a complete Visual QA contact board directory containing:
 *   `base.png`, `head.png`, `heatmap.png`, `board-1x.png`, `board-2x.png`,
 *   `board-3x.png`, `verdict.json`, and `index.html`.
 */
export function generateVisualBoard({
    name,
    basePng,
    headPng,
    outDir = null,
    verdict = null,
    rois = [],
    scales = [1, 2, 3],
    threshold = JND_DELTA_E,
}) {
    const safeName = String(name || 'visual-board').replace(/[^a-zA-Z0-9._-]+/g, '-');
    const targetDir = outDir || path.join(ROOT, 'output', 'visual-boards', safeName);
    mkdirSync(targetDir, { recursive: true });

    const comparison = comparePngBuffers(basePng, headPng, { jndThreshold: threshold });
    const resolvedVerdict = verdict || evaluateVerdict({
        caseId: safeName,
        perceptualByRegion: comparison.perceptualByRegion,
        parityAttribution: comparison.parityAttribution,
    });
    const heatmap = renderDeltaEHeatmap(basePng, headPng, threshold);

    const files = {
        base: path.join(targetDir, 'base.png'),
        head: path.join(targetDir, 'head.png'),
        heatmap: path.join(targetDir, 'heatmap.png'),
        boards: {},
        verdict: path.join(targetDir, 'verdict.json'),
        html: path.join(targetDir, 'index.html'),
    };

    writeFileSync(files.base, PNG.sync.write(scaleNearestPng(basePng, 1)));
    writeFileSync(files.head, PNG.sync.write(scaleNearestPng(headPng, 1)));
    writeFileSync(files.heatmap, PNG.sync.write(heatmap.png));

    for (const scale of scales) {
        const boardPng = composeSideBySideBoard(basePng, headPng, heatmap.png, scale);
        const boardFile = path.join(targetDir, `board-${scale}x.png`);
        writeFileSync(boardFile, PNG.sync.write(boardPng));
        files.boards[`${scale}x`] = boardFile;
    }

    const roiReports = rois.map((roi) => {
        const refCrop = cropPng(basePng, roi);
        const candCrop = cropPng(headPng, roi);
        const cmp = comparePngBuffers(refCrop, candCrop, { jndThreshold: threshold });
        return {
            label: roi.label || `${roi.x},${roi.y}`,
            x: roi.x,
            y: roi.y,
            w: refCrop.width,
            h: refCrop.height,
            metrics: cmp.perceptualByRegion.all,
        };
    });

    writeFileSync(files.verdict, `${JSON.stringify(resolvedVerdict, null, 2)}\n`);
    writeFileSync(files.html, renderBoardHtml({
        name: safeName,
        scales,
        verdict: resolvedVerdict,
        comparison,
        roiReports,
    }));

    return {
        outDir: targetDir,
        files,
        comparison,
        verdict: resolvedVerdict,
        heatmapStats: { overJndPixels: heatmap.overJndPixels, maxDeltaE: heatmap.maxDeltaE },
        roiReports,
    };
}

// ---------------------------------------------------------------------- CLI

function parseRois(value) {
    return String(value).split(';').map((item) => item.trim()).filter(Boolean).map((spec) => {
        const [labelPart, coordsPart] = spec.includes(':') ? spec.split(':', 2) : ['roi', spec];
        const [x, y, w, h] = coordsPart.split(',').map(Number);
        if (![x, y, w, h].every(Number.isFinite)) throw new Error(`Invalid --roi spec: ${spec}`);
        return { label: labelPart, x, y, w, h };
    });
}

function parseArgs(argv) {
    const opts = {
        name: 'compare',
        base: null,
        head: null,
        out: null,
        verdict: null,
        rois: [],
        scales: [1, 2, 3],
        help: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
        const [flag, inline] = arg.split('=', 2);
        const value = inline ?? argv[++i];
        if (value == null || value === '') throw new Error(`Missing value for ${flag}`);
        switch (flag) {
            case '--name': opts.name = value; break;
            case '--base': opts.base = path.resolve(process.cwd(), value); break;
            case '--head': opts.head = path.resolve(process.cwd(), value); break;
            case '--out': opts.out = path.resolve(process.cwd(), value); break;
            case '--verdict': opts.verdict = path.resolve(process.cwd(), value); break;
            case '--roi': opts.rois.push(...parseRois(value)); break;
            case '--scales': opts.scales = value.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 1); break;
            default: throw new Error(`Unknown argument: ${arg}`);
        }
    }
    return opts;
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help || !opts.base || !opts.head) {
        console.log('Usage: node scripts/visual/board.mjs --name <name> --base <png> --head <png> [--out <dir>] [--verdict <json>] [--roi <label:x,y,w,h>] [--scales 1,2,3]');
        if (!opts.help) process.exitCode = 1;
        return;
    }
    const basePng = PNG.sync.read(readFileSync(opts.base));
    const headPng = PNG.sync.read(readFileSync(opts.head));
    const verdict = opts.verdict && existsSync(opts.verdict)
        ? JSON.parse(readFileSync(opts.verdict, 'utf8'))
        : null;
    const result = generateVisualBoard({
        name: opts.name,
        basePng,
        headPng,
        outDir: opts.out,
        verdict,
        rois: opts.rois,
        scales: opts.scales.length ? opts.scales : [1, 2, 3],
    });
    console.log(`[visual:board] wrote ${path.relative(ROOT, result.files.html)} (${result.verdict.verdict.toUpperCase()}, scales=${opts.scales.join(',')})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        main();
    } catch (error) {
        console.error(`[visual:board] FAIL: ${error.stack || error.message}`);
        process.exit(1);
    }
}
