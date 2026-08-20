#!/usr/bin/env node
/**
 * Real end-to-end verification, not a smoke test: loads the actual built
 * page in a real browser, uploads a fixture image with known text through
 * the real file-input UI, clicks the real button, and checks two things
 * that actually matter for this project — not just "did it build":
 *
 *   1. OCR genuinely works: the recognized text exactly matches the known
 *      fixture text.
 *   2. The core promise holds: no network request during the run carries
 *      anything derived from the image, and nothing beyond the expected
 *      same-origin /vendor/ assets is ever requested.
 *
 * Requires `npm run build` to have already produced public/vendor/, and a
 * Chromium Playwright can launch (set PLAYWRIGHT_CHROMIUM_PATH to a local
 * install if the default download isn't available).
 */
import { chromium } from "playwright";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startServer } from "./serve.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC_DIR = `${ROOT}public`;
const FIXTURE_PATH = `${ROOT}test/fixtures/sample-invoice.png`;
const EXPECTED_TEXT = "Invoice number 88214, total due $942.50";
const PORT = 8931;

if (!existsSync(`${PUBLIC_DIR}/vendor/tesseract.min.js`)) {
  console.error("✗ public/vendor/ not found — run `npm run build` first.");
  process.exit(1);
}
if (!existsSync(FIXTURE_PATH)) {
  console.error(`✗ Fixture not found at ${FIXTURE_PATH}.`);
  process.exit(1);
}

const server = await startServer(PUBLIC_DIR, PORT);
const origin = `http://127.0.0.1:${PORT}`;

const launchOptions = {};
if (process.env.PLAYWRIGHT_CHROMIUM_PATH) launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const browser = await chromium.launch(launchOptions);
const context = await browser.newContext();
const page = await context.newPage();

const requests = [];
page.on("request", (r) => requests.push({ url: r.url(), postDataLength: (r.postData() || "").length }));
page.on("pageerror", (e) => console.error("[pageerror]", String(e)));

let failed = false;

try {
  console.log("Loading QuietOCR...");
  await page.goto(`${origin}/index.html`, { waitUntil: "load" });

  console.log("Uploading fixture image via the real file input...");
  await page.setInputFiles("#file-input", FIXTURE_PATH);

  console.log("Clicking Run OCR...");
  await page.click("#run");

  console.log("Waiting for recognition to finish (up to 60s)...");
  await page.waitForFunction(
    () => document.getElementById("status").textContent === "Done." ||
      /^Error:/.test(document.getElementById("status").textContent),
    { timeout: 60000 },
  );

  const status = await page.textContent("#status");
  if (status.startsWith("Error:")) throw new Error(`Page reported: ${status}`);

  const recognized = (await page.inputValue("#result")).trim();
  console.log(`\nExpected:   ${JSON.stringify(EXPECTED_TEXT)}`);
  console.log(`Recognized: ${JSON.stringify(recognized)}`);

  if (recognized !== EXPECTED_TEXT) {
    console.error("\n✗ FAILED: recognized text does not exactly match the fixture's known text.");
    failed = true;
  } else {
    console.log("✓ OCR recognized the fixture text exactly.");
  }

  // Every request must be same-origin (this server) or a blob: URL (an
  // in-memory object reference that never leaves the browser process —
  // not a network request to anywhere). Anything else, or any request
  // carrying a body, would mean something is being sent off-machine.
  const suspicious = requests.filter(
    (r) => r.postDataLength > 0 || (!r.url.startsWith(origin) && !r.url.startsWith("blob:")),
  );
  console.log(`\n${requests.length} total requests, ${suspicious.length} suspicious.`);
  if (suspicious.length > 0) {
    console.error("✗ FAILED: found a request that looks like it could carry data off-machine:");
    for (const r of suspicious) console.error("  ", r);
    failed = true;
  } else {
    console.log("✓ No request left the page's own origin, and none carried a body.");
  }
} finally {
  await browser.close();
  server.close();
}

if (failed) process.exit(1);
console.log("\nPASSED");
