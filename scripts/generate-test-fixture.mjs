#!/usr/bin/env node
/**
 * Regenerates test/fixtures/*.png and test/fixtures/manifest.json. Not run
 * automatically — fixtures are committed so accuracy checks don't depend
 * on font rendering being identical between whatever environment last
 * generated them and whatever's currently running the tests. Only re-run
 * this deliberately, and re-verify the new fixtures' actual recognized
 * output before committing them — see scripts/measure-fixture-accuracy.mjs.
 *
 * Fixtures deliberately span real-world conditions, not just the one
 * clean, high-contrast line the original prototype used:
 *   - sample-invoice: short single line, high contrast (the original
 *                     prototype fixture — the one case exact match is a
 *                     reasonable bar for)
 *   - paragraph:      multi-line body text, realistic document font size
 *   - table:          tabular/numeric data — currency, alignment, digits
 *   - noisy-scan:     the paragraph text again, degraded the way a real
 *                     phone photo or scan actually is — rotated, lower
 *                     contrast, blurred, with per-pixel noise
 */
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURE_DIR = fileURLToPath(new URL("../test/fixtures/", import.meta.url));

const launchOptions = {};
if (process.env.PLAYWRIGHT_CHROMIUM_PATH) launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const browser = await chromium.launch(launchOptions);
const page = await browser.newPage();

async function toPng() {
  const dataUrl = await page.evaluate(() => document.getElementById('c').toDataURL('image/png'));
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

// --- sample-invoice: the original single-line, high-contrast fixture ---
const INVOICE_TEXT = "Invoice number 88214, total due $942.50";
await page.setContent('<canvas id="c" width="700" height="150"></canvas>');
await page.evaluate((text) => {
  const ctx = document.getElementById('c').getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 700, 150);
  ctx.fillStyle = '#000000';
  ctx.font = '30px sans-serif';
  ctx.fillText(text, 20, 80);
}, INVOICE_TEXT);
writeFileSync(`${FIXTURE_DIR}sample-invoice.png`, await toPng());

// --- paragraph: multi-line body text ---
const PARAGRAPH_LINES = [
  "The quarterly report shows a steady increase in revenue across all",
  "regions. Customer satisfaction scores improved by 12% compared to",
  "the previous period, while operational costs remained flat. The",
  "board recommends continuing the current strategy through the next",
  "fiscal year.",
];
await page.setContent('<canvas id="c" width="900" height="260"></canvas>');
await page.evaluate((lines) => {
  const ctx = document.getElementById('c').getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 900, 260);
  ctx.fillStyle = '#000000';
  ctx.font = '24px sans-serif';
  lines.forEach((line, i) => ctx.fillText(line, 30, 50 + i * 38));
}, PARAGRAPH_LINES);
writeFileSync(`${FIXTURE_DIR}paragraph.png`, await toPng());

// --- table: tabular/numeric data ---
const TABLE_LINES = [
  "Item        Qty   Price    Total",
  "Widget A     3   $12.50   $37.50",
  "Widget B     1   $89.99   $89.99",
  "Widget C     5    $4.25   $21.25",
];
await page.setContent('<canvas id="c" width="700" height="260"></canvas>');
await page.evaluate((lines) => {
  const ctx = document.getElementById('c').getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 700, 260);
  ctx.fillStyle = '#000000';
  ctx.font = '26px monospace';
  lines.forEach((line, i) => ctx.fillText(line, 30, 50 + i * 44));
}, TABLE_LINES);
writeFileSync(`${FIXTURE_DIR}table.png`, await toPng());

// --- noisy-scan: the paragraph again, degraded like a real phone photo —
// rotated, lower contrast, per-pixel noise, slight blur. Clean
// canvas-rendered text is not representative of what this tool actually
// encounters in practice.
//
// The noise uses a seeded PRNG (mulberry32), not Math.random(): an
// unseeded first attempt at tuning this produced a genuinely
// non-monotonic, unreproducible relationship between the noise amplitude
// and measured accuracy (97.5% -> 100% -> 22.5% as amplitude increased)
// purely because every regeneration drew a different random pattern —
// not because of the amplitude changes being tested. A fixed seed makes
// the fixture bit-for-bit reproducible, which is what makes tuning
// against real measurements meaningful at all. ---
const NOISE_SEED = 20260820;
await page.setContent('<canvas id="c" width="950" height="320"></canvas>');
await page.evaluate(({ lines, seed }) => {
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const w = 950, h = 320;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);

  // mulberry32 — small, fast, deterministic given the same seed.
  let state = seed;
  function rand() {
    state |= 0; state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // Tuned by real measurement (scripts/measure-fixture-accuracy.mjs) against
  // this seeded, reproducible noise — not guessed, and not re-tuned against
  // a moving target the way the unseeded version was.
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate((-6 * Math.PI) / 180);
  ctx.translate(-w / 2, -h / 2);
  ctx.fillStyle = '#3a3a3a'; // mid-grey on white — materially lower contrast
  ctx.font = '24px sans-serif';
  lines.forEach((line, i) => ctx.fillText(line, 50, 70 + i * 38));
  ctx.restore();

  const imageData = ctx.getImageData(0, 0, w, h);
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    const noise = (rand() - 0.5) * 85;
    d[i] = Math.min(255, Math.max(0, d[i] + noise));
    d[i + 1] = Math.min(255, Math.max(0, d[i + 1] + noise));
    d[i + 2] = Math.min(255, Math.max(0, d[i + 2] + noise));
  }
  ctx.putImageData(imageData, 0, 0);
  ctx.filter = 'blur(1.1px)';
  ctx.drawImage(canvas, 0, 0);
}, { lines: PARAGRAPH_LINES, seed: NOISE_SEED });
writeFileSync(`${FIXTURE_DIR}noisy-scan.png`, await toPng());

// --- manifest: what each fixture expects, and how strictly to check it ---
const manifest = [
  { name: "sample-invoice", file: "sample-invoice.png", expectedText: INVOICE_TEXT, mode: "exact" },
  { name: "paragraph", file: "paragraph.png", expectedText: PARAGRAPH_LINES.join(" "), mode: "word-accuracy" },
  { name: "table", file: "table.png", expectedText: TABLE_LINES.join(" "), mode: "word-accuracy" },
  { name: "noisy-scan", file: "noisy-scan.png", expectedText: PARAGRAPH_LINES.join(" "), mode: "word-accuracy" },
];
writeFileSync(`${FIXTURE_DIR}manifest.json`, JSON.stringify(manifest, null, 2) + "\n");

console.log(`Wrote ${manifest.length} fixtures + manifest.json to ${FIXTURE_DIR}`);
console.log("Run `npm run measure-accuracy` next to see real recognized output and set honest thresholds.");
await browser.close();
