import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { PNG } from 'pngjs';

import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';
import { LIVESTOCK_ROUTES } from '../../claudeville/src/config/scenery.js';
import { frontEdgeFoot, landmarkFootprint } from '../../claudeville/src/presentation/character-mode/FootprintField.js';
import { buildingCenterToWorld, tileToWorld } from '../../claudeville/src/presentation/character-mode/Projection.js';
import { faunaSheetFrame, livestockPose } from '../../claudeville/src/presentation/character-mode/WildlifeRenderer.js';

// Livestock draws in the wildlife layer, which the GPU paths replay on the
// overlay above every building (WILDLIFE_SCENE_CATEGORY), so a building never
// hides an animal standing behind it. Every pose a route can take (each held
// point and each walk step, moving or held still, in the facing and frame
// livestockPose gives it) must keep its drawn texels off the opaque base art
// of every building it stands behind: above the footprint's front edges at
// its screen column (frontEdgeFoot). World texels, so it holds at every zoom.
// CM-1 moved Command two rows north under the cow's and a hen's old points.

const SPRITES = new URL('../../claudeville/assets/sprites/', import.meta.url);
const manifest = yaml.load(readFileSync(new URL('manifest.yaml', SPRITES), 'utf8'));
const entries = new Map([...manifest.buildings, ...manifest.props].map((entry) => [entry.id, entry]));
const decoded = new Map();
const png = (path) => {
    if (!decoded.has(path)) decoded.set(path, PNG.sync.read(readFileSync(new URL(path, SPRITES))));
    return decoded.get(path);
};

const buildings = BUILDING_DEFS.map((def) => {
    const [anchorX, anchorY] = entries.get(`building.${def.type}`).anchor;
    const centre = buildingCenterToWorld(def);
    return {
        type: def.type,
        art: png(`buildings/building.${def.type}/base.png`),
        left: Math.round(centre.x - anchorX),
        top: Math.round(centre.y - anchorY),
        footprint: landmarkFootprint(def),
    };
});

// Every distinct drawn pose over an hour of the route's walk clock (each
// loop is a few minutes), as WildlifeRenderer places it.
function routePoses(route) {
    const poses = new Map();
    const pose = {};
    for (const still of [false, true]) {
        for (let clockMs = 0; clockMs < 3600000; clockMs += 100) {
            livestockPose(route, clockMs, { still }, pose);
            const world = tileToWorld(pose.tileX, pose.tileY);
            const x = Math.round(world.x);
            const y = Math.round(world.y);
            const key = `${x},${y},${pose.dir},${pose.frame}`;
            if (!poses.has(key)) poses.set(key, { x, y, dir: pose.dir, frame: pose.frame, tileX: pose.tileX, tileY: pose.tileY });
        }
    }
    return [...poses.values()];
}

// Texels of the animal's cell (WildlifeRenderer._drawFaunaCell placement)
// that land on the building's opaque art.
function texelsOver(route, pose, building) {
    const entry = entries.get(route.sprite);
    const sheet = png(`props/${route.sprite}.png`);
    const cell = faunaSheetFrame(entry, pose.dir, pose.frame, sheet, {});
    const [anchorX, anchorY] = entry.anchor;
    const { art, left, top } = building;
    let count = 0;
    for (let v = 0; v < cell.sh; v++) {
        for (let u = 0; u < cell.sw; u++) {
            if (sheet.data[((cell.sy + v) * sheet.width + cell.sx + u) * 4 + 3] === 0) continue;
            const x = (cell.mirror ? pose.x + anchorX - u - 1 : pose.x - anchorX + u) - left;
            const y = pose.y - anchorY + v - top;
            if (x >= 0 && y >= 0 && x < art.width && y < art.height && art.data[(y * art.width + x) * 4 + 3] > 0) count++;
        }
    }
    return count;
}

test('no livestock pose draws over a building it stands behind', () => {
    let behind = 0;
    for (const route of LIVESTOCK_ROUTES) {
        for (const pose of routePoses(route)) {
            for (const building of buildings) {
                if (pose.y >= frontEdgeFoot(building.footprint, pose.x).y) continue;
                behind++;
                const texels = texelsOver(route, pose, building);
                assert.equal(texels, 0,
                    `${route.id} at ${pose.tileX.toFixed(2)},${pose.tileY.toFixed(2)} (${pose.dir}) draws ${texels} texels over ${building.type}, which stands in front of it`);
            }
        }
    }
    assert.ok(behind > 0, 'the paddock stands behind Command, so some pose must be checked');
});
