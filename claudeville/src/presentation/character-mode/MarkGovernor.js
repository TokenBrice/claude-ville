export const MarkTier = Object.freeze({ PRIMARY: 'primary', RECENT: 'recent', WORKING: 'working', SECONDARY: 'working', AMBIENT: 'ambient' });
export const SALIENCE_ORDER = Object.freeze([MarkTier.PRIMARY, MarkTier.RECENT, MarkTier.WORKING, MarkTier.AMBIENT]);
const POLICY = Object.freeze({ primary: { alphaCap: 1, soft: Infinity, hard: Infinity }, recent: { alphaCap: .92, soft: 4, hard: 8 }, working: { alphaCap: .78, soft: 3, hard: 7 }, ambient: { alphaCap: .5, soft: 2, hard: 5 } });
const DEFAULT_REGION_SIZE = 200;

export function salienceTierFor({ selected = false, status = '', recent = false, working = false } = {}) {
    if (selected || ['waiting_on_user', 'errored', 'rate_limited'].includes(status)) return MarkTier.PRIMARY;
    if (recent) return MarkTier.RECENT;
    if (working || status === 'working' || status === 'waiting') return MarkTier.WORKING;
    return MarkTier.AMBIENT;
}

export function calculateScenePressure({ sprites = [], viewport = {}, zoom = 1, overlayArea = 0, collisions = 0 } = {}) {
    const area = Math.max(1, Number(viewport.width) * Number(viewport.height) || 1);
    const z = Math.max(1, Number(zoom) || 1);
    let spriteArea = 0;
    for (const sprite of sprites || []) {
        if (!sprite || sprite.isArrivalPending?.()) continue;
        spriteArea += (Number(sprite.projectedWidth) || 34 * z) * (Number(sprite.projectedHeight) || 54 * z);
    }
    const occupancy = Math.min(1.5, spriteArea / area);
    const overlays = Math.min(1.5, Math.max(0, Number(overlayArea) || 0) / area);
    const collisionLoad = Math.min(1, Math.max(0, Number(collisions) || 0) / Math.max(1, sprites.length));
    const populationLoad = Math.min(1, sprites.length / Math.max(12, area / 42000));
    return Math.max(0, Math.min(1, occupancy * .34 + overlays * .2 + collisionLoad * .16 + populationLoad * .3));
}

export function annotationModeForPressure(pressure, previous = 'full') {
    const p = Math.max(0, Math.min(1, Number(pressure) || 0));
    if (previous === 'minimal' && p >= .66) return 'minimal';
    if (previous === 'compact' && p >= .37 && p < .78) return 'compact';
    return p >= .72 ? 'minimal' : p >= .42 ? 'compact' : 'full';
}

export class MarkGovernor {
    constructor() { this.regionSize = DEFAULT_REGION_SIZE; this.motionScale = 1; this._regions = new Map(); this._occupied = []; this._primaryRegions = new Set(); this._frame = 0; }
    beginFrame({ regionSize = DEFAULT_REGION_SIZE, motionScale = 1 } = {}) { this.regionSize = regionSize > 0 ? regionSize : DEFAULT_REGION_SIZE; this.motionScale = motionScale; this._regions.clear(); this._occupied.length = 0; this._primaryRegions.clear(); this._frame++; }
    _key(x, y) { return `${Math.floor((Number(x) || 0) / this.regionSize)},${Math.floor((Number(y) || 0) / this.regionSize)}`; }
    _region(x, y) { const key = this._key(x, y); let region = this._regions.get(key); if (!region) this._regions.set(key, region = { recent: 0, working: 0, ambient: 0 }); return { key, region }; }
    reserve(rect, tier = MarkTier.AMBIENT, stableKey = '') {
        if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y)) return false;
        const candidate = { ...rect, tier, stableKey: String(stableKey) };
        if (tier !== MarkTier.PRIMARY && this._occupied.some(item => item.tier === MarkTier.PRIMARY && overlaps(candidate, item))) return false;
        this._occupied.push(candidate);
        if (tier === MarkTier.PRIMARY) this._primaryRegions.add(this._key(rect.x + rect.w / 2, rect.y + rect.h / 2));
        return true;
    }
    admit(tier, x = 0, y = 0, { rect = null, stableKey = '' } = {}) {
        tier = POLICY[tier] ? tier : MarkTier.AMBIENT;
        if (rect && !this.reserve(rect, tier, stableKey)) return { draw: false, alpha: 0 };
        if (tier === MarkTier.PRIMARY) return { draw: true, alpha: 1 };
        const policy = POLICY[tier];
        if (this.motionScale <= 0) return { draw: true, alpha: policy.alphaCap };
        const { key, region } = this._region(x, y); const index = region[tier]++;
        if (index >= policy.hard) return { draw: false, alpha: 0 };
        let alpha = policy.alphaCap;
        if (index >= policy.soft) alpha *= Math.max(0, 1 - (index - policy.soft) / Math.max(1, policy.hard - policy.soft));
        if (this._primaryRegions.has(key)) alpha *= tier === MarkTier.AMBIENT ? .28 : .72;
        return { draw: alpha > .01, alpha };
    }
    alphaFor(tier, x = 0, y = 0) { const result = this.admit(tier, x, y); return result.draw ? result.alpha : 0; }
}
function overlaps(a, b) { return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }
let activeGovernor = null;
export function setActiveMarkGovernor(governor) { activeGovernor = governor || null; }
export function getActiveMarkGovernor() { return activeGovernor; }
