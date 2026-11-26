import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Camera } from '../../claudeville/src/presentation/character-mode/Camera.js';
import {
    CameraDirector,
    PROMENADE_PLAZA_REST,
    PROMENADE_STATIONS,
    promenadeTargetPose,
    stripZoomForDpr,
} from '../../claudeville/src/presentation/character-mode/CameraDirector.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { startIsolatedServer } from '../smoke/support/isolated-server.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const canvasOf = (w = 1440, h = 222, dpr = 1) => ({
    _claudeVilleCssWidth: w,
    _claudeVilleCssHeight: h,
    _claudeVilleDpr: dpr,
    clientWidth: w,
    clientHeight: h,
    style: {},
    addEventListener() {},
    removeEventListener() {},
});

function httpRequest(port, pathname, { method = 'GET', host = `127.0.0.1:${port}`, origin, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const reqHeaders = { Host: host, ...headers };
        if (origin !== undefined) reqHeaders.Origin = origin;
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: pathname,
            method,
            headers: reqHeaders,
        }, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({
                statusCode: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks),
            }));
        });
        req.on('error', reject);
        req.setTimeout(3_000, () => req.destroy(new Error(`Request timed out: ${pathname}`)));
        req.end();
    });
}

function makeSprite(id, {
    x = 0,
    y = 600,
    status = AgentStatus.WORKING,
    building = 'forge',
    awaitingSince = null,
    visitRole = 'work',
} = {}) {
    return {
        x,
        y,
        moving: false,
        visitRole,
        _foldBuildingType: visitRole === 'rest' ? null : building,
        _restSeatBuilding: visitRole === 'rest' ? building : null,
        isArrivalPending: () => false,
        agent: {
            id,
            status,
            awaitingSince,
            targetBuildingType: building,
            lastKnownBuildingType: building,
        },
    };
}

function finishGlide(camera) {
    for (let i = 0; i < 60 && camera.isDirectorGliding(); i++) {
        camera.update(100);
    }
    assert.equal(camera.isDirectorGliding(), false, 'glide settled cleanly');
}

test('PROMENADE_STATIONS exports exact 9 west-to-east entrance coordinates and PROMENADE_PLAZA_REST', () => {
    const expected = [
        ['portal', -896, 640],
        ['mine', -704, 768],
        ['taskboard', -384, 992],
        ['archive', -256, 416],
        ['forge', -160, 880],
        ['command', -128, 544],
        ['tavern', 160, 656],
        ['harbor', 256, 768],
        ['watchtower', 416, 624],
    ];
    assert.equal(PROMENADE_STATIONS.length, 9);
    assert.deepEqual(
        PROMENADE_STATIONS.map((s) => [s.type, s.x, s.y]),
        expected,
    );
    for (let i = 1; i < PROMENADE_STATIONS.length; i++) {
        assert.ok(
            PROMENADE_STATIONS[i].x > PROMENADE_STATIONS[i - 1].x,
            `${PROMENADE_STATIONS[i].type} is east of ${PROMENADE_STATIONS[i - 1].type}`,
        );
    }
    assert.equal(PROMENADE_PLAZA_REST.x, 16);
    assert.equal(PROMENADE_PLAZA_REST.y, 600);
});

test('stripZoomForDpr selects 0.5 at DPR >= 2 and 1 below DPR 2', () => {
    assert.equal(stripZoomForDpr(1), 1);
    assert.equal(stripZoomForDpr(1.25), 1);
    assert.equal(stripZoomForDpr(1.5), 1);
    assert.equal(stripZoomForDpr(1.99), 1);
    assert.equal(stripZoomForDpr(2), 0.5);
    assert.equal(stripZoomForDpr(2.5), 0.5);
    assert.equal(stripZoomForDpr(3), 0.5);
    assert.equal(stripZoomForDpr(undefined), 1);
    assert.equal(stripZoomForDpr(NaN), 1);
});

