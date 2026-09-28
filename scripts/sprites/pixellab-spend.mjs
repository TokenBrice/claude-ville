// Guarded PixelLab spend for the REST generation tools: every paid job reads
// the live balance before and after, refuses to start when its worst-case
// cost would cross the caller's floor, and appends one JSON line to the spend
// ledger. The token is read by pixellab-rest.mjs and never printed or logged.
//
// Ledger line: { ts, agent, item, endpoint, target, generationsBefore,
//                generationsAfter, spent, outcome, detail? }
//
// Usage:
//   const spend = createSpend({ token, agent: 'AssetsA', floor: 1172 });
//   const result = await spend.job({ item: '7.3', endpoint: '/animate-with-skeleton-v3',
//       target: 'agent.claude.sonnet east', maxCost: 4, run: () => api(token, '/…', { … }) });

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { API_BASE, getBalance, repoRoot, sleep } from './pixellab-rest.mjs';

export const DEFAULT_LEDGER = join(repoRoot, 'output', 'waking-isle', 'pixellab-ledger.jsonl');
// The maintainer's global floor (plan M10: 1,000 of 1,272 may be spent).
export const GLOBAL_FLOOR = 272;

// One authenticated REST call. 429 "concurrent background jobs" waits for a
// job slot (the account's 8 slots are shared); other non-2xx statuses throw
// with the endpoint's JSON body (never the request headers).
export async function api(token, path, { method = 'GET', body = null, label = path, slotWaitMs = 30_000, slotAttempts = 20 } = {}) {
    for (let attempt = 1; ; attempt++) {
        const response = await fetch(`${API_BASE}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const json = await response.json().catch(() => null);
        if (response.ok) return json;
        const busy = response.status === 429 && /concurrent/i.test(JSON.stringify(json));
        if (busy && attempt < slotAttempts) {
            console.log(`[pixellab] ${label}: job slots busy, retrying in ${slotWaitMs / 1000}s`);
            await sleep(slotWaitMs);
            continue;
        }
        const error = new Error(`PixelLab ${response.status} for ${label}: ${JSON.stringify(json)?.slice(0, 600)}`);
        error.status = response.status;
        throw error;
    }
}

// Poll GET /background-jobs/{id} until it completes or fails.
export async function waitForBackgroundJob(token, jobId, { label = jobId, pollMs = 8000, maxWaitMs = 15 * 60 * 1000 } = {}) {
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
        const job = await api(token, `/background-jobs/${jobId}`, { label: `job ${label}` });
        const status = job?.status || job?.data?.status;
        if (status === 'completed') return job;
        if (status === 'failed' || status === 'error' || status === 'cancelled') {
            throw new Error(`background job ${label} ${status}: ${JSON.stringify(job?.error || job?.last_response || job).slice(0, 400)}`);
        }
        if (Date.now() > deadline) throw new Error(`background job ${label} still ${status} after ${maxWaitMs / 60000} min`);
        await sleep(pollMs);
    }
}

export function generationsOf(balance) {
    return Number(balance?.subscription?.generations);
}

export function createSpend({ token, agent, floor = GLOBAL_FLOOR, ledgerPath = DEFAULT_LEDGER, dryRun = false }) {
    const effectiveFloor = Math.max(GLOBAL_FLOOR, Number(floor));
    const record = (line) => {
        mkdirSync(dirname(ledgerPath), { recursive: true });
        appendFileSync(ledgerPath, `${JSON.stringify(line)}\n`);
    };
    return {
        floor: effectiveFloor,
        async balance() {
            return generationsOf(await getBalance(token));
        },
        // `run` performs the paid request (and, for async endpoints, waits for
        // it) and returns its result; `settle` optionally waits for the charge
        // to post before the after-balance read.
        async job({ item, endpoint, target, maxCost, run, detail = null }) {
            const before = generationsOf(await getBalance(token));
            if (!Number.isFinite(before)) throw new Error('balance unreadable; refusing to spend');
            if (before - maxCost < effectiveFloor) {
                const line = { ts: new Date().toISOString(), agent, item, endpoint, target, generationsBefore: before, generationsAfter: before, spent: 0, outcome: `refused: worst case ${maxCost} would cross floor ${effectiveFloor}` };
                record(line);
                throw new Error(`[spend] ${target}: ${line.outcome} (balance ${before})`);
            }
            if (dryRun) {
                console.log(`[spend] dry run ${endpoint} ${target}: worst case ${maxCost}, balance ${before}, floor ${effectiveFloor}`);
                return null;
            }
            let result = null;
            let outcome = 'ok';
            let failure = null;
            try {
                result = await run();
            } catch (err) {
                failure = err;
                outcome = `error: ${err.message.slice(0, 300)}`;
            }
            const after = generationsOf(await getBalance(token));
            // The balance can post a charge late or include a concurrent job's
            // charge; the endpoint's own `usage` is the per-job truth.
            const usage = result?.usage?.generations ?? null;
            const spent = Math.round((before - after) * 100) / 100;
            const line = { ts: new Date().toISOString(), agent, item, endpoint, target, generationsBefore: before, generationsAfter: after, spent, charged: usage, outcome };
            if (detail) line.detail = detail;
            if (result && typeof result === 'object' && result.ledgerDetail) line.detail = { ...(line.detail || {}), ...result.ledgerDetail };
            record(line);
            console.log(`[spend] ${endpoint} ${target}: ${outcome}; balance ${before} → ${after} (spent ${spent}, charged ${usage ?? 'n/a'})`);
            if (failure) throw failure;
            return result;
        },
    };
}
