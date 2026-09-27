// The invite at the moment of need (plan 7.5, UX-6). Sound stays opt-in and
// off by default; instead, the first time an agent needs the operator while
// sound is off — on a page that has been open at least two minutes and is
// visible — the attention notice carries a one-time offer to turn on Signals.
// Accepting plays the call of the family that triggered it. The offer is made
// at most once per profile: showing it records the profile as invited.
// Pure and DOM-free: storage, visibility, uptime and sound state come in.

import { actionableFamily, attentionStatus, familyCueKind } from './audio/ActionableRouting.js';
import { readSoundInvited, writeSoundInvited } from './SoundSettings.js';

// The page must have been open this long: an offer in the first moments of a
// visit is an ambush, not help.
export const INVITE_MIN_UPTIME_MS = 120_000;
// The offer waits for an answer, but never longer than this.
export const INVITE_MAX_SHOW_MS = 20_000;

export const SOUND_INVITE_COPY = Object.freeze({
    prompt: 'Want a bell for moments like this?',
    accept: 'TURN ON SIGNALS',
    decline: 'NO THANKS',
});

/**
 * What an `attention:raised` payload would ring: the SignalLedger family and
 * its entry voice (`summons | distress | limit`), plus the agent.
 */
export function inviteTrigger(payload) {
    const family = actionableFamily(attentionStatus(payload));
    const agentId = payload?.agentId ?? payload?.agent?.id ?? null;
    return { bucket: familyCueKind(family), family, agentId };
}

/** Pure eligibility: every condition of 7.5 at once. */
export function inviteEligible({ soundOn, visible, uptimeMs, invited, offered }) {
    return soundOn !== true
        && visible === true
        && Number(uptimeMs) >= INVITE_MIN_UPTIME_MS
        && invited !== true
        && offered !== true;
}

/**
 * One session's invite. `offer(payload, conditions)` returns the trigger to
 * show with the notice, or null. The first offer of a session is the only
 * one, and it marks the profile invited before it is shown, so a reload, a
 * second listener or an unanswered offer never asks again.
 */
export class SoundInvite {
    constructor({ storage = globalThis.window?.localStorage } = {}) {
        this._storage = storage;
        this._offered = false;
    }

    get offered() {
        return this._offered;
    }

    offer(payload, { soundOn = false, visible = false, uptimeMs = 0 } = {}) {
        if (!inviteEligible({
            soundOn,
            visible,
            uptimeMs,
            invited: readSoundInvited(this._storage),
            offered: this._offered,
        })) return null;
        this._offered = true;
        writeSoundInvited(this._storage);
        return inviteTrigger(payload);
    }
}