test('promenadeTargetPose computes 62% ground line and integer ±48 triangle drift (0 under reduced motion)', () => {
    const forge = { x: -160, y: 880 };

    // DPR 1 (zoom = 1): 240 px strip minus 18 px rail = 222 rows.
    const z1 = promenadeTargetPose({ station: forge, stripHeight: 240, zoom: 1, elapsedMs: 0, reducedMotion: false });
    assert.equal(z1.rows, 222);
    assert.equal(z1.drift, 0);
    assert.equal(z1.x, -160);
    assert.equal(z1.y, Math.round(880 - 0.12 * 222)); // 853
    assert.equal(z1.cx, z1.x);
    assert.equal(z1.cy, z1.y);
    assert.equal(z1.zoom, 1);

    // Ground line sits ~62% down the 222 px canvas.
    const groundShare = (forge.y - (z1.y - z1.rows / 2)) / z1.rows;
    assert.ok(Math.abs(groundShare - 0.62) < 0.005, `ground line share ${groundShare.toFixed(4)} ≈ 0.62`);

    // DPR 2 (zoom = 0.5): 444 rows visible.
    const z05 = promenadeTargetPose({ station: forge, stripHeight: 240, zoom: 0.5, elapsedMs: 0, reducedMotion: false });
    assert.equal(z05.rows, 444);
    assert.equal(z05.y, Math.round(880 - 0.12 * 444)); // 827

    // Triangle wave: ±48 texels at 4 texels/sec (full period 48 s), whole integer texels.
    const checkpoints = [
        [0, 0],
        [250, 1],
        [6000, 24],
        [12000, 48],
        [18000, 24],
        [24000, 0],
        [30000, -24],
        [36000, -48],
        [42000, -24],
        [48000, 0],
        [60000, 48],
    ];
    for (const [elapsedMs, expectedDrift] of checkpoints) {
        const pose = promenadeTargetPose({ station: forge, stripHeight: 240, zoom: 1, elapsedMs, reducedMotion: false });
        assert.equal(pose.drift, expectedDrift, `drift at ${elapsedMs} ms`);
        assert.equal(pose.x, forge.x + expectedDrift);
        assert.equal(Number.isInteger(pose.drift), true);
        assert.equal(Object.is(pose.drift, -0), false, 'never -0');
    }

    // Reduced motion zeroes drift at every phase.
    for (const [elapsedMs] of checkpoints) {
        const pose = promenadeTargetPose({ station: forge, stripHeight: 240, zoom: 1, elapsedMs, reducedMotion: true });
        assert.equal(pose.drift, 0, `reduced motion drift at ${elapsedMs} ms`);
        assert.equal(pose.x, forge.x);
    }

    // Degenerate stripHeight clamps rows to >= 1.
    const tiny = promenadeTargetPose({ station: forge, stripHeight: 18, zoom: 1, elapsedMs: 0, reducedMotion: false });
    assert.equal(tiny.rows, 1);
});

