// PNG plotter: draws the analysis payload (spectrogram, peak envelopes,
// loudness curves, onsets, markers) on a Chromium canvas and saves a PNG.
// One page is reused for many plots.
import fs from 'node:fs';

export const SPEC_DB_FLOOR = -120;
export const SPEC_DB_CEIL = -30;

const PAGE_JS = String.raw`
window.drawPlot = function drawPlot(d) {
    const W = d.width, SH = d.specHeight;
    const LM = 64, RM = 64;
    const cv = document.createElement('canvas');
    cv.width = W + LM + RM;
    let g = cv.getContext('2d');
    const font = (px, weight = 400) => { g.font = weight + ' ' + px + 'px Menlo, Consolas, monospace'; };
    // Wrap the metric lines on their ' · ' separators to the space left of the colour bar.
    font(12);
    const maxW = cv.width - LM - 240;
    const subs = [];
    for (const line of (Array.isArray(d.subtitle) ? d.subtitle : [d.subtitle])) {
        let cur = '';
        for (const part of line.split('  ·  ')) {
            const next = cur ? cur + '  ·  ' + part : part;
            if (cur && g.measureText(next).width > maxW) { subs.push(cur); cur = part; } else cur = next;
        }
        if (cur) subs.push(cur);
    }
    const TOP = 44 + subs.length * 16;
    const ENV_H = 110, LOU_H = 120, AXIS_H = 34, GAP = 8, MK_H = 16 * Math.max(1, d.markerRows);
    const H = TOP + MK_H + SH + GAP + ENV_H + GAP + LOU_H + AXIS_H;
    cv.height = H;
    g = cv.getContext('2d');
    g.fillStyle = '#0d0f14'; g.fillRect(0, 0, cv.width, cv.height);

    // Title
    g.fillStyle = '#f2efe6'; font(17, 700);
    g.fillText(d.title, LM, 22);
    g.fillStyle = '#b9c2cf'; font(12);
    subs.forEach((line, i) => g.fillText(line, LM, 42 + i * 16));

    const x0 = LM, specTop = TOP + MK_H;
    const tx = t => x0 + (t / d.duration) * W;

    // Spectrogram
    const img = g.createImageData(W, SH);
    const bytes = Uint8Array.from(atob(d.specB64), c => c.charCodeAt(0));
    const lut = d.lut;
    for (let i = 0; i < W * SH; i++) {
        const v = bytes[i] * 3;
        img.data[i * 4] = lut[v]; img.data[i * 4 + 1] = lut[v + 1]; img.data[i * 4 + 2] = lut[v + 2]; img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, x0, specTop);
    const fy = f => specTop + SH * (1 - Math.log(f / d.fmin) / Math.log(d.fmax / d.fmin));
    // Frequency grid
    const grid = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].filter(f => f >= d.fmin && f <= d.fmax);
    for (const f of grid) {
        const y = Math.round(fy(f)) + 0.5;
        const major = f === 100 || f === 1000 || f === 10000;
        g.strokeStyle = major ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.18)';
        g.lineWidth = 1;
        g.setLineDash(major ? [] : [3, 4]);
        g.beginPath(); g.moveTo(x0, y); g.lineTo(x0 + W, y); g.stroke();
        g.setLineDash([]);
        g.fillStyle = major ? '#ffffff' : '#9aa3b0'; font(major ? 13 : 11, major ? 700 : 400);
        const label = f >= 1000 ? (f / 1000) + 'k' : String(f);
        g.textAlign = 'right'; g.fillText(label + (major ? ' Hz' : ''), x0 - 6, y + 4);
    }
    // Pitch ticks (A notes) on the right axis
    g.textAlign = 'left'; font(11);
    for (let o = 1; o <= 8; o++) {
        const f = 55 * Math.pow(2, o - 1);
        if (f < d.fmin || f > d.fmax) continue;
        const y = Math.round(fy(f)) + 0.5;
        g.strokeStyle = '#7fd1b9'; g.beginPath(); g.moveTo(x0 + W, y); g.lineTo(x0 + W + 6, y); g.stroke();
        g.fillStyle = '#7fd1b9'; g.fillText('A' + o, x0 + W + 9, y + 4);
    }
    g.textAlign = 'left';
    // Onset ticks along the spectrogram bottom
    g.fillStyle = '#ffe066';
    for (const t of d.onsets) g.fillRect(Math.round(tx(t)), specTop + SH - 6, 1, 6);
    g.strokeStyle = '#3a4252'; g.strokeRect(x0 - 0.5, specTop - 0.5, W + 1, SH + 1);
    font(10); g.fillStyle = '#9aa3b0';
    g.fillText('log-f spectrogram, mid (L+R)/2, dB/bin ' + d.dbFloor + '..' + d.dbCeil + ' dBFS, FFT ' + d.fftSize + ' · yellow ticks = onsets', x0 + 4, specTop + 12);

    // Envelope panel: peak dBFS per column, L up / R down, -72..0
    const envTop = specTop + SH + GAP, mid = envTop + ENV_H / 2;
    g.fillStyle = '#12161f'; g.fillRect(x0, envTop, W, ENV_H);
    const ey = v => Math.max(0, Math.min(1, (v + 72) / 72)) * (ENV_H / 2 - 2);
    const envL = d.envL, envR = d.envR;
    g.fillStyle = '#5fb0ff';
    for (let x = 0; x < W; x++) { const h = ey(envL[x]); if (h > 0) g.fillRect(x0 + x, mid - h, 1, h); }
    g.fillStyle = '#ff8f6b';
    for (let x = 0; x < W; x++) { const h = ey(envR[x]); if (h > 0) g.fillRect(x0 + x, mid, 1, h); }
    for (const v of [-60, -48, -36, -24, -12]) {
        g.strokeStyle = 'rgba(255,255,255,0.12)';
        for (const s of [-1, 1]) { const y = Math.round(mid + s * ey(v)) + 0.5; g.beginPath(); g.moveTo(x0, y); g.lineTo(x0 + W, y); g.stroke(); }
    }
    font(10); g.fillStyle = '#9aa3b0'; g.textAlign = 'right';
    for (const v of [-48, -24, 0]) { g.fillText(String(v), x0 - 6, mid - ey(v) + 4); g.fillText(String(v), x0 - 6, mid + ey(v) + 4); }
    g.textAlign = 'left';
    g.fillText('peak dBFS  L (blue, up) / R (orange, down)', x0 + 4, envTop + 11);
    g.strokeStyle = '#3a4252'; g.strokeRect(x0 - 0.5, envTop - 0.5, W + 1, ENV_H + 1);

    // Loudness panel: momentary (400 ms) + short-term (3 s) LUFS, -70..-10
    const louTop = envTop + ENV_H + GAP;
    g.fillStyle = '#12161f'; g.fillRect(x0, louTop, W, LOU_H);
    const ly = v => louTop + LOU_H * (1 - (Math.max(-70, Math.min(-10, v)) + 70) / 60);
    for (let v = -70; v <= -10; v += 10) {
        const y = Math.round(ly(v)) + 0.5;
        g.strokeStyle = 'rgba(255,255,255,0.12)'; g.beginPath(); g.moveTo(x0, y); g.lineTo(x0 + W, y); g.stroke();
        g.fillStyle = '#9aa3b0'; g.textAlign = 'right'; font(10); g.fillText(String(v), x0 - 6, y + 4);
    }
    g.textAlign = 'left';
    const curve = (pts, color, lw) => {
        g.strokeStyle = color; g.lineWidth = lw; g.beginPath();
        let started = false;
        for (const [t, v] of pts) {
            if (!Number.isFinite(v) || v < -70) { started = false; continue; }
            const x = tx(t - (color === '#ffd166' ? 1.5 : 0.2)), y = ly(v);
            if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
        }
        g.stroke(); g.lineWidth = 1;
    };
    curve(d.momentary, 'rgba(120,220,160,0.85)', 1);
    curve(d.shortTerm, '#ffd166', 2);
    if (Number.isFinite(d.integrated)) {
        const y = Math.round(ly(d.integrated)) + 0.5;
        g.setLineDash([6, 4]); g.strokeStyle = '#ffffff'; g.beginPath(); g.moveTo(x0, y); g.lineTo(x0 + W, y); g.stroke(); g.setLineDash([]);
    }
    font(10); g.fillStyle = '#9aa3b0';
    g.fillText('LUFS: momentary 400 ms (green), short-term 3 s (yellow), integrated (dashed white)', x0 + 4, louTop + 11);
    g.strokeStyle = '#3a4252'; g.strokeRect(x0 - 0.5, louTop - 0.5, W + 1, LOU_H + 1);

    // Time axis
    const axisTop = louTop + LOU_H;
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
    const step = steps.find(s => d.duration / s <= 24) || 60;
    font(11); g.fillStyle = '#cfd6e0'; g.textAlign = 'center';
    for (let t = 0; t <= d.duration + 1e-6; t += step) {
        const x = Math.round(tx(t)) + 0.5;
        g.strokeStyle = 'rgba(255,255,255,0.10)'; g.beginPath(); g.moveTo(x, specTop); g.lineTo(x, axisTop); g.stroke();
        g.strokeStyle = '#cfd6e0'; g.beginPath(); g.moveTo(x, axisTop); g.lineTo(x, axisTop + 5); g.stroke();
        g.fillText((step < 1 ? t.toFixed(step < 0.5 ? 2 : 1) : String(Math.round(t))) + 's', x, axisTop + 18);
    }
    g.textAlign = 'left';

    // Markers: vertical lines through all panels, labels in stacked rows
    const colors = { event: '#ff5c8a', section: '#6fe3ff', loop: '#b28dff', chunk: 'rgba(178,141,255,0.45)', action: '#ffa94d' };
    const rowsEnd = new Array(d.markerRows).fill(-1e9);
    font(11);
    for (const m of d.markers) {
        const x = Math.round(tx(m.t)) + 0.5;
        const c = colors[m.kind] || '#dddddd';
        g.strokeStyle = c; g.setLineDash(m.kind === 'chunk' ? [2, 4] : [5, 3]);
        g.beginPath(); g.moveTo(x, specTop); g.lineTo(x, axisTop); g.stroke(); g.setLineDash([]);
        if (m.kind === 'chunk') continue;
        const wLabel = g.measureText(m.label).width + 8;
        let row = rowsEnd.findIndex(end => end < x);
        if (row < 0) row = rowsEnd.indexOf(Math.min(...rowsEnd));
        rowsEnd[row] = x + wLabel;
        g.fillStyle = c; g.fillText(m.label, x + 2, TOP + 12 + row * 16);
        g.beginPath(); g.moveTo(x, TOP + 14 + row * 16); g.lineTo(x, specTop); g.stroke();
    }

    // Colour bar
    const cbx = x0 + W - 220, cby = 10;
    for (let i = 0; i < 200; i++) {
        const v = Math.round(i / 199 * 255) * 3;
        g.fillStyle = 'rgb(' + lut[v] + ',' + lut[v + 1] + ',' + lut[v + 2] + ')';
        g.fillRect(cbx + i, cby, 1, 10);
    }
    font(10); g.fillStyle = '#cfd6e0';
    g.fillText(d.dbFloor + ' dB', cbx, cby + 22); g.textAlign = 'right'; g.fillText(d.dbCeil + ' dB', cbx + 200, cby + 22); g.textAlign = 'left';
    return cv.toDataURL('image/png');
};
window.__plotReady = true;
`;

