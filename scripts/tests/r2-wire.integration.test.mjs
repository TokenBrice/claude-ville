import test from 'node:test';
import assert from 'node:assert/strict';

import { Agent } from '../../claudeville/src/domain/entities/Agent.js';
import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { VisitIntentManager } from '../../claudeville/src/presentation/character-mode/VisitIntentManager.js';
import { WeatherRenderer } from '../../claudeville/src/presentation/character-mode/WeatherRenderer.js';

test('AgentSprite consumes the Agent intent bubble contract instead of recomposing tool copy', () => {
    const now = Date.now();
    const agent = new Agent({
        id: 'wire-intent-agent',
        provider: 'codex',
        status: 'working',
        currentTool: 'Edit',
        currentToolInput: 'forge.js',
    });
    const manager = new VisitIntentManager({ now: () => now });
    manager.reconcile([agent], now);
    agent.currentTool = 'Bash';
    agent.currentToolInput = 'npm test';
    manager.reconcile([agent], now + 1_000);

    const spriteConsumer = {
        _truncateActivityText: AgentSprite.prototype._truncateActivityText,
        _providerTrimColor: () => '#7dd3fc',
    };
    const entry = AgentSprite.prototype._activityEntryForAgent.call(
        spriteConsumer,
        agent,
        now + 1_000,
    );

    assert.equal(entry.text, agent.bubbleText);
    assert.equal(entry.text, agent.visitIntentBubble.text);
    assert.equal(entry.kind, 'intent');
    assert.doesNotMatch(entry.text, /npm test|running bash/i);
    manager.dispose();
});

test('district atmosphere paints a cached local wash around project occupants', () => {
    let textureCreations = 0;
    const gradientStops = [];
    const canvasFactory = () => {
        textureCreations++;
        return {
            width: 0,
            height: 0,
            getContext() {
                return {
                    fillStyle: '',
                    createRadialGradient() {
                        return {
                            addColorStop(offset, color) { gradientStops.push([offset, color]); },
                        };
                    },
                    fillRect() {},
                };
            },
        };
    };
    const drawCalls = [];
    const ctx = {
        globalAlpha: 1,
        globalCompositeOperation: 'source-over',
        save() {},
        restore() { this.globalAlpha = 1; },
        drawImage(...args) { drawCalls.push(args); },
    };
    const renderer = new WeatherRenderer({ canvasFactory });
    renderer.setDistrictContext({
        camera: { x: 0, y: 0, zoom: 1 },
        agentSprites: new Map([
            ['troubled-a', { x: 300, y: 220 }],
            ['troubled-b', { x: 340, y: 230 }],
            ['unrelated', { x: 1000, y: 600 }],
        ]),
    });
    const atmosphere = {
        motion: { particleEnabled: false },
        weather: { type: 'clear', intensity: 0, precipitation: 0, fog: 0, cloudCover: 0 },
        districtAtmosphere: [{
            project: '/repos/troubled',
            agentIds: ['troubled-a', 'troubled-b'],
            groundHaze: { alpha: 0.2, tint: '76, 68, 94' },
            lightingBias: { cool: 0.15, warm: 0, dim: 0.1 },
            falloff: { shape: 'smoothstep', innerRadiusTiles: 2.5, outerRadiusTiles: 7 },
        }],
    };

    renderer.drawForeground(ctx, { canvas: { width: 1280, height: 720 }, atmosphere });
    const firstTextureCount = textureCreations;

    assert.equal(renderer._lastDistrictDrawCount, 1);
    assert.equal(drawCalls.length, 3);
    assert.ok(drawCalls.every(([, x, y, width, height]) => (
        x > 0 && y > 0 && width < 1280 && height < 720
    )));
    assert.ok(gradientStops.some(([offset]) => offset > 0 && offset < 1));

    // Reduced motion uses the same fixed visual and reuses its texture cache.
    renderer.drawForeground(ctx, { canvas: { width: 1280, height: 720 }, atmosphere });
    assert.equal(renderer._lastDistrictDrawCount, 1);
    assert.equal(textureCreations, firstTextureCount);
    renderer.dispose();
});
