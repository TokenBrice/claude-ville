// Node side of the virtual-clock renderer (HAR-1, page/virtual.js): one fresh
// page per scene (module singletons such as the cue score and the governor
// start clean), the scene rendered on an OfflineAudioContext with the clock
// stepped, then the program and every requested stem pulled out as float PCM.
import fs from 'node:fs';
import path from 'node:path';
import { AUDIO_DIR } from './server.mjs';
import { newHarnessPage, pullPcm, readHazards } from './capture.mjs';

const VIRTUAL_CLOCK_JS = fs.readFileSync(path.join(AUDIO_DIR, 'page/virtual-clock.js'), 'utf8');

async function openVirtual(browser, baseUrl, seed) {
    const h = await newHarnessPage(browser, seed, undefined, [VIRTUAL_CLOCK_JS]);
    await h.page.goto(`${baseUrl}/__har/virtual.html`);
    await h.page.waitForFunction(() => window.__vcReady === true, null, { timeout: 20000 });
    return h;
}

async function pullAll(page, res) {
    const out = {};
    for (const name of res.names) {
        const frames = await page.evaluate(n => window.__vcRender.stage(n), name);
        out[name] = await pullPcm(page, frames * 2, '__vcStage');
    }
    await page.evaluate(() => { window.__vcStage = null; });
    return out;
}

// → { sr, program: {L, R}, stems: {name: {L, R}}, meta, hazards, errors }
export async function renderVirtual(browser, baseUrl, spec, { seed }) {
    const h = await openVirtual(browser, baseUrl, seed);
    try {
        const meta = await h.page.evaluate(s => window.__vcRender.runVirtual(s), spec);
        const pcm = await pullAll(h.page, meta);
        const { program, ...stems } = pcm;
        const hazards = await readHazards(h.page);
        return { sr: meta.sampleRate, program, stems, meta, hazards, errors: [...h.errors, ...meta.clock.errors] };
    } finally {
        await h.context.close();
    }
}

export async function renderEngineUnit(browser, baseUrl, spec, { seed }) {
    const h = await openVirtual(browser, baseUrl, seed);
    try {
        const meta = await h.page.evaluate(s => window.__vcRender.runEngineUnit(s), spec);
        const pcm = await pullAll(h.page, meta);
        const { program, ...stems } = pcm;
        return { sr: meta.sampleRate, program, stems, meta, errors: h.errors };
    } finally {
        await h.context.close();
    }
}

// Island Air unit (page/virtual.js runAirUnit): the baked IRs plus the dry
// and wet taps of placed bursts. IR pairs keep their own sample rate.
export async function renderAirUnit(browser, baseUrl, spec, { seed }) {
    const h = await openVirtual(browser, baseUrl, seed);
    try {
        const meta = await h.page.evaluate(s => window.__vcRender.runAirUnit(s), spec);
        const pcm = await pullAll(h.page, meta);
        const { program, irDay, irNight, ...stems } = pcm;
        return { sr: meta.sampleRate, program, stems, irs: { day: irDay, night: irNight }, irRates: meta.irRates, meta, errors: h.errors };
    } finally {
        await h.context.close();
    }
}