// Magma-like 256-entry LUT.
function buildLut() {
    const stops = [
        [0, [0, 0, 4]], [0.18, [28, 16, 68]], [0.38, [99, 26, 128]], [0.58, [183, 55, 121]],
        [0.76, [241, 105, 69]], [0.9, [254, 176, 90]], [1, [252, 253, 191]],
    ];
    const lut = [];
    for (let i = 0; i < 256; i++) {
        const t = i / 255;
        let a = stops[0], b = stops[stops.length - 1];
        for (let s = 0; s < stops.length - 1; s++) if (t >= stops[s][0] && t <= stops[s + 1][0]) { a = stops[s]; b = stops[s + 1]; break; }
        const f = (t - a[0]) / Math.max(1e-9, b[0] - a[0]);
        for (let c = 0; c < 3; c++) lut.push(Math.round(a[1][c] + (b[1][c] - a[1][c]) * f));
    }
    return lut;
}
const LUT = buildLut();

export async function openPlotter(browser) {
    const page = await browser.newPage();
    await page.setContent('<html><body style="margin:0;background:#000"></body></html>');
    await page.addScriptTag({ content: PAGE_JS });
    return {
        async plot(file, { title, subtitle, plot, markers = [], integrated }) {
            const { spec } = plot;
            const bytes = Buffer.alloc(spec.width * spec.height);
            for (let i = 0; i < bytes.length; i++) {
                const v = (spec.matrix[i] - SPEC_DB_FLOOR) / (SPEC_DB_CEIL - SPEC_DB_FLOOR);
                bytes[i] = Math.max(0, Math.min(255, Math.round(v * 255)));
            }
            const visible = markers.filter(m => Number.isFinite(m.t) && m.t >= -0.01 && m.t <= plot.duration + 0.01);
            const labelled = visible.filter(m => m.kind !== 'chunk').length;
            const payload = {
                title, subtitle,
                width: spec.width, specHeight: spec.height, fmin: spec.fmin, fmax: spec.fmax, fftSize: spec.fftSize,
                specB64: bytes.toString('base64'), lut: LUT, dbFloor: SPEC_DB_FLOOR, dbCeil: SPEC_DB_CEIL,
                envL: Array.from(plot.env.L, v => Math.round(v * 10) / 10),
                envR: Array.from(plot.env.R, v => Math.round(v * 10) / 10),
                momentary: plot.momentary.map(([t, v]) => [t, Number.isFinite(v) ? Math.round(v * 10) / 10 : null]),
                shortTerm: plot.shortTerm.map(([t, v]) => [t, Number.isFinite(v) ? Math.round(v * 10) / 10 : null]),
                onsets: plot.onsets, duration: plot.duration,
                markers: visible, markerRows: Math.min(4, Math.max(1, Math.ceil(labelled / Math.max(1, Math.floor(spec.width / 140))) + (labelled > 3 ? 1 : 0))),
                integrated,
            };
            const url = await page.evaluate(d => window.drawPlot(d), payload);
            fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
        },
        close: () => page.close(),
    };
}
