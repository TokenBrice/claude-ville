// One Chromium launcher for the browser smokes and capture tools (plan T6).
// Imported helper; not directly executable.
//
// Executable: `CLAUDEVILLE_CHROME` when set; else Playwright's bundled
// Chromium; and when that is not installed (Playwright throws "Executable
// doesn't exist"), the first system Chrome found for this platform.
// GPU flags: `gpuLaunchArgs()` picks the ANGLE backend that reaches the real
// GPU per platform (Metal on macOS, Vulkan on Linux).
import fs from 'node:fs';
import { chromium } from 'playwright';

export const CHROME_ENV = 'CLAUDEVILLE_CHROME';

const SYSTEM_CHROME = Object.freeze({
  linux: ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
  win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
});

const COMMON_GPU_ARGS = ['--ignore-gpu-blocklist', '--enable-gpu-rasterization'];

/** Flags that give headless Chromium a hardware WebGL2/WebGPU adapter on this platform. */
export function gpuLaunchArgs(platform = process.platform) {
  if (platform === 'darwin') return ['--use-angle=metal', ...COMMON_GPU_ARGS];
  // Without Vulkan ANGLE, Linux headless falls back to SwiftShader (the
  // Canvas world) and has no WebGPU adapter.
  if (platform === 'linux') return ['--use-angle=vulkan', '--enable-features=Vulkan', '--enable-unsafe-webgpu', ...COMMON_GPU_ARGS];
  return [...COMMON_GPU_ARGS];
}

/** The first existing system Chrome for `platform`, or null. */
export function systemChromePath({ platform = process.platform, exists = fs.existsSync } = {}) {
  return (SYSTEM_CHROME[platform] || []).find(candidate => exists(candidate)) || null;
}

function isMissingExecutable(error) {
  return /Executable doesn't exist|browserType\.launch: .*not found/i.test(String(error?.message || error));
}

let bundledMissingFallback = null;

/** `chromium.launch(options)` with the executable resolution above. */
export async function launchChromium(options = {}) {
  const override = process.env[CHROME_ENV];
  if (override) {
    if (!fs.existsSync(override)) throw new Error(`${CHROME_ENV}=${override} does not exist`);
    return chromium.launch({ ...options, executablePath: override });
  }
  if (options.executablePath) return chromium.launch(options);
  if (bundledMissingFallback) return chromium.launch({ ...options, executablePath: bundledMissingFallback });
  try {
    return await chromium.launch(options);
  } catch (error) {
    if (!isMissingExecutable(error)) throw error;
    const fallback = systemChromePath();
    if (!fallback) {
      throw new Error(`Playwright's bundled Chromium is not installed and no system Chrome was found. Run \`npx playwright install chromium\` or set ${CHROME_ENV}=/path/to/chrome.\n${error.message}`);
    }
    console.warn(`[chromium] Playwright's bundled Chromium is not installed; using ${fallback} (set ${CHROME_ENV} to choose).`);
    bundledMissingFallback = fallback;
    return chromium.launch({ ...options, executablePath: fallback });
  }
}
