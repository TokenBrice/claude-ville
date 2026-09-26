// Capture plumbing shared by the listening harness CLI (audio-capture.mjs)
// and the Wave-0 probe (probe.mjs): page setup with the tap init script, PCM
// transfer out of the page, and the underrun-splice mapping from audio-clock
// time to sample index.
import fs from 'node:fs';
import path from 'node:path';
import { AUDIO_DIR } from './server.mjs';
import { tempRoot } from '../../tests/support/tmp.mjs';

export const INIT_JS = fs.readFileSync(path.join(AUDIO_DIR, 'page/init.js'), 'utf8');
export const DEFAULT_SEED = 0x5eed;

// Renders never land in the repository: the default root lives under
// $CLAUDEVILLE_TEST_TMPDIR (or the OS temp dir). It is a stable path so
// `index` and `replot` find earlier renders across runs.
export const RENDERS = path.join(tempRoot(), 'claudeville-audio-renders');

// The harness page and the offline cues construct the controller directly,
// so they run without a gesture requirement; the probe's app checks use
// `--autoplay-policy=user-gesture-required` instead (see probe.mjs).
export const BACKGROUND_ARGS = ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
export const HARNESS_CHROME_ARGS = ['--autoplay-policy=no-user-gesture-required', ...BACKGROUND_ARGS];

export async function pullPcm(page, floats, name = '__harPcm') {
    const parts = [];
    const step = 1 << 20;
    for (let off = 0; off < floats; off += step) {
        const b64 = await page.evaluate(([o, n, k]) => window.__harPull(o, n, k), [off, step, name]);
        parts.push(Buffer.from(b64, 'base64'));
    }
    const buf = Buffer.concat(parts);
    const f = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
    const frames = f.length / 2;
    const L = new Float32Array(frames), R = new Float32Array(frames);
    for (let i = 0; i < frames; i++) { L[i] = f[2 * i]; R[i] = f[2 * i + 1]; }
    return { L, R };
}

// A browser context with the tap init script (seeded Math.random when `seed`
// is not null), any extra init scripts after it, and page-error collection.
export async function newHarnessPage(browser, seed, viewport = { width: 1280, height: 800 }, extraInit = []) {
    const context = await browser.newContext({ viewport });
    const seedLine = seed == null ? '' : `window.__HAR_SEED = ${Number(seed)};\n`;
    await context.addInitScript({ content: seedLine + INIT_JS });
    for (const content of extraInit) await context.addInitScript({ content });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e?.message || e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    return { context, page, errors };
}

// The renderer-free harness page. The click gives the page a real user
// activation, which the controller's enable path requires.
export async function openHarness(browser, baseUrl, seed) {
    const h = await newHarnessPage(browser, seed);
    await h.page.goto(`${baseUrl}/__har/harness.html`);
    await h.page.waitForFunction(() => window.__harReady === true, null, { timeout: 20000 });
    await h.page.mouse.click(4, 4);
    return h;
}

// Audio-thread underruns: the recorder reports every skipped span [clockFrame,
// lost]; the PCM is spliced across them. clockToIndex maps an audio-clock time
// to a sample index of the spliced PCM; windowGaps lists the skips inside the
// kept window (the rest fall in warmup).
export function clockToIndex(info, t) {
    const frame = Math.round(t * info.sampleRate);
    let removed = 0;
    for (const [at, lost] of info.gapList || []) {
        if (lost <= 0 || at >= frame) break;
        if (frame < at + lost) return at - info.firstFrame - removed;
        removed += lost;
    }
    return frame - info.firstFrame - removed;
}

export function windowGaps(info, startT, endT) {
    const sr = info.sampleRate;
    const inside = (info.gapList || []).filter(([at]) => at / sr >= startT && at / sr <= endT);
    return {
        gaps: inside.length,
        droppedFrames: inside.reduce((n, [, lost]) => n + Math.max(0, lost), 0),
        gapTimes: inside.slice(0, 60).map(([at, lost]) => [Number((at / sr - startT).toFixed(3)), lost]),
        gapsOutsideWindow: (info.gapList || []).length - inside.length,
    };
}

// Cut [startT, endT] (audio clock) out of the spliced PCM and re-express
// markers / voices as seconds from the first kept sample.
export function cutWindow(info, pcm, startT, endT, markers, voiceLog) {
    const sr = info.sampleRate;
    const a = Math.max(0, clockToIndex(info, startT));
    const b = Math.min(info.frames, clockToIndex(info, endT));
    const rel = t => (clockToIndex(info, t) - a) / sr;
    return {
        L: pcm.L.subarray(a, b), R: pcm.R.subarray(a, b), sampleRate: sr,
        markers: (markers || []).filter(m => m.t != null).map(m => ({ ...m, t: rel(m.t) })),
        voiceLog: voiceLog ? voiceLog.map(v => ({ s: rel(v.s), e: v.e == null ? null : rel(v.e), k: v.k })) : null,
        gapInfo: windowGaps(info, startT, endT),
    };
}

// Every scheduled source's audio-clock window, for voice-count metrics.
export function readVoiceLog(page) {
    return page.evaluate(() => window.__harVoiceLog.map(v => ({ s: v.s, e: Number.isFinite(v.e) ? v.e : null, k: v.k })));
}

// Envelope hazards (HAR-4) collected by the init script; `clear` resets the
// map so consecutive renders on one page report their own.
export function readHazards(page, { clear = false } = {}) {
    return page.evaluate((c) => {
        const list = [...window.__harHazards.values()];
        if (c) window.__harHazards.clear();
        return list;
    }, clear);
}
