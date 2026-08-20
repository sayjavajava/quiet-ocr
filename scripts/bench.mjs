#!/usr/bin/env node
/**
 * Performance benchmark: measures engine-load time and recognize() time
 * separately, not just one combined number — the two have very different
 * costs (engine load is dominated by fetching/instantiating the WASM core
 * and trained-data; recognize() scales with image size and content) and a
 * regression in either should show up distinctly. Not part of CI — run by
 * hand and record results in docs/PERFORMANCE.md.
 *
 * Runs the manifest fixtures (small, canvas-rendered) plus one large
 * synthetic "photo-sized" fixture generated on the fly, since the manifest
 * fixtures are all well under the resolution of an actual phone photo of a
 * document page and recognize() time is size-sensitive.
 *
 * Each fixture runs BENCH_RUNS times in a fresh page/worker each time — this
 * project creates a new Tesseract worker per run rather than pooling one
 * (see public/app.js), so the per-run engine-load cost measured here is
 * real, current, user-facing cost, not an artifact of the benchmark.
 */
import { chromium } from "playwright";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./serve.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC_DIR = `${ROOT}public`;
const FIXTURE_DIR = `${ROOT}test/fixtures/`;
const PORT = 8933;
const RUNS_PER_FIXTURE = 3;

if (!existsSync(`${PUBLIC_DIR}/vendor/tesseract.min.js`)) {
  console.error("✗ public/vendor/ not found — run `npm run build` first.");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(`${FIXTURE_DIR}manifest.json`, "utf8"));
const server = await startServer(PUBLIC_DIR, PORT);
const origin = `http://127.0.0.1:${PORT}`;

const launchOptions = {};
if (process.env.PLAYWRIGHT_CHROMIUM_PATH) launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const browser = await chromium.launch(launchOptions);

// --- generate a large, photo-of-a-document-page-sized fixture, not committed ---
// 2480x3508 = A4 at 300dpi, the resolution a real phone-camera scanning app
// or flatbed scanner typically produces — the manifest fixtures are all a
// couple hundred pixels tall and don't exercise recognize()'s size scaling.
const scratchDir = mkdtempSync(join(tmpdir(), "quiet-ocr-bench-"));
const largePhotoPath = join(scratchDir, "large-photo.png");
{
  const genPage = await browser.newPage();
  await genPage.setContent('<canvas id="c" width="2480" height="3508"></canvas>');
  const dataUrl = await genPage.evaluate(() => {
    const w = 2480, h = 3508;
    const ctx = document.getElementById('c').getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#000000';
    ctx.font = '48px sans-serif';
    const paragraph = [
      "The quarterly report shows a steady increase in revenue across all regions.",
      "Customer satisfaction scores improved by 12% compared to the previous period,",
      "while operational costs remained flat. The board recommends continuing the",
      "current strategy through the next fiscal year.",
    ];
    let y = 150;
    for (let block = 0; block < 8; block++) {
      for (const line of paragraph) {
        ctx.fillText(line, 120, y);
        y += 70;
      }
      y += 60;
    }
    return document.getElementById('c').toDataURL('image/png');
  });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(largePhotoPath, Buffer.from(dataUrl.split(',')[1], 'base64'));
  await genPage.close();
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function runOnce(page, fixturePath) {
  await page.goto(`${origin}/index.html`, { waitUntil: "load" });
  await page.setInputFiles("#file-input", fixturePath);

  const start = Date.now();
  await page.click("#run");
  await page.waitForFunction(
    () => document.getElementById("status").textContent.startsWith("Recognizing"),
    { timeout: 60000 },
  );
  const engineLoaded = Date.now();
  await page.waitForFunction(
    () => document.getElementById("status").textContent === "Done." ||
      /^Error:/.test(document.getElementById("status").textContent),
    { timeout: 120000 },
  );
  const done = Date.now();

  const status = await page.textContent("#status");
  if (status.startsWith("Error:")) throw new Error(`Page reported: ${status}`);

  return {
    engineLoadMs: engineLoaded - start,
    recognizeMs: done - engineLoaded,
    totalMs: done - start,
  };
}

const fixturesToRun = [
  ...manifest.map((f) => ({ name: f.name, path: `${FIXTURE_DIR}${f.file}` })),
  { name: "large-photo (A4@300dpi)", path: largePhotoPath },
];

const results = [];

try {
  for (const fixture of fixturesToRun) {
    const runs = [];
    for (let i = 0; i < RUNS_PER_FIXTURE; i++) {
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        runs.push(await runOnce(page, fixture.path));
      } finally {
        await context.close();
      }
    }

    const engineLoads = runs.map((r) => r.engineLoadMs);
    const recognizes = runs.map((r) => r.recognizeMs);
    const totals = runs.map((r) => r.totalMs);

    results.push({ name: fixture.name, engineLoads, recognizes, totals });

    console.log(`\n=== ${fixture.name} (${RUNS_PER_FIXTURE} runs) ===`);
    console.log(`Engine load:  first ${engineLoads[0]}ms, median ${median(engineLoads).toFixed(0)}ms`);
    console.log(`Recognize:    first ${recognizes[0]}ms, median ${median(recognizes).toFixed(0)}ms`);
    console.log(`Total:        first ${totals[0]}ms, median ${median(totals).toFixed(0)}ms`);
  }
} finally {
  await browser.close();
  server.close();
}

console.log("\n--- summary (median ms across runs) ---");
console.log("fixture".padEnd(24), "engine-load".padEnd(14), "recognize".padEnd(12), "total");
for (const r of results) {
  console.log(
    r.name.padEnd(24),
    String(median(r.engineLoads).toFixed(0)).padEnd(14),
    String(median(r.recognizes).toFixed(0)).padEnd(12),
    String(median(r.totals).toFixed(0)),
  );
}
