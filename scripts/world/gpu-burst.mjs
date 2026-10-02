#!/usr/bin/env node
// Timer-independent throughput of the REAL resident frame per ladder level
// (plan 0.1, V2). For each case it stops the app loop, renders the frame the
// app last built (`renderer._gpuRenderContext`) N times back to back at a
// forced level, drains the GPU with a 1-px readPixels, and reports the median
// of R reps. Wall per frame is max(CPU submit, GPU execution); CPU per frame is
// the submit share. Levels 0/1/2 by default; `--debug-load` adds an arm with
// the injected present-pass load at every level. Runs against an isolated
// server unless `--url` is given; never touches port 4000 on its own.
import { writeFileSync } from 'node:fs';
import {
  hostSnapshot,
  launchBenchBrowser,
  median,
  openWorld,
  parseConditions,
  parseViewport,
  poseWorld,
  resolveServer,
  round,
} from '../smoke/support/world-bench.mjs';

function usage() {
  console.log(`Usage: node scripts/world/gpu-burst.mjs [options]

Options:
  --url=<url>             Existing ClaudeVille server (default: an isolated server)
  --scenario=<ids>        Comma-separated sim scenarios (default: dense-24-agents)
  --viewport=<list>       Comma-separated WIDTHxHEIGHT (default: 1920x1080,5120x1440)
  --dpr=<n>               Device scale factor (default: 1)
  --zoom=<list>           Comma-separated zoom tiers, or survey (default: 1,2)
  --conditions=<list>     Comma-separated hour:weather, weather clear|rain|storm (default: 22:clear)
  --levels=<list>         Forced ladder levels (default: 0,1,2)
  --frames=<n>            Frames per rep, rendered back to back (default: 60)
  --reps=<n>              Reps per level; the median is reported (default: 4)
  --contexts=<n>          Fresh browser contexts per case (default: 3)
  --settle-seconds=<n>    Wait after posing before measuring (default: 8)
  --debug-load=<passes>   Also measure each level with this many injected passes
  --renderer=<mode>       Force the World backend: webgl | webgpu (default: the app's
                          default, WebGPU in Chromium; pass webgl to measure WebGL2)
  --out=<file>            Write the full JSON report here as well
  --headed                Show the Chromium window
  --help                  Print this help

Output: one JSON line per case and context, then a summary with the median
wall ms per level across contexts. Take receipts on a quiet host (load < 4).`);
}

function parseArgs(argv) {
  const options = {
    url: null,
    scenarios: ['dense-24-agents'],
    viewports: ['1920x1080', '5120x1440'].map(parseViewport),
    dpr: 1,
    zooms: ['1', '2'],
    conditions: parseConditions('22:clear'),
    levels: [0, 1, 2],
    frames: 60,
    reps: 4,
    contexts: 3,
    settleSeconds: 8,
    debugLoad: 0,
    renderer: null,
    out: null,
    headed: false,
  };
  const list = value => String(value).split(',').map(item => item.trim()).filter(Boolean);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help') {
      usage();
      process.exit(0);
    }
    if (arg === '--headed') {
      options.headed = true;
      continue;
    }
    const [flag, inline] = arg.split('=', 2);
    const value = inline ?? argv[++index];
    if (value == null || value === '') throw new Error(`Missing value for ${flag}`);
    switch (flag) {
      case '--url': options.url = value; break;
      case '--scenario': options.scenarios = list(value); break;
      case '--viewport': options.viewports = list(value).map(parseViewport); break;
      case '--dpr': options.dpr = Number(value); break;
      case '--zoom': options.zooms = list(value); break;
      case '--conditions': options.conditions = parseConditions(value); break;
      case '--levels': options.levels = list(value).map(Number); break;
      case '--frames': options.frames = Number(value); break;
      case '--reps': options.reps = Number(value); break;
      case '--contexts': options.contexts = Number(value); break;
      case '--settle-seconds': options.settleSeconds = Number(value); break;
      case '--debug-load': options.debugLoad = Number(value); break;
      case '--renderer': options.renderer = value; break;
      case '--out': options.out = value; break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.levels.length || options.levels.some(level => ![0, 1, 2].includes(level))) {
    throw new Error('levels must be a subset of 0,1,2');
  }
  for (const key of ['frames', 'reps', 'contexts']) {
    if (!Number.isInteger(options[key]) || options[key] < 1) throw new Error(`${key} must be a positive integer`);
  }
  if (!(options.dpr > 0)) throw new Error('dpr must be positive');
  if (!(options.settleSeconds >= 0)) throw new Error('settle seconds must be zero or positive');
  if (!Number.isInteger(options.debugLoad) || options.debugLoad < 0) throw new Error('debug load must be a whole number of passes');
  if (options.renderer != null && !['webgl', 'webgpu'].includes(options.renderer)) throw new Error('renderer must be webgl or webgpu');
  return options;
}

