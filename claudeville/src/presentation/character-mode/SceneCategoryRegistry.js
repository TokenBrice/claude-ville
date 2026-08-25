import { HARBOR_TRAFFIC_SCENE_CATEGORY } from './HarborTraffic.js';

const UNSUPPORTED_POLICIES = new Set([
    'overlay-safe',
    'require-canvas-frame',
    'omit',
]);

/**
 * Registry for visual sources that must declare how every scene backend treats
 * them. Categories still enter DrawablePass; this registry owns discovery,
 * neutral command emission, and the policy used when a backend cannot consume
 * those commands.
 */
export class SceneCategoryRegistry {
    constructor(categories = []) {
        this.categories = [];
        this.byId = new Map();
        for (const category of categories) this.register(category);
    }

    register(definition) {
        const category = normalizeCategory(definition);
        if (this.byId.has(category.id)) {
            throw new Error(`Scene category already registered: ${category.id}`);
        }
        this.categories.push(category);
        this.byId.set(category.id, category);
        return category;
    }

    enumerate(context = {}) {
        const entries = [];
        let totalItems = 0;
        for (const category of this.categories) {
            const items = normalizeItems(category.enumerate(context));
            const commandGroups = items.map(item => normalizeCommands(
                category.emitSceneCommands(item, context),
            ));
            entries.push({ category, items, commandGroups });
            totalItems += items.length;
        }
        return { entries, totalItems };
    }

    resolve(frame, backend = {}) {
        const overlayCategoryIds = new Set();
        const omittedCategoryIds = new Set();
        const nativeCommandBatches = [];
        const diagnostics = [];
        const categories = [];
        let requireCanvasFrame = false;

        for (const entry of frame?.entries || []) {
            const { category, items, commandGroups } = entry;
            if (!items.length) {
                categories.push(categoryStatus(category, 'empty', 0));
                continue;
            }
            if (backend.canvasFallback === true) {
                categories.push(categoryStatus(category, 'canvas-fallback', items.length));
                continue;
            }

            // Native support is all-or-nothing for a category. A missing command
            // for even one item follows the declared unsupported policy instead
            // of allowing a partially rendered category to vanish silently.
            const completeCommands = commandGroups.length === items.length
                && commandGroups.every(commands => commands.length > 0);
            const commands = commandGroups.flat();
            const native = completeCommands
                && backend.supportsSceneCommands?.({
                    categoryId: category.id,
                    commands,
                }) === true;
            if (native) {
                nativeCommandBatches.push({ categoryId: category.id, commands });
                categories.push(categoryStatus(category, 'native', items.length));
                continue;
            }

            if (category.unsupported === 'overlay-safe') {
                overlayCategoryIds.add(category.id);
                categories.push(categoryStatus(category, 'overlay', items.length));
                continue;
            }
            if (category.unsupported === 'require-canvas-frame') {
                requireCanvasFrame = true;
                diagnostics.push({
                    code: 'scene-category-requires-canvas',
                    categoryId: category.id,
                    backendId: backend.id || 'unknown',
                    message: `Scene backend ${backend.id || 'unknown'} cannot render category ${category.id}; using the Canvas frame.`,
                });
                categories.push(categoryStatus(category, 'canvas-required', items.length));
                continue;
            }

            omittedCategoryIds.add(category.id);
            categories.push(categoryStatus(category, 'omitted', items.length));
        }

        return {
            requireCanvasFrame,
            overlayCategoryIds,
            omittedCategoryIds,
            nativeCommandBatches,
            diagnostics,
            categories,
        };
    }
}

function normalizeCategory(definition = {}) {
    const id = String(definition.id || '').trim();
    if (!id) throw new TypeError('Scene category id is required.');
    if (typeof definition.enumerate !== 'function') {
        throw new TypeError(`Scene category ${id} must define enumerate().`);
    }
    if (typeof definition.emitSceneCommands !== 'function') {
        throw new TypeError(`Scene category ${id} must define emitSceneCommands().`);
    }
    if (typeof definition.canvasFallback !== 'function') {
        throw new TypeError(`Scene category ${id} must define canvasFallback().`);
    }
    if (!UNSUPPORTED_POLICIES.has(definition.unsupported)) {
        throw new TypeError(`Scene category ${id} has an invalid unsupported policy.`);
    }
    const sortBand = finiteBand(definition.sortBand, 50);
    return Object.freeze({
        id,
        sortBand,
        enumerate: definition.enumerate,
        emitSceneCommands: definition.emitSceneCommands,
        canvasFallback: definition.canvasFallback,
        unsupported: definition.unsupported,
        overlayBand: finiteBand(definition.overlayBand, sortBand),
    });
}

function normalizeItems(value) {
    if (value == null) return [];
    return Array.isArray(value) ? value : [...value];
}

function normalizeCommands(value) {
    if (value == null) return [];
    return (Array.isArray(value) ? value : [value]).filter(Boolean);
}

function finiteBand(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function categoryStatus(category, handling, count) {
    return {
        id: category.id,
        handling,
        count,
        unsupported: category.unsupported,
    };
}

// Built-in registration lives here so frame orchestration has no category list,
// backend-specific or otherwise. Adding a category changes the registry and its
// source adapter, while every renderer receives the same resolved frame.
export const worldSceneCategoryRegistry = new SceneCategoryRegistry([
    HARBOR_TRAFFIC_SCENE_CATEGORY,
]);
