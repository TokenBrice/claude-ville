import test from 'node:test';
import assert from 'node:assert/strict';

import { packGpuAgentFrameAtlas } from '../../claudeville/src/presentation/character-mode/gpu/GpuSceneBuilder.js';

test('occluder recovery restores the retained albedo pose without advancing its cadence', () => {
    const previousDocument = globalThis.document;
    const draws = [];
    const canvas = (width = 0, height = 0) => ({
        width,
        height,
        getContext: () => ({ clearRect() {}, drawImage(...args) { draws.push(args); } }),
    });
    globalThis.document = { createElement: () => canvas() };
    try {
        const source = canvas(16, 8);
        const occluderSource = canvas(16, 8);
        const renderer = { agentSprites: new Map([['one', {}]]) };
        const frame = sx => ({
            id: 'agent:one', source, occluderSource, sx, sy: 0, sw: 8, sh: 8,
            width: 8, height: 8, textureKey: 'sheet', textureRevision: sx,
        });
        packGpuAgentFrameAtlas(renderer, [frame(0)], true);
        renderer._gpuAgentAtlasUpdatedAt = -Infinity;
        draws.length = 0;
        packGpuAgentFrameAtlas(renderer, [frame(8)], false);
        assert.equal(draws.some(args => args[0] === occluderSource), false);

        renderer._gpuAgentAtlasUpdatedAt = Infinity;
        draws.length = 0;
        const [restored] = packGpuAgentFrameAtlas(renderer, [frame(0)], true);
        assert.equal(draws.some(args => args[0] === source), false);
        assert.equal(draws.find(args => args[0] === occluderSource)?.[1], 8);
        assert.equal(restored.occluderTextureUpdates.length, 0);
    } finally {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
    }
});