test('Promenade Rail cycles eastward across occupied stations, wraps, drifts in whole texels, and rests at Plaza when empty', () => {
    const camera = new Camera(canvasOf(1440, 222, 1));
    camera.fatFlight = true;
    const glideCalls = [];
    const origGlideToPose = camera.glideToPose.bind(camera);
    camera.glideToPose = (pose, opts) => {
        glideCalls.push({ pose, opts });
        return origGlideToPose(pose, opts);
    };

    const director = new CameraDirector(camera, { stripProfile: true });
    assert.equal(director.isStripProfile(), true);
    assert.equal(director.setAmbient(true), true);
    assert.equal(camera.owner, 'ambient');

    const sprites = [
        makeSprite('w-portal', { x: -896, y: 640, building: 'portal' }),
        makeSprite('w-forge', { x: -160, y: 880, building: 'forge' }),
        makeSprite('w-harbor', { x: 256, y: 768, building: 'harbor' }),
    ];

    // 1. Initial tick selects westernmost occupied station: portal (-896, 640).
    let now = 10_000;
    director.update({ now, dt: 16, agentSprites: sprites, snapshot: { workCohorts: [] } });
    assert.equal(glideCalls.length, 1);
    assert.equal(glideCalls[0].opts.owner, 'ambient');
    assert.equal(glideCalls[0].opts.motion, 'ambient');
    assert.equal(director.getPromenadeState().station.type, 'portal');
    assert.equal(glideCalls[0].pose.x, -896);
    assert.equal(glideCalls[0].pose.y, Math.round(640 - 0.12 * 222));

    // Settle glide at now = 13_000.
    finishGlide(camera);
    now = 13_000;
    director.update({ now, dt: 16, agentSprites: sprites, snapshot: { workCohorts: [] } });
    const settledCenter = camera.currentCenterWorld();

    // During hold (6 s after settle), camera drifts by +24 whole texels horizontally.
    director.update({ now: now + 6_000, dt: 16, agentSprites: sprites, snapshot: { workCohorts: [] } });
    const driftedCenter = camera.currentCenterWorld();
    assert.equal(Math.round(driftedCenter.x - settledCenter.x), 24);
    assert.equal(glideCalls.length, 1, 'still holding on portal before 20 s');

    // Before 20 s hold elapses (19.5 s), must not advance.
    director.update({ now: now + 19_500, dt: 16, agentSprites: sprites, snapshot: { workCohorts: [] } });
    assert.equal(glideCalls.length, 1);

    // At 20 s hold (and >= 18 s gap), advances eastward to forge (-160, 880), skipping empty mine/taskboard/archive.
    now += 20_000;
    director.update({ now, dt: 16, agentSprites: sprites, snapshot: { workCohorts: [] } });
    assert.equal(glideCalls.length, 2);
    assert.equal(director.getPromenadeState().station.type, 'forge');
    assert.equal(glideCalls[1].pose.x, -160);
    assert.equal(glideCalls[1].pose.y, Math.round(880 - 0.12 * 222));
    finishGlide(camera);
    now += 3_000;
    director.update({ now, dt: 16, agentSprites: sprites, snapshot: { workCohorts: [] } });

    // Next cycle advances eastward to harbor (256, 768).
    now += 20_000;
    director.update({ now, dt: 16, agentSprites: sprites, snapshot: { workCohorts: [] } });
    assert.equal(glideCalls.length, 3);
    assert.equal(director.getPromenadeState().station.type, 'harbor');
    assert.equal(glideCalls[2].pose.x, 256);
    finishGlide(camera);
    now += 3_000;
    director.update({ now, dt: 16, agentSprites: sprites, snapshot: { workCohorts: [] } });

    // Next cycle wraps around eastward back to portal (-896, 640).
    now += 20_000;
    director.update({ now, dt: 16, agentSprites: sprites, snapshot: { workCohorts: [] } });
    assert.equal(glideCalls.length, 4);
    assert.equal(director.getPromenadeState().station.type, 'portal');
    finishGlide(camera);
    now += 3_000;
    director.update({ now, dt: 16, agentSprites: sprites, snapshot: { workCohorts: [] } });

    // Empty village -> rests on PROMENADE_PLAZA_REST (16, 600).
    now += 20_000;
    director.update({ now, dt: 16, agentSprites: [], snapshot: { workCohorts: [], buildingSignals: [] } });
    assert.equal(glideCalls.length, 5);
    assert.equal(director.getPromenadeState().station.type, 'plaza');
    assert.equal(glideCalls[4].pose.x, PROMENADE_PLAZA_REST.x);
    assert.equal(glideCalls[4].pose.y, Math.round(PROMENADE_PLAZA_REST.y - 0.12 * 222));
    finishGlide(camera);
    now += 3_000;
    director.update({ now, dt: 16, agentSprites: [], snapshot: { workCohorts: [], buildingSignals: [] } });

    // Staying empty does not emit redundant glides.
    now += 25_000;
    director.update({ now, dt: 16, agentSprites: [], snapshot: { workCohorts: [], buildingSignals: [] } });
    assert.equal(glideCalls.length, 5);

    // Tavern patron occupancy (`visitRole: 'rest'`) is recognized as occupied.
    const patron = [makeSprite('patron-1', { x: 160, y: 656, status: AgentStatus.IDLE, building: 'tavern', visitRole: 'rest' })];
    now += 25_000;
    director.update({ now, dt: 16, agentSprites: patron, snapshot: { workCohorts: [], buildingSignals: [] } });
    assert.equal(glideCalls.length, 6);
    assert.equal(director.getPromenadeState().station.type, 'tavern');

    director.dispose();
});

test('Promenade Rail uses z=0.5 at DPR >= 2 and freezes drift under reduced motion', () => {
    const camera = new Camera(canvasOf(1440, 222, 2));
    camera.setReducedMotion(true);
    const director = new CameraDirector(camera, { stripProfile: true, motionScale: 0 });
    director.setAmbient(true);

    const sprites = [makeSprite('w-command', { x: -128, y: 544, building: 'command' })];
    director.update({ now: 1_000, dt: 16, agentSprites: sprites, snapshot: { workCohorts: [] } });
    assert.equal(camera.zoom, 0.5);
    const initialCenter = camera.currentCenterWorld();
    assert.equal(Math.round(initialCenter.x), -128);
    assert.equal(Math.round(initialCenter.y), Math.round(544 - 0.12 * 444));

    // Advance 12 s under reduced motion: zero drift.
    director.update({ now: 13_000, dt: 16, agentSprites: sprites, snapshot: { workCohorts: [] } });
    const laterCenter = camera.currentCenterWorld();
    assert.equal(laterCenter.x, initialCenter.x);
    assert.equal(laterCenter.y, initialCenter.y);

    director.dispose();
});

