#!/usr/bin/env node
/**
 * Finds where PDF-page rendering (public/pdf-to-images.js, driven through
 * the real app.js file-selection path — this never clicks Run, so it
 * isolates the render phase from OCR entirely) actually breaks down as
 * page count grows, and how per-page time degrades before that.
 * Motivated by docs/PERFORMANCE.md's own flagged gap: no hard page-count
 * cap, and rendering is unverified at real-world PDF sizes.
 *
 * Not a pass/fail check — a measurement script (see
 * scripts/measure-pdf-dpi.mjs, measure-fixture-accuracy.mjs for the same
 * convention). Run by hand:
 *
 *   npm run build && npm run measure-render-scaling
 *
 * Two content profiles, escalated separately, because the breaking point
 * depends heavily on per-page size, not just page count:
 *
 *   - "scan": one real, full-resolution scanned-page-sized image (A4 @
 *     300dpi, 2480x3508 — the same synthetic shape scripts/bench.mjs
 *     already uses for realistic OCR benchmarking), reused across every
 *     page. This is the actually-realistic worst case: a phone-scanned
 *     or flatbed-scanned multi-page document, which is exactly what a
 *     user hitting a real page-count problem is most likely to have
 *     selected.
 *   - "text": sample-multipage.pdf-style clean vector text — the cheap
 *     case, for contrast, so a single number doesn't misrepresent this
 *     as "PDF rendering breaks at page N" when it actually depends
 *     entirely on what's on each page.
 *
 * pdf-lib de-duplicates a reused embedded image/font across pages, so
 * building even a many-thousand-page PDF this way stays cheap on the
 * Node side — the cost under test is entirely the browser's own
 * per-page rasterization, which is the thing this project doesn't yet
 * know the limits of.
 */
import { chromium } from "playwright";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startServer } from "./serve.mjs";
import { selectFilesInBrowser } from "./browser-test-helpers.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC_DIR = `${ROOT}public`;
const PORT = 8935;

// A single attempt taking longer than this is declared "broken" on its
// own terms even without a crash: at the time this measurement was taken,
// the app had no progress bar beyond the per-page status list and no way
// to cancel a render in progress (see docs/PERFORMANCE.md) — a rendering
// phase this long, on a page the user couldn't interact with, wasn't a
// usable product experience regardless of whether the browser technically
// survived it. A real Cancel button exists now (public/app.js), but the
// measured numbers this ceiling produced are still the real evidence
// MAX_PDF_PAGES is based on — kept as-is, not re-measured, since Cancel
// changes what happens when a render runs long, not how fast it runs.
const PRACTICAL_TIMEOUT_MS = 3 * 60 * 1000;

if (!existsSync(`${PUBLIC_DIR}/vendor/tesseract.min.js`)) {
  console.error("✗ public/vendor/ not found — run `npm run build` first.");
  process.exit(1);
}

function fmtMs(ms) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

async function buildScanPdf(pageCount, imageBytes, imageDims) {
  const pdfDoc = await PDFDocument.create();
  const image = await pdfDoc.embedPng(imageBytes);
  for (let i = 0; i < pageCount; i++) {
    const page = pdfDoc.addPage([imageDims.width, imageDims.height]);
    page.drawImage(image, { x: 0, y: 0, width: imageDims.width, height: imageDims.height });
  }
  return pdfDoc.save();
}

async function buildTextPdf(pageCount) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pageCount; i++) {
    const page = pdfDoc.addPage([612, 200]);
    page.drawText(`Page ${i + 1} of ${pageCount}: stress-test content.`, { x: 50, y: 120, size: 18, font, color: rgb(0, 0, 0) });
  }
  return pdfDoc.save();
}

const server = await startServer(PUBLIC_DIR, PORT);
const origin = `http://127.0.0.1:${PORT}`;

const launchOptions = {};
if (process.env.PLAYWRIGHT_CHROMIUM_PATH) launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const browser = await chromium.launch(launchOptions);

