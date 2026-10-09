import { worldToTile } from './Projection.js';

// W7.11 (SW-P14) — VillageDirector work cohorts and crowd cells are one
// system. A body standing (not walking) within COHORT_REACH_TILES of the
// building its cohort works at joins that building's ONE cohort cluster
// instead of a grid cell, so a busy building reads as one aura and one tab
// with an exact count; everyone else (walkers, plaza crowds, members far from
// their building) buckets into cells exactly as before.
export const COHORT_MIN_MEMBERS = 2;
export const COHORT_REACH_TILES = 6;

function cohortSites(cohorts) {
    const byAgent = new Map();
    for (const cohort of Array.isArray(cohorts) ? cohorts : []) {
        if (!cohort?.type || !Array.isArray(cohort.agentIds)) continue;
        const center = cohort.center;
        if (!Number.isFinite(center?.x) || !Number.isFinite(center?.y)) continue;
        const tile = worldToTile(center.x, center.y);
        const site = { id: `cohort:${cohort.type}`, type: cohort.type, tileX: tile.tileX, tileY: tile.tileY };
        for (const agentId of cohort.agentIds) byAgent.set(agentId, site);
    }
    return byAgent;
}

function cohortSiteFor(entry, sites, tileX, tileY) {
    if (!sites.size || entry?.moving || entry?.agentId == null) return null;
    const site = sites.get(entry.agentId);
    if (!site) return null;
    return Math.hypot(tileX - site.tileX, tileY - site.tileY) <= COHORT_REACH_TILES ? site : null;
}

export function dominantCountKey(counts) {
    let bestKey = null;
    let bestCount = -1;
    for (const [key, count] of Object.entries(counts || {})) {
        if (count > bestCount || (count === bestCount && key.localeCompare(bestKey || '') < 0)) {
            bestKey = key;
            bestCount = count;
        }
    }
    return bestKey;
}

export function summarizeCrowdClusterEntries(entries, {
    cellSize = 4,
    topLimit = 12,
    includeStatusCounts = false,
    includeDominantProvider = false,
    includeTeamCount = true,
    cohorts = null,
} = {}) {
    const list = Array.isArray(entries) ? entries : [];
    if (list.length === 0) {
        return {
            clusters: [],
            minClusterSize: 3,
            maxClusterSize: 0,
            congestedAgents: 0,
        };
    }

    const size = Math.max(1, Number(cellSize) || 4);
    const sites = cohortSites(cohorts);
    const siteCounts = new Map();
    if (sites.size) {
        for (const entry of list) {
            const site = cohortSiteFor(entry, sites, Number(entry?.tileX), Number(entry?.tileY));
            if (site) siteCounts.set(site.id, (siteCounts.get(site.id) || 0) + 1);
        }
    }
    const groups = new Map();
    for (const entry of list) {
        const tileX = Number(entry?.tileX);
        const tileY = Number(entry?.tileY);
        if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) continue;
        const site = cohortSiteFor(entry, sites, tileX, tileY);
        const cohort = site && (siteCounts.get(site.id) || 0) >= COHORT_MIN_MEMBERS ? site : null;
        const cellX = Math.floor(tileX / size);
        const cellY = Math.floor(tileY / size);
        const key = cohort ? cohort.id : `${cellX},${cellY}`;
        let group = groups.get(key);
        if (!group) {
            group = {
                id: key,
                cellX,
                cellY,
                cohort: cohort?.type || null,
                agentIds: cohort ? [] : null,
                count: 0,
                moving: 0,
                sumTileX: 0,
                sumTileY: 0,
                statuses: {},
                providers: {},
                teams: new Set(),
            };
            groups.set(key, group);
        }
        group.count++;
        if (entry.moving) group.moving++;
        group.sumTileX += tileX;
        group.sumTileY += tileY;
        if (group.agentIds) group.agentIds.push(entry.agentId);
        const status = entry.status || 'unknown';
        group.statuses[status] = (group.statuses[status] || 0) + 1;
        if (entry.provider) {
            const provider = entry.provider || 'unknown';
            group.providers[provider] = (group.providers[provider] || 0) + 1;
        }
        if (entry.teamName) group.teams.add(entry.teamName);
    }

    const minClusterSize = list.length >= 90 ? 6 : list.length >= 50 ? 5 : 3;
    const clusters = Array.from(groups.values())
        .filter(group => (group.cohort ? group.count >= COHORT_MIN_MEMBERS : group.count >= minClusterSize))
        .map(group => {
            const cluster = {
                id: group.id,
                tileX: group.sumTileX / group.count,
                tileY: group.sumTileY / group.count,
                count: group.count,
                moving: group.moving,
                dominantStatus: dominantCountKey(group.statuses),
            };
            if (group.cohort) {
                cluster.kind = 'cohort';
                cluster.building = group.cohort;
                cluster.agentIds = group.agentIds.sort();
            }
            if (includeStatusCounts) cluster.statuses = group.statuses;
            if (includeDominantProvider) cluster.dominantProvider = dominantCountKey(group.providers);
            if (includeTeamCount) cluster.teamCount = group.teams.size;
            return cluster;
        })
        .sort((a, b) => (b.count - a.count) || a.id.localeCompare(b.id))
        .slice(0, Math.max(0, Number(topLimit) || 0));

    // Congestion stays the dense-crowd measure: a two-body cohort at its
    // building is a working group, not a jam.
    let maxClusterSize = 0;
    let congestedAgents = 0;
    for (const cluster of clusters) {
        if (cluster.count < minClusterSize) continue;
        maxClusterSize = Math.max(maxClusterSize, cluster.count);
        congestedAgents += cluster.count;
    }
    return {
        clusters,
        minClusterSize,
        maxClusterSize,
        congestedAgents,
    };
}
