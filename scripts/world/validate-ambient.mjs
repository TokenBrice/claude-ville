import assert from 'node:assert/strict';
import { WildlifeRenderer, songbirdBudget, fireflyBudget, ashMoteBudget, dragonflyBudget } from '../../claudeville/src/presentation/character-mode/WildlifeRenderer.js';
import { SeasonalAmbience, seasonalDriftCap, seasonTokenForMonth } from '../../claudeville/src/presentation/character-mode/SeasonalAmbience.js';
import { ambientGates, createAmbientScheduler, AMBIENT_TIERS } from '../../claudeville/src/presentation/character-mode/AmbientEvents.js';
import { CALM_WATER_FAUNA, SHORE_FAUNA } from '../../claudeville/src/config/scenery.js';

// This is an eligibility census at a settled, fully loaded wide shot, not a
// screenshot count: camera culling, asset loading and particle spawn latency
// do not change whether a class is allowed to live. No renderer or DOM boots.
const HOURS = [{ label: 'dawn', hour: 6, phase: 'dawn' }, { label: 'noon', hour: 12, phase: 'day' }, { label: 'dusk', hour: 19, phase: 'dusk' }, { label: 'night', hour: 23, phase: 'night' }];
const MONTHS = [{ label: 'Jan', month: 0 }, { label: 'Apr', month: 3 }, { label: 'Jul', month: 6 }, { label: 'Oct', month: 9 }];
const WEATHER = [{ label: 'clear', type: 'clear', cloudCover: 0.1 }, { label: 'partly', type: 'partly-cloudy', cloudCover: 0.42 }, { label: 'overcast', type: 'overcast', cloudCover: 0.9 }, { label: 'rain', type: 'rain', cloudCover: 0.95 }];
const scheduler = createAmbientScheduler();
const rows = [];
for (const { label: seasonLabel, month } of MONTHS) {
    for (const { label: hourLabel, hour, phase } of HOURS) {
        for (const spec of WEATHER) {
            const date = new Date(2026, month, 15, hour);
            const weather = { ...spec, nextType: spec.type, transitionProgress: 0, precipitation: spec.type === 'rain' ? 0.7 : 0 };
            const atmosphere = { phase, clock: { date }, effectiveDate: date, weather };
            const context = { zoom: 1, weatherType: spec.type, phase, motionScale: 1, month, approach: ambientGates({ weather, phase }).approach };
            // Resolve existing gate methods on isolated objects with injected
            // providers: no draw/update/particle allocation or browser is needed.
            const wildlife = new WildlifeRenderer({ motionScale: 1, camera: { zoom: 1 }, _lastAtmosphere: atmosphere });
            const gullPlan = wildlife._gullPlan();
            const drift = new SeasonalAmbience({ cameraGetter: () => ({ zoom: 1 }), atmosphereStateGetter: () => atmosphere });
            const events = scheduler.at(date, { weather, phase, season: seasonTokenForMonth(month), motionScale: 1, level: 0, calm: false });
            const caps = {
                gulls: gullPlan.flying ? Math.min(gullPlan.cap, wildlife._gullActiveBand()[0]) : gullPlan.lighthouse ? 1 : gullPlan.roost ? 4 : 0,
                songbirds: songbirdBudget(context).cap,
                fireflies: fireflyBudget(context).cap,
                ashMotes: ashMoteBudget(context).cap,
                dragonflies: dragonflyBudget({ ...context, level: 0, calm: false }).cap,
                drift: drift._driftSeason() ? seasonalDriftCap(1) : 0,
                waterfowl: (spec.type === 'storm' ? 0 : CALM_WATER_FAUNA.length) + SHORE_FAUNA.length,
                loneCloud: AMBIENT_TIERS.some(tier => events[tier]?.kind === 'lone-cloud' && date.getTime() >= events[tier].startMs && date.getTime() < events[tier].endMs) ? 1 : 0,
            };
            const live = Object.entries(caps).filter(([, cap]) => cap > 0).map(([name]) => name);
            // Gulls (the lighthouse bird at night) and waterfowl are persistent
            // even in January. Rain permits sheltering waterfowl and fewer gulls;
            // its deliberately weaker floor is one. Seasonal/event life is bonus.
            const minimum = spec.type === 'rain' ? 1 : 2;
            assert.ok(live.length >= minimum, `${seasonLabel} ${hourLabel} ${spec.label}: ${live.length} classes < ${minimum}; ${JSON.stringify(caps)}`);
            assert.equal(caps.fireflies, month >= 3 && month <= 9 && (phase === 'dusk' || phase === 'night') && spec.type !== 'rain' ? 12 : 0);
            assert.equal(caps.ashMotes, phase === 'night' ? 12 : 0, 'ash motes live year-round, including rainy nights');
            rows.push({ season: seasonLabel, hour: hourLabel, weather: spec.label, classes: live.length, minimum, live: live.join(', '), frequent: events.frequent?.kind || events.held.frequent });
        }
    }
}
console.table(rows);
console.log(`PASS: ${rows.length} ambient eligibility cases at zoom 1 (FULL motion; clear/partly/overcast >= 2 classes, rain >= 1).`);
