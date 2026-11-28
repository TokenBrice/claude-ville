// Pure-Node portrait renderer for ClaudeVille characters.
// Matches ModelVisualIdentity.js, Compositor.js, AgentLayerRecords.js, and
// AvatarCanvas.js pixel-for-pixel using only Node built-ins (zero runtime deps).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const {
  MODEL_DEFAULTS,
  findModelRow,
  normalizeModel,
} = require('../src/config/models.generated.cjs');

const realpathSync = fs.realpathSync.native || fs.realpathSync;

const SPRITES_ROOT = path.resolve(__dirname, '..', 'assets', 'sprites');
const MANIFEST_PATH = path.join(SPRITES_ROOT, 'manifest.yaml');
const ROSTER_PALETTES_PATH = path.join(SPRITES_ROOT, 'characters', 'roster-palettes.json');
const CHARACTERS_ROOT = path.join(SPRITES_ROOT, 'characters');
const CHARACTERS_REAL_ROOT = fs.existsSync(CHARACTERS_ROOT) ? realpathSync(CHARACTERS_ROOT) : CHARACTERS_ROOT;

const SAFE_SPRITE_ID_RE = /^agent(?:\.[a-z0-9_-]+)+$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const EMPTY_BUFFER = Buffer.alloc(0);
const MAX_PNG_DIMENSION = 2048;

const DIRECTIONS_COUNT = 8;
const IDLE_SOUTH_ROW = 6;
const OUTLINE_RGB = Object.freeze([28, 20, 16]);
const OUTLINE_ALPHA = 128;
const DAY_RIM_ALPHA = 245;
const OPAQUE_ALPHA = 16;
const PALETTE_TOLERANCE = 12;

const ROBE_VALUE_STEPS = Object.freeze([1, 1.1, 0.9, 1.2]);
const ROBE_HUE_BANDS = Object.freeze([0, 16, -16]);
const ROBE_HUE_LIMIT_DEG = 18;
const ROBE_VARIANT_COUNT = ROBE_VALUE_STEPS.length * ROBE_HUE_BANDS.length;
const ROBE_TURN_CHROMA = 0.09;
const ROBE_CHROMA_FLOOR = 0.09;
const ROBE_CHROMA_LIFT_MAX = 0.04;
const ROBE_VARIANTS = Object.freeze(Array.from({ length: ROBE_VARIANT_COUNT }, (_, index) => Object.freeze({
  value: ROBE_VALUE_STEPS[index % ROBE_VALUE_STEPS.length],
  hue: Math.max(-ROBE_HUE_LIMIT_DEG, Math.min(ROBE_HUE_LIMIT_DEG,
    ROBE_HUE_BANDS[Math.floor(index / ROBE_VALUE_STEPS.length)])),
})));

const CODEX_GPT55_SPRITE_BY_EFFORT = Object.freeze({
  high: 'agent.codex.gpt55.high',
  xhigh: 'agent.codex.gpt55.xhigh',
});
const DEEPSEEK_FLASH_SPRITE_BY_EFFORT = Object.freeze({
  high: 'agent.deepseek.flash.high',
  xhigh: 'agent.deepseek.flash.xhigh',
});
const PROVIDER_BASE_SPRITES = Object.freeze(Object.fromEntries(
  Object.entries(MODEL_DEFAULTS).map(([provider, identity]) => [provider, identity.spriteId]),
));

const MAX_PORTRAIT_CACHE_ENTRIES = 256;
const MAX_IDLE_CELL_CACHE_ENTRIES = 64;

