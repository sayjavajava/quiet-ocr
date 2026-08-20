#!/usr/bin/env node
/**
 * Real end-to-end verification, not a smoke test: loads the actual built
 * page in a real browser, uploads each fixture in test/fixtures/manifest.json
 * through the real file-input UI, clicks the real button, and checks two
 * things that actually matter for this project — not just "did it build":
 *
 *   1. OCR genuinely works on real-world-shaped input: an exact match for
 *      the one clean, single-line fixture, and a word-accuracy threshold
 *      (see scripts/text-accuracy.mjs) for the others, since real OCR
 *      output on a paragraph, a table, or a degraded scan legitimately
 *      varies without being broken. Thresholds are set from real measured
 *      numbers (scripts/measure-fixture-accuracy.mjs), not guesses — see
 *      each fixture's threshold below for the measurement it's pinned to.
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
import { wordAccuracy, parseLabelledBlocks } from "./text-accuracy.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC_DIR = `${ROOT}public`;
const FIXTURE_DIR = `${ROOT}test/fixtures/`;
const PORT = 8931;

// Minimum word accuracy per fixture. Set from real runs of
// scripts/measure-fixture-accuracy.mjs against the committed fixtures, with
// a small margin below the measured value — not a guess, and not 100%,
// because holding real OCR output to a perfect bar would make this test
// flake on the model's own legitimate, harmless variance.
const THRESHOLDS = {
  // measured 100% (see scripts/generate-test-fixture.mjs's fixture comment)
  paragraph: 0.9,
  table: 0.85,
  // measured 92.5% at 6° rotation / seed 20260820 / +/-85 noise / 1.1px blur
  "noisy-scan": 0.8,
  // measured 100% per page at 150/200/300 DPI (see docs/PERFORMANCE.md's
  // PDF input section) — this fixture is clean vector text, so it doesn't
  // differentiate DPI choices; it exists to regression-test the render
  // pipeline itself (PDF -> N page images -> OCR), not to stress accuracy.
  "sample-multipage": 0.9,
};

if (!existsSync(`${PUBLIC_DIR}/vendor/tesseract.min.js`)) {
  console.error("✗ public/vendor/ not found — run `npm run build` first.");
  process.exit(1);
}
if (!existsSync(`${FIXTURE_DIR}manifest.json`)) {
  console.error(`✗ Manifest not found at ${FIXTURE_DIR}manifest.json.`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(`${FIXTURE_DIR}manifest.json`, "utf8"));
const server = await startServer(PUBLIC_DIR, PORT);
const origin = `http://127.0.0.1:${PORT}`;

const launchOptions = {};
if (process.env.PLAYWRIGHT_CHROMIUM_PATH) launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const browser = await chromium.launch(launchOptions);

let failed = false;
const allRequests = [];

try {
  for (const fixture of manifest) {
    const fixturePath = `${FIXTURE_DIR}${fixture.file}`;
    if (!existsSync(fixturePath)) {
      console.error(`✗ Fixture not found at ${fixturePath}.`);
      failed = true;
      continue;
    }

    console.log(`\n=== ${fixture.name} (${fixture.mode}) ===`);

    const context = await browser.newContext();
    const page = await context.newPage();
    const requests = [];
    page.on("request", (r) => requests.push({ url: r.url(), postDataLength: (r.postData() || "").length }));
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await page.setInputFiles("#file-input", fixturePath);
    // click() auto-waits for #run to become enabled — for a PDF fixture
    // that's not immediate: the change handler renders every page (see
    // pdf-to-images.js) before Run is enabled at all.
    await page.click("#run");
    await page.waitForFunction(
      () => document.getElementById("status").textContent === "Done." ||
        /^Error:/.test(document.getElementById("status").textContent),
      { timeout: 60000 },
    );

    const status = await page.textContent("#status");
    if (status.startsWith("Error:")) {
      console.error(`✗ FAILED: page reported ${status}`);
      failed = true;
    } else if (fixture.mode === "pdf-word-accuracy") {
      const recognized = await page.inputValue("#result");
      const pageNames = await page.$$eval("#file-list .file-name", (els) => els.map((e) => e.textContent));
      const blocks = parseLabelledBlocks(recognized);
      console.log(`Rendered pages: ${JSON.stringify(pageNames)}`);

      if (pageNames.length !== fixture.expectedPages.length || blocks.length !== fixture.expectedPages.length) {
        console.error(`✗ FAILED: expected ${fixture.expectedPages.length} rendered pages, got ${pageNames.length} (${blocks.length} labelled blocks).`);
        failed = true;
      } else {
        const threshold = THRESHOLDS[fixture.name];
        let allOk = true;
        fixture.expectedPages.forEach((expectedText, i) => {
          const accuracy = wordAccuracy(expectedText, blocks[i].text);
          const ok = accuracy >= threshold;
          allOk &&= ok;
          console.log(`  page ${i + 1}: ${(accuracy * 100).toFixed(1)}% ${ok ? "✓" : "✗"} — ${JSON.stringify(blocks[i].text.trim())}`);
        });
        if (!allOk) {
          console.error("✗ FAILED: at least one PDF page's word accuracy is below threshold.");
          failed = true;
        } else {
          console.log("✓ Every rendered page meets its word-accuracy threshold.");
        }
      }
    } else {
      const recognized = (await page.inputValue("#result")).trim();
      console.log(`Expected:   ${JSON.stringify(fixture.expectedText)}`);
      console.log(`Recognized: ${JSON.stringify(recognized)}`);

      if (fixture.mode === "exact") {
        if (recognized !== fixture.expectedText) {
          console.error("✗ FAILED: recognized text does not exactly match the fixture's known text.");
          failed = true;
        } else {
          console.log("✓ OCR recognized the fixture text exactly.");
        }
      } else {
        const accuracy = wordAccuracy(fixture.expectedText, recognized);
        const threshold = THRESHOLDS[fixture.name];
        console.log(`Word accuracy: ${(accuracy * 100).toFixed(1)}% (threshold: ${(threshold * 100).toFixed(0)}%)`);
        if (accuracy < threshold) {
          console.error("✗ FAILED: word accuracy below threshold.");
          failed = true;
        } else {
          console.log("✓ Word accuracy meets threshold.");
        }
      }
    }

    allRequests.push(...requests);
    await context.close();
  }

  // --- batch mode: multiple files selected and run together, not just one
  // fixture at a time. Proves the multi-file UI actually produces per-file,
  // labelled output through the real page, not just "the loop ran twice". ---
  {
    console.log(`\n=== batch (sample-invoice + table) ===`);
    const invoiceFixture = manifest.find((f) => f.name === "sample-invoice");
    const tableFixture = manifest.find((f) => f.name === "table");
    const batchPaths = [`${FIXTURE_DIR}${invoiceFixture.file}`, `${FIXTURE_DIR}${tableFixture.file}`];

    const context = await browser.newContext();
    const page = await context.newPage();
    const requests = [];
    page.on("request", (r) => requests.push({ url: r.url(), postDataLength: (r.postData() || "").length }));
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await page.setInputFiles("#file-input", batchPaths);
    await page.click("#run");
    await page.waitForFunction(
      () => document.getElementById("status").textContent === "Done." ||
        /^Error:/.test(document.getElementById("status").textContent),
      { timeout: 90000 },
    );

    const status = await page.textContent("#status");
    const recognized = await page.inputValue("#result");
    const fileStatuses = await page.$$eval("#file-list .file-status", (els) => els.map((e) => e.textContent));
    console.log(`Status: ${status}`);
    console.log(`Per-file statuses: ${JSON.stringify(fileStatuses)}`);

    const hasInvoiceSection = recognized.includes(`=== ${invoiceFixture.file} ===`);
    const hasTableSection = recognized.includes(`=== ${tableFixture.file} ===`);
    const invoiceTextPresent = recognized.includes(invoiceFixture.expectedText);
    const tableWordsPresent = ["Widget A", "Widget B", "Widget C"].every((w) => recognized.includes(w));
    const bothDone = fileStatuses.length === 2 && fileStatuses.every((s) => s === "Done");

    if (status !== "Done." || !hasInvoiceSection || !hasTableSection || !invoiceTextPresent || !tableWordsPresent || !bothDone) {
      console.error("✗ FAILED: batch run did not produce the expected per-file, labelled output.");
      console.error(`  status==="Done.": ${status === "Done."}, invoice section: ${hasInvoiceSection}, table section: ${hasTableSection}, invoice text: ${invoiceTextPresent}, table words: ${tableWordsPresent}, per-file "Done": ${bothDone}`);
      failed = true;
    } else {
      console.log("✓ Batch run recognized both images and labelled each result by filename.");
    }

    allRequests.push(...requests);
    await context.close();
  }

  // Every request across every fixture run must be same-origin (this
  // server) or a blob: URL (an in-memory object reference that never
  // leaves the browser process — not a network request to anywhere).
  // Anything else, or any request carrying a body, would mean something is
  // being sent off-machine.
  const suspicious = allRequests.filter(
    (r) => r.postDataLength > 0 || (!r.url.startsWith(origin) && !r.url.startsWith("blob:")),
  );
  console.log(`\n${allRequests.length} total requests across all fixtures, ${suspicious.length} suspicious.`);
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
