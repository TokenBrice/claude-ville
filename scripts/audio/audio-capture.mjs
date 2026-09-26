#!/usr/bin/env node
// ClaudeVille listening harness CLI. See scripts/audio/README.md.
//
//   node scripts/audio/audio-capture.mjs list
//   node scripts/audio/audio-capture.mjs <target|category|all> [--seconds N] [--out dir] [--jobs N] [--seed N] [--snippet file.js]
//   node scripts/audio/audio-capture.mjs snippet --snippet file.js [--seconds N] [--offline] [--volume-step 0-10] [--name id] [--out dir]
//   node scripts/audio/audio-capture.mjs analyze file.wav [--markers markers.json] [--out dir]
//   node scripts/audio/audio-capture.mjs index [--out dir]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { startStaticServer, AUDIO_DIR, REPO_ROOT } from './lib/server.mjs';
import { analyze, readWav, writeWavFloat } from './lib/analyze.mjs';
import { openPlotter } from './lib/plot.mjs';
import { buildTargets } from './lib/targets.mjs';
import { STANDARD_VOLUME_STEP } from '../../claudeville/src/presentation/shared/audio/Loudness.js';
import {
    DEFAULT_SEED, HARNESS_CHROME_ARGS, RENDERS,
    cutWindow, newHarnessPage, openHarness, pullPcm, readHazards, readVoiceLog,
} from './lib/capture.mjs';

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next == null || next.startsWith('--')) out[key] = true;
            else { out[key] = next; i++; }
        } else out._.push(a);
    }
    return out;
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ------------------------------------------------------------ capture ----

async function captureRealtime(browser, server, target, opts) {
    const seed = (opts.seed ?? DEFAULT_SEED) + (target.seedOffset ?? 0);
    const h = await openHarness(browser, server.baseUrl, seed);
    try {
        const spec = { ...target };
        if (opts.seconds) spec.seconds = Number(opts.seconds);
        if (opts.snippetUrl) spec.snippet = opts.snippetUrl;
        const result = await h.page.evaluate(s => window.__har.runRealtime(s), spec);
        const info = await h.page.evaluate(() => window.__harTap.collect());
        const pcm = await pullPcm(h.page, info.frames * 2);
        const voiceLog = await readVoiceLog(h.page);
        const hazards = await readHazards(h.page);
        const firstT = info.firstFrame / info.sampleRate;
        const start = Math.max(result.window.start, firstT);
        const cut = cutWindow(info, pcm, start, result.window.end, result.markers, voiceLog);
        return {
            L: cut.L, R: cut.R, sampleRate: cut.sampleRate,
            windowStart: start,
            markers: cut.markers,
            voiceLog: cut.voiceLog,
            meta: {
                seed, ...cut.gapInfo, hazards, firstFrame: info.firstFrame, timedOut: result.timedOut,
                loopSeconds: result.loopSeconds, hour: result.hour, atmosphere: result.atmosphere,
                worldCounts: result.worldCounts,
                stateLog: result.stateLog.map(s => ({ ...s, t: Number((s.t - start).toFixed(2)) })),
                finalState: {
                    state: result.finalSnapshot?.state, mode: result.finalSnapshot?.mode,
                    levels: result.finalSnapshot?.levels, framePressureLevel: result.finalSnapshot?.framePressureLevel,
                    atmosphereSource: result.finalSnapshot?.atmosphereSource, section: result.finalSnapshot?.section,
                    volumeStep: result.finalSnapshot?.volumeStep,
                },
                pageErrors: h.errors,
            },
        };
    } finally {
        await h.context.close();
    }
}

async function captureOffline(page, target) {
    const result = await page.evaluate(s => window.__har.runOfflineCues(s), target);
    const pcm = await pullPcm(page, result.frames * 2);
    const voiceLog = await readVoiceLog(page);
    const hazards = await readHazards(page, { clear: true });
    return { ...pcm, sampleRate: result.sampleRate, windowStart: 0, markers: result.markers, voiceLog, meta: { hazards } };
}