// ─── CRC32 + Pure-Node PNG Decode / Encode ─────────────────────────────────

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer, start = 0, end = buffer.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) {
    c = CRC32_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Invalid PNG signature');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let sawIhdr = false;
  let sawIend = false;
  let plte = null;
  let trns = null;
  const idatChunks = [];

  let offset = 8;
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) {
      throw new Error(`Truncated PNG chunk ${type}`);
    }
    const expectedCrc = buf.readUInt32BE(dataEnd);
    const actualCrc = crc32(buf, offset + 4, dataEnd);
    if (actualCrc !== expectedCrc) {
      throw new Error(`Invalid PNG chunk CRC for ${type}`);
    }

    if (type === 'IHDR') {
      if (length !== 13) throw new Error('Invalid IHDR length');
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
      const compression = buf[dataStart + 10];
      const filter = buf[dataStart + 11];
      const interlace = buf[dataStart + 12];
      if (width <= 0 || height <= 0 || width > MAX_PNG_DIMENSION || height > MAX_PNG_DIMENSION) {
        throw new Error(`Unsupported PNG dimensions ${width}x${height}`);
      }
      if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${bitDepth}`);
      if (compression !== 0 || filter !== 0) throw new Error('Unsupported PNG compression/filter method');
      if (interlace !== 0) throw new Error('Interlaced PNG is not supported');
      sawIhdr = true;
    } else if (type === 'PLTE') {
      plte = buf.subarray(dataStart, dataEnd);
    } else if (type === 'tRNS') {
      trns = buf.subarray(dataStart, dataEnd);
    } else if (type === 'IDAT') {
      idatChunks.push(buf.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      sawIend = true;
      break;
    }

    offset = dataEnd + 4;
  }

  if (!sawIhdr || !sawIend || idatChunks.length === 0) {
    throw new Error('Incomplete PNG stream');
  }

  let bpp;
  if (colorType === 6) bpp = 4;
  else if (colorType === 2) bpp = 3;
  else if (colorType === 4) bpp = 2;
  else if (colorType === 0) bpp = 1;
  else if (colorType === 3) {
    if (!plte || plte.length < 3) throw new Error('Indexed PNG missing PLTE');
    bpp = 1;
  } else {
    throw new Error(`Unsupported PNG color type ${colorType}`);
  }

  const stride = width * bpp;
  const expectedRawBytes = height * (1 + stride);
  const compressed = idatChunks.length === 1 ? idatChunks[0] : Buffer.concat(idatChunks);
  const inflated = zlib.inflateSync(compressed, { maxOutputLength: expectedRawBytes + 64 });
  if (inflated.length < expectedRawBytes) {
    throw new Error('Truncated PNG image data');
  }

  const rgba = new Uint8Array(width * height * 4);
  let prevRow = new Uint8Array(stride);
  let currRow = new Uint8Array(stride);

  const trnsGray = colorType === 0 && trns && trns.length >= 2 ? trns.readUInt16BE(0) : -1;
  const trnsRgb = colorType === 2 && trns && trns.length >= 6
    ? [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)]
    : null;

  for (let y = 0; y < height; y++) {
    const srcStart = y * (1 + stride);
    const filterType = inflated[srcStart];
    const rowDataStart = srcStart + 1;

    if (filterType === 0) {
      currRow.set(inflated.subarray(rowDataStart, rowDataStart + stride));
    } else if (filterType === 1) {
      for (let x = 0; x < stride; x++) {
        const left = x >= bpp ? currRow[x - bpp] : 0;
        currRow[x] = (inflated[rowDataStart + x] + left) & 0xff;
      }
    } else if (filterType === 2) {
      for (let x = 0; x < stride; x++) {
        currRow[x] = (inflated[rowDataStart + x] + prevRow[x]) & 0xff;
      }
    } else if (filterType === 3) {
      for (let x = 0; x < stride; x++) {
        const left = x >= bpp ? currRow[x - bpp] : 0;
        const up = prevRow[x];
        currRow[x] = (inflated[rowDataStart + x] + ((left + up) >> 1)) & 0xff;
      }
    } else if (filterType === 4) {
      for (let x = 0; x < stride; x++) {
        const left = x >= bpp ? currRow[x - bpp] : 0;
        const up = prevRow[x];
        const upLeft = x >= bpp ? prevRow[x - bpp] : 0;
        currRow[x] = (inflated[rowDataStart + x] + paethPredictor(left, up, upLeft)) & 0xff;
      }
    } else {
      throw new Error(`Unsupported PNG scanline filter ${filterType}`);
    }

    const dstRowStart = y * width * 4;
    if (colorType === 6) {
      rgba.set(currRow, dstRowStart);
    } else if (colorType === 2) {
      for (let x = 0; x < width; x++) {
        const s = x * 3;
        const d = dstRowStart + x * 4;
        const r = currRow[s];
        const g = currRow[s + 1];
        const b = currRow[s + 2];
        rgba[d] = r;
        rgba[d + 1] = g;
        rgba[d + 2] = b;
        rgba[d + 3] = (trnsRgb && r === trnsRgb[0] && g === trnsRgb[1] && b === trnsRgb[2]) ? 0 : 255;
      }
    } else if (colorType === 4) {
      for (let x = 0; x < width; x++) {
        const s = x * 2;
        const d = dstRowStart + x * 4;
        const gray = currRow[s];
        rgba[d] = gray;
        rgba[d + 1] = gray;
        rgba[d + 2] = gray;
        rgba[d + 3] = currRow[s + 1];
      }
    } else if (colorType === 0) {
      for (let x = 0; x < width; x++) {
        const d = dstRowStart + x * 4;
        const gray = currRow[x];
        rgba[d] = gray;
        rgba[d + 1] = gray;
        rgba[d + 2] = gray;
        rgba[d + 3] = gray === trnsGray ? 0 : 255;
      }
    } else if (colorType === 3) {
      for (let x = 0; x < width; x++) {
        const idx = currRow[x];
        const p = idx * 3;
        const d = dstRowStart + x * 4;
        rgba[d] = p + 2 < plte.length ? plte[p] : 0;
        rgba[d + 1] = p + 2 < plte.length ? plte[p + 1] : 0;
        rgba[d + 2] = p + 2 < plte.length ? plte[p + 2] : 0;
        rgba[d + 3] = trns && idx < trns.length ? trns[idx] : 255;
      }
    }

    const tmp = prevRow;
    prevRow = currRow;
    currRow = tmp;
  }

  return { width, height, data: rgba };
}

function makePngChunk(type, data) {
  const chunk = Buffer.allocUnsafe(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, 'ascii');
  if (data.length > 0) data.copy(chunk, 8);
  const checksum = crc32(chunk, 4, 8 + data.length);
  chunk.writeUInt32BE(checksum, 8 + data.length);
  return chunk;
}

function encodePngRgba(rgba, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('Invalid PNG output dimensions');
  }
  const rowBytes = width * 4;
  if (rgba.length !== height * rowBytes) {
    throw new Error('RGBA buffer length does not match dimensions');
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filter
  ihdr[12] = 0; // non-interlaced

  const raw = Buffer.allocUnsafe(height * (1 + rowBytes));
  for (let y = 0; y < height; y++) {
    const dst = y * (1 + rowBytes);
    raw[dst] = 0; // filter None
    const srcStart = y * rowBytes;
    raw.set(rgba.subarray(srcStart, srcStart + rowBytes), dst + 1);
  }

  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    PNG_SIGNATURE,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', idat),
    makePngChunk('IEND', EMPTY_BUFFER),
  ]);
}

// ─── Zero-Dependency Manifest Parser ────────────────────────────────────────

function stripYamlScalar(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text.replace(/\s+#.*$/, '').trim();
}

function normalizeCrop(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const w = Number(raw.w);
  const h = Number(raw.h);
  if (![x, y, w, h].every(Number.isInteger)) return null;
  if (x < 0 || y < 0 || w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

function normalizeFace(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const x = Number(raw.x);
  const y = Number(raw.y);
  if (![x, y].every(Number.isInteger) || x < 0 || y < 0) return null;
  return { x, y };
}

function parseInlineIntMap(text) {
  const match = text.match(/\{([^}]*)\}/);
  if (!match) return null;
  const out = {};
  for (const part of match[1].split(',')) {
    const kv = part.match(/^\s*([a-zA-Z0-9_]+)\s*:\s*(-?\d+)\s*$/);
    if (kv) out[kv[1]] = Number(kv[2]);
  }
  return out;
}

function parseHexList(text) {
  const matches = String(text || '').match(/#[0-9a-fA-F]{6}/g);
  return matches ? matches.map((hex) => hex.toLowerCase()) : [];
}

function parseSpriteManifest(yamlText) {
  let assetVersion = 'unknown';
  const characters = new Map();
  const palettes = {};

  const lines = String(yamlText || '').split(/\r?\n/);
  let section = null;
  let currentChar = null;
  let nestedField = null;
  let nestedMap = null;
  let currentPalette = null;
  let readingTrimList = false;

  const flushNested = () => {
    if (!currentChar || !nestedField || !nestedMap) {
      nestedField = null;
      nestedMap = null;
      return;
    }
    if (nestedField === 'portraitCrop') {
      currentChar.portraitCrop = normalizeCrop(nestedMap);
    } else if (nestedField === 'portraitFace') {
      currentChar.portraitFace = normalizeFace(nestedMap);
    }
    nestedField = null;
    nestedMap = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;

    const indent = line.length - line.trimStart().length;

    if (indent === 0) {
      flushNested();
      currentChar = null;
      currentPalette = null;
      readingTrimList = false;
      const topMatch = line.match(/^([a-zA-Z0-9_-]+):\s*(?:#.*)?$/);
      section = topMatch ? topMatch[1] : null;
      continue;
    }

    if (section === 'style') {
      const avMatch = line.match(/^\s+assetVersion:\s*(.+)$/);
      if (avMatch) {
        const parsed = stripYamlScalar(avMatch[1]);
        if (parsed) assetVersion = parsed;
      }
      continue;
    }

    if (section === 'palettes') {
      if (indent === 2) {
        readingTrimList = false;
        const palMatch = line.match(/^  ([a-zA-Z0-9_-]+):\s*(?:#.*)?$/);
        if (palMatch) {
          currentPalette = palMatch[1];
          palettes[currentPalette] = { trim: [] };
        }
      } else if (currentPalette && indent === 4) {
        const trimMatch = line.match(/^    trim:\s*(.*)$/);
        if (trimMatch) {
          const inlineHexes = parseHexList(trimMatch[1]);
          if (inlineHexes.length > 0) {
            palettes[currentPalette].trim = inlineHexes;
            readingTrimList = false;
          } else {
            readingTrimList = true;
          }
        } else {
          readingTrimList = false;
        }
      } else if (currentPalette && readingTrimList && indent >= 6) {
        const hexes = parseHexList(line);
        if (hexes.length > 0) palettes[currentPalette].trim.push(...hexes);
      }
      continue;
    }

    if (section === 'characters') {
      if (indent === 2) {
        flushNested();
        const idMatch = line.match(/^  -\s+id:\s*(.+)$/);
        if (idMatch) {
          const id = stripYamlScalar(idMatch[1]);
          if (id) {
            currentChar = {
              id,
              portraitCrop: null,
              portraitFace: null,
              paletteLayer: null,
            };
            characters.set(id, currentChar);
          } else {
            currentChar = null;
          }
        }
        continue;
      }

      if (!currentChar) continue;

      if (indent <= 4) {
        flushNested();
        if (indent === 4) {
          const cropMatch = line.match(/^    portraitCrop:\s*(.*)$/);
          if (cropMatch) {
            const inline = parseInlineIntMap(cropMatch[1]);
            if (inline) {
              currentChar.portraitCrop = normalizeCrop(inline);
            } else {
              nestedField = 'portraitCrop';
              nestedMap = {};
            }
            continue;
          }
          const faceMatch = line.match(/^    portraitFace:\s*(.*)$/);
          if (faceMatch) {
            const inline = parseInlineIntMap(faceMatch[1]);
            if (inline) {
              currentChar.portraitFace = normalizeFace(inline);
            } else {
              nestedField = 'portraitFace';
              nestedMap = {};
            }
            continue;
          }
          const layerMatch = line.match(/^    palette_layer:\s*(.+)$/);
          if (layerMatch) {
            const layer = stripYamlScalar(layerMatch[1]);
            if (layer) currentChar.paletteLayer = layer;
          }
        }
        continue;
      }

      if (nestedField && nestedMap && indent >= 6) {
        const kv = line.trim().match(/^([a-zA-Z0-9_]+):\s*(-?\d+)(?:\s+#.*)?$/);
        if (kv) nestedMap[kv[1]] = Number(kv[2]);
      }
    }
  }

  flushNested();
  return { assetVersion, characters, palettes };
}

// ─── ModelVisualIdentity Parity ─────────────────────────────────────────────

function signatureHash(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function providerPaletteKey(agent) {
  const provider = String(agent?.provider || '').toLowerCase();
  const model = String(agent?.model || '').toLowerCase();
  if (model.includes('deepseek')) return 'deepseek';
  if (model.includes('glm') || provider.includes('zai') || provider.includes('zhipu') || provider === 'glm') return 'zai';
  if (provider.includes('opencode')) return 'opencode';
  if (provider.includes('gemini') || model.includes('gemini')) return 'gemini';
  if (provider.includes('codex') || model.includes('codex') || model.includes('gpt')) return 'codex';
  if (provider.includes('claude') || model.includes('claude')) return 'claude';
  if (provider.includes('kimi') || model.includes('kimi')) return 'kimi';
  if (provider.includes('grok') || model.includes('grok')) return 'grok';
  if (provider.includes('antigravity') || provider === 'agy') return 'gemini';
  return 'default';
}

function inferredRegistryProvider(model, provider = '') {
  const normalizedModel = normalizeModel(model);
  if (normalizedModel.includes('deepseek')) return 'deepseek';
  if (normalizedModel.includes('glm')) return 'zai';
  if (normalizedModel.includes('gemini')) return 'gemini';
  if (normalizedModel.includes('codex') || normalizedModel.includes('gpt')) return 'codex';
  if (normalizedModel.includes('claude')) return 'claude';
  if (normalizedModel.includes('kimi')) return 'kimi';
  if (normalizedModel.includes('grok')) return 'grok';
  const normalizedProvider = String(provider || '').toLowerCase();
  if (normalizedProvider.includes('deepseek')) return 'deepseek';
  if (normalizedProvider.includes('zai') || normalizedProvider.includes('zhipu') || normalizedProvider === 'glm') return 'zai';
  if (normalizedProvider.includes('gemini') || normalizedProvider.includes('antigravity') || normalizedProvider === 'agy') return 'gemini';
  if (normalizedProvider.includes('codex') || normalizedProvider.includes('openai')) return 'codex';
  if (normalizedProvider.includes('claude')) return 'claude';
  if (normalizedProvider.includes('kimi')) return 'kimi';
  if (normalizedProvider.includes('grok')) return 'grok';
  return normalizedProvider;
}

function selectModelRow(model, provider = '') {
  const direct = findModelRow(model, provider);
  if (!direct.isDefault) return direct;

  const modelMatch = findModelRow(model);
  if (!modelMatch.isDefault) return modelMatch;

  const inferredProvider = inferredRegistryProvider(model, provider);
  if (inferredProvider && inferredProvider !== String(provider || '').toLowerCase()) {
    const inferred = findModelRow(model, inferredProvider);
    if (inferred.row) return inferred;
  }
  return direct;
}

function normalizeReasoningEffort(effort) {
  const normalized = String(effort || '').toLowerCase();
  if (!normalized || normalized === 'none') return normalized ? 'none' : null;
  if (normalized.includes('ultra')) return 'ultra';
  if (normalized === 'max' || normalized.includes('maximum')) return 'max';
  if (normalized.includes('xhigh') || normalized.includes('extra')) return 'xhigh';
  if (normalized.includes('high')) return 'high';
  if (normalized.includes('mid')) return 'medium';
  if (normalized.includes('medium')) return 'medium';
  if (normalized.includes('low')) return 'low';
  return normalized;
}

function normalizeCodexEffortTier(effortTier) {
  return effortTier === 'max' ? 'xhigh' : effortTier;
}

function agentBodySpriteId(spriteId, spriteVariants, agentId) {
  if (!Array.isArray(spriteVariants) || spriteVariants.length < 2) return spriteId;
  if (agentId === null || agentId === undefined || agentId === '') return spriteId;
  return spriteVariants[signatureHash(`${agentId}:body`) % spriteVariants.length];
}

function codexGpt55Sprite(effortTier) {
  return CODEX_GPT55_SPRITE_BY_EFFORT[effortTier] || 'agent.codex.gpt55';
}

function getModelVisualIdentity(model, effort, provider = '', agentId = null) {
  const { row } = selectModelRow(model, provider);
  const effortTier = normalizeReasoningEffort(effort);

  if (!row) {
    const paletteKey = providerPaletteKey({ model, provider });
    return {
      spriteId: PROVIDER_BASE_SPRITES[paletteKey] || null,
      paletteKey: paletteKey === 'default' ? null : paletteKey,
      effortTier,
      modelClass: 'standard',
    };
  }

  if (row.paletteKey !== 'codex') {
    const ladderSprite = row.spriteId === 'agent.deepseek.flash'
      ? DEEPSEEK_FLASH_SPRITE_BY_EFFORT[normalizeCodexEffortTier(effortTier)]
      : null;
    return {
      spriteId: ladderSprite || agentBodySpriteId(row.spriteId, row.spriteVariants, agentId),
      paletteKey: row.paletteKey,
      effortTier,
      modelClass: row.modelClass,
    };
  }

  const isCelestial = row.modelClass === 'gpt6astra'
    || row.modelClass === 'gpt56sol'
    || row.modelClass === 'gpt56terra'
    || row.modelClass === 'gpt56luna';
  const codexEffortTier = isCelestial ? effortTier : normalizeCodexEffortTier(effortTier);
  return {
    spriteId: row.modelClass === 'gpt55'
      ? codexGpt55Sprite(codexEffortTier)
      : agentBodySpriteId(row.spriteId, row.spriteVariants, agentId),
    paletteKey: row.paletteKey,
    effortTier: codexEffortTier,
    modelClass: row.modelClass,
  };
}

// ─── Compositor OKLab Palette Shifting Parity ───────────────────────────────

function variantIndex(variant) {
  return Math.max(0, Math.floor(Number(variant) || 0)) % ROBE_VARIANT_COUNT;
}

function robeVariant(variant) {
  return ROBE_VARIANTS[variantIndex(variant)];
}

function trimIndex(index, rampLength) {
  return (index % ROBE_VALUE_STEPS.length) % Math.max(1, rampLength);
}

function agentPaletteVariant(agentId, model, providerKey) {
  const text = `${agentId ?? ''}:${model || ''}:${providerKey || ''}`;
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % ROBE_VARIANT_COUNT;
}

function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(v) {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, c * 255));
}

function srgbToOklab(r8, g8, b8) {
  const r = srgbToLinear(r8);
  const g = srgbToLinear(g8);
  const b = srgbToLinear(b8);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

function oklabToLinear(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

function inGamut(linear) {
  return linear[0] >= -1e-4 && linear[0] <= 1 + 1e-4
    && linear[1] >= -1e-4 && linear[1] <= 1 + 1e-4
    && linear[2] >= -1e-4 && linear[2] <= 1 + 1e-4;
}

function oklabToSrgb(L, a, b) {
  let lin = oklabToLinear(L, a, b);
  for (let k = 0.85; k >= 0 && !inGamut(lin); k -= 0.15) {
    lin = oklabToLinear(L, a * k, b * k);
  }
  return [linearToSrgb(lin[0]), linearToSrgb(lin[1]), linearToSrgb(lin[2])];
}

function robeHueTurn(variant, source) {
  const { hue } = robeVariant(variant);
  if (hue === 0) return 0;
  const [, sa, sb] = srgbToOklab(source[0], source[1], source[2]);
  const scale = Math.min(1, ROBE_TURN_CHROMA / Math.max(1e-4, Math.hypot(sa, sb)));
  return Math.max(-ROBE_HUE_LIMIT_DEG, Math.min(ROBE_HUE_LIMIT_DEG, hue * scale));
}

function shiftRobeColor(rgb, variant, source = rgb) {
  const { value, hue } = robeVariant(variant);
  let r = rgb[0];
  let g = rgb[1];
  let b = rgb[2];
  if (hue !== 0) {
    const [L, A, B] = srgbToOklab(r, g, b);
    const theta = (robeHueTurn(variant, source) * Math.PI) / 180;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    let a = A * cos - B * sin;
    let bb = A * sin + B * cos;
    const [, sa, sb] = srgbToOklab(source[0], source[1], source[2]);
    const sc = Math.hypot(sa, sb);
    const lift = Math.min(ROBE_CHROMA_LIFT_MAX, Math.max(0, ROBE_CHROMA_FLOOR - sc));
    if (lift > 0 && sc > 1e-4) {
      a += lift * ((sa * cos - sb * sin) / sc);
      bb += lift * ((sa * sin + sb * cos) / sc);
    }
    [r, g, b] = oklabToSrgb(L, a, bb);
  }
  return [
    Math.max(0, Math.min(255, Math.round(r * value))),
    Math.max(0, Math.min(255, Math.round(g * value))),
    Math.max(0, Math.min(255, Math.round(b * value))),
  ];
}

// Mirrors claudeville/src/config/theme.js & TeamColor.js (FK-7) for trim accent parity.
const TEAM_HUES = Object.freeze([
  '#a26e88', '#8a814f', '#da9fa5', '#4d897e', '#c294b4',
  '#b38e5c', '#9c775e', '#7b7ba6', '#bcab92', '#bb9587',
]);

const HARNESS_HUES = Object.freeze({
  red: '#b56760',
  blue: '#5f86b8',
  green: '#6f9a5e',
  yellow: '#ad9a58',
  purple: '#9a7cc0',
  orange: '#b87a4c',
  pink: '#c27f9e',
  cyan: '#559fa8',
});

function stableTeamHash(value) {
  const text = String(value || '');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function harnessAccent(agentColor) {
  const key = String(agentColor || '').trim().toLowerCase();
  return Object.hasOwn(HARNESS_HUES, key) ? HARNESS_HUES[key] : null;
}

function agentTrimAccent(agent) {
  const harness = harnessAccent(agent?.agentColor);
  if (harness) return harness;
  const name = typeof agent?.teamName === 'string' ? agent.teamName.trim() : '';
  if (!name) return null;
  return TEAM_HUES[stableTeamHash(name) % TEAM_HUES.length];
}

function parseTrimColor(value) {
  if (!value || typeof value !== 'string') return null;
  const text = value.trim().replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(text)) return null;
  return [parseInt(text.slice(0, 2), 16), parseInt(text.slice(2, 4), 16), parseInt(text.slice(4, 6), 16)];
}

function normalizeTrimHex(value) {
  if (!value || typeof value !== 'string') return null;
  const text = value.trim().replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(text)) return null;
  return `#${text.toLowerCase()}`;
}