// In-page: the burst itself. Restores the loop, override and load afterwards.
// The GPU is drained through the backend's own `drain()` when it has one
// (WebGPU: onSubmittedWorkDone), else with a 1-px readPixels (WebGL2).
async function burst(page, { levels, frames, reps, debugLoad, renderer: requested }) {
  return page.evaluate(async ({ levels, frames, reps, debugLoad, requested }) => {
    const renderer = window.__claudeVilleApp.renderer;
    const gpu = renderer.gpuWorld;
    if (!gpu?.isActive?.()) throw new Error('the resident GPU world is not active');
    const backend = gpu.backend || 'webgl';
    if (requested && backend !== requested) throw new Error(`the ${requested} backend is not active (${backend} is)`);
    const context = renderer._gpuRenderContext;
    if (!context?.records?.length) throw new Error('no resident frame to replay');
    const previousFreshOutput = context.forceFreshOutput;
    context.forceFreshOutput = true;
    const pixel = new Uint8Array(4);
    const drain = async () => {
      if (typeof gpu.drain === 'function') {
        await gpu.drain();
        return;
      }
      if (!gpu.ensureFreshOutput()) throw new Error('resident readback repaint failed');
      const gl = gpu.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    };
    const middle = (values) => {
      const sorted = [...values].sort((a, b) => a - b);
      const half = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
    };
    const renderOnce = () => {
      gpu.prepareFrame(context.feed);
      if (gpu.render(context) !== true) throw new Error('resident render failed during the burst');
    };
    const previousOverride = gpu.qualityLadder.getState().override;
    const arms = [];
    renderer._stopLoop();
    try {
      for (const level of levels) {
        for (const loadPasses of debugLoad > 0 ? [0, debugLoad] : [0]) {
          gpu.qualityLadder.setOverride(level);
          gpu.setDebugLoad(loadPasses > 0 ? { passes: loadPasses, levels: 'all' } : null);
          renderOnce();
          await drain();
          const walls = [];
          const cpus = [];
          for (let rep = 0; rep < reps; rep++) {
            let cpu = 0;
            const started = performance.now();
            for (let frame = 0; frame < frames; frame++) {
              const submit = performance.now();
              renderOnce();
              cpu += performance.now() - submit;
            }
            await drain();
            walls.push((performance.now() - started) / frames);
            cpus.push(cpu / frames);
          }
          arms.push({
            level,
            debugLoadPasses: loadPasses,
            wallMs: middle(walls),
            wallMinMs: Math.min(...walls),
            wallMaxMs: Math.max(...walls),
            cpuMs: middle(cpus),
            records: gpu.records,
            batches: gpu.batches,
            lights: gpu.lightCount,
            lightAdmission: { ...gpu.lightAdmission },
          });
        }
      }
    } finally {
      context.forceFreshOutput = previousFreshOutput;
      gpu.setDebugLoad(null);
      gpu.qualityLadder.setOverride(previousOverride);
      renderer._startLoop();
    }
    return { backend, backing: [gpu.width, gpu.height], arms };
  }, { levels, frames, reps, debugLoad, requested });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const server = await resolveServer(options.url);
  const browser = await launchBenchBrowser({ headed: options.headed });
  const runs = [];
  try {
    for (const scenario of options.scenarios) {
      for (const viewport of options.viewports) {
        for (const zoom of options.zooms) {
          for (const condition of options.conditions) {
            for (let contextIndex = 0; contextIndex < options.contexts; contextIndex++) {
              const loadStart = hostSnapshot().loadAverage;
              const { context, page, errors } = await openWorld(browser, {
                baseUrl: server.baseUrl, scenario, width: viewport.width, height: viewport.height, dpr: options.dpr,
                query: options.renderer ? { renderer: options.renderer } : {},
              });
              try {
                // The opening glide owns the camera for its first seconds.
                await page.waitForTimeout(4500);
                const pose = await poseWorld(page, { ...condition, zoom });
                if (!pose.gpuWorldActive) throw new Error(`resident GPU world inactive for ${scenario} ${viewport.width}x${viewport.height}`);
                await page.waitForTimeout(options.settleSeconds * 1000);
                await poseWorld(page, { ...condition, zoom });
                await page.waitForTimeout(500);
                const result = await burst(page, options);
                const run = {
                  type: 'run',
                  scenario,
                  viewport: `${viewport.width}x${viewport.height}`,
                  dpr: options.dpr,
                  zoom,
                  hour: condition.hour,
                  weather: condition.weather,
                  context: contextIndex,
                  frames: options.frames,
                  reps: options.reps,
                  backend: result.backend,
                  glRenderer: pose.glRenderer,
                  backing: result.backing,
                  hostLoadAverage: { start: loadStart, end: hostSnapshot().loadAverage },
                  arms: result.arms.map(arm => ({
                    ...arm,
                    wallMs: round(arm.wallMs),
                    wallMinMs: round(arm.wallMinMs),
                    wallMaxMs: round(arm.wallMaxMs),
                    cpuMs: round(arm.cpuMs),
                  })),
                  errors: errors.slice(0, 5),
                };
                runs.push(run);
                console.log(JSON.stringify(run));
              } finally {
                await context.close();
              }
            }
          }
        }
      }
    }
    const groups = new Map();
    for (const run of runs) {
      for (const arm of run.arms) {
        const key = [run.scenario, run.viewport, run.zoom, run.hour, run.weather, arm.level, arm.debugLoadPasses].join('|');
        const group = groups.get(key) || {
          scenario: run.scenario, viewport: run.viewport, dpr: run.dpr, zoom: run.zoom, hour: run.hour, weather: run.weather,
          level: arm.level, debugLoadPasses: arm.debugLoadPasses, walls: [], cpus: [], lights: arm.lights,
        };
        group.walls.push(arm.wallMs);
        group.cpus.push(arm.cpuMs);
        groups.set(key, group);
      }
    }
    const cases = [...groups.values()].map(({ walls, cpus, ...group }) => ({
      ...group,
      contexts: walls.length,
      wallMs: round(median(walls)),
      wallSpreadMs: round(Math.max(...walls) - Math.min(...walls)),
      cpuMs: round(median(cpus)),
    }));
    const summary = {
      type: 'summary',
      tool: 'gpu-burst',
      server: server.isolated ? 'isolated' : server.baseUrl,
      browserVersion: browser.version(),
      host: hostSnapshot(),
      options: { ...options, viewports: options.viewports.map(v => `${v.width}x${v.height}`) },
      cases,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (options.out) writeFileSync(options.out, JSON.stringify({ summary, runs }, null, 2));
  } finally {
    await browser.close();
    await server.stop();
  }
}

main().catch((error) => {
  console.error(`[gpu-burst] FAIL: ${error.stack || error.message}`);
  process.exit(1);
});