async function captureApp(browser, target) {
    const { startIsolatedServer } = await import(path.join(REPO_ROOT, 'scripts/smoke/support/isolated-server.mjs'));
    const server = await startIsolatedServer();
    const h = await newHarnessPage(browser, null, { width: 1440, height: 900 });
    try {
        await h.page.goto(`${server.baseUrl}/?sim=1`, { waitUntil: 'domcontentloaded' });
        await h.page.waitForFunction(() => Boolean(window.__claudeVilleApp) && Boolean(document.querySelector('#topbarSoundToggle')), null, { timeout: 30000 });
        await h.page.waitForTimeout(3000);
        await h.page.evaluate(({ hour, weather }) => {
            const atmo = window.__claudeVilleAtmosphere;
            atmo?.setHour?.(hour);
            atmo?.setWeather?.(weather);
        }, { hour: target.hour, weather: target.weather });
        await h.page.click('#topbarSoundToggle');
        await h.page.waitForFunction(() => {
            const a = window.__claudevilleAudio?.();
            return a?.contextState === 'running' && a?.running === true;
        }, null, { timeout: 15000 });
        const result = await h.page.evaluate(async ({ warmup, seconds }) => {
            const sleep = ms => new Promise(r => setTimeout(r, ms));
            const ctx = [...window.__harTap.taps.keys()][0];
            const stateLog = [];
            const timer = setInterval(() => {
                const s = window.__claudevilleAudio?.();
                if (s) stateLog.push({ t: ctx.currentTime, state: s.state, levels: s.levels, framePressureLevel: s.framePressureLevel, atmosphereSource: s.atmosphereSource, phase: s.phase, nowPlaying: s.nowPlaying, sectionCounts: s.sectionCounts });
            }, 1000);
            await sleep(warmup * 1000);
            const start = ctx.currentTime;
            await sleep(seconds * 1000);
            const end = ctx.currentTime;
            clearInterval(timer);
            const snap = window.__claudevilleAudio?.();
            return { start, end, stateLog: JSON.parse(JSON.stringify(stateLog)), final: JSON.parse(JSON.stringify(snap)) };
        }, { warmup: target.warmup, seconds: target.seconds });
        const info = await h.page.evaluate(() => window.__harTap.collect());
        const pcm = await pullPcm(h.page, info.frames * 2);
        const hazards = await readHazards(h.page);
        const cut = cutWindow(info, pcm, result.start, result.end, [], null);
        return {
            L: cut.L, R: cut.R, sampleRate: cut.sampleRate, windowStart: result.start,
            markers: [], voiceLog: null,
            meta: {
                ...cut.gapInfo,
                hazards,
                stateLog: result.stateLog.map(s => ({ ...s, t: Number((s.t - result.start).toFixed(2)) })),
                finalState: {
                    state: result.final?.state, mode: result.final?.mode, levels: result.final?.levels,
                    framePressureLevel: result.final?.framePressureLevel, atmosphereSource: result.final?.atmosphereSource,
                    phase: result.final?.phase, sectionCounts: result.final?.sectionCounts, volumeStep: result.final?.volumeStep,
                },
                pageErrors: h.errors.slice(0, 20),
            },
        };
    } finally {
        await h.context.close();
        await server.stop();
    }
}

// ----------------------------------------------------------- write out ----
function summarizeTarget(target) {
    const { name, category, method, mode, isolate, atmosphere, world, music, bgm, actions, cues, volumeStep, warmup, seconds } = target;
    return { name, category, method, mode, isolate, atmosphere, world, music, bgm, actions, cues, volumeStep: volumeStep ?? STANDARD_VOLUME_STEP, warmup, seconds };
}

function notable(m, target, capture = null) {
    const bits = [];
    if (capture?.gaps) bits.push(`${capture.gaps} audio-thread skips (${capture.droppedFrames} frames)`);
    if (capture?.timedOut) bits.push('TIMED OUT');
    for (const hz of capture?.hazards || []) bits.push(`ENVELOPE HAZARD x${hz.count} (${hz.maxLeadMs} ms at gain 1) ${hz.site.replace(/^at\s+/, '').replace(/https?:\/\/[^/]+/g, '').slice(0, 90)}`);
    if (m.peak.clippedSamples > 0) bits.push(`CLIP x${m.peak.clippedSamples}`);
    if (m.peak.truePeakDBTP != null && m.peak.truePeakDBTP > -1) bits.push('TP>-1');
    if (m.loudness.integratedLUFS == null) bits.push('silent (<-70 LUFS gate)');
    const bands = Object.entries(m.octaveBandRmsDBFS).sort((a, b) => b[1] - a[1]);
    if (bands.length) bits.push(`peak band ${bands[0][0]}Hz`);
    if (m.onsets.perMinute != null) bits.push(`${m.onsets.perMinute} onsets/min`);
    const mm = (m.markerMetrics || []).filter(x => x.marginLU != null);
    if (mm.length && target.method !== 'offline') bits.push(`cue margin ${mm.map(x => `${x.marginLU > 0 ? '+' : ''}${x.marginLU}`).join('/')} LU`);
    if (m.voices?.maxConcurrentSources != null) bits.push(`≤${m.voices.maxConcurrentSources} voices`);
    if (m.stereo.sideToMidDB != null && m.stereo.sideToMidDB > -40) bits.push(`S/M ${m.stereo.sideToMidDB} dB`);
    else if (m.stereo.correlation != null && m.stereo.correlation > 0.999) bits.push('mono');
    return bits.join('; ');
}

