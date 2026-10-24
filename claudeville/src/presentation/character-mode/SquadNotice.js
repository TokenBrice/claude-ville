// D7 — heads turn. When a villager takes its celebrate pose for a verified
// commit, push, release or mend, nearby villagers of the same repository who
// are sitting or waiting in place turn to face it for the 5 s window, then
// turn back. A shared repository is a real relationship and facing makes no
// claim, so nothing here invents a fact; walking or working bodies never turn.

import { eventBus } from '../../domain/events/DomainEvent.js';
import { VERIFIED_OUTCOME_EVENT } from '../../domain/services/VerifiedOutcome.js';
import { VERIFIED_CELEBRATION_MS } from './ActionVocabulary.js';
import { worldToTile } from './Projection.js';
import { noteMoment } from './MomentTally.js';

export const SQUAD_NOTICE_RADIUS_TILES = 8;
export const SQUAD_NOTICE_CAP = 6;
const NOTICED_KINDS = new Set(['commit', 'push', 'release', 'mended']);

function repoKey(agent) {
    return String(agent?.repoRoot || agent?.projectPath || '').trim();
}

function departed(agent) {
    return agent?.isDeparted === true || (agent?.departedAt != null && Number.isFinite(Number(agent.departedAt)));
}

/**
 * Pure: the sprites that turn toward `celebrant` — same repository, holding
 * a seat or queue place (`_holdsRestPlace`), within the radius, nearest
 * first, at most `cap`.
 */
export function squadWatchers(celebrant, sprites, {
    radiusTiles = SQUAD_NOTICE_RADIUS_TILES,
    cap = SQUAD_NOTICE_CAP,
} = {}) {
    const repo = repoKey(celebrant?.agent);
    if (!repo || !Number.isFinite(celebrant?.x) || !Number.isFinite(celebrant?.y)) return [];
    const origin = worldToTile(celebrant.x, celebrant.y);
    const near = [];
    for (const sprite of sprites || []) {
        if (!sprite || sprite === celebrant || !sprite.agent || departed(sprite.agent)) continue;
        if (repoKey(sprite.agent) !== repo) continue;
        if (typeof sprite._holdsRestPlace !== 'function' || !sprite._holdsRestPlace()) continue;
        if (!Number.isFinite(sprite.x) || !Number.isFinite(sprite.y)) continue;
        const tile = worldToTile(sprite.x, sprite.y);
        const distance = Math.hypot(tile.tileX - origin.tileX, tile.tileY - origin.tileY);
        if (distance <= radiusTiles) near.push({ sprite, distance });
    }
    near.sort((a, b) => a.distance - b.distance);
    return near.slice(0, cap).map(entry => entry.sprite);
}

/**
 * Listen for verified outcomes and turn the watchers. `getSprites()` returns
 * the live `agentSprites` Map. Returns the unsubscribe.
 */
export function bindSquadNotice(getSprites, { eventTarget = eventBus, onNotice = null } = {}) {
    return eventTarget.on(VERIFIED_OUTCOME_EVENT, (outcome) => {
        if (!outcome?.agentId || !NOTICED_KINDS.has(outcome.kind)) return;
        const sprites = getSprites?.();
        const celebrant = sprites?.get?.(String(outcome.agentId));
        if (!celebrant) return;
        const until = Number(outcome.at) + VERIFIED_CELEBRATION_MS;
        if (!Number.isFinite(until) || until <= Date.now()) return;
        const watchers = squadWatchers(celebrant, sprites.values());
        for (const sprite of watchers) sprite.noticeSquadmate?.({ x: celebrant.x, y: celebrant.y }, until);
        if (watchers.length) {
            noteMoment('heads-turn');
            onNotice?.(watchers.length);
        }
    });
}