// ─── Cell Operations + AvatarCanvas Framing Parity ──────────────────────────

function isContainedPath(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function clearDetachedCodexWrenchSouthIdle(data, cellSize) {
  // Matches CodexEngineerGrips.js for col 0 (south), row 6: starts[0][0] = 65, height = 34.
  const startX = Math.floor((65 * cellSize) / 92);
  const endY = Math.min(cellSize, Math.ceil((34 * cellSize) / 92));
  for (let y = 0; y < endY; y++) {
    const rowOffset = y * cellSize * 4;
    data.fill(0, rowOffset + startX * 4, rowOffset + cellSize * 4);
  }
}

function bakeCellOutlineInPlace(data, cellSize) {
  const solid = new Uint8Array(cellSize * cellSize);
  for (let i = 0; i < solid.length; i++) {
    solid[i] = data[i * 4 + 3] >= OPAQUE_ALPHA ? 1 : 0;
  }
  for (let y = 0; y < cellSize; y++) {
    for (let x = 0; x < cellSize; x++) {
      const idx = y * cellSize + x;
      if (solid[idx]) continue;
      const touches = (x > 0 && solid[idx - 1])
        || (x + 1 < cellSize && solid[idx + 1])
        || (y > 0 && solid[idx - cellSize])
        || (y + 1 < cellSize && solid[idx + cellSize]);
      if (!touches) continue;
      const off = idx * 4;
      data[off] = OUTLINE_RGB[0];
      data[off + 1] = OUTLINE_RGB[1];
      data[off + 2] = OUTLINE_RGB[2];
      data[off + 3] = OUTLINE_ALPHA;
    }
  }
}

function recolorCellInPlace(data, modelPalette, robeColorMap, trimRgb, variant) {
  const idx = variantIndex(variant);
  const style = robeVariant(idx);
  const robeChanges = style.value !== 1 || style.hue !== 0;

  // Build shifted robe table (1-indexed to match AgentLayerRecords.writePaletteRow).
  let shiftedRobe = null;
  if (modelPalette && modelPalette.robeColors.length > 0) {
    shiftedRobe = new Array(modelPalette.robeColors.length + 1);
    for (let i = 0; i < modelPalette.robeColors.length; i++) {
      const [r, g, b, robeAnchorIdx, trimAnchorIdx] = modelPalette.robeColors[i];
      if (robeChanges) {
        shiftedRobe[i + 1] = shiftRobeColor([r, g, b], idx, modelPalette.robeAnchors[robeAnchorIdx]);
      } else if (trimAnchorIdx >= 0 && trimRgb) {
        const anchor = modelPalette.trimAnchors[trimAnchorIdx];
        shiftedRobe[i + 1] = [
          Math.max(0, Math.min(255, trimRgb[0] + r - anchor[0])),
          Math.max(0, Math.min(255, trimRgb[1] + g - anchor[1])),
          Math.max(0, Math.min(255, trimRgb[2] + b - anchor[2])),
        ];
      } else {
        shiftedRobe[i + 1] = [r, g, b];
      }
    }
  }

  const trimAnchors = modelPalette?.trimAnchors || [];
  const hasTrimSwap = Boolean(trimRgb && trimAnchors.length > 0);

  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const rim = alpha > 102 && alpha < 153 && Math.max(r, g, b) <= 40;
    if (alpha >= OPAQUE_ALPHA && !rim && modelPalette) {
      const key = (r << 16) | (g << 8) | b;
      const robeCode = robeColorMap ? robeColorMap.get(key) : undefined;
      if (robeCode && shiftedRobe) {
        const out = shiftedRobe[robeCode];
        data[i] = out[0];
        data[i + 1] = out[1];
        data[i + 2] = out[2];
      } else if (hasTrimSwap) {
        for (let k = 0; k < trimAnchors.length; k++) {
          const anchor = trimAnchors[k];
          if (
            Math.abs(r - anchor[0]) <= PALETTE_TOLERANCE
            && Math.abs(g - anchor[1]) <= PALETTE_TOLERANCE
            && Math.abs(b - anchor[2]) <= PALETTE_TOLERANCE
          ) {
            data[i] = Math.max(0, Math.min(255, r + trimRgb[0] - anchor[0]));
            data[i + 1] = Math.max(0, Math.min(255, g + trimRgb[1] - anchor[1]));
            data[i + 2] = Math.max(0, Math.min(255, b + trimRgb[2] - anchor[2]));
            break;
          }
        }
      }
    }
    if (rim) {
      data[i + 3] = DAY_RIM_ALPHA;
    }
  }
}