/** Renders `pdfBytes` through the real file-selection path (never clicks Run) and reports what happened. */
async function attemptRender(pdfBytes, pageCount) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");

  let crashed = false;
  page.on("crash", () => { crashed = true; });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  async function heapUsedBytes() {
    try {
      const { metrics } = await cdp.send("Performance.getMetrics");
      return metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? null;
    } catch {
      return null; // context may already be gone if the page crashed
    }
  }

  const b64 = Buffer.from(pdfBytes).toString("base64");
  const heapBefore = await heapUsedBytes();
  const t0 = Date.now();

  try {
    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await selectFilesInBrowser(page, [{ name: "stress.pdf", b64, type: "application/pdf" }]);

    const deadline = t0 + PRACTICAL_TIMEOUT_MS;
    let renderedCount = null;
    let statusText = "";
    for (;;) {
      if (crashed) break;
      const disabled = await page.$eval("#run", (el) => el.disabled).catch(() => null);
      if (disabled === false) {
        renderedCount = await page.$$eval("#file-list .file-name", (els) => els.length).catch(() => null);
        statusText = await page.textContent("#status").catch(() => "");
        break;
      }
      if (Date.now() > deadline) break;
      await page.waitForTimeout(500);
    }

    const elapsedMs = Date.now() - t0;
    const heapAfter = await heapUsedBytes();
    const timedOut = renderedCount === null && !crashed;

    await context.close().catch(() => {});
    return {
      pageCount,
      elapsedMs,
      heapBeforeMB: heapBefore != null ? heapBefore / 1e6 : null,
      heapAfterMB: heapAfter != null ? heapAfter / 1e6 : null,
      renderedCount,
      crashed,
      timedOut,
      pageErrors,
      statusText,
      ok: !crashed && !timedOut && renderedCount === pageCount && pageErrors.length === 0,
    };
  } catch (error) {
    const elapsedMs = Date.now() - t0;
    await context.close().catch(() => {});
    return {
      pageCount,
      elapsedMs,
      heapBeforeMB: heapBefore != null ? heapBefore / 1e6 : null,
      heapAfterMB: null,
      renderedCount: null,
      crashed,
      timedOut: false,
      pageErrors: [...pageErrors, String(error?.message ?? error)],
      statusText: "",
      ok: false,
    };
  }
}

function reportAttempt(r) {
  const heapStr = r.heapBeforeMB != null && r.heapAfterMB != null
    ? `${r.heapBeforeMB.toFixed(1)}MB -> ${r.heapAfterMB.toFixed(1)}MB`
    : "n/a";
  console.log(
    `  ${String(r.pageCount).padStart(5)} pages: ${fmtMs(r.elapsedMs).padStart(8)} ` +
    `(${(r.elapsedMs / r.pageCount).toFixed(0).padStart(6)}ms/page)  heap ${heapStr}  ` +
    `rendered ${r.renderedCount ?? "?"}/${r.pageCount}  ${r.ok ? "✓" : "✗ BROKE"}`,
  );
  if (r.crashed) console.log(`    -> page CRASHED`);
  if (r.timedOut) console.log(`    -> exceeded practical timeout (${fmtMs(PRACTICAL_TIMEOUT_MS)})`);
  if (r.pageErrors.length > 0) console.log(`    -> page error(s): ${r.pageErrors.join("; ")}`);
  if (r.statusText && !r.ok) console.log(`    -> status: ${r.statusText}`);
}

async function escalate(name, pageCounts, buildFn) {
  console.log(`\n=== profile: ${name} ===`);
  const results = [];
  for (const pageCount of pageCounts) {
    console.log(`Building ${pageCount}-page "${name}" PDF...`);
    const pdfBytes = await buildFn(pageCount);
    console.log(`  ${(pdfBytes.length / 1024).toFixed(1)} KiB PDF, rendering...`);
    const result = await attemptRender(pdfBytes, pageCount);
    results.push(result);
    reportAttempt(result);
    if (!result.ok) {
      console.log(`  Stopping "${name}" escalation — broke at ${pageCount} pages.`);
      break;
    }
  }
  return results;
}

let scanImageBytes, scanImageDims;
{
  console.log("Generating one full-resolution scan-page image (A4 @ 300dpi, reused across every page)...");
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
      for (const line of paragraph) { ctx.fillText(line, 120, y); y += 70; }
      y += 60;
    }
    return document.getElementById('c').toDataURL('image/png');
  });
  scanImageBytes = Buffer.from(dataUrl.split(',')[1], 'base64');
  scanImageDims = { width: 2480, height: 3508 };
  await genPage.close();
  console.log(`  ${(scanImageBytes.length / 1024).toFixed(1)} KiB\n`);
}

const allResults = {};
try {
  allResults.scan = await escalate(
    "scan (2480x3508 full-res image per page)",
    [400, 500, 600, 700, 900, 1200, 1600],
    (n) => buildScanPdf(n, scanImageBytes, scanImageDims),
  );
  allResults.text = await escalate(
    "text (clean vector text per page)",
    [4000, 8000, 16000, 32000],
    (n) => buildTextPdf(n),
  );
} finally {
  await browser.close();
  server.close();
}

console.log("\n--- summary ---");
for (const [name, results] of Object.entries(allResults)) {
  const lastOk = [...results].reverse().find((r) => r.ok);
  const brokeAt = results.find((r) => !r.ok);
  console.log(`${name}:`);
  console.log(`  Last fully successful: ${lastOk ? `${lastOk.pageCount} pages (${fmtMs(lastOk.elapsedMs)})` : "none tested succeeded"}`);
  if (brokeAt) {
    console.log(`  Broke at: ${brokeAt.pageCount} pages (crashed=${brokeAt.crashed}, timedOut=${brokeAt.timedOut}, rendered=${brokeAt.renderedCount}/${brokeAt.pageCount})`);
  } else {
    console.log(`  Never broke within the tested range.`);
  }
}
