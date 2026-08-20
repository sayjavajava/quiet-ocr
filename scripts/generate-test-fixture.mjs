#!/usr/bin/env node
/**
 * Regenerates test/fixtures/sample-invoice.png. Not run automatically —
 * the fixture is committed so scripts/verify.mjs's exact-match check
 * doesn't depend on font rendering being identical between whatever
 * environment last generated it and the one currently running it. Only
 * re-run this deliberately, and re-verify the new fixture actually
 * recognizes correctly before committing it.
 */
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TEXT = "Invoice number 88214, total due $942.50";
const OUT_PATH = fileURLToPath(new URL("../test/fixtures/sample-invoice.png", import.meta.url));

const launchOptions = {};
if (process.env.PLAYWRIGHT_CHROMIUM_PATH) launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const browser = await chromium.launch(launchOptions);
const page = await browser.newPage();
await page.setContent('<canvas id="c" width="700" height="150"></canvas>');
const dataUrl = await page.evaluate((text) => {
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000000';
  ctx.font = '30px sans-serif';
  ctx.fillText(text, 20, 80);
  return canvas.toDataURL('image/png');
}, TEXT);
writeFileSync(OUT_PATH, Buffer.from(dataUrl.split(',')[1], 'base64'));
console.log(`Fixture written to ${OUT_PATH} — expected text: ${JSON.stringify(TEXT)}`);
await browser.close();