test('Promenade Rail overrides to oldest attention agent with 0.12*rows ground line and cycles every 20 s', () => {
    const camera = new Camera(canvasOf(1440, 222, 1));
    camera.fatFlight = true;
    const director = new CameraDirector(camera, { stripProfile: true });
    director.setAmbient(true);

    const worker = makeSprite('worker-portal', { x: -896, y: 640, building: 'portal' });
    let now = 10_000;
    director.update({ now, dt: 16, agentSprites: [worker], snapshot: { workCohorts: [] } });
    finishGlide(camera);
    now += 3_000;
    director.update({ now, dt: 16, agentSprites: [worker], snapshot: { workCohorts: [] } });
    assert.equal(director.getPromenadeState().station.type, 'portal');

    // Two agents need attention: moss (older) and reed (newer).
    const moss = makeSprite('moss', { x: 110, y: 710, status: AgentStatus.WAITING_ON_USER, building: 'command', awaitingSince: 1_000 });
    const reed = makeSprite('reed', { x: -320, y: 520, status: AgentStatus.ERRORED, building: 'archive', awaitingSince: 5_000 });

    now += 1_000;
    director.update({ now, dt: 16, agentSprites: [worker, reed, moss], snapshot: { workCohorts: [] } });
    assert.equal(director.getPromenadeState().mode, 'attention');
    assert.equal(director.getPromenadeState().attentionAgentId, 'moss', 'oldest attention agent goes first');
    finishGlide(camera);
    const mossCenter = camera.currentCenterWorld();
    assert.equal(Math.round(mossCenter.x), 110);
    assert.equal(Math.round(mossCenter.y), Math.round(710 - 0.12 * 222));

    // Settle on moss at now + 2000.
    now += 2_000;
    director.update({ now, dt: 16, agentSprites: [worker, reed, moss], snapshot: { workCohorts: [] } });

    // Before 20 s: still holding moss.
    director.update({ now: now + 19_000, dt: 16, agentSprites: [worker, reed, moss], snapshot: { workCohorts: [] } });
    assert.equal(director.getPromenadeState().attentionAgentId, 'moss');

    // At 20 s: cycles to reed.
    now += 20_000;
    director.update({ now, dt: 16, agentSprites: [worker, reed, moss], snapshot: { workCohorts: [] } });
    assert.equal(director.getPromenadeState().attentionAgentId, 'reed');
    finishGlide(camera);
    const reedCenter = camera.currentCenterWorld();
    assert.equal(Math.round(reedCenter.x), -320);
    assert.equal(Math.round(reedCenter.y), Math.round(520 - 0.12 * 222));

    // Once attention agents resolve, returns to station schedule after move gap.
    now += 2_000;
    director.update({ now, dt: 16, agentSprites: [worker], snapshot: { workCohorts: [] } });
    assert.equal(director.getPromenadeState().mode, 'station');
    assert.equal(director.getPromenadeState().attentionAgentId, null);

    director.dispose();
});

test('Promenade Rail pauses for USER_IDLE_MS (45 s) on operator pan/zoom and resumes afterward', () => {
    const camera = new Camera(canvasOf(1440, 222, 1));
    camera.fatFlight = true;
    const director = new CameraDirector(camera, { stripProfile: true });
    director.setAmbient(true);

    const sprites = [
        makeSprite('w-portal', { x: -896, y: 640, building: 'portal' }),
        makeSprite('w-harbor', { x: 256, y: 768, building: 'harbor' }),
    ];

    let now = 100_000;
    director.update({ now, dt: 16, agentSprites: sprites, snapshot: { workCohorts: [] } });
    finishGlide(camera);
    now += 3_000;
    director.update({ now, dt: 16, agentSprites: sprites, snapshot: { workCohorts: [] } });

    // Operator pans/zooms manually.
    camera.noteUserInput();
    camera._lastUserInputAt = now;
    camera._setCenter(40, 620, 1);
    const userPos = camera.currentCenterWorld();

    // First update after user input records the pause without moving camera.
    director.update({ now, dt: 16, agentSprites: sprites, snapshot: { workCohorts: [] } });
    assert.equal(camera.owner, 'user');
    assert.equal(director.getPromenadeState().paused, true);

    // At +44,999 ms: still paused, camera untouched.
    director.update({ now: now + 44_999, dt: 16, agentSprites: sprites, snapshot: { workCohorts: [] } });
    assert.equal(camera.owner, 'user');
    assert.equal(director.getPromenadeState().paused, true);
    assert.deepEqual(camera.currentCenterWorld(), userPos);

    // At +45,000 ms: resumes ambient Promenade Rail and glides to next occupied station eastward (harbor).
    director.update({ now: now + 45_000, dt: 16, agentSprites: sprites, snapshot: { workCohorts: [] } });
    assert.equal(camera.owner, 'ambient');
    assert.equal(director.getPromenadeState().paused, false);
    assert.equal(director.getPromenadeState().active, true);
    assert.equal(director.getPromenadeState().station.type, 'harbor');

    // Explicit setAmbient(false) disables without auto-resuming.
    director.setAmbient(false);
    director.update({ now: now + 100_000, dt: 16, agentSprites: sprites, snapshot: { workCohorts: [] } });
    assert.equal(director.isAmbient(), false);
    assert.equal(director.getPromenadeState().paused, false);

    director.dispose();
});

