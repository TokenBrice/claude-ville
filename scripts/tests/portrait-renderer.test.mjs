import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { PNG } from 'pngjs';

import {
  getModelVisualIdentity as uiGetModelVisualIdentity,
  providerPaletteKey as uiProviderPaletteKey,
} from '../../claudeville/src/presentation/shared/ModelVisualIdentity.js';
import {
  agentTrimAccent as uiAgentTrimAccent,
  harnessAccent as uiHarnessAccent,
} from '../../claudeville/src/presentation/shared/TeamColor.js';
import {
  agentPaletteVariant as uiAgentPaletteVariant,
  robeHueTurn as uiRobeHueTurn,
  robeVariant as uiRobeVariant,
  shiftRobeColor as uiShiftRobeColor,
} from '../../claudeville/src/presentation/character-mode/Compositor.js';
import {
  paletteIdentity,
  recolorCellBytes,
  writePaletteRow,
} from '../../claudeville/src/presentation/character-mode/AgentLayerRecords.js';
import { startIsolatedServer } from '../smoke/support/isolated-server.mjs';
import { makeTempDir } from './support/tmp.mjs';

const require = createRequire(import.meta.url);
const portraitRenderer = require('../../claudeville/services/portraitRenderer.js');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SPRITES_ROOT = path.join(REPO_ROOT, 'claudeville', 'assets', 'sprites');
const MANIFEST_PATH = path.join(SPRITES_ROOT, 'manifest.yaml');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPngHeader(buffer) {
  assert.ok(Buffer.isBuffer(buffer), 'PNG output must be a Buffer');
  assert.ok(buffer.length >= 33, 'PNG buffer too short');
  assert.ok(buffer.subarray(0, 8).equals(PNG_MAGIC), 'PNG magic signature mismatch');
  assert.equal(buffer.toString('ascii', 12, 16), 'IHDR', 'first PNG chunk must be IHDR');
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
    compression: buffer[26],
    filter: buffer[27],
    interlace: buffer[28],
  };
}

function countOpaquePixels(rgba) {
  let count = 0;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] >= 16) count++;
  }
  return count;
}

function httpRequest(port, {
  method = 'GET',
  pathname = '/api/portrait/status',
  host = `127.0.0.1:${port}`,
  origin,
  body = null,
  headers: extraHeaders = {},
} = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host, ...extraHeaders };
    if (origin !== undefined) headers.Origin = origin;
    if (body !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          buffer,
          text: buffer.toString('utf8'),
        });
      });
    });
    req.setTimeout(3000, () => req.destroy(new Error(`Request ${method} ${pathname} timed out`)));
    req.on('error', reject);
    req.end(body);
  });
}

test('zero-dep manifest parser matches js-yaml across assetVersion, palettes, and all 40 characters', () => {
  const rawYaml = fs.readFileSync(MANIFEST_PATH, 'utf8');
  const expected = yaml.load(rawYaml);
  const actual = portraitRenderer.parseSpriteManifest(rawYaml);

  assert.equal(actual.assetVersion, expected.style.assetVersion);
  assert.equal(actual.characters.size, 40);
  assert.equal(expected.characters.length, 40);

  for (const [provider, pal] of Object.entries(expected.palettes)) {
    assert.deepEqual(actual.palettes[provider]?.trim, pal.trim, `palette mismatch for ${provider}`);
  }

  for (const entry of expected.characters) {
    const parsed = actual.characters.get(entry.id);
    assert.ok(parsed, `missing character ${entry.id}`);
    assert.deepEqual(parsed.portraitCrop, entry.portraitCrop ?? null, `portraitCrop mismatch for ${entry.id}`);
    assert.deepEqual(parsed.portraitFace, entry.portraitFace ?? null, `portraitFace mismatch for ${entry.id}`);
    assert.equal(parsed.paletteLayer, entry.palette_layer ?? null, `paletteLayer mismatch for ${entry.id}`);
  }

  const status = portraitRenderer.getPortraitStatus();
  assert.deepEqual(status, {
    ok: true,
    portraitApi: true,
    assetVersion: expected.style.assetVersion,
    spriteCount: 40,
  });
});

