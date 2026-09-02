import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as browserRegistry from '../../claudeville/src/config/models.generated.js';
import {
    formatModelLabel as browserFormatModelLabel,
    getModelVisualIdentity,
    POLICY_SPRITE_IDS,
} from '../../claudeville/src/presentation/shared/ModelVisualIdentity.js';

const require = createRequire(import.meta.url);
const serverRegistry = require('../../claudeville/src/config/models.generated.cjs');
const {
    formatModelLabel: serverFormatModelLabel,
    modelIdentity,
} = require('../../claudeville/adapters/sessionPresentation.js');

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
let manifestTools = null;
let manifestImportError = null;
try {
    manifestTools = await import('../sprites/manifest-utils.mjs');
} catch (error) {
    manifestImportError = error;
}

describe('generated model registry parity', () => {
    for (const row of browserRegistry.MODEL_REGISTRY) {
        test(row.id, () => {
            const browserMatch = browserRegistry.findModelRow(row.sample, row.provider);
            const serverMatch = serverRegistry.findModelRow(row.sample, row.provider);

            assert.equal(browserMatch.row?.id, row.id, `${row.id}: browser sample resolved to ${browserMatch.row?.id || 'no row'}`);
            assert.equal(serverMatch.row?.id, row.id, `${row.id}: server sample resolved to ${serverMatch.row?.id || 'no row'}`);
            assert.equal(browserMatch.isDefault, false, `${row.id}: browser unexpectedly used a default`);
            assert.equal(serverMatch.isDefault, false, `${row.id}: server unexpectedly used a default`);
            assert.deepEqual(
                browserRegistry.ratesForModel(row.sample, row.provider),
                serverRegistry.ratesForModel(row.sample, row.provider),
                `${row.id}: pricing differs between browser and server registries`,
            );
            assert.equal(
                browserRegistry.contextWindowForModel(row.sample, row.provider),
                serverRegistry.contextWindowForModel(row.sample, row.provider),
                `${row.id}: context window differs between browser and server registries`,
            );
            assert.equal(browserMatch.row.id, serverMatch.row.id, `${row.id}: matched row differs between registries`);

            const sheetPath = join(repoRoot, 'claudeville', 'assets', 'sprites', 'characters', row.spriteId, 'sheet.png');
            assert.ok(existsSync(sheetPath), `${row.id}: missing sprite sheet for ${row.spriteId}`);
        });
    }
});

describe('presentation model identity parity', () => {
    for (const row of browserRegistry.MODEL_REGISTRY) {
        test(row.id, () => {
            const browserIdentity = getModelVisualIdentity(row.sample, null, row.provider);
            const serverIdentity = modelIdentity(row.sample, null, row.provider);
            assert.equal(
                browserIdentity.spriteId,
                serverIdentity.spriteId,
                `${row.id}: browser/server spriteId mismatch`,
            );
            assert.equal(
                browserFormatModelLabel(row.sample, null, row.provider),
                serverFormatModelLabel(row.sample, null, row.provider),
                `${row.id}: browser/server formatted label mismatch`,
            );
        });
    }
});

test('registry and defaults cover every manifest agent sprite in both directions', (t) => {
    if (!manifestTools) {
        if (manifestImportError?.code === 'ERR_MODULE_NOT_FOUND' && String(manifestImportError.message).includes('js-yaml')) {
            t.skip('manifest assertions require js-yaml; run npm ci');
            return;
        }
        throw manifestImportError;
    }

    const manifest = manifestTools.loadSpriteManifest();
    const characterIds = new Set(
        (manifest?.characters || [])
            .map((entry) => entry?.id)
            .filter((id) => typeof id === 'string' && id.startsWith('agent.')),
    );

    for (const row of browserRegistry.MODEL_REGISTRY) {
        assert.ok(characterIds.has(row.spriteId), `${row.id}: manifest is missing ${row.spriteId}`);
    }

    const referencedIds = new Set([
        ...browserRegistry.MODEL_REGISTRY.map((row) => row.spriteId),
        ...Object.values(browserRegistry.MODEL_DEFAULTS).map((row) => row.spriteId),
        ...POLICY_SPRITE_IDS,
    ]);
    const orphans = [...characterIds].filter((id) => !referencedIds.has(id)).sort();
    assert.deepEqual(orphans, [], `manifest agent sprites without a registry row, provider default, or rendering-policy reference: ${orphans.join(', ')}`);
});
