import { chromium } from 'playwright';
const browser = await chromium.launch();
for (const [w, h] of [[1920, 1080], [2560, 1440]]) {
  const page = await (await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 })).newPage();
  await page.goto('http://localhost:4000', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  const dpr = await page.evaluate(() => window.__claudeVillePerf.canvasBudget().dpr);
  await page.evaluate(() => window.cameraSet({ x: 0, y: 0, zoom: 1 }));
  await page.waitForTimeout(600);
  await page.screenshot({ path: `output/playwright/dpr-fix-${w}x${h}.png` });
  console.log(`${w}x${h}: effective dpr = ${dpr}`);
  await page.close();
}
await browser.close();