function cropWindow(crop, face, winW, winH, cellSize, anchor = 'face') {
  if (anchor === 'face' && face) {
    return {
      sx: Math.max(0, Math.min(cellSize - winW, face.x - Math.floor(winW / 2))),
      sy: Math.max(0, Math.min(cellSize - winH, face.y - Math.floor(winH * 0.45))),
    };
  }
  return {
    sx: crop.x + Math.floor((crop.w - winW) / 2),
    sy: anchor === 'face' ? crop.y + Math.floor((crop.h - winH) * 0.75) : crop.y,
  };
}

function opaqueCellBounds(data, cellSize) {
  let minX = cellSize;
  let minY = cellSize;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < cellSize; y++) {
    for (let x = 0; x < cellSize; x++) {
      if (data[(y * cellSize + x) * 4 + 3] <= OPAQUE_ALPHA) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (minX > maxX || minY > maxY) {
    return { minX: 0, minY: 0, maxX: cellSize - 1, maxY: cellSize - 1 };
  }
  return {
    minX: Math.max(0, minX - 2),
    minY: Math.max(0, minY - 2),
    maxX: Math.min(cellSize - 1, maxX + 2),
    maxY: Math.min(cellSize - 1, maxY + 1),
  };
}

function blitNearest(src, srcW, srcH, sx, sy, sw, sh, dst, dstW, dstH, dx, dy, scale) {
  for (let py = 0; py < sh; py++) {
    const srcY = sy + py;
    if (srcY < 0 || srcY >= srcH) continue;
    const dstY0 = dy + py * scale;
    for (let px = 0; px < sw; px++) {
      const srcX = sx + px;
      if (srcX < 0 || srcX >= srcW) continue;
      const sIdx = (srcY * srcW + srcX) * 4;
      const a = src[sIdx + 3];
      if (a === 0) continue;
      const r = src[sIdx];
      const g = src[sIdx + 1];
      const b = src[sIdx + 2];
      const dstX0 = dx + px * scale;
      for (let oy = 0; oy < scale; oy++) {
        const y = dstY0 + oy;
        if (y < 0 || y >= dstH) continue;
        for (let ox = 0; ox < scale; ox++) {
          const x = dstX0 + ox;
          if (x < 0 || x >= dstW) continue;
          const dIdx = (y * dstW + x) * 4;
          dst[dIdx] = r;
          dst[dIdx + 1] = g;
          dst[dIdx + 2] = b;
          dst[dIdx + 3] = a;
        }
      }
    }
  }
}

// ─── Metadata, Idle-Cell, and Encoded PNG LRU Caches ────────────────────────

let metadataCache = null;
const idleCellCache = new Map();
const portraitLruCache = new Map();

function statSignature(filePath) {
  try {
    const st = fs.statSync(filePath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'missing';
  }
}

function loadMetadata() {
  const sig = `${statSignature(MANIFEST_PATH)}|${statSignature(ROSTER_PALETTES_PATH)}`;
  if (metadataCache && metadataCache.sig === sig) {
    return metadataCache;
  }

  let manifest = { assetVersion: 'unknown', characters: new Map(), palettes: {} };
  try {
    manifest = parseSpriteManifest(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    // Keep safe defaults if manifest is temporarily unavailable.
  }

  let rosterModels = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(ROSTER_PALETTES_PATH, 'utf8'));
    if (parsed && typeof parsed.models === 'object' && parsed.models !== null) {
      rosterModels = parsed.models;
    }
  } catch {
    // Keep empty palette map if roster palettes file is unavailable.
  }

  const robeColorMaps = new Map();
  for (const [id, pal] of Object.entries(rosterModels)) {
    const map = new Map();
    if (Array.isArray(pal?.robeColors)) {
      for (let i = 0; i < pal.robeColors.length; i++) {
        const [r, g, b] = pal.robeColors[i];
        map.set((r << 16) | (g << 8) | b, i + 1);
      }
    }
    robeColorMaps.set(id, map);
  }

  // Invalidate derived caches whenever manifest or palettes change on disk.
  idleCellCache.clear();
  portraitLruCache.clear();

  metadataCache = {
    sig,
    manifest,
    rosterModels,
    robeColorMaps,
  };
  return metadataCache;
}

function resolveContainedSheetPath(spriteId) {
  if (typeof spriteId !== 'string' || !SAFE_SPRITE_ID_RE.test(spriteId)) return null;
  const candidate = path.resolve(CHARACTERS_ROOT, spriteId, 'sheet.png');
  if (!isContainedPath(CHARACTERS_ROOT, candidate)) return null;
  let realPath;
  try {
    realPath = realpathSync(candidate);
  } catch {
    return null;
  }
  if (!isContainedPath(CHARACTERS_REAL_ROOT, realPath)) return null;
  return realPath;
}

function loadIdleSouthCell(spriteId) {
  const cached = idleCellCache.get(spriteId);
  if (cached) {
    idleCellCache.delete(spriteId);
    idleCellCache.set(spriteId, cached);
    return cached;
  }

  const sheetPath = resolveContainedSheetPath(spriteId);
  if (!sheetPath) return null;

  let decoded;
  try {
    decoded = decodePng(fs.readFileSync(sheetPath));
  } catch {
    return null;
  }

  const cellSize = Math.floor(decoded.width / DIRECTIONS_COUNT);
  if (!Number.isFinite(cellSize) || cellSize <= 0) return null;
  const sy = IDLE_SOUTH_ROW * cellSize;
  if (sy + cellSize > decoded.height || cellSize > decoded.width) return null;

  const cellData = new Uint8Array(cellSize * cellSize * 4);
  for (let y = 0; y < cellSize; y++) {
    const srcStart = ((sy + y) * decoded.width) * 4;
    cellData.set(decoded.data.subarray(srcStart, srcStart + cellSize * 4), y * cellSize * 4);
  }
  if (spriteId === 'agent.codex.gpt54') {
    clearDetachedCodexWrenchSouthIdle(cellData, cellSize);
  }

  const record = { cellSize, data: cellData };
  while (idleCellCache.size >= MAX_IDLE_CELL_CACHE_ENTRIES) {
    const oldest = idleCellCache.keys().next().value;
    if (oldest === undefined) break;
    idleCellCache.delete(oldest);
  }
  idleCellCache.set(spriteId, record);
  return record;
}

function normalizePortraitSize(size) {
  if (size === undefined || size === null || size === '') return 64;
  const numeric = Number(size);
  if (!Number.isFinite(numeric) || numeric <= 0) return 64;
  return numeric <= 32 ? 32 : 64;
}

function renderSpritePortrait({
  spriteId,
  paletteKey = null,
  variant = 0,
  teamTrim = null,
  teamName = null,
  agentColor = null,
  size = 64,
} = {}) {
  if (typeof spriteId !== 'string' || !SAFE_SPRITE_ID_RE.test(spriteId)) return null;
  const targetSize = normalizePortraitSize(size);
  const metadata = loadMetadata();
  const assetVersion = metadata.manifest.assetVersion;
  const entry = metadata.manifest.characters.get(spriteId) || null;
  const resolvedPaletteKey = paletteKey || entry?.paletteLayer || spriteId.split('.')[1] || 'claude';
  const resolvedVariant = variantIndex(variant);
  const resolvedTeamTrim = normalizeTrimHex(teamTrim) || agentTrimAccent({ agentColor, teamName });

  const cacheKey = `${assetVersion}|${spriteId}|${resolvedPaletteKey}|${resolvedVariant}|${resolvedTeamTrim || ''}|${targetSize}`;
  const cached = portraitLruCache.get(cacheKey);
  if (cached) {
    portraitLruCache.delete(cacheKey);
    portraitLruCache.set(cacheKey, cached);
    return cached;
  }

  const idleCell = loadIdleSouthCell(spriteId);
  if (!idleCell) return null;

  const { cellSize, data: baseCell } = idleCell;
  const work = new Uint8Array(baseCell);
  bakeCellOutlineInPlace(work, cellSize);

  const trimRamp = metadata.manifest.palettes?.[resolvedPaletteKey]?.trim || [];
  const trimRgb = parseTrimColor(resolvedTeamTrim)
    || (trimRamp.length > 0
      ? parseTrimColor(trimRamp[trimIndex(resolvedVariant, trimRamp.length)])
      : null);
  const modelPalette = metadata.rosterModels[spriteId] || null;
  const robeColorMap = metadata.robeColorMaps.get(spriteId) || null;
  recolorCellInPlace(work, modelPalette, robeColorMap, trimRgb, resolvedVariant);

  const output = new Uint8Array(targetSize * targetSize * 4);
  const crop = entry?.portraitCrop || null;
  const face = entry?.portraitFace || null;

  if (crop && crop.x + crop.w <= cellSize && crop.y + crop.h <= cellSize) {
    const cropScale = targetSize === 64 ? 2 : 1;
    const winW = Math.min(crop.w, Math.floor(targetSize / cropScale));
    const winH = Math.min(crop.h, Math.floor(targetSize / cropScale));
    const { sx, sy } = cropWindow(crop, face, winW, winH, cellSize, 'face');
    const drawW = winW * cropScale;
    const drawH = winH * cropScale;
    const dx = Math.round((targetSize - drawW) / 2);
    const dy = targetSize - drawH;
    blitNearest(work, cellSize, cellSize, sx, sy, winW, winH, output, targetSize, targetSize, dx, dy, cropScale);
  } else {
    const bounds = opaqueCellBounds(work, cellSize);
    const sourceW = bounds.maxX - bounds.minX + 1;
    const sourceH = bounds.maxY - bounds.minY + 1;
    const fit = Math.min(targetSize / sourceW, targetSize / sourceH);
    const scale = Math.max(1, Math.min(4, Math.floor(fit)));
    const drawW = sourceW * scale;
    const drawH = sourceH * scale;
    const dx = Math.round((targetSize - drawW) / 2);
    const dy = drawH > targetSize ? 1 : Math.round((targetSize - drawH) / 2);
    blitNearest(
      work,
      cellSize,
      cellSize,
      bounds.minX,
      bounds.minY,
      sourceW,
      sourceH,
      output,
      targetSize,
      targetSize,
      dx,
      dy,
      scale,
    );
  }

  const png = encodePngRgba(output, targetSize, targetSize);
  const hash = crypto.createHash('sha256').update(png);
  if (resolvedTeamTrim) {
    hash.update('\0trim:');
    hash.update(resolvedTeamTrim);
  }
  const digest = hash.digest('base64url');
  const result = {
    png,
    etag: `"sha256-${digest}"`,
    spriteId,
    assetVersion,
    variant: resolvedVariant,
    trimAccent: resolvedTeamTrim,
  };

  while (portraitLruCache.size >= MAX_PORTRAIT_CACHE_ENTRIES) {
    const oldest = portraitLruCache.keys().next().value;
    if (oldest === undefined) break;
    portraitLruCache.delete(oldest);
  }
  portraitLruCache.set(cacheKey, result);
  return result;
}

function renderAgentPortrait({
  model = '',
  provider = '',
  effort = '',
  agentId = null,
  teamName = null,
  agentColor = null,
  teamTrim = null,
  size = 64,
} = {}) {
  const identity = getModelVisualIdentity(model, effort, provider, agentId);
  if (!identity.spriteId) return null;
  const providerKey = providerPaletteKey({ model, provider });
  const paletteKey = identity.paletteKey || (providerKey !== 'default' ? providerKey : null);
  const variant = agentPaletteVariant(agentId, model, providerKey);
  return renderSpritePortrait({
    spriteId: identity.spriteId,
    paletteKey,
    variant,
    teamTrim,
    teamName,
    agentColor,
    size,
  });
}

function getPortraitStatus() {
  const metadata = loadMetadata();
  return {
    ok: true,
    portraitApi: true,
    assetVersion: metadata.manifest.assetVersion,
    spriteCount: metadata.manifest.characters.size,
  };
}

function clearPortraitCache() {
  metadataCache = null;
  idleCellCache.clear();
  portraitLruCache.clear();
}

function getPortraitCacheStats() {
  return {
    portraits: portraitLruCache.size,
    portraitLimit: MAX_PORTRAIT_CACHE_ENTRIES,
    idleCells: idleCellCache.size,
  };
}

module.exports = {
  IDLE_SOUTH_ROW,
  MAX_PNG_DIMENSION,
  MAX_PORTRAIT_CACHE_ENTRIES,
  SAFE_SPRITE_ID_RE,
  ROBE_VARIANT_COUNT,
  renderAgentPortrait,
  renderSpritePortrait,
  getPortraitStatus,
  clearPortraitCache,
  getPortraitCacheStats,
  getModelVisualIdentity,
  agentBodySpriteId,
  agentPaletteVariant,
  agentTrimAccent,
  harnessAccent,
  providerPaletteKey,
  normalizeReasoningEffort,
  robeVariant,
  robeHueTurn,
  shiftRobeColor,
  srgbToOklab,
  oklabToSrgb,
  cropWindow,
  parseSpriteManifest,
  decodePng,
  encodePngRgba,
  normalizePortraitSize,
};
