#!/usr/bin/env node
/**
 * A truly large, real-world-shaped PDF driven through the full pipeline in
 * a real browser: rasterize every page (main thread, pdf-to-images.js) ->
 * OCR every page (one Tesseract worker, the batch pipeline) -> a single
 * .docx with a real page break between each page. Everything else in this
 * project's test coverage uses PDFs of 2-3 pages; this is the one place
 * that actually exercises what happens at the scale docs/PERFORMANCE.md
 * has flagged as unverified — a real multi-minute run, not just that the
 * code path exists.
 *
 * Separate from `npm run verify` deliberately: it's genuinely slow (this
 * is the point, not a flaw) and isn't meant to gate every PR the way the
 * fast fixture checks are. Run by hand, or on a schedule, and record
 * results in docs/PERFORMANCE.md:
 *
 *   npm run build && npm run verify-large-pdf
 *
 * The PDF is generated on the fly (pdf-lib), not committed — same
 * reasoning as scripts/bench.mjs's large-photo fixture: a 60-page PDF has
 * no business living in git history, and generating it from known,
 * per-page-distinct text means the expected output for every single page
 * is exact, not just "did it complete." Distinct text per page matters
 * specifically because the one real bug this project's hardening found
 * (PR #13) was a page/file *identity* bug — duplicate names silently
 * collapsing into each other — so a fixture where every page reads the
 * same would not actually test that ordering and identity survive at
 * scale.
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { chromium } from "playwright";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startServer } from "./serve.mjs";
import { wordAccuracy } from "./text-accuracy.mjs";
import { readDocxPages, selectFilesInBrowser, waitForStatus } from "./browser-test-helpers.mjs";

const PAGE_COUNT = 60; // comfortably past LARGE_BATCH_THRESHOLD (25 in app.js)

// Deterministic, distinct-per-page text — enough density to be a realistic
// document page (comparable to the "table"/"paragraph" fixtures), not a
// single short line, so recognize() time here is representative of a real
// scanned/exported document rather than the best case.
function pageText(n) {
  return [
    `Page ${n}: purchase order ${4000 + n}, quantity ${n * 7} units, unit price $${(n * 1.35).toFixed(2)}.`,
    `Warehouse zone ${String.fromCharCode(65 + (n % 26))}, batch reference LP-${n}-QOCR.`,
    `Approved by reviewer number ${(n % 5) + 1} on schedule day ${n}.`,
  ];
}

async function buildLargePdf(pageCount) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const expectedPages = [];
  for (let n = 1; n <= pageCount; n++) {
    const page = pdfDoc.addPage([612, 200]);
    const lines = pageText(n);
    lines.forEach((line, i) => {
      page.drawText(line, { x: 50, y: 140 - i * 28, size: 14, font, color: rgb(0, 0, 0) });
    });
    expectedPages.push(lines.join(" "));
  }
  return { bytes: await pdfDoc.save(), expectedPages };
}

function fmtMs(ms) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC_DIR = `${ROOT}public`;
const PORT = 8934; // distinct from verify.mjs (8931) and bench.mjs (8933)

// Measured against a real 60-page run of this exact fixture shape (clean
// vector text, 3 short lines, Helvetica 14pt): every page scored at or
// above 96.2% (worst page: #34). Kept at a real margin below that, not at
// it, for the same reason every other threshold in this project isn't
// pinned to its own measured value: real OCR has legitimate run-to-run
// variance, and this fixture's short numeric/alphanumeric tokens (order
// numbers, zone letters, "LP-N-QOCR" references) are exactly the kind of
// content Tesseract occasionally misreads a single character of.
const WORD_ACCURACY_THRESHOLD = 0.9;

if (!existsSync(`${PUBLIC_DIR}/vendor/tesseract.min.js`)) {
  console.error("✗ public/vendor/ not found — run `npm run build` first.");
  process.exit(1);
}

console.log(`Building a ${PAGE_COUNT}-page PDF fixture (in memory, not committed)…`);
const { bytes: pdfBytes, expectedPages } = await buildLargePdf(PAGE_COUNT);
const pdfB64 = Buffer.from(pdfBytes).toString("base64");
console.log(`  ${(pdfBytes.length / 1024).toFixed(1)} KiB`);

const server = await startServer(PUBLIC_DIR, PORT);
const origin = `http://127.0.0.1:${PORT}`;

const launchOptions = {};
if (process.env.PLAYWRIGHT_CHROMIUM_PATH) launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const browser = await chromium.launch(launchOptions);

let failed = false;
const problems = [];
function fail(message) {
  failed = true;
  problems.push(message);
  console.error(`✗ ${message}`);
}

try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");

  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  const requests = [];
  page.on("request", (r) => requests.push({ url: r.url(), postDataLength: (r.postData() || "").length }));

  let dialogMessage = null;
  page.on("dialog", async (dialog) => {
    dialogMessage = dialog.message();
    await dialog.accept();
  });

  async function heapUsedBytes() {
    const { metrics } = await cdp.send("Performance.getMetrics");
    return metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? null;
  }

  console.log("\n=== loading page and selecting the large PDF ===");
  await page.goto(`${origin}/index.html`, { waitUntil: "load" });

  const heapBefore = await heapUsedBytes();
  const tSelectStart = Date.now();
  await selectFilesInBrowser(page, [{ name: "large-multipage.pdf", b64: pdfB64, type: "application/pdf" }]);
  await page.waitForFunction(() => !document.getElementById("run").disabled, { timeout: 180000 });
  const tRendered = Date.now();
  const renderMs = tRendered - tSelectStart;

  const renderStatus = await page.textContent("#status");
  const fileNames = await page.$$eval("#file-list .file-name", (els) => els.map((e) => e.textContent));
  console.log(`Render phase: ${fmtMs(renderMs)} for ${PAGE_COUNT} pages`);
  console.log(`Status after render: ${JSON.stringify(renderStatus)}`);
  console.log(`Rendered page count: ${fileNames.length} (expected ${PAGE_COUNT})`);

  if (fileNames.length !== PAGE_COUNT) {
    fail(`expected ${PAGE_COUNT} rendered pages, got ${fileNames.length}.`);
  }
  if (renderStatus.startsWith("Rendered with errors")) {
    fail(`page rendering reported errors: ${renderStatus}`);
  }

  console.log("\n=== running OCR on all pages (this is the slow part, by design) ===");
  const tRunClick = Date.now();
  await page.click("#run");

  if (!dialogMessage) {
    // The confirmation dialog is async relative to click(); give it a beat.
    await page.waitForTimeout(200);
  }
  const dialogMentionsCount = dialogMessage?.includes(String(PAGE_COUNT)) ?? false;
  console.log(`Confirmation dialog fired: ${!!dialogMessage} (mentions ${PAGE_COUNT}: ${dialogMentionsCount})`);
  if (!dialogMessage) fail(`expected the large-batch confirmation dialog for ${PAGE_COUNT} pages, none fired.`);
  else if (!dialogMentionsCount) fail(`confirmation dialog didn't mention the real page count: "${dialogMessage}"`);

  await waitForStatus(page, (s) => s.startsWith("Recognizing"), {
    timeoutMs: 60000,
    intervalMs: 500,
    label: "the engine to finish loading and recognition to start",
  });
  const tEngineLoaded = Date.now();
  const engineLoadMs = tEngineLoaded - tRunClick;

  await waitForStatus(page, (s) => s === "Done." || /^Error:/.test(s), {
    timeoutMs: 15 * 60 * 1000, // real multi-minute run, by design
    intervalMs: 2000,
    label: "the run to finish",
  });
  const tDone = Date.now();
  const recognizeMs = tDone - tEngineLoaded;
  const heapAfter = await heapUsedBytes();

  const finalStatus = await page.textContent("#status");
  if (finalStatus.startsWith("Error:")) fail(`page reported ${finalStatus}`);

  const fileStatuses = await page.$$eval("#file-list .file-status", (els) => els.map((e) => e.textContent));
  const doneCount = fileStatuses.filter((s) => s === "Done").length;
  console.log(`Engine load: ${fmtMs(engineLoadMs)}`);
  console.log(`Recognize (${PAGE_COUNT} pages): ${fmtMs(recognizeMs)} (~${(recognizeMs / PAGE_COUNT).toFixed(0)}ms/page)`);
  console.log(`Total (render + engine load + recognize): ${fmtMs(renderMs + engineLoadMs + recognizeMs)}`);
  if (heapBefore != null && heapAfter != null) {
    console.log(`JS heap: ${(heapBefore / 1e6).toFixed(1)}MB before -> ${(heapAfter / 1e6).toFixed(1)}MB after`);
  }
  console.log(`Per-file statuses: ${doneCount}/${PAGE_COUNT} "Done"`);
  if (doneCount !== PAGE_COUNT) {
    fail(`${PAGE_COUNT - doneCount} page(s) did not finish with status "Done": ${JSON.stringify(fileStatuses)}`);
  }

  console.log("\n=== downloading the .docx and checking every page's content ===");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
  const docxBytes = new Uint8Array(readFileSync(await download.path()));
  const docxPages = readDocxPages(docxBytes);
  console.log(`.docx page breaks: ${docxPages.length} (expected ${PAGE_COUNT})`);

  if (docxPages.length !== PAGE_COUNT) {
    fail(`expected ${PAGE_COUNT} pages in the .docx, got ${docxPages.length}.`);
  } else {
    let worstAccuracy = 1;
    let worstPage = -1;
    for (let i = 0; i < PAGE_COUNT; i++) {
      const accuracy = wordAccuracy(expectedPages[i], docxPages[i]);
      if (accuracy < worstAccuracy) {
        worstAccuracy = accuracy;
        worstPage = i + 1;
      }
      if (accuracy < WORD_ACCURACY_THRESHOLD) {
        fail(`page ${i + 1}: word accuracy ${(accuracy * 100).toFixed(1)}% below ${(WORD_ACCURACY_THRESHOLD * 100).toFixed(0)}% threshold — expected ${JSON.stringify(expectedPages[i])}, got ${JSON.stringify(docxPages[i])}`);
      }
    }
    console.log(`Worst page: #${worstPage} at ${(worstAccuracy * 100).toFixed(1)}% word accuracy (threshold ${(WORD_ACCURACY_THRESHOLD * 100).toFixed(0)}%)`);
    if (!failed) console.log(`✓ All ${PAGE_COUNT} pages meet the word-accuracy threshold, in the correct order.`);
  }

  if (pageErrors.length > 0) {
    fail(`${pageErrors.length} uncaught page error(s) during the run: ${pageErrors.join("; ")}`);
  } else {
    console.log("✓ No uncaught page errors during the run.");
  }

  // blob: URLs are in-memory object references that never leave the
  // browser process (Tesseract.js's worker uses them heavily for image
  // data) — not a network request to anywhere, so not "suspicious" the
  // way an actual off-origin request would be. Same check as verify.mjs.
  const suspicious = requests.filter(
    (r) => r.postDataLength > 0 || (!r.url.startsWith(origin) && !r.url.startsWith("blob:")),
  );
  console.log(`${requests.length} total requests, ${suspicious.length} suspicious.`);
  if (suspicious.length > 0) {
    fail(`${suspicious.length} request(s) left the page's own origin or carried a body: ${JSON.stringify(suspicious)}`);
  } else {
    console.log("✓ No request left the page's own origin, and none carried a body.");
  }

  await context.close();
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${failed ? "FAILED" : "PASSED"}`);
if (failed) {
  console.error(`\n${problems.length} problem(s):`);
  problems.forEach((p) => console.error(`  - ${p}`));
  process.exit(1);
}