// Phase 1 (cheap, safe during realtime capture): write the WAV and keep the
// scenario/capture data. Phase 2 (CPU heavy): analyse the WAV from disk, write
// JSON and PNG. Realtime captures defer phase 2 until every page has finished
// so analysis never competes with the audio threads.
function saveRender(outDir, target, cap, method) {
    const dir = path.join(outDir, target.category || 'adhoc');
    fs.mkdirSync(dir, { recursive: true });
    const base = path.join(dir, target.name);
    writeWavFloat(`${base}.wav`, cap.L, cap.R, cap.sampleRate);
    return {
        base, target, method, sampleRate: cap.sampleRate, duration: cap.L.length / cap.sampleRate,
        markers: cap.markers, voiceLog: cap.voiceLog, meta: cap.meta,
    };
}

async function finalizeRender(plotter, rec) {
    const { base, target, method } = rec;
    const wav = readWav(`${base}.wav`);
    const duration = wav.L.length / wav.sampleRate;
    const { metrics, plot } = analyze(wav.L, wav.R, wav.sampleRate, {
        markers: rec.markers,
        voiceLog: rec.voiceLog,
        voiceWindow: { start: 0, end: duration },
    });
    const json = {
        name: target.name,
        category: target.category,
        method,
        generatedAt: new Date().toISOString(),
        files: { wav: `${target.name}.wav`, png: `${target.name}.png` },
        target: summarizeTarget(target),
        capture: { sampleRate: rec.sampleRate, ...rec.meta },
        markers: rec.markers.map(m => ({ ...m, t: Number(m.t.toFixed(3)) })),
        metrics,
    };
    fs.writeFileSync(`${base}.json`, JSON.stringify(json, null, 2));
    await plotter.plot(`${base}.png`, {
        title: `${target.name}  [${target.category}]`,
        subtitle: subtitleFor(metrics, method, target.volumeStep ?? STANDARD_VOLUME_STEP),
        plot,
        markers: rec.markers,
        integrated: metrics.loudness.integratedLUFS,
    });
    return { name: target.name, category: target.category, method, duration, metrics, notable: notable(metrics, target, rec.meta) };
}

async function writeRender(plotter, outDir, target, cap, method) {
    return finalizeRender(plotter, saveRender(outDir, target, cap, method));
}

function subtitleFor(metrics, method, volumeStep) {
    const L = metrics.loudness;
    const duration = metrics.durationSeconds;
    return [
        [
            `${method}`, `${duration} s`, `step ${volumeStep}`,
            `LUFS-I ${L.integratedLUFS ?? '—'}`, `ST max ${L.shortTermMaxLUFS ?? '—'}`, `M max ${L.momentaryMaxLUFS ?? '—'}`,
            `LRA ${L.loudnessRangeLU ?? '—'} LU`, `TP ${metrics.peak.truePeakDBTP} dBTP`, `crest ${metrics.crestFactorDB} dB`,
        ].join('  ·  '),
        [
            `centroid ${metrics.spectralCentroidHz.mean ?? '—'}±${metrics.spectralCentroidHz.sd ?? '—'} Hz`,
            `onsets ${metrics.onsets.perMinute}/min`, `corr ${metrics.stereo.correlation}`, `S/M ${metrics.stereo.sideToMidDB} dB`,
            `bands ${Object.entries(metrics.octaveBandRmsDBFS).map(([k, v]) => `${k}:${Math.round(v)}`).join(' ')}`,
        ].join('  ·  '),
    ];
}

