// Compatibility re-export barrel for legacy callers of BelfryQuota.js.
// The canonical 4-provider weekly quota model lives in QuotaTerrace.js.

import {
    QUOTA_PILLAR_DRAIN_MS,
    QUOTA_PILLAR_LEVELS,
    QUOTA_TERRACE_PROVIDERS,
    quotaDrainStep,
    quotaDraining,
    quotaPillarKey,
    quotaPillarLevel,
    quotaPillarReading,
    quotaPillarReadings,
    quotaPillarTooltip,
} from './QuotaTerrace.js';

export {
    QUOTA_PILLAR_DRAIN_MS,
    QUOTA_PILLAR_LEVELS,
    QUOTA_TERRACE_PROVIDERS,
    quotaDrainStep,
    quotaDraining,
    quotaPillarKey,
    quotaPillarLevel,
    quotaPillarReading,
    quotaPillarReadings,
    quotaPillarTooltip,
};

export const BELFRY_LEVELS = QUOTA_PILLAR_LEVELS;
export const BELFRY_ACCOUNTS = QUOTA_TERRACE_PROVIDERS;
export const BELFRY_DRAIN_MS = QUOTA_PILLAR_DRAIN_MS;
export const belfryLevel = quotaPillarLevel;
export const belfryGlass = quotaPillarReading;
export const belfryGlasses = quotaPillarReadings;
export const belfryDrainStep = quotaDrainStep;
export const belfryDraining = quotaDraining;
export const belfryGlassKey = quotaPillarKey;
export const belfryTooltip = (usage, now = Date.now(), provider = 'claude') => quotaPillarTooltip(provider, usage, now);