test('pure-Node PNG decoder matches pngjs across all 40 character sheets and roundtrips filtered PNGs', () => {
  const expected = yaml.load(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  for (const entry of expected.characters) {
    const filePath = path.join(SPRITES_ROOT, 'characters', entry.id, 'sheet.png');
    const raw = fs.readFileSync(filePath);
    const ours = portraitRenderer.decodePng(raw);
    const ref = PNG.sync.read(raw);
    assert.equal(ours.width, ref.width, `width mismatch for ${entry.id}`);
    assert.equal(ours.height, ref.height, `height mismatch for ${entry.id}`);
    assert.equal(Buffer.compare(Buffer.from(ours.data), ref.data), 0, `pixel mismatch for ${entry.id}`);
  }

  // Verify filter types 0..4 decode identically to pngjs.
  const w = 17;
  const h = 13;
  const sample = new Uint8Array(w * h * 4);
  for (let i = 0; i < sample.length; i++) {
    sample[i] = (i * 73 + 19) & 0xff;
  }
  for (const filterType of [0, 1, 2, 3, 4]) {
    const png = new PNG({ width: w, height: h });
    png.data.set(sample);
    const encoded = PNG.sync.write(png, { colorType: 6, filterType });
    const decoded = portraitRenderer.decodePng(encoded);
    assert.equal(decoded.width, w);
    assert.equal(decoded.height, h);
    assert.equal(Buffer.compare(Buffer.from(decoded.data), Buffer.from(sample)), 0, `filter ${filterType} failed`);
  }

  // Verify RGB (colorType 2) decode fallback.
  const rgbPng = new PNG({ width: 5, height: 4 });
  for (let i = 0; i < 5 * 4; i++) {
    rgbPng.data[i * 4] = (i * 11) & 0xff;
    rgbPng.data[i * 4 + 1] = (i * 23) & 0xff;
    rgbPng.data[i * 4 + 2] = (i * 37) & 0xff;
    rgbPng.data[i * 4 + 3] = 255;
  }
  const rgbBytes = PNG.sync.write(rgbPng, { colorType: 2, inputHasAlpha: true });
  const rgbDecoded = portraitRenderer.decodePng(rgbBytes);
  assert.equal(Buffer.compare(Buffer.from(rgbDecoded.data), rgbPng.data), 0);

  // Verify MAX_PNG_DIMENSION is tightened to 2048 and bad chunk CRCs are rejected.
  assert.equal(portraitRenderer.MAX_PNG_DIMENSION, 2048);

  const validSmall = portraitRenderer.encodePngRgba(new Uint8Array(4 * 4 * 4).fill(200), 4, 4);
  assert.equal(portraitRenderer.decodePng(validSmall).width, 4);

  // Flip a CRC bit in IHDR (bytes 29..32) -> must reject with CRC error.
  const badIhdrCrc = Buffer.from(validSmall);
  badIhdrCrc[32] ^= 0x01;
  assert.throws(() => portraitRenderer.decodePng(badIhdrCrc), /Invalid PNG chunk CRC for IHDR/);

  // Flip a payload byte inside IDAT -> must reject with CRC error.
  const badIdatCrc = Buffer.from(validSmall);
  const idatOffset = 8 + 12 + 13; // signature + IHDR chunk
  badIdatCrc[idatOffset + 8] ^= 0xff;
  assert.throws(() => portraitRenderer.decodePng(badIdatCrc), /Invalid PNG chunk CRC for IDAT/);
});

test('agentColor and teamName trim accents match TeamColor + AgentLayerRecords with distinct ETags', () => {
  portraitRenderer.clearPortraitCache();
  for (const color of ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan', 'unknown', '']) {
    assert.equal(portraitRenderer.harnessAccent(color), uiHarnessAccent(color));
  }
  for (const agent of [
    { agentColor: 'cyan', teamName: 'alpha' },
    { agentColor: 'red', teamName: null },
    { agentColor: 'not-a-color', teamName: 'council-team' },
    { agentColor: null, teamName: 'squad-west' },
    { agentColor: null, teamName: null },
  ]) {
    assert.equal(portraitRenderer.agentTrimAccent(agent), uiAgentTrimAccent(agent));
  }

  // `agent.claude.opus` has trimAnchors in roster-palettes.json, so harness/team trims recolor pixels and ETags.
  const solo = portraitRenderer.renderSpritePortrait({
    spriteId: 'agent.claude.opus',
    paletteKey: 'claude',
    variant: 0,
    size: 64,
  });
  const cyan = portraitRenderer.renderSpritePortrait({
    spriteId: 'agent.claude.opus',
    paletteKey: 'claude',
    variant: 0,
    agentColor: 'cyan',
    size: 64,
  });
  const red = portraitRenderer.renderSpritePortrait({
    spriteId: 'agent.claude.opus',
    paletteKey: 'claude',
    variant: 0,
    agentColor: 'red',
    size: 64,
  });
  const team = portraitRenderer.renderSpritePortrait({
    spriteId: 'agent.claude.opus',
    paletteKey: 'claude',
    variant: 0,
    teamName: 'research-council',
    size: 64,
  });
  assert.ok(solo && cyan && red && team);
  assert.notEqual(cyan.etag, solo.etag);
  assert.notEqual(cyan.etag, red.etag);
  assert.notEqual(team.etag, solo.etag);
  assert.notEqual(Buffer.compare(cyan.png, solo.png), 0);
  assert.notEqual(Buffer.compare(cyan.png, red.png), 0);

  // Also verify renderAgentPortrait forwards agentColor / teamName and stays distinct in cache + ETag.
  const agentSolo = portraitRenderer.renderAgentPortrait({
    model: 'claude-opus-5-5',
    provider: 'claude',
    agentId: 'trim-parity-agent',
    size: 64,
  });
  const agentBlue = portraitRenderer.renderAgentPortrait({
    model: 'claude-opus-5-5',
    provider: 'claude',
    agentId: 'trim-parity-agent',
    agentColor: 'blue',
    size: 64,
  });
  const agentTeam = portraitRenderer.renderAgentPortrait({
    model: 'claude-opus-5-5',
    provider: 'claude',
    agentId: 'trim-parity-agent',
    teamName: 'ops-team',
    size: 64,
  });
  assert.ok(agentSolo && agentBlue && agentTeam);
  assert.notEqual(agentBlue.etag, agentSolo.etag);
  assert.notEqual(agentTeam.etag, agentSolo.etag);
  assert.notEqual(agentBlue.etag, agentTeam.etag);
  assert.notEqual(Buffer.compare(agentBlue.png, agentSolo.png), 0);
});

test('all 40 characters render valid 64x64 and 32x32 PNGs with opaque pixels', () => {
  portraitRenderer.clearPortraitCache();
  const expected = yaml.load(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  assert.equal(expected.characters.length, 40);

  for (const entry of expected.characters) {
    for (const size of [64, 32]) {
      const rendered = portraitRenderer.renderSpritePortrait({
        spriteId: entry.id,
        paletteKey: entry.palette_layer,
        variant: 0,
        size,
      });
      assert.ok(rendered, `failed to render ${entry.id} at ${size}px`);
      assert.equal(rendered.spriteId, entry.id);
      assert.equal(rendered.assetVersion, expected.style.assetVersion);
      assert.equal(rendered.variant, 0);
      assert.match(rendered.etag, /^"sha256-[A-Za-z0-9_-]+"$/);

      const header = readPngHeader(rendered.png);
      assert.equal(header.width, size, `${entry.id} width`);
      assert.equal(header.height, size, `${entry.id} height`);
      assert.equal(header.bitDepth, 8);
      assert.equal(header.colorType, 6);
      assert.equal(header.interlace, 0);

      // Parse with independent pngjs decoder and verify non-empty opaque pixels.
      const decoded = PNG.sync.read(rendered.png);
      assert.equal(decoded.width, size);
      assert.equal(decoded.height, size);
      const opaque = countOpaquePixels(decoded.data);
      assert.ok(opaque >= 64, `${entry.id} at ${size}px has too few opaque pixels (${opaque})`);
    }
  }
});

test('model identity, effort ladders, .a/.b variants, and OKLab robe shift match ClaudeVille UI exactly', () => {
  const cases = [
    { model: 'claude-opus-5-5', provider: 'claude', effort: '', agentId: 'sess-opus-a' },
    { model: 'claude-opus-5-5', provider: 'claude', effort: '', agentId: 'sess-opus-b' },
    { model: 'gemini-4-neon', provider: 'antigravity', effort: 'xhigh', agentId: 'antigravity-conv-1' },
    { model: 'gpt-5.5', provider: 'codex', effort: 'none', agentId: 'codex-1' },
    { model: 'gpt-5.5', provider: 'codex', effort: 'high', agentId: 'codex-1' },
    { model: 'gpt-5.5', provider: 'codex', effort: 'xhigh', agentId: 'codex-1' },
    { model: 'gpt-5.5', provider: 'codex', effort: 'max', agentId: 'codex-1' },
    { model: 'deepseek-flash', provider: 'deepseek', effort: 'high', agentId: 'ds-1' },
    { model: 'deepseek-flash', provider: 'deepseek', effort: 'xhigh', agentId: 'ds-1' },
    { model: 'glm-5.4', provider: 'zai', effort: '', agentId: 'zai-hbt-th-1' },
    { model: 'claude-fable-5-2', provider: 'claude', effort: 'max', agentId: 'fable-1' },
    { model: 'gpt-6.2-astra', provider: 'codex', effort: 'xhigh', agentId: 'astra-1' },
  ];

  for (const c of cases) {
    const ours = portraitRenderer.getModelVisualIdentity(c.model, c.effort, c.provider, c.agentId);
    const ui = uiGetModelVisualIdentity(c.model, c.effort, c.provider, c.agentId);
    assert.equal(ours.spriteId, ui.spriteId, `spriteId mismatch for ${JSON.stringify(c)}`);
    assert.equal(ours.paletteKey, ui.paletteKey, `paletteKey mismatch for ${JSON.stringify(c)}`);

    const ourProvKey = portraitRenderer.providerPaletteKey(c);
    const uiProvKey = uiProviderPaletteKey(c);
    assert.equal(ourProvKey, uiProvKey);
    assert.equal(
      portraitRenderer.agentPaletteVariant(c.agentId, c.model, ourProvKey),
      uiAgentPaletteVariant(c.agentId, c.model, uiProvKey),
    );
  }

  // Verify GPT-5.5 effort ladder resolves distinct sprites.
  assert.equal(portraitRenderer.renderAgentPortrait({ model: 'gpt-5.5', provider: 'codex', effort: 'low', agentId: 'a' }).spriteId, 'agent.codex.gpt55');
  assert.equal(portraitRenderer.renderAgentPortrait({ model: 'gpt-5.5', provider: 'codex', effort: 'high', agentId: 'a' }).spriteId, 'agent.codex.gpt55.high');
  assert.equal(portraitRenderer.renderAgentPortrait({ model: 'gpt-5.5', provider: 'codex', effort: 'xhigh', agentId: 'a' }).spriteId, 'agent.codex.gpt55.xhigh');
  assert.equal(portraitRenderer.renderAgentPortrait({ model: 'gpt-5.5', provider: 'codex', effort: 'max', agentId: 'a' }).spriteId, 'agent.codex.gpt55.xhigh');

  // Verify .a/.b variant split occurs across distinct agentIds for multi-body models.
  for (const [model, provider, expectedSet] of [
    ['claude-opus-5-5', 'claude', ['agent.claude.opus', 'agent.claude.opus.b']],
    ['gemini-4-neon', 'antigravity', ['agent.gemini.neon', 'agent.gemini.neon.b']],
    ['glm-5.4', 'zai', ['agent.zai.glm', 'agent.zai.glm.b']],
  ]) {
    const seen = new Set();
    for (let i = 0; i < 40; i++) {
      const rendered = portraitRenderer.renderAgentPortrait({ model, provider, agentId: `agent-${i}`, size: 64 });
      seen.add(rendered.spriteId);
    }
    assert.deepEqual([...seen].sort(), expectedSet.slice().sort(), `expected .a/.b split for ${model}`);
  }

  // Verify OKLab robe shift parity with Compositor.js across all 12 variants.
  const sampleColors = [
    [98, 48, 130], // Sonnet violet
    [179, 46, 40], // GLM vermilion
    [34, 41, 69],  // GPT-5.5 navy
    [62, 70, 82],  // Gemini Neon slate
  ];
  for (let variant = 0; variant < 12; variant++) {
    assert.deepEqual(portraitRenderer.robeVariant(variant), uiRobeVariant(variant));
    for (const rgb of sampleColors) {
      assert.equal(portraitRenderer.robeHueTurn(variant, rgb), uiRobeHueTurn(variant, rgb));
      assert.deepEqual(portraitRenderer.shiftRobeColor(rgb, variant, rgb), uiShiftRobeColor(rgb, variant, rgb));
    }
  }

  // Verify OKLab robe shift produces distinct rendered PNGs across variants.
  for (const spriteId of ['agent.claude.sonnet', 'agent.claude.opus', 'agent.gemini.neon', 'agent.zai.glm', 'agent.codex.gpt55']) {
    const paletteKey = spriteId.split('.')[1];
    const v0 = portraitRenderer.renderSpritePortrait({ spriteId, paletteKey, variant: 0, size: 64 });
    const v5 = portraitRenderer.renderSpritePortrait({ spriteId, paletteKey, variant: 5, size: 64 });
    const v11 = portraitRenderer.renderSpritePortrait({ spriteId, paletteKey, variant: 11, size: 64 });
    assert.notEqual(v0.etag, v5.etag, `${spriteId} variant 0 vs 5 must differ`);
    assert.notEqual(v5.etag, v11.etag, `${spriteId} variant 5 vs 11 must differ`);
    assert.notEqual(Buffer.compare(v0.png, v5.png), 0);
  }
});

test('rendered portrait pixels match AgentLayerRecords recolor + AvatarCanvas nicheRoomy crop byte-for-byte', () => {
  const manifest = yaml.load(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const entry = manifest.characters.find((c) => c.id === 'agent.codex.gpt6astra.b');
  assert.ok(entry?.portraitFace, 'gpt6astra.b must have portraitFace');
  const variant = 7;
  const paletteKey = 'codex';
  const rendered = portraitRenderer.renderSpritePortrait({
    spriteId: entry.id,
    paletteKey,
    variant,
    size: 64,
  });
  const actualPng = PNG.sync.read(rendered.png);

  // Reference: decode sheet + material sidecar via pngjs, outline + recolor via AgentLayerRecords.
  const sheet = PNG.sync.read(fs.readFileSync(path.join(SPRITES_ROOT, 'characters', entry.id, 'sheet.png')));
  const mat = PNG.sync.read(fs.readFileSync(path.join(SPRITES_ROOT, 'characters', entry.id, 'sheet.material.png')));
  const cellSize = sheet.width / 8;
  const sy0 = 6 * cellSize;
  const cellData = new Uint8ClampedArray(cellSize * cellSize * 4);
  const matData = new Uint8ClampedArray(cellSize * cellSize * 4);
  for (let y = 0; y < cellSize; y++) {
    const rowOff = ((sy0 + y) * sheet.width) * 4;
    cellData.set(sheet.data.subarray(rowOff, rowOff + cellSize * 4), y * cellSize * 4);
    matData.set(mat.data.subarray(rowOff, rowOff + cellSize * 4), y * cellSize * 4);
  }
  // Bake 1-texel warm rim identical to Compositor.bakeSpriteOutline
  const solid = new Uint8Array(cellSize * cellSize);
  for (let i = 0; i < solid.length; i++) solid[i] = cellData[i * 4 + 3] >= 16 ? 1 : 0;
  for (let y = 0; y < cellSize; y++) {
    for (let x = 0; x < cellSize; x++) {
      const idx = y * cellSize + x;
      if (solid[idx]) continue;
      if (
        (x > 0 && solid[idx - 1])
        || (x + 1 < cellSize && solid[idx + 1])
        || (y > 0 && solid[idx - cellSize])
        || (y + 1 < cellSize && solid[idx + cellSize])
      ) {
        cellData.set([28, 20, 16, 128], idx * 4);
      }
    }
  }
  const identity = paletteIdentity(entry.id, variant, null, manifest.palettes[paletteKey].trim);
  const row = new Uint8Array(256);
  writePaletteRow(row, identity);
  recolorCellBytes(cellData, null, row, true, matData, entry.id);

  // NicheRoomy cropWindow at 2x
  const winW = Math.min(entry.portraitCrop.w, 32);
  const winH = Math.min(entry.portraitCrop.h, 32);
  const sx = Math.max(0, Math.min(cellSize - winW, entry.portraitFace.x - Math.floor(winW / 2)));
  const sy = Math.max(0, Math.min(cellSize - winH, entry.portraitFace.y - Math.floor(winH * 0.45)));
  const expectedOut = new Uint8Array(64 * 64 * 4);
  for (let py = 0; py < winH; py++) {
    for (let px = 0; px < winW; px++) {
      const s = ((sy + py) * cellSize + (sx + px)) * 4;
      for (let oy = 0; oy < 2; oy++) {
        for (let ox = 0; ox < 2; ox++) {
          const d = ((py * 2 + oy) * 64 + (px * 2 + ox)) * 4;
          expectedOut[d] = cellData[s];
          expectedOut[d + 1] = cellData[s + 1];
          expectedOut[d + 2] = cellData[s + 2];
          expectedOut[d + 3] = cellData[s + 3];
        }
      }
    }
  }

  assert.equal(Buffer.compare(actualPng.data, Buffer.from(expectedOut)), 0);
});

test('path traversal and malicious inputs are rejected cleanly', () => {
  const maliciousSpriteIds = [
    '',
    '../server.js',
    '../../etc/passwd',
    'agent.claude.opus/../../server.js',
    'agent..claude.opus',
    'agent.claude.opus\0.png',
    'agent.nonexistent.sprite',
    'building.command',
    'agent/claude/opus',
    'agent.claude.opus\\..\\..\\server.js',
  ];
  for (const spriteId of maliciousSpriteIds) {
    assert.equal(
      portraitRenderer.renderSpritePortrait({ spriteId, size: 64 }),
      null,
      `malicious spriteId must return null: ${JSON.stringify(spriteId)}`,
    );
  }

  const maliciousQueries = [
    { model: '../../etc/passwd', provider: '' },
    { model: '', provider: '../../etc/passwd' },
    { model: 'unknown-xyz-model', provider: 'unknown-provider' },
    { model: '\0\r\n', provider: '../..', effort: '../../../', agentId: '../../etc/passwd' },
  ];
  for (const q of maliciousQueries) {
    assert.equal(portraitRenderer.renderAgentPortrait(q), null);
  }
});

test('LRU cache returns stable Buffer/ETag on hit and stays bounded at 256 entries', () => {
  portraitRenderer.clearPortraitCache();
  const first = portraitRenderer.renderAgentPortrait({
    model: 'claude-opus-5-5',
    provider: 'claude',
    agentId: 'cache-test-1',
    size: 64,
  });
  const second = portraitRenderer.renderAgentPortrait({
    model: 'claude-opus-5-5',
    provider: 'claude',
    agentId: 'cache-test-1',
    size: 64,
  });
  assert.ok(first && second);
  assert.equal(first, second, 'cache hit must return cached record');
  assert.equal(first.png, second.png, 'cache hit must reuse PNG Buffer');
  assert.equal(first.etag, second.etag);

  // Render > 256 distinct (sprite, variant, size) keys to exercise LRU eviction.
  const expected = yaml.load(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  let generated = 0;
  for (const entry of expected.characters) {
    for (let variant = 0; variant < 8; variant++) {
      portraitRenderer.renderSpritePortrait({
        spriteId: entry.id,
        paletteKey: entry.palette_layer,
        variant,
        size: 64,
      });
      generated++;
    }
  }
  assert.ok(generated > portraitRenderer.MAX_PORTRAIT_CACHE_ENTRIES);
  const stats = portraitRenderer.getPortraitCacheStats();
  assert.equal(stats.portraits, portraitRenderer.MAX_PORTRAIT_CACHE_ENTRIES);
});

test('live HTTP server endpoints: /api/portrait/status, /api/portrait, 304 ETag, security guards, and Hobotnica canonical ID + ingest ack', async () => {
  const tmpHome = makeTempDir('claudeville-portrait-http-');
  const bridgeToken = 'portrait-test-bridge-token-0123456789';
  const secretsDir = path.join(tmpHome, '.local', 'share', 'hobotnica', 'userdata', 'secrets');
  const tokenFile = path.join(secretsDir, 'claudeville-bridge-token');
  fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenFile, `${bridgeToken}\n`, { mode: 0o600 });
  fs.chmodSync(tokenFile, 0o600);

  const server = await startIsolatedServer({ home: tmpHome });
  try {
    // 1. GET /api/portrait/status
    const statusRes = await httpRequest(server.port, { pathname: '/api/portrait/status' });
    assert.equal(statusRes.statusCode, 200);
    assert.equal(statusRes.headers['cache-control'], 'no-store');
    const statusJson = JSON.parse(statusRes.text);
    assert.equal(statusJson.ok, true);
    assert.equal(statusJson.portraitApi, true);
    assert.equal(statusJson.spriteCount, 40);
    assert.match(statusJson.claudevilleBootId, /^[0-9a-f]{16}$/);
    assert.ok(statusJson.assetVersion && statusJson.assetVersion !== 'unknown');

    // 2. GET /api/portrait (64x64 default & 32x32) for unresolved fallback identity
    const p64 = await httpRequest(server.port, {
      pathname: '/api/portrait?model=claude-opus-5-5&provider=claude&agentId=http-agent-1',
    });
    assert.equal(p64.statusCode, 200);
    assert.equal(p64.headers['content-type'], 'image/png');
    assert.equal(Number(p64.headers['content-length']), p64.buffer.length);
    assert.equal(p64.headers['cache-control'], 'private, no-cache');
    assert.equal(p64.headers['x-claudeville-identity'], 'fallback');
    assert.equal(p64.headers['x-content-type-options'], 'nosniff');
    assert.equal(p64.headers['x-claudeville-asset-version'], statusJson.assetVersion);
    assert.match(p64.headers['x-claudeville-sprite-id'], /^agent\.claude\.opus(?:\.b)?$/);
    assert.match(p64.headers['x-claudeville-variant'], /^(?:[0-9]|1[01])$/);
    assert.match(p64.headers.etag, /^"sha256-[A-Za-z0-9_-]+"$/);
    const hdr64 = readPngHeader(p64.buffer);
    assert.equal(hdr64.width, 64);
    assert.equal(hdr64.height, 64);

    const p32 = await httpRequest(server.port, {
      pathname: '/api/portrait?model=gemini-4-neon&provider=antigravity&agentId=http-agent-2&size=32',
    });
    assert.equal(p32.statusCode, 200);
    const hdr32 = readPngHeader(p32.buffer);
    assert.equal(hdr32.width, 32);
    assert.equal(hdr32.height, 32);

    // 3. HEAD /api/portrait
    const headRes = await httpRequest(server.port, {
      method: 'HEAD',
      pathname: '/api/portrait?model=claude-opus-5-5&provider=claude&agentId=http-agent-1',
    });
    assert.equal(headRes.statusCode, 200);
    assert.equal(headRes.buffer.length, 0);
    assert.equal(Number(headRes.headers['content-length']), p64.buffer.length);
    assert.equal(headRes.headers.etag, p64.headers.etag);

    // 4. Conditional GET 304 If-None-Match
    const notModified = await httpRequest(server.port, {
      pathname: '/api/portrait?model=claude-opus-5-5&provider=claude&agentId=http-agent-1',
      headers: { 'If-None-Match': p64.headers.etag },
    });
    assert.equal(notModified.statusCode, 304);
    assert.equal(notModified.buffer.length, 0);
    assert.equal(notModified.headers.etag, p64.headers.etag);

    // 5. Unknown sprite -> 404 JSON
    const missing = await httpRequest(server.port, {
      pathname: '/api/portrait?model=nonexistent-foo-bar',
    });
    assert.equal(missing.statusCode, 404);
    assert.deepEqual(JSON.parse(missing.text), { error: 'portrait_not_found' });

    // 6. Security guards: bad Host (421), cross-origin Origin (403), wrong method (405)
    const badHost = await httpRequest(server.port, {
      pathname: '/api/portrait?model=claude-opus-5-5&provider=claude',
      host: 'attacker.example',
    });
    assert.equal(badHost.statusCode, 421);

    const badHostStatus = await httpRequest(server.port, {
      pathname: '/api/portrait/status',
      host: 'attacker.example',
    });
    assert.equal(badHostStatus.statusCode, 421);

    const hostileOrigin = await httpRequest(server.port, {
      pathname: '/api/portrait?model=claude-opus-5-5&provider=claude',
      origin: 'https://attacker.example',
    });
    assert.equal(hostileOrigin.statusCode, 403);

    const postMethod = await httpRequest(server.port, {
      method: 'POST',
      pathname: '/api/portrait',
      body: '{}',
    });
    assert.equal(postMethod.statusCode, 405);

    const optionsMethod = await httpRequest(server.port, {
      method: 'OPTIONS',
      pathname: '/api/portrait',
    });
    assert.equal(optionsMethod.statusCode, 405);

    // 7. POST /api/ingest/hobotnica ack includes portraitApi: true & assetVersion,
    //    and canonical ID resolution matches ClaudeVille's synthetic zai-hbt-* villager.
    const ingestRes = await httpRequest(server.port, {
      method: 'POST',
      pathname: '/api/ingest/hobotnica',
      headers: { Authorization: `Bearer ${bridgeToken}` },
      body: JSON.stringify({
        protocol: 'hobotnica-telemetry.v1',
        type: 'snapshot',
        instanceId: 'portrait-inst',
        bootId: 'portrait-boot-1',
        seq: 1,
        mode: 'dev',
        snapshotId: 'snap-portrait-1',
        chunkIndex: 0,
        totalChunks: 1,
        serverTimeMs: Date.now(),
        agents: [
          {
            key: 'agent-glm-1',
            subagentId: 'sub-glm-1',
            owningThreadId: 'th-glm-portrait',
            parentThreadId: null,
            childThreadId: null,
            origin: 'root',
            waveId: null,
            teamName: null,
            supersedes: null,
            role: 'worker',
            title: 'GLM Portrait Test',
            providerDriver: 'acp-registry',
            providerInstanceId: 'glm-agent',
            model: 'glm-5.4',
            nativeSessionId: null,
            cwd: tmpHome,
            projectName: 'portrait-smoke',
            turnState: 'working',
            phase: 'thinking',
            activeToolName: null,
            currentActivityLabel: 'Testing portrait parity',
            latestSnippet: null,
            workingSet: [],
            planProgress: null,
            tokenUsage: null,
            pendingActions: [],
            waitAudience: null,
            startedAtMs: Date.now() - 1000,
            updatedAtMs: Date.now(),
            completedAtMs: null,
          },
        ],
      }),
    });
    assert.equal(ingestRes.statusCode, 200);
    const ingestAck = JSON.parse(ingestRes.text);
    assert.equal(ingestAck.ok, true);
    assert.equal(ingestAck.portraitApi, true);
    assert.equal(ingestAck.assetVersion, statusJson.assetVersion);

    // Query by Hobotnica threadId+subagentId vs canonical ClaudeVille agentId `zai-hbt-th-glm-portrait`.
    const byThread = await httpRequest(server.port, {
      pathname: '/api/portrait?model=glm-5.4&provider=zai&threadId=th-glm-portrait&subagentId=sub-glm-1',
    });
    const byCanonical = await httpRequest(server.port, {
      pathname: '/api/portrait?model=glm-5.4&provider=zai&agentId=zai-hbt-th-glm-portrait',
    });
    assert.equal(byThread.statusCode, 200);
    assert.equal(byCanonical.statusCode, 200);
    assert.equal(byThread.headers['x-claudeville-identity'], 'matched');
    assert.equal(byCanonical.headers['x-claudeville-identity'], 'matched');
    assert.equal(byThread.headers['cache-control'], 'private, max-age=60');
    assert.equal(byCanonical.headers['cache-control'], 'private, max-age=60');
    assert.equal(byThread.headers['x-claudeville-sprite-id'], byCanonical.headers['x-claudeville-sprite-id']);
    assert.equal(byThread.headers['x-claudeville-variant'], byCanonical.headers['x-claudeville-variant']);
    assert.equal(byThread.headers.etag, byCanonical.headers.etag);
    assert.equal(Buffer.compare(byThread.buffer, byCanonical.buffer), 0);

    // Live-session metadata override: mismatched query model/provider yields to the matched live session.
    const overridden = await httpRequest(server.port, {
      pathname: '/api/portrait?model=claude-haiku-4-5&provider=claude&threadId=th-glm-portrait&subagentId=sub-glm-1',
    });
    assert.equal(overridden.statusCode, 200);
    assert.equal(overridden.headers['x-claudeville-identity'], 'matched');
    assert.equal(overridden.headers['x-claudeville-sprite-id'], byCanonical.headers['x-claudeville-sprite-id']);
    assert.equal(overridden.headers['x-claudeville-variant'], byCanonical.headers['x-claudeville-variant']);
    assert.equal(overridden.headers.etag, byCanonical.headers.etag);
    assert.equal(Buffer.compare(overridden.buffer, byCanonical.buffer), 0);
  } finally {
    await server.stop();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