// --------------------------------------------------------------- index ----
function writeIndex(outRoot) {
    const rows = [];
    const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.json')) {
                try {
                    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
                    if (j.metrics) rows.push({ j, rel: path.relative(RENDERS, p) });
                } catch { /* skip */ }
            }
        }
    };
    if (fs.existsSync(outRoot)) walk(outRoot);
    const order = ['cues', 'cues-providers', 'cues-pan', 'layers', 'music-layer', 'bgm', 'mix', 'fidelity', 'adhoc', 'snippets'];
    rows.sort((a, b) => (order.indexOf(a.j.category) - order.indexOf(b.j.category)) || a.j.name.localeCompare(b.j.name));
    const lines = [
        '# ClaudeVille listening harness — render index',
        '',
        `Generated ${new Date().toISOString()} by \`node scripts/audio/audio-capture.mjs index\`. ${rows.length} renders.`,
        `All renders at the standard volume step ${STANDARD_VOLUME_STEP} unless the name says \`vol100\` (step 10, unity). Levels are measured at the`,
        'engine output (after the limiter and the volume), i.e. what the speaker receives. LUFS = BS.1770-4 integrated (gated); TP = 4x-oversampled',
        'true peak; crest = sample peak / RMS; centroid = mean±sd over active frames (> -70 dBFS). PNG/WAV/JSON share the base name.',
        '',
        '| target | category | method | dur s | LUFS-I | ST max | TP dBTP | crest dB | centroid Hz | notable |',
        '|---|---|---|---:|---:|---:|---:|---:|---:|---|',
    ];
    for (const { j, rel } of rows) {
        const m = j.metrics;
        const pngRel = rel.replace(/\.json$/, '.png');
        lines.push(`| [${j.name}](${pngRel}) | ${j.category} | ${j.method} | ${m.durationSeconds} | ${m.loudness.integratedLUFS ?? '—'} | ${m.loudness.shortTermMaxLUFS ?? '—'} | ${m.peak.truePeakDBTP} | ${m.crestFactorDB} | ${m.spectralCentroidHz.mean ?? '—'}±${m.spectralCentroidHz.sd ?? '—'} | ${notable(m, j.target || j, j.capture)} |`);
    }
    lines.push('');
    // Other render roots (A/B snippet runs) are listed, not tabulated.
    fs.mkdirSync(RENDERS, { recursive: true });
    const others = fs.readdirSync(RENDERS, { withFileTypes: true })
        .filter(e => e.isDirectory() && !['baseline', 'scratch'].includes(e.name)).map(e => e.name);
    if (others.length) {
        lines.push('## Other render sets', '');
        for (const name of others) lines.push(`- [\`${name}/\`](${name}/) — see its README.md or JSON sidecars`);
        lines.push('');
    }
    lines.push(`Reading guide, capture methods and fidelity limits: \`${path.join(AUDIO_DIR, 'README.md')}\`.`, '');
    fs.writeFileSync(path.join(RENDERS, 'INDEX.md'), lines.join('\n'));
    return rows.length;
}

// ----------------------------------------------------------------- pool ----
async function pool(items, jobs, fn) {
    const results = [];
    let next = 0;
    const workers = Array.from({ length: Math.min(jobs, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            try { results[i] = await fn(items[i], i); } catch (e) { results[i] = { error: e }; log(`FAIL ${items[i].name}: ${e.stack || e}`); }
        }
    });
    await Promise.all(workers);
    return results;
}