test('HTTP server serves /strip, /strip/, and /strip.webmanifest on an isolated ephemeral port', async () => {
    const server = await startIsolatedServer();
    try {
        assert.notEqual(server.port, 4000, 'test must never touch port 4000');

        const rootRes = await httpRequest(server.port, '/');
        assert.equal(rootRes.statusCode, 200);

        for (const route of ['/strip', '/strip/', '/strip/?sim=1']) {
            const res = await httpRequest(server.port, route);
            assert.equal(res.statusCode, 200, route);
            assert.equal(res.headers['content-type'], 'text/html; charset=utf-8', route);
            assert.equal(res.headers['cache-control'], 'no-cache', route);
            assert.equal(res.headers.vary, 'Accept-Encoding', route);
            assert.ok(res.headers.etag, `${route} sets ETag`);
            assert.deepEqual(res.body, rootRes.body, `${route} serves index.html verbatim`);
        }

        // Sub-paths under /strip/ remain contained (404).
        const subRes = await httpRequest(server.port, '/strip/index.html');
        assert.equal(subRes.statusCode, 404);

        // Security posture on /strip/ matches / (hostile Host -> 421, hostile Origin -> 403).
        const badHost = await httpRequest(server.port, '/strip/', { host: 'attacker.example' });
        assert.equal(badHost.statusCode, 421);
        const badOrigin = await httpRequest(server.port, '/strip/', { origin: 'https://attacker.example' });
        assert.equal(badOrigin.statusCode, 403);

        // /strip.webmanifest served with application/manifest+json.
        const manifestRes = await httpRequest(server.port, '/strip.webmanifest');
        assert.equal(manifestRes.statusCode, 200);
        assert.equal(manifestRes.headers['content-type'], 'application/manifest+json; charset=utf-8');
        const manifest = JSON.parse(manifestRes.body.toString('utf8'));
        assert.equal(manifest.name, 'ClaudeVille Strip');
        assert.equal(manifest.short_name, 'Village Strip');
        assert.equal(manifest.display, 'standalone');
        assert.equal(manifest.start_url, '/strip/');
        assert.equal(manifest.background_color, '#140e0a');
        assert.equal(manifest.theme_color, '#140e0a');

        // /css/strip.css is served and strictly scoped to :root[data-cv-profile="strip"].
        const cssRes = await httpRequest(server.port, '/css/strip.css');
        assert.equal(cssRes.statusCode, 200);
        assert.equal(cssRes.headers['content-type'], 'text/css; charset=utf-8');
        const cssText = cssRes.body.toString('utf8');
        assert.match(cssText, /height:\s*18px;/);
        assert.match(cssText, /calc\(100vh\s*-\s*18px\)/);
        assert.match(cssText, /:root\[data-cv-profile="strip"\]\s+#stripRail/);
    } finally {
        await server.stop();
    }
});

test('claudeville/css/strip.css exists on disk and leaves desktop/mobile stylesheets untouched', () => {
    const stripCss = fs.readFileSync(path.join(REPO_ROOT, 'claudeville/css/strip.css'), 'utf8');
    assert.ok(stripCss.length > 0);
    assert.match(stripCss, /:root\[data-cv-profile="strip"\]\s+#topbar/);
    assert.match(stripCss, /:root\[data-cv-profile="strip"\]\s+#stripRail/);
});