// ----------------------------------------------------------------- main ----
async function main() {
    const args = parseArgs(process.argv.slice(2));
    const cmd = args._[0];
    const targets = buildTargets();

    if (!cmd || cmd === 'help' || args.help) {
        console.log(fs.readFileSync(path.join(AUDIO_DIR, 'README.md'), 'utf8').split('\n').slice(0, 60).join('\n'));
        return;
    }
    if (cmd === 'list') {
        for (const t of targets) console.log(`${t.category.padEnd(15)} ${t.method.padEnd(9)} ${t.name}`);
        return;
    }
    if (cmd === 'index') {
        const n = writeIndex(path.resolve(args.out || path.join(RENDERS, 'baseline')));
        console.log(`INDEX.md: ${n} rows`);
        return;
    }

    const browser = await chromium.launch({ headless: true, args: HARNESS_CHROME_ARGS });
    const plotter = await openPlotter(browser);
    let server = null;
    try {
        if (cmd === 'analyze') {
            const file = args._[1];
            if (!file) throw new Error('usage: analyze file.wav [--markers m.json] [--out dir]');
            const wav = readWav(file);
            const markers = args.markers ? JSON.parse(fs.readFileSync(args.markers, 'utf8')) : [];
            const name = path.basename(file).replace(/\.wav$/i, '');
            const outDir = path.resolve(args.out || path.dirname(file));
            fs.mkdirSync(outDir, { recursive: true });
            const { metrics, plot } = analyze(wav.L, wav.R, wav.sampleRate, { markers });
            fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify({ name, category: 'adhoc', method: 'analyze', source: path.resolve(file), markers, metrics }, null, 2));
            await plotter.plot(path.join(outDir, `${name}.png`), {
                title: `${name}  [analyze]`,
                subtitle: `${metrics.durationSeconds} s · LUFS-I ${metrics.loudness.integratedLUFS} · TP ${metrics.peak.truePeakDBTP} dBTP · crest ${metrics.crestFactorDB} dB · centroid ${metrics.spectralCentroidHz.mean} Hz`,
                plot, markers, integrated: metrics.loudness.integratedLUFS,
            });
            console.log(JSON.stringify({ json: path.join(outDir, `${name}.json`), png: path.join(outDir, `${name}.png`), loudness: metrics.loudness, peak: metrics.peak }, null, 2));
            return;
        }

        if (cmd === 'replot') {
            // Re-analyse every WAV under a render root from disk and redraw its PNG
            // (after an analysis/plot upgrade). Scenario, capture and voice data are kept.
            const root = path.resolve(args.out || path.join(RENDERS, 'baseline'));
            const jsons = [];
            const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.json')) jsons.push(p); } };
            walk(root);
            for (const file of jsons) {
                const j = JSON.parse(fs.readFileSync(file, 'utf8'));
                const wavFile = file.replace(/\.json$/, '.wav');
                if (!j.metrics || !fs.existsSync(wavFile)) continue;
                const wav = readWav(wavFile);
                const { metrics, plot } = analyze(wav.L, wav.R, wav.sampleRate, { markers: j.markers || [] });
                metrics.voices = j.metrics.voices ?? null;
                j.metrics = metrics;
                j.analyzedFrom = 'wav16';
                fs.writeFileSync(file, JSON.stringify(j, null, 2));
                await plotter.plot(file.replace(/\.json$/, '.png'), {
                    title: `${j.name}  [${j.category}]`,
                    subtitle: subtitleFor(metrics, j.method, j.target?.volumeStep ?? STANDARD_VOLUME_STEP),
                    plot, markers: j.markers || [], integrated: metrics.loudness.integratedLUFS,
                });
            }
            if (root.startsWith(path.join(RENDERS, 'baseline'))) writeIndex(path.join(RENDERS, 'baseline'));
            console.log(`replotted ${jsons.length} renders under ${root}`);
            return;
        }

        server = await startStaticServer();
        const snippetUrl = args.snippet ? server.registerSnippet(args.snippet) : null;

        if (cmd === 'snippet') {
            if (!snippetUrl) throw new Error('usage: snippet --snippet file.js [--seconds N] [--offline]');
            const name = args.name || path.basename(args.snippet).replace(/\.m?js$/, '');
            const seconds = Number(args.seconds || 8);
            const outDir = path.resolve(args.out || path.join(RENDERS, 'scratch'));
            const h = await openHarness(browser, server.baseUrl, args.seed ?? DEFAULT_SEED);
            let cap;
            try {
                const res = await h.page.evaluate(o => window.__har.runSnippet(o), { url: snippetUrl, seconds, offline: Boolean(args.offline), volumeStep: Number(args['volume-step'] ?? STANDARD_VOLUME_STEP) });
                let L, R, sr, start, gapInfo = null;
                if (res.offline) {
                    ({ L, R } = await pullPcm(h.page, res.frames * 2));
                    sr = res.sampleRate; start = 0;
                } else {
                    const info = await h.page.evaluate(() => window.__harTap.collect());
                    const pcm = await pullPcm(h.page, info.frames * 2);
                    sr = info.sampleRate;
                    start = Math.max(res.recStart, info.firstFrame / sr);
                    const cut = cutWindow(info, pcm, start, res.recEnd, res.markers, null);
                    L = cut.L; R = cut.R;
                    res.markers = cut.markers.map(m => ({ ...m, t: m.t + start }));
                    gapInfo = cut.gapInfo;
                }
                const voiceLog = await readVoiceLog(h.page);
                cap = {
                    L, R, sampleRate: sr, windowStart: start,
                    markers: res.markers.filter(m => m.t != null && !/^rec-/.test(m.label)).map(m => ({ kind: 'event', ...m, t: m.t - start })),
                    voiceLog: voiceLog.map(v => ({ s: v.s - start, e: v.e == null ? null : v.e - start, k: v.k })),
                    meta: { snippet: path.resolve(args.snippet), offline: res.offline, ...(gapInfo || {}), pageErrors: h.errors },
                };
            } finally {
                await h.context.close();
            }
            const target = { name, category: 'snippets', method: cap.meta.offline ? 'offline' : 'realtime', volumeStep: Number(args['volume-step'] ?? STANDARD_VOLUME_STEP) };
            const row = await writeRender(plotter, outDir, target, cap, `snippet-${target.method}`);
            console.log(JSON.stringify({ out: path.join(outDir, 'snippets', name), loudness: row.metrics.loudness, peak: row.metrics.peak, notable: row.notable, pageErrors: cap.meta.pageErrors }, null, 2));
            return;
        }

        let selected = cmd === 'all'
            ? targets
            : targets.filter(t => t.name === cmd || t.category === cmd || (cmd.endsWith('*') && t.name.startsWith(cmd.slice(0, -1))));
        if (!selected.length) throw new Error(`unknown target "${cmd}" — run "list"`);
        if (args.name && selected.length === 1) selected = [{ ...selected[0], name: String(args.name) }];
        if (snippetUrl && selected.some(t => t.method !== 'realtime')) throw new Error('--snippet with a target needs a realtime target (use the "snippet" command for standalone renders)');
        const outDir = path.resolve(args.out || (cmd === 'all' ? path.join(RENDERS, 'baseline') : path.join(RENDERS, 'scratch')));
        const jobs = Number(args.jobs || 6);
        const opts = { seconds: args.seconds, seed: args.seed != null ? Number(args.seed) : undefined, snippetUrl };
        const t0 = Date.now();
        const rows = [];

        const offline = selected.filter(t => t.method === 'offline');
        const realtime = selected.filter(t => t.method === 'realtime');
        const app = selected.filter(t => t.method === 'app');

        // Offline cues: one page, sequential (each render is milliseconds).
        const offlineRun = async () => {
            if (!offline.length) return;
            const h = await openHarness(browser, server.baseUrl, opts.seed ?? DEFAULT_SEED);
            try {
                for (const t of offline) {
                    const target = opts.seconds ? { ...t, seconds: Number(opts.seconds) } : t;
                    const cap = await captureOffline(h.page, target);
                    rows.push(await writeRender(plotter, outDir, target, cap, 'offline'));
                    log(`offline  ${t.name}  LUFS-I ${rows.at(-1).metrics.loudness.integratedLUFS}`);
                }
                if (h.errors.length) log(`offline page errors: ${h.errors.slice(0, 5).join(' | ')}`);
            } finally {
                await h.context.close();
            }
        };

        // Realtime: longest first, N pages in parallel.
        const est = t => (t.warmup ?? 0) + (t.seconds ?? 0) + (t.bgm ? 120 : 0) + (t.music ? 100 : 0);
        const ordered = [...realtime].sort((a, b) => est(b) - est(a));
        const pending = [];
        const realtimeRun = pool(ordered, jobs, async (t) => {
            log(`realtime start ${t.name}`);
            const cap = await captureRealtime(browser, server, t, opts);
            pending.push(saveRender(outDir, t, cap, 'realtime'));
            log(`realtime captured ${t.name}  ${(cap.L.length / cap.sampleRate).toFixed(1)} s  gaps ${cap.meta.gaps} (${cap.meta.droppedFrames} frames)${cap.meta.timedOut ? '  TIMED OUT' : ''}${cap.meta.pageErrors?.length ? `  errors: ${cap.meta.pageErrors.slice(0, 3).join(' | ')}` : ''}`);
        });

        await realtimeRun;
        for (const rec of pending) {
            const row = await finalizeRender(plotter, rec);
            rows.push(row);
            log(`analysed ${row.name}  LUFS-I ${row.metrics.loudness.integratedLUFS}`);
        }
        await offlineRun();
        for (const t of app) {
            log(`app start ${t.name}`);
            const cap = await captureApp(browser, t);
            rows.push(await writeRender(plotter, outDir, t, cap, 'app-realtime'));
            log(`app done ${t.name} LUFS-I ${rows.at(-1).metrics.loudness.integratedLUFS} framePressure ${cap.meta.finalState?.framePressureLevel}`);
        }
        if (outDir.startsWith(path.join(RENDERS, 'baseline'))) writeIndex(path.join(RENDERS, 'baseline'));
        log(`${rows.length}/${selected.length} renders in ${((Date.now() - t0) / 1000).toFixed(0)} s → ${outDir}`);
    } finally {
        await plotter.close().catch(() => {});
        await browser.close();
        if (server) await server.close();
    }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
