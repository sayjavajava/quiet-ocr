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
import { chromium, firefox, webkit, devices } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { unzipSync, strFromU8 } from "fflate";
import { startServer } from "./serve.mjs";
import { wordAccuracy, parseLabelledBlocks } from "./text-accuracy.mjs";
import { readDocxText, readDocxPages, readPdfPagesText, pdfHasInvisibleTextOperator, selectFilesInBrowser, waitForStatus, waitForRunEnabled, waitForText } from "./browser-test-helpers.mjs";

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
  // scanned-multipage's pages are raster images (a real scanned/photographed
  // PDF's actual shape), unlike sample-multipage's vector text — this one
  // does test DPI-dependent accuracy. Measured at the shipped 150 DPI
  // default: 95.0% (degraded page), 100% (clean page) — see
  // scripts/measure-pdf-dpi.mjs and docs/PERFORMANCE.md.
  "scanned-multipage": 0.85,

  // Per-language degraded-accuracy fixtures (test/fixtures/manifest.json's
  // paragraph-<lang>/noisy-<lang> entries) — the gap flagged when
  // multi-language OCR shipped (#23): clean single-line accuracy was
  // verified per language, but not the same noisy-scan-style degraded
  // condition English's own paragraph/noisy-scan fixtures get. Every
  // number below is real, measured (scripts/measure-fixture-accuracy.mjs)
  // against the exact same degradation recipe as noisy-scan (6° rotation,
  // seed 20260822, +/-85 noise, 1.1px blur, same 24px font — the
  // per-language paragraphs were originally rendered smaller to fit a
  // narrower canvas, which was caught as an unfair comparison before any
  // number here was trusted: smaller text is inherently more vulnerable to
  // the same absolute noise/blur, so an early, since-discarded pass showed
  // implausibly bad scores — e.g. noisy-fra at 5.3% — that were a font-size
  // artifact, not a real French-language weakness; re-measured at 24px,
  // matching English exactly, before setting any of these), not guessed or
  // copied from English's own threshold.
  "paragraph-fra": 0.9, "noisy-fra": 0.85,
  "paragraph-spa": 0.9, "noisy-spa": 0.85,
  "paragraph-deu": 0.9, "noisy-deu": 0.9,
  "paragraph-por": 0.9, "noisy-por": 0.7,
  "paragraph-ita": 0.85, "noisy-ita": 0.85,
  "paragraph-rus": 0.9, "noisy-rus": 0.65,
  "paragraph-ara": 0.9, "noisy-ara": 0.8,
  "paragraph-hin": 0.75, "noisy-hin": 0.4,
  "paragraph-chi_sim": 0.9, "noisy-chi_sim": 0.5,
  "paragraph-jpn": 0.85, "noisy-jpn": 0.25,
  "paragraph-kor": 0.9, "noisy-kor": 0.4,
};

// Must match public/pdf-to-images.js's MAX_PDF_PAGES — not imported
// directly since that module is browser-only (it references `document`
// and pdf.js's own browser build at module scope, neither of which exist
// under Node).
const MAX_PDF_PAGES = 300;

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

// BROWSER selects the real engine to run this whole suite against — the
// same fixtures, the same UI, the same network-cleanliness check, just a
// different rendering/JS engine underneath. Defaults to chromium (this
// project's only committed, self-hosted engine locally); CI additionally
// runs this against firefox and webkit in a matrix, which is the only way
// a real engine-compatibility gap (like the Map.prototype.getOrInsertComputed
// shim pdf-to-images.js needed for pdf.js) would actually show up — see
// docs/PERFORMANCE.md's "PDF input" section for that history.
const ENGINES = { chromium, firefox, webkit };
const engineName = process.env.BROWSER ?? "chromium";
const engine = ENGINES[engineName];
if (!engine) {
  console.error(`✗ Unknown BROWSER "${engineName}" — expected one of: ${Object.keys(ENGINES).join(", ")}.`);
  process.exit(1);
}

const launchOptions = {};
if (engineName === "chromium" && process.env.PLAYWRIGHT_CHROMIUM_PATH) {
  launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
}
console.log(`Running against: ${engineName}`);
const browser = await engine.launch(launchOptions);

// `isMobile` is documented as unsupported on Firefox, so it's stripped
// from a device profile's context options only on that engine — hasTouch
// and the viewport itself, the parts that actually matter for the mobile
// checks below, still apply on every engine.
function mobileContextOptions(profile) {
  const { isMobile, ...withoutIsMobile } = profile;
  return engineName === "firefox" ? withoutIsMobile : profile;
}

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
    // Only the eleven per-language fixtures set this — everything else
    // relies on #language's default (English), unchanged.
    if (fixture.lang) await page.selectOption("#language", fixture.lang);
    await page.setInputFiles("#file-input", fixturePath);
    // click() auto-waits for #run to become enabled — for a PDF fixture
    // that's not immediate: the change handler renders every page (see
    // pdf-to-images.js) before Run is enabled at all.
    await page.click("#run");
    const status = await waitForStatus(page, (s) => s === "Done." || /^Error:/.test(s), {
      timeoutMs: 60000,
      label: "the run to finish",
    });

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
    const status = await waitForStatus(page, (s) => s === "Done." || /^Error:/.test(s), {
      timeoutMs: 90000,
      label: "the run to finish",
    });

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

  // --- large batch: above LARGE_BATCH_THRESHOLD (app.js), Run must ask for
  // confirmation with a time estimate before starting, and dismissing it
  // must not start anything. Real regression coverage for the confirm()
  // gate, not just "the code exists" — dismissing it and confirming it are
  // both checked against actual page state, not assumed from the dialog
  // firing alone. ---
  {
    console.log(`\n=== large batch (26x sample-invoice, confirmation gate) ===`);
    const invoiceFixture = manifest.find((f) => f.name === "sample-invoice");
    const manyPaths = Array.from({ length: 26 }, () => `${FIXTURE_DIR}${invoiceFixture.file}`);

    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await page.setInputFiles("#file-input", manyPaths);
    await waitForRunEnabled(page);

    let dialogMessage = null;
    page.once("dialog", async (dialog) => {
      dialogMessage = dialog.message();
      await dialog.dismiss();
    });
    await page.click("#run");
    await page.waitForTimeout(300);
    const statusAfterDismiss = await page.textContent("#status");
    const dialogMentionsCount = dialogMessage?.includes("26") ?? false;

    if (!dialogMessage || !dialogMentionsCount || statusAfterDismiss !== "") {
      console.error("✗ FAILED: large-batch confirmation gate didn't behave as expected.");
      console.error(`  dialog fired: ${!!dialogMessage}, mentions item count: ${dialogMentionsCount}, status after dismiss (expected empty): ${JSON.stringify(statusAfterDismiss)}`);
      failed = true;
    } else {
      console.log(`✓ Dialog fired ("${dialogMessage}") and dismissing it left the run un-started.`);
    }

    await context.close();
  }

  // --- Large batch: accept path, not just dismiss. Only checking dismiss
  // (above) would miss real bugs in the actual run — including a genuine
  // one found by adding this: 26 copies of the same fixture all produced
  // .docx files named "sample-invoice.docx", which zipSync silently
  // collapsed to a single entry, losing 25 of the 26 recognized documents
  // with no error. Fixed in app.js (uniqueDocxName) and verified here:
  // 26 real, distinct, correctly-numbered .docx entries, not just that
  // the run completes. Real measured time for this: ~8s, not the
  // conservative ~45s the confirmation estimate itself uses — small and
  // cheap enough for every CI run, not just a manual check. ---
  {
    console.log(`\n=== large batch (26x sample-invoice, accept path + duplicate-name dedup) ===`);
    const invoiceFixture = manifest.find((f) => f.name === "sample-invoice");
    const manyPaths = Array.from({ length: 26 }, () => `${FIXTURE_DIR}${invoiceFixture.file}`);

    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));
    page.on("dialog", (dialog) => dialog.accept());

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await page.setInputFiles("#file-input", manyPaths);
    await waitForRunEnabled(page);
    await page.click("#run");
    await waitForStatus(page, (s) => s === "Done.", { timeoutMs: 60000, label: "the run to finish" });

    const fileStatuses = await page.$$eval("#file-list .file-status", (els) => els.map((e) => e.textContent));
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
    const zipBytes = new Uint8Array(readFileSync(await download.path()));
    const entries = unzipSync(zipBytes);
    const names = Object.keys(entries).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const expectedNames = Array.from({ length: 26 }, (_, i) => (i === 0 ? "sample-invoice.docx" : `sample-invoice (${i + 1}).docx`)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    console.log(`26/26 statuses "Done": ${fileStatuses.every((s) => s === "Done")}`);
    console.log(`Zip entry count: ${names.length} (expected 26)`);

    const ok = fileStatuses.length === 26 && fileStatuses.every((s) => s === "Done")
      && names.length === 26
      && JSON.stringify(names) === JSON.stringify(expectedNames)
      && readDocxText(entries["sample-invoice.docx"]).includes(invoiceFixture.expectedText)
      && readDocxText(entries["sample-invoice (13).docx"]).includes(invoiceFixture.expectedText)
      && readDocxText(entries["sample-invoice (26).docx"]).includes(invoiceFixture.expectedText);
    if (!ok) {
      console.error("✗ FAILED: accepting a large batch of same-named files didn't complete correctly, or lost/misnamed entries in the zip.");
      failed = true;
    } else {
      console.log("✓ All 26 recognized correctly; the zip has 26 distinct, correctly-numbered .docx entries, none lost to a name collision.");
    }
    await context.close();
  }

  // --- Unicode filenames: a real, common case for a client-side OCR tool
  // (a user's own files are not guaranteed to be ASCII-named) that nothing
  // else here exercises. Two checks: the single-file download's real
  // <a download> value (not Playwright's own download.suggestedFilename(),
  // confirmed unreliable for non-ASCII names in this sandbox — falls back
  // to a generic "download" even though the DOM property itself is
  // correct, the same locale issue selectFilesInBrowser above works
  // around), and — the more portable, tool-independent check — the zip's
  // actual internal entry name for the batch case. ---
  {
    console.log(`\n=== unicode filename: single file, real <a download> value ===`);
    const invoiceFixture = manifest.find((f) => f.name === "sample-invoice");
    const unicodeName = "café ☕ résumé.png";
    const invoiceB64 = readFileSync(`${FIXTURE_DIR}${invoiceFixture.file}`).toString("base64");

    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));
    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await selectFilesInBrowser(page, [{ name: unicodeName, b64: invoiceB64, type: "image/png" }]);
    await waitForRunEnabled(page, { timeoutMs: 10000 });
    const listedName = await page.textContent("#file-list .file-name");
    await page.click("#run");
    await waitForStatus(page, (s) => s === "Done.", { timeoutMs: 30000, label: "the run to finish" });

    // page.waitForEvent() must be registered before the click that
    // triggers the download, not after — the click happens synchronously
    // inside the page.evaluate() below, so the real browser download can
    // fire (and, under load, be fully processed by Playwright) before a
    // waitForEvent() called only afterward ever attaches its listener.
    // Found the hard way: this raced and timed out in CI (30s) while
    // passing reliably in a lighter-loaded local run — the same class of
    // "listener registered too late" bug as every other download check in
    // this file already avoids via Promise.all([waitForEvent, click]).
    const downloadPromise = page.waitForEvent("download");
    const realDownloadName = await page.evaluate(() => new Promise((resolve) => {
      const originalCreateElement = document.createElement.bind(document);
      document.createElement = (tag) => {
        const el = originalCreateElement(tag);
        if (tag === "a") {
          const originalClick = el.click.bind(el);
          el.click = () => { resolve(el.download); originalClick(); };
        }
        return el;
      };
      document.getElementById("download").click();
    }));
    await downloadPromise;

    console.log(`File-list name: ${JSON.stringify(listedName)}, real <a download> value: ${JSON.stringify(realDownloadName)}`);
    const ok = listedName === unicodeName && realDownloadName === "café ☕ résumé.docx";
    if (!ok) {
      console.error("✗ FAILED: a Unicode filename wasn't preserved through selection and the real download name.");
      failed = true;
    } else {
      console.log("✓ Unicode filename preserved through the file list and the real (DOM-level) download name.");
    }
    await context.close();
  }

  {
    console.log(`\n=== unicode filename: batch, real zip entry name ===`);
    const invoiceFixture = manifest.find((f) => f.name === "sample-invoice");
    const tableFixture = manifest.find((f) => f.name === "table");
    const unicodeName = "café ☕ résumé.png";
    const invoiceB64 = readFileSync(`${FIXTURE_DIR}${invoiceFixture.file}`).toString("base64");
    const tableB64 = readFileSync(`${FIXTURE_DIR}${tableFixture.file}`).toString("base64");

    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));
    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await selectFilesInBrowser(page, [
      { name: unicodeName, b64: invoiceB64, type: "image/png" },
      { name: tableFixture.file, b64: tableB64, type: "image/png" },
    ]);
    await waitForRunEnabled(page, { timeoutMs: 10000 });
    await page.click("#run");
    await waitForStatus(page, (s) => s === "Done.", { timeoutMs: 30000, label: "the run to finish" });

    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
    const zipBytes = new Uint8Array(readFileSync(await download.path()));
    const entries = unzipSync(zipBytes);
    const names = Object.keys(entries).sort();
    console.log(`Zip entry names: ${JSON.stringify(names)}`);

    const ok = names.length === 2 && names.includes("café ☕ résumé.docx") && names.includes("table.docx")
      && readDocxText(entries["café ☕ résumé.docx"]).includes(invoiceFixture.expectedText);
    if (!ok) {
      console.error("✗ FAILED: a Unicode filename wasn't preserved correctly as a real zip entry name.");
      failed = true;
    } else {
      console.log("✓ Unicode filename preserved correctly as a real zip entry, with correct content.");
    }
    await context.close();
  }

  // --- Word-document export: the actual downloaded file, not just the
  // on-screen preview text, is what users take away — verify the real
  // bytes Playwright captures from a real download event, not just that
  // the button exists. Three shapes: single image -> one .docx; multiple
  // images -> one .zip of several .docx; a multi-page PDF -> one .docx
  // with real OOXML page breaks between pages, not just paragraph breaks. ---
  {
    console.log(`\n=== docx export: single image ===`);
    const invoiceFixture = manifest.find((f) => f.name === "sample-invoice");
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await page.setInputFiles("#file-input", `${FIXTURE_DIR}${invoiceFixture.file}`);
    await page.click("#run");
    await waitForStatus(page, (s) => s === "Done.", { timeoutMs: 60000, label: "the run to finish" });

    const label = await page.textContent("#download");
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
    const bytes = new Uint8Array(readFileSync(await download.path()));
    const text = readDocxText(bytes);

    const ok = label === "Download .docx"
      && download.suggestedFilename() === "sample-invoice.docx"
      && bytes[0] === 0x50 && bytes[1] === 0x4b // "PK" — a .docx is a zip
      && text.includes(invoiceFixture.expectedText);
    console.log(`Filename: ${download.suggestedFilename()}, text: ${JSON.stringify(text)}`);
    if (!ok) {
      console.error("✗ FAILED: single-image .docx export didn't produce the expected file/content.");
      failed = true;
    } else {
      console.log("✓ Single image downloads as a correctly-named .docx with the recognized text.");
    }
    await context.close();
  }

  {
    console.log(`\n=== docx export: two images -> .zip ===`);
    const invoiceFixture = manifest.find((f) => f.name === "sample-invoice");
    const tableFixture = manifest.find((f) => f.name === "table");
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await page.setInputFiles("#file-input", [`${FIXTURE_DIR}${invoiceFixture.file}`, `${FIXTURE_DIR}${tableFixture.file}`]);
    await page.click("#run");
    await waitForStatus(page, (s) => s === "Done.", { timeoutMs: 60000, label: "the run to finish" });

    const label = await page.textContent("#download");
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
    const zipBytes = new Uint8Array(readFileSync(await download.path()));
    const entries = unzipSync(zipBytes);
    const names = Object.keys(entries).sort();

    const ok = label === "Download .zip"
      && download.suggestedFilename() === "ocr-results.zip"
      && names.length === 2 && names.includes("sample-invoice.docx") && names.includes("table.docx")
      && readDocxText(entries["sample-invoice.docx"]).includes(invoiceFixture.expectedText)
      && readDocxText(entries["table.docx"]).includes("Widget A");
    console.log(`Zip entries: ${JSON.stringify(names)}`);
    if (!ok) {
      console.error("✗ FAILED: multi-image .zip export didn't produce the expected files/content.");
      failed = true;
    } else {
      console.log("✓ Two images download as a .zip containing two correctly-named, correctly-contented .docx files.");
    }
    await context.close();
  }

  {
    console.log(`\n=== docx export: multi-page PDF -> one .docx with real page breaks ===`);
    const pdfFixture = manifest.find((f) => f.name === "sample-multipage");
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await page.setInputFiles("#file-input", `${FIXTURE_DIR}${pdfFixture.file}`);
    await waitForRunEnabled(page, { timeoutMs: 20000 });
    await page.click("#run");
    await waitForStatus(page, (s) => s === "Done.", { timeoutMs: 60000, label: "the run to finish" });

    const label = await page.textContent("#download");
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
    const bytes = new Uint8Array(readFileSync(await download.path()));
    const xml = strFromU8(unzipSync(bytes)["word/document.xml"]);
    const pageBreaks = (xml.match(/<w:pageBreakBefore\/>/g) || []).length;
    const text = readDocxText(bytes);

    const ok = label === "Download .docx"
      && download.suggestedFilename() === `${pdfFixture.file.replace(/\.pdf$/, "")}.docx`
      && pageBreaks === pdfFixture.expectedPages.length - 1
      && pdfFixture.expectedPages.every((p) => text.includes(p));
    console.log(`Page breaks: ${pageBreaks} (expected ${pdfFixture.expectedPages.length - 1}), text: ${JSON.stringify(text)}`);
    if (!ok) {
      console.error("✗ FAILED: PDF -> single multi-page .docx export didn't produce the expected file/content.");
      failed = true;
    } else {
      console.log("✓ A multi-page PDF downloads as one .docx with a real page break between each page.");
    }
    await context.close();
  }

  // --- docx export from a *degraded* PDF, not just clean vector text.
  // sample-multipage.pdf above is clean vector text, which the .docx step
  // just has to carry through faithfully; scanned-multipage.pdf's pages
  // are raster images with real, imperfect OCR output — this checks the
  // .docx export step doesn't lose or mangle that on the way out, using
  // the same word-accuracy bar (scripts/text-accuracy.mjs) the fixture
  // loop above already established for this fixture, not exact match. ---
  {
    console.log(`\n=== docx export: degraded/scanned PDF -> .docx with real OCR imperfections intact ===`);
    const pdfFixture = manifest.find((f) => f.name === "scanned-multipage");
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await page.setInputFiles("#file-input", `${FIXTURE_DIR}${pdfFixture.file}`);
    await waitForRunEnabled(page, { timeoutMs: 20000 });
    await page.click("#run");
    await waitForStatus(page, (s) => s === "Done.", { timeoutMs: 60000, label: "the run to finish" });

    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
    const bytes = new Uint8Array(readFileSync(await download.path()));
    const pages = readDocxPages(bytes);
    const threshold = THRESHOLDS[pdfFixture.name];

    let allOk = pages.length === pdfFixture.expectedPages.length;
    pdfFixture.expectedPages.forEach((expected, i) => {
      const accuracy = pages[i] ? wordAccuracy(expected, pages[i]) : 0;
      const ok = accuracy >= threshold;
      allOk &&= ok;
      console.log(`  page ${i + 1}: ${(accuracy * 100).toFixed(1)}% ${ok ? "✓" : "✗"} — ${JSON.stringify(pages[i])}`);
    });
    if (!allOk) {
      console.error("✗ FAILED: the degraded PDF's .docx export lost accuracy or page structure vs. the on-screen preview.");
      failed = true;
    } else {
      console.log("✓ Degraded-PDF .docx export preserves per-page structure and real OCR accuracy.");
    }
    await context.close();
  }

  // --- Multi-language OCR: #language defaults to English, unmodified by
  // adding the picker (every fixture above that doesn't set fixture.lang
  // relies on exactly this default), and is locked for the same reason
  // #file-input already is — changing it mid-run wouldn't affect the
  // already-created worker, so leaving it interactive would just be
  // misleading about what's actually running. Per-language recognition
  // accuracy itself is already covered by the eleven per-language fixtures
  // in the main loop above (test/fixtures/manifest.json's fixture.lang
  // entries), each recognized via this exact same #language control. ---
  {
    console.log(`\n=== multi-language: #language defaults to English, locked during a run ===`);
    const invoiceFixture = manifest.find((f) => f.name === "sample-invoice");
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    const defaultLanguage = await page.inputValue("#language");
    await page.setInputFiles("#file-input", `${FIXTURE_DIR}${invoiceFixture.file}`);
    await page.click("#run");
    const disabledMidRun = await page.$eval("#language", (el) => el.disabled);
    await waitForStatus(page, (s) => s === "Done.", { timeoutMs: 60000, label: "the run to finish" });
    const disabledAfterRun = await page.$eval("#language", (el) => el.disabled);
    const recognized = (await page.inputValue("#result")).trim();

    const ok = defaultLanguage === "eng" && disabledMidRun && !disabledAfterRun
      && recognized === invoiceFixture.expectedText;
    console.log(`Default: "${defaultLanguage}", disabled mid-run: ${disabledMidRun}, disabled after: ${disabledAfterRun}`);
    if (!ok) {
      console.error("✗ FAILED: #language's default/lock behavior regressed.");
      failed = true;
    } else {
      console.log("✓ #language defaults to English, locks during a run, and unlocks again after — English recognition unaffected.");
    }
    await context.close();
  }

  // --- Real bug found during implementation, not hypothetical: pdf-export.js's
  // invisible text layer uses StandardFonts.Helvetica (WinAnsi encoding),
  // and font.encodeText() throwing on an out-of-range word is already
  // tolerated *per word* (skip just that word) — but for a genuinely
  // non-Latin-script language, *every* word in the document fails to
  // encode, which would silently produce a "searchable" PDF with the
  // right image and zero actual searchable text. #output-format's PDF
  // option is disabled outright for these languages instead of shipping
  // that silent degradation — checked directly, not assumed, for every
  // one of the six affected languages, plus that switching back to a
  // Latin-script language re-enables it. ---
  {
    console.log(`\n=== multi-language: searchable PDF disabled for non-Latin-script languages ===`);
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));
    await page.goto(`${origin}/index.html`, { waitUntil: "load" });

    const NON_LATIN = ["rus", "ara", "hin", "chi_sim", "jpn", "kor"];
    let allOk = true;
    for (const lang of NON_LATIN) {
      await page.selectOption("#language", lang);
      const disabled = await page.$eval("#pdf-format-option", (el) => el.disabled);
      const mentionsWhy = (await page.$eval("#pdf-format-option", (el) => el.textContent)).includes("not available");
      const ok = disabled && mentionsWhy;
      allOk &&= ok;
      console.log(`  ${lang}: disabled=${disabled}, explains why=${mentionsWhy} ${ok ? "✓" : "✗"}`);
    }

    // Switching back to a Latin-script language should simply re-enable
    // the option again — nothing to force-reset here, since "pdf" was
    // never a reachable selection while a non-Latin language was active
    // (checked above; every affected language shows it disabled).
    await page.selectOption("#language", "fra");
    const reenabled = await page.$eval("#pdf-format-option", (el) => !el.disabled);
    allOk &&= reenabled;
    console.log(`  switch to fra: re-enabled=${reenabled} ${reenabled ? "✓" : "✗"}`);

    // The real scenario the force-reset logic exists for: "pdf" becomes
    // selected while on a compatible language (#output-format lives inside
    // #result-section, hidden pre-run — set directly here since this is
    // checking the reset logic itself, not real click-driven
    // interactability, which the Latin-script test below already covers
    // via a real run + real click), *then* the language switches to a
    // non-Latin one — the now-stale "pdf" selection must not survive,
    // since the option that produced it is no longer even reachable.
    await page.$eval("#output-format", (el) => { el.value = "pdf"; el.dispatchEvent(new Event("change")); });
    await page.selectOption("#language", "hin");
    const resetToDocx = (await page.$eval("#output-format", (el) => el.value)) === "docx";
    allOk &&= resetToDocx;
    console.log(`  pdf selected on fra, then switch to hin: forced back to docx=${resetToDocx} ${resetToDocx ? "✓" : "✗"}`);

    if (!allOk) {
      console.error("✗ FAILED: searchable-PDF gating for non-Latin-script languages regressed.");
      failed = true;
    } else {
      console.log("✓ Searchable PDF is disabled (with an explanation) for every non-Latin-script language, and re-enables when switching back.");
    }
    await context.close();
  }

  // --- Real measured accuracy (docs/PERFORMANCE.md's degraded-conditions
  // table) drops sharply below the other ten languages specifically for
  // Hindi/Chinese(Simplified)/Japanese/Korean once a scan is rotated,
  // blurry, or noisy. Rather than hide that, #language-hint discloses it
  // in the UI for exactly those four — a *different* set from NON_LATIN
  // above (Russian and Arabic score well above this group: 77.8%/89.7%
  // degraded), so this needs its own direct check rather than reusing the
  // PDF-gating list. ---
  {
    console.log(`\n=== multi-language: accuracy hint shown only for the four low-degraded-accuracy languages ===`);
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));
    await page.goto(`${origin}/index.html`, { waitUntil: "load" });

    const hiddenAtLoad = await page.$eval("#language-hint", (el) => el.hidden);
    let allOk = hiddenAtLoad;
    console.log(`  default (eng): hint hidden=${hiddenAtLoad} ${hiddenAtLoad ? "✓" : "✗"}`);

    const LOW_ACCURACY = ["hin", "chi_sim", "jpn", "kor"];
    for (const lang of LOW_ACCURACY) {
      await page.selectOption("#language", lang);
      const shown = !(await page.$eval("#language-hint", (el) => el.hidden));
      allOk &&= shown;
      console.log(`  ${lang}: hint shown=${shown} ${shown ? "✓" : "✗"}`);
    }

    // Every other language — including rus/ara, which the PDF-gating set
    // above *does* flag but this one deliberately doesn't — must not show
    // the hint, so the two sets are proven genuinely independent here.
    const OTHER = ["eng", "fra", "spa", "deu", "por", "ita", "rus", "ara"];
    for (const lang of OTHER) {
      await page.selectOption("#language", lang);
      const hidden = await page.$eval("#language-hint", (el) => el.hidden);
      allOk &&= hidden;
      console.log(`  ${lang}: hint hidden=${hidden} ${hidden ? "✓" : "✗"}`);
    }

    if (!allOk) {
      console.error("✗ FAILED: accuracy hint visibility regressed.");
      failed = true;
    } else {
      console.log("✓ Accuracy hint shows only for the four low-degraded-accuracy languages, and only those.");
    }
    await context.close();
  }

  // --- The gating test above proves non-Latin-script languages are
  // blocked from the PDF path — this proves a Latin-script *non-English*
  // language isn't accidentally caught by the same net: French uses
  // accented characters (é, è, à, …) that WinAnsi does cover, so its
  // invisible text layer should be exactly as real/extractable as
  // English's already-covered case, not silently degraded either. ---
  {
    console.log(`\n=== multi-language: searchable PDF still genuinely works for a Latin-script non-English language ===`);
    const frenchFixture = manifest.find((f) => f.name === "sample-french");
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await page.selectOption("#language", "fra");
    await page.setInputFiles("#file-input", `${FIXTURE_DIR}${frenchFixture.file}`);
    await page.click("#run");
    await waitForStatus(page, (s) => s === "Done.", { timeoutMs: 60000, label: "the run to finish" });
    const pdfOptionDisabled = await page.$eval("#pdf-format-option", (el) => el.disabled);
    await page.selectOption("#output-format", "pdf");
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
    const bytes = new Uint8Array(readFileSync(await download.path()));
    const pages = await readPdfPagesText(bytes);
    const hasInvisibleOp = pdfHasInvisibleTextOperator(bytes);

    const ok = !pdfOptionDisabled && pages.length === 1
      && ["Le", "rapport", "trimestriel"].every((w) => pages[0]?.includes(w))
      && hasInvisibleOp;
    console.log(`pdf option disabled: ${pdfOptionDisabled}, page 1 text: ${JSON.stringify(pages[0])}, real invisible-text operator: ${hasInvisibleOp}`);
    if (!ok) {
      console.error("✗ FAILED: French (Latin-script, non-English) searchable-PDF export regressed.");
      failed = true;
    } else {
      console.log("✓ A Latin-script non-English language still gets a real, genuinely searchable PDF — not caught by the non-Latin-script gate.");
    }
    await context.close();
  }

  // --- Searchable-PDF export: the same "sandwich PDF" technique real OCR
  // tools use (original page image, unchanged, with an invisible text
  // layer underneath) as an alternative to .docx. Format defaults to
  // .docx (byte-identical to every test above, none of which ever touch
  // #output-format) — these are additive checks for the new format, not a
  // replacement for the docx coverage above. ---
  {
    console.log(`\n=== searchable PDF: format selector defaults to .docx, unmodified ===`);
    const invoiceFixture = manifest.find((f) => f.name === "sample-invoice");
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    const defaultFormat = await page.inputValue("#output-format");
    await page.setInputFiles("#file-input", `${FIXTURE_DIR}${invoiceFixture.file}`);
    await page.click("#run");
    await waitForStatus(page, (s) => s === "Done.", { timeoutMs: 60000, label: "the run to finish" });
    const label = await page.textContent("#download");
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
    const bytes = new Uint8Array(readFileSync(await download.path()));

    const ok = defaultFormat === "docx" && label === "Download .docx"
      && bytes[0] === 0x50 && bytes[1] === 0x4b // "PK" — still a .docx (zip), not a PDF
      && readDocxText(bytes).includes(invoiceFixture.expectedText);
    console.log(`Default format: "${defaultFormat}", label: "${label}"`);
    if (!ok) {
      console.error("✗ FAILED: adding the PDF format changed the default .docx behavior.");
      failed = true;
    } else {
      console.log("✓ #output-format defaults to docx, and default-format export is unaffected by the new PDF path.");
    }
    await context.close();
  }

  {
    console.log(`\n=== searchable PDF: single image ===`);
    const invoiceFixture = manifest.find((f) => f.name === "sample-invoice");
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await page.setInputFiles("#file-input", `${FIXTURE_DIR}${invoiceFixture.file}`);
    await page.click("#run");
    await waitForStatus(page, (s) => s === "Done.", { timeoutMs: 60000, label: "the run to finish" });
    await page.selectOption("#output-format", "pdf");

    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
    const bytes = new Uint8Array(readFileSync(await download.path()));
    const magic = String.fromCharCode(...bytes.subarray(0, 4));
    const pages = await readPdfPagesText(bytes);

    const ok = download.suggestedFilename() === "sample-invoice.pdf"
      && magic === "%PDF" && pages.length === 1
      && pages[0].includes("Invoice") && pages[0].includes("88214") && pages[0].includes("942.50");
    console.log(`Filename: ${download.suggestedFilename()}, magic: ${JSON.stringify(magic)}, page 1 text: ${JSON.stringify(pages[0])}`);
    if (!ok) {
      console.error("✗ FAILED: single-image searchable-PDF export didn't produce the expected file/content.");
      failed = true;
    } else {
      console.log("✓ Single image downloads as a real PDF with the recognized text genuinely extractable.");
    }
    await context.close();
  }

  {
    console.log(`\n=== searchable PDF: text is genuinely invisible, not alpha-faded ===`);
    const invoiceFixture = manifest.find((f) => f.name === "sample-invoice");
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await page.setInputFiles("#file-input", `${FIXTURE_DIR}${invoiceFixture.file}`);
    await page.click("#run");
    await waitForStatus(page, (s) => s === "Done.", { timeoutMs: 60000, label: "the run to finish" });
    await page.selectOption("#output-format", "pdf");
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
    const bytes = new Uint8Array(readFileSync(await download.path()));
    const hasInvisibleOp = pdfHasInvisibleTextOperator(bytes);

    console.log(`Content stream contains literal "3 Tr" (after inflating): ${hasInvisibleOp}`);
    if (!hasInvisibleOp) {
      console.error("✗ FAILED: no true invisible-text (Tr 3) operator found — may have regressed to an opacity-based fake.");
      failed = true;
    } else {
      console.log("✓ The OCR text layer uses the real PDF invisible-text rendering mode, not alpha-fade.");
    }
    await context.close();
  }

  {
    console.log(`\n=== searchable PDF: multi-page PDF -> one PDF, correct pages and per-page text ===`);
    const pdfFixture = manifest.find((f) => f.name === "sample-multipage");
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await page.setInputFiles("#file-input", `${FIXTURE_DIR}${pdfFixture.file}`);
    await waitForRunEnabled(page, { timeoutMs: 20000 });
    await page.click("#run");
    await waitForStatus(page, (s) => s === "Done.", { timeoutMs: 60000, label: "the run to finish" });
    await page.selectOption("#output-format", "pdf");
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
    const bytes = new Uint8Array(readFileSync(await download.path()));
    const pages = await readPdfPagesText(bytes);
    const threshold = THRESHOLDS[pdfFixture.name];

    let allOk = pages.length === pdfFixture.expectedPages.length;
    pdfFixture.expectedPages.forEach((expected, i) => {
      const accuracy = pages[i] ? wordAccuracy(expected, pages[i]) : 0;
      const ok = accuracy >= threshold;
      allOk &&= ok;
      console.log(`  page ${i + 1}: ${(accuracy * 100).toFixed(1)}% ${ok ? "✓" : "✗"} — ${JSON.stringify(pages[i])}`);
    });
    if (!allOk) {
      console.error("✗ FAILED: the multi-page searchable PDF has the wrong page count or lost accuracy per page.");
      failed = true;
    } else {
      console.log("✓ A multi-page PDF downloads as one PDF, each page's real text genuinely extractable, in order.");
    }
    await context.close();
  }

  {
    console.log(`\n=== searchable PDF: corrupt image degrades to a placeholder page, not a lost/aborted document ===`);
    const invoiceFixture = manifest.find((f) => f.name === "sample-invoice");
    const tableFixture = manifest.find((f) => f.name === "table");
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await page.setInputFiles("#file-input", [
      `${FIXTURE_DIR}${invoiceFixture.file}`,
      `${FIXTURE_DIR}corrupt-image.png`,
      `${FIXTURE_DIR}${tableFixture.file}`,
    ]);
    await page.click("#run");
    await waitForStatus(page, (s) => s === "Done.", { timeoutMs: 30000, label: "the run to finish" });
    await page.selectOption("#output-format", "pdf");
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
    const zipBytes = new Uint8Array(readFileSync(await download.path()));
    const entries = unzipSync(zipBytes);
    const names = Object.keys(entries).sort();
    const corruptPages = entries["corrupt-image.pdf"] ? await readPdfPagesText(entries["corrupt-image.pdf"]) : null;

    console.log(`Zip entries: ${JSON.stringify(names)}`);
    console.log(`corrupt-image.pdf page count: ${corruptPages?.length}, magic: ${entries["corrupt-image.pdf"] ? String.fromCharCode(...entries["corrupt-image.pdf"].subarray(0, 4)) : "n/a"}`);

    // This fixture (a genuinely truncated 30-byte PNG — see corruptImageFixture's
    // history in the per-file-failure test above) is confirmed to also fail
    // pdf-lib's embedPng(), not just Tesseract's recognize() — checked directly
    // (`PDFDocument.create().embedPng(readFileSync(...))` throws
    // "Invalid typed array length: 0") before writing this assertion, not assumed.
    const ok = names.length === 3 && names.includes("corrupt-image.pdf")
      && entries["corrupt-image.pdf"][0] === 0x25 // "%" — still a real, openable PDF
      && corruptPages?.length === 1;
    if (!ok) {
      console.error("✗ FAILED: a corrupt source image should still produce a valid placeholder PDF page, not break the export.");
      failed = true;
    } else {
      console.log("✓ The corrupt image still produced a real, valid PDF page (a placeholder) instead of losing the document or aborting the export.");
    }
    await context.close();
  }

  {
    console.log(`\n=== searchable PDF: a word outside WinAnsi doesn't crash the whole export ===`);
    // Real Tesseract almost never emits a genuinely out-of-WinAnsi
    // character on this project's own (English) fixtures, so this targets
    // pdf-export.js directly with synthetic word data containing one —
    // the same targeted-fault-injection spirit as the PDF page-render
    // failure test above (a monkey-patched canvas.getContext, not a
    // naturally-corrupt fixture), just injecting bad *data* instead of a
    // thrown exception.
    const invoiceFixture = manifest.find((f) => f.name === "sample-invoice");
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    const imageB64 = readFileSync(`${FIXTURE_DIR}${invoiceFixture.file}`).toString("base64");
    const pdfB64 = await page.evaluate(async ({ imageB64, expectedText }) => {
      const { buildSearchablePdfBlob } = await import("./pdf-export.js");
      const bytes = Uint8Array.from(atob(imageB64), (c) => c.charCodeAt(0));
      const file = new File([bytes], "sample-invoice.png", { type: "image/png" });
      const words = [
        { text: expectedText, bbox: { x0: 23, y0: 58, x1: 564, y1: 84 }, confidence: 95 },
        // Cyrillic and CJK are both entirely outside WinAnsi encoding —
        // font.encodeText() must throw on this specific word.
        { text: "привет日本語", bbox: { x0: 23, y0: 100, x1: 200, y1: 120 }, confidence: 50 },
      ];
      const blob = await buildSearchablePdfBlob([{ file, words }]);
      const buf = await blob.arrayBuffer();
      let binary = "";
      for (const b of new Uint8Array(buf)) binary += String.fromCharCode(b);
      return btoa(binary);
    }, { imageB64, expectedText: invoiceFixture.expectedText });

    const bytes = Uint8Array.from(atob(pdfB64), (c) => c.charCodeAt(0));
    const magic = String.fromCharCode(...bytes.subarray(0, 4));
    const pages = await readPdfPagesText(bytes);
    const ok = magic === "%PDF" && pages.length === 1 && pages[0].includes(invoiceFixture.expectedText);
    console.log(`magic: ${JSON.stringify(magic)}, page 1 text: ${JSON.stringify(pages[0])}`);
    if (!ok) {
      console.error("✗ FAILED: a single unencodable word crashed or corrupted the whole PDF export.");
      failed = true;
    } else {
      console.log("✓ The unencodable word's invisible run was skipped; every other word on the page still exported correctly.");
    }
    await context.close();
  }

  {
    console.log(`\n=== searchable PDF: switching format after a run doesn't rebuild the format already built ===`);
    const invoiceFixture = manifest.find((f) => f.name === "sample-invoice");
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await page.setInputFiles("#file-input", `${FIXTURE_DIR}${invoiceFixture.file}`);
    await page.click("#run");
    await waitForStatus(page, (s) => s === "Done.", { timeoutMs: 60000, label: "the run to finish" });

    const [firstDocx] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
    const firstDocxBytes = new Uint8Array(readFileSync(await firstDocx.path()));

    await page.selectOption("#output-format", "pdf");
    const [pdfDownload] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
    const pdfBytes = new Uint8Array(readFileSync(await pdfDownload.path()));

    await page.selectOption("#output-format", "docx");
    const [secondDocx] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
    const secondDocxBytes = new Uint8Array(readFileSync(await secondDocx.path()));

    const identical = firstDocxBytes.length === secondDocxBytes.length
      && firstDocxBytes.every((b, i) => b === secondDocxBytes[i]);
    console.log(`First/second .docx byte length: ${firstDocxBytes.length}/${secondDocxBytes.length}, identical: ${identical}, pdf magic: ${String.fromCharCode(...pdfBytes.subarray(0, 4))}`);
    if (!identical || pdfBytes[0] !== 0x25) {
      console.error("✗ FAILED: switching formats and back produced different bytes for a format that was already built once.");
      failed = true;
    } else {
      console.log("✓ Switching to PDF and back to .docx served the already-built .docx again, byte-identical — no wasteful/racy rebuild.");
    }
    await context.close();
  }

  // --- Per-file OCR failure: a real corrupt image (test/fixtures/corrupt-image.png
  // — a genuinely truncated real PNG, not a synthetic empty file) mixed
  // into a batch with two good ones. Confirms the whole error-handling
  // chain with a real thrown error, not a simulated one: the batch doesn't
  // abort, the bad file's status/preview both say so, the overall run
  // still reports "Done." (not "all failed") since 2 of 3 succeeded, and
  // the .docx export for the bad file contains the error placeholder text
  // instead of silently omitting that file or crashing the export. ---
  {
    console.log(`\n=== per-file failure: one corrupt image in a 3-file batch ===`);
    const invoiceFixture = manifest.find((f) => f.name === "sample-invoice");
    const tableFixture = manifest.find((f) => f.name === "table");
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await page.setInputFiles("#file-input", [
      `${FIXTURE_DIR}${invoiceFixture.file}`,
      `${FIXTURE_DIR}corrupt-image.png`,
      `${FIXTURE_DIR}${tableFixture.file}`,
    ]);
    await page.click("#run");
    await waitForStatus(page, (s) => s === "Done.", { timeoutMs: 30000, label: "the run to finish" });

    const fileStatuses = await page.$$eval("#file-list .file-status", (els) => els.map((e) => e.textContent));
    const preview = await page.inputValue("#result");
    const label = await page.textContent("#download");
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
    const zipBytes = new Uint8Array(readFileSync(await download.path()));
    const entries = unzipSync(zipBytes);
    const corruptDocxText = readDocxText(entries["corrupt-image.docx"]);

    console.log(`Per-file statuses: ${JSON.stringify(fileStatuses)}`);
    console.log(`corrupt-image.docx text: ${JSON.stringify(corruptDocxText)}`);

    const ok = fileStatuses.length === 3
      && fileStatuses[0] === "Done" && fileStatuses[2] === "Done"
      && fileStatuses[1].startsWith("Error:")
      && preview.includes(invoiceFixture.expectedText) && preview.includes("Widget A")
      && preview.includes("=== corrupt-image.png ===") && preview.includes("Error:")
      && label === "Download .zip"
      && Object.keys(entries).sort().join(",") === "corrupt-image.docx,sample-invoice.docx,table.docx"
      && corruptDocxText.includes("Error recognizing this page:");
    if (!ok) {
      console.error("✗ FAILED: one corrupt file in a batch didn't degrade the way it should.");
      failed = true;
    } else {
      console.log("✓ The bad file failed visibly (status, preview, and its own .docx) without sinking the other two.");
    }
    await context.close();
  }

  // --- PDF page-render failure: one page of a real PDF fails to rasterize
  // while the pages around it render fine. Real byte-level corruption was
  // tried first (a garbled FlateDecode content stream, an absurd
  // 200000x200000pt page) and pdf.js recovered from both without
  // throwing — genuinely resilient by design, not a gap in these attempts.
  // This uses targeted fault injection instead: pdf.js's page.render()
  // calls canvas.getContext('2d') internally exactly once per page when
  // given a raw canvas (see public/pdf-to-images.js), so failing that call
  // on the 2nd invocation reliably exercises the real per-page try/catch
  // without needing an artificially-corrupted fixture. ---
  {
    console.log(`\n=== PDF page-render failure: page 2 of 3 fails, 1 and 3 still render ===`);
    const pdfFixture = manifest.find((f) => f.name === "sample-multipage");
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await page.evaluate(() => {
      let getContextCalls = 0;
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (...args) {
        getContextCalls += 1;
        if (getContextCalls === 2) throw new Error("Injected failure for page 2");
        return original.apply(this, args);
      };
    });
    await page.setInputFiles("#file-input", `${FIXTURE_DIR}${pdfFixture.file}`);
    await waitForRunEnabled(page, { timeoutMs: 20000 });

    const statusAfterRender = await page.textContent("#status");
    const namesAfterRender = await page.$$eval("#file-list .file-name", (els) => els.map((e) => e.textContent));
    const runLabel = await page.textContent("#run");

    await page.click("#run");
    await waitForStatus(page, (s) => s === "Done.", { timeoutMs: 30000, label: "the run to finish" });
    const preview = await page.inputValue("#result");

    console.log(`Status after render: ${JSON.stringify(statusAfterRender)}`);
    console.log(`File list after render: ${JSON.stringify(namesAfterRender)}`);

    const ok = statusAfterRender.includes("Rendered with errors") && statusAfterRender.includes("page 2")
      && namesAfterRender.length === 2
      && namesAfterRender[0] === `${pdfFixture.name}-page-1.png` && namesAfterRender[1] === `${pdfFixture.name}-page-3.png`
      && runLabel === "Run OCR on 2 images"
      && preview.includes(pdfFixture.expectedPages[0]) && preview.includes(pdfFixture.expectedPages[2])
      && !preview.includes(pdfFixture.expectedPages[1]);
    if (!ok) {
      console.error("✗ FAILED: a page-render failure didn't degrade the way it should.");
      failed = true;
    } else {
      console.log("✓ Page 2 failed visibly; pages 1 and 3 still rendered, ran, and recognized correctly.");
    }
    await context.close();
  }

  // --- Hard page-count cap (MAX_PDF_PAGES, public/pdf-to-images.js): set
  // from a real measured breaking point (scripts/measure-render-scaling.mjs)
  // rather than guessed — see that constant's own comment for the numbers.
  // Checks both sides of the boundary: exactly at the cap still renders
  // (not an off-by-one that rejects a legitimate document), one page over
  // is rejected outright, before the expensive per-page render loop ever
  // starts. Cheap vector text pages here, not a full-resolution scan —
  // this is testing the *count* check itself, not render performance
  // (which measure-render-scaling.mjs already covers separately). ---
  {
    console.log(`\n=== hard page-count cap: exactly at the limit still renders ===`);
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < MAX_PDF_PAGES; i++) {
      const p = pdfDoc.addPage([200, 100]);
      p.drawText(`Page ${i + 1}`, { x: 20, y: 50, size: 12, font, color: rgb(0, 0, 0) });
    }
    const pdfB64 = Buffer.from(await pdfDoc.save()).toString("base64");

    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));
    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await selectFilesInBrowser(page, [{ name: "at-cap.pdf", b64: pdfB64, type: "application/pdf" }]);
    await waitForRunEnabled(page, { timeoutMs: 60000 });

    const status = await page.textContent("#status");
    const renderedCount = await page.$$eval("#file-list .file-name", (els) => els.length);
    console.log(`Status: ${JSON.stringify(status)}, rendered: ${renderedCount}/${MAX_PDF_PAGES}`);
    if (status.startsWith("Error:") || renderedCount !== MAX_PDF_PAGES) {
      console.error(`✗ FAILED: a PDF at exactly the ${MAX_PDF_PAGES}-page cap was rejected or under-rendered.`);
      failed = true;
    } else {
      console.log(`✓ A PDF at exactly the ${MAX_PDF_PAGES}-page cap rendered every page.`);
    }
    await context.close();
  }

  {
    console.log(`\n=== hard page-count cap: one page over is rejected outright ===`);
    const overCount = MAX_PDF_PAGES + 1;
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < overCount; i++) {
      const p = pdfDoc.addPage([200, 100]);
      p.drawText(`Page ${i + 1}`, { x: 20, y: 50, size: 12, font, color: rgb(0, 0, 0) });
    }
    const pdfB64 = Buffer.from(await pdfDoc.save()).toString("base64");

    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));
    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await selectFilesInBrowser(page, [{ name: "over-cap.pdf", b64: pdfB64, type: "application/pdf" }]);
    const status = await waitForStatus(page, (s) => s.includes("Rendered with errors"), { timeoutMs: 60000, label: "the rejection message" });
    const renderedCount = await page.$$eval("#file-list .file-name", (els) => els.length);
    console.log(`Status: ${JSON.stringify(status)}, rendered: ${renderedCount}`);

    const ok = status.includes(String(overCount)) && status.includes(String(MAX_PDF_PAGES)) && renderedCount === 0;
    if (!ok) {
      console.error(`✗ FAILED: a ${overCount}-page PDF (one over the cap) wasn't rejected with a clear message and zero rendered pages.`);
      failed = true;
    } else {
      console.log(`✓ A ${overCount}-page PDF was rejected outright, before any page rendered, with a clear message.`);
    }
    await context.close();
  }

  // --- Mixed batch: an image and a PDF selected together in one run, not
  // tested anywhere else — every other batch test uses all-images or a
  // single PDF. Confirms the image and the PDF's rendered pages coexist
  // correctly in the same selectedFiles/fileGroups pipeline, and that the
  // image gets its own single-page .docx alongside the PDF's own
  // multi-page .docx in the resulting .zip. ---
  {
    console.log(`\n=== mixed batch: one image + one PDF together ===`);
    const invoiceFixture = manifest.find((f) => f.name === "sample-invoice");
    const pdfFixture = manifest.find((f) => f.name === "sample-multipage");
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await page.setInputFiles("#file-input", [`${FIXTURE_DIR}${invoiceFixture.file}`, `${FIXTURE_DIR}${pdfFixture.file}`]);
    await waitForRunEnabled(page, { timeoutMs: 20000 });

    const namesAfterRender = await page.$$eval("#file-list .file-name", (els) => els.map((e) => e.textContent));
    const runLabel = await page.textContent("#run");

    await page.click("#run");
    await waitForStatus(page, (s) => s === "Done.", { timeoutMs: 30000, label: "the run to finish" });
    const preview = await page.inputValue("#result");

    const label = await page.textContent("#download");
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
    const zipBytes = new Uint8Array(readFileSync(await download.path()));
    const entries = unzipSync(zipBytes);
    const names = Object.keys(entries).sort();
    const pdfDocxBreaks = entries["sample-multipage.docx"]
      ? (strFromU8(unzipSync(entries["sample-multipage.docx"])["word/document.xml"]).match(/<w:pageBreakBefore\/>/g) || []).length
      : -1;

    console.log(`File list: ${JSON.stringify(namesAfterRender)}`);
    console.log(`Zip entries: ${JSON.stringify(names)}`);

    const ok = namesAfterRender.length === 4 // 1 image + 3 PDF pages
      && namesAfterRender[0] === invoiceFixture.file
      && runLabel === "Run OCR on 4 images"
      && preview.includes(invoiceFixture.expectedText)
      && pdfFixture.expectedPages.every((p) => preview.includes(p))
      && label === "Download .zip"
      && names.length === 2 && names.includes("sample-invoice.docx") && names.includes("sample-multipage.docx")
      && readDocxText(entries["sample-invoice.docx"]).includes(invoiceFixture.expectedText)
      && pdfDocxBreaks === pdfFixture.expectedPages.length - 1;
    if (!ok) {
      console.error("✗ FAILED: a mixed image+PDF batch didn't behave as expected.");
      failed = true;
    } else {
      console.log("✓ Image and PDF coexisted correctly through recognition and export: 2 .docx files, one per original file.");
    }
    await context.close();
  }

  // --- Race conditions: real UI state can be manipulated faster than a
  // single run's async flow, and the fixes for these were found by actually
  // reproducing the bugs first, not by inspection alone. ---
  {
    console.log(`\n=== race: mid-run reselection doesn't corrupt the running batch ===`);
    const invoiceFixture = manifest.find((f) => f.name === "sample-invoice");
    const tableFixture = manifest.find((f) => f.name === "table");
    const paragraphFixture = manifest.find((f) => f.name === "paragraph");
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await page.setInputFiles("#file-input", [
      `${FIXTURE_DIR}${invoiceFixture.file}`,
      `${FIXTURE_DIR}${tableFixture.file}`,
      `${FIXTURE_DIR}${paragraphFixture.file}`,
    ]);
    await page.click("#run");
    await waitForStatus(page, (s) => s.startsWith("Recognizing"), { timeoutMs: 20000, label: "recognition to start" });
    const disabledMidRun = await page.$eval("#file-input", (el) => el.disabled);

    // setInputFiles bypasses the native disabled-input block entirely (it
    // sets .files and dispatches change() directly, not via a simulated
    // click on the picker) — this is deliberately the harder case, testing
    // the isRunning guard specifically, not just the disabled attribute.
    await page.setInputFiles("#file-input", `${FIXTURE_DIR}${invoiceFixture.file}`);
    await page.waitForTimeout(200);
    const runStillDisabled = await page.$eval("#run", (el) => el.disabled);

    await waitForStatus(page, (s) => s === "Done.", { timeoutMs: 30000, label: "the run to finish" });
    const names = await page.$$eval("#file-list .file-name", (els) => els.map((e) => e.textContent));
    const result = await page.inputValue("#result");

    const ok = disabledMidRun && runStillDisabled && names.length === 3
      && result.includes(invoiceFixture.file) && result.includes(tableFixture.file) && result.includes(paragraphFixture.file);
    console.log(`fileInput.disabled mid-run: ${disabledMidRun}, run.disabled after forced reselect: ${runStillDisabled}, file-list after: ${JSON.stringify(names)}`);
    if (!ok) {
      console.error("✗ FAILED: a mid-run reselection attempt corrupted or truncated the in-flight run.");
      failed = true;
    } else {
      console.log("✓ Original 3-file run completed uncorrupted; the mid-run reselection attempt was ignored.");
    }
    await context.close();
  }

  {
    console.log(`\n=== race: synchronous double-click on Run starts only one recognition ===`);
    const invoiceFixture = manifest.find((f) => f.name === "sample-invoice");
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    let createWorkerCalls = 0;
    await page.exposeFunction("__countCreateWorker", () => { createWorkerCalls += 1; });
    await page.evaluate(() => {
      const original = Tesseract.createWorker;
      Tesseract.createWorker = (...args) => { window.__countCreateWorker(); return original(...args); };
    });
    await page.setInputFiles("#file-input", `${FIXTURE_DIR}${invoiceFixture.file}`);
    // Two .click() calls in one synchronous script — the real test of
    // whether the handler's lock (isRunning set before anything else,
    // including before the large-batch confirm() dialog) actually holds.
    // A Promise.all() of two separate page.click() calls is NOT an
    // equivalent test: Playwright's own click machinery has enough
    // latency that the two land seconds apart, well after the first run
    // already finished — that looked like a failure on first attempt and
    // was actually a test-methodology bug, not an app bug; caught by
    // logging real event timestamps before trusting the result.
    await page.evaluate(() => {
      const btn = document.getElementById('run');
      btn.click();
      btn.click();
    });
    await waitForStatus(page, (s) => s === "Done.", { timeoutMs: 30000, label: "the run to finish" });

    console.log(`Tesseract.createWorker call count: ${createWorkerCalls}`);
    if (createWorkerCalls !== 1) {
      console.error("✗ FAILED: a synchronous double-click started more than one recognition run.");
      failed = true;
    } else {
      console.log("✓ Only one recognition run started.");
    }
    await context.close();
  }

  {
    console.log(`\n=== race: Download is structurally inaccessible during an active run ===`);
    const invoiceFixture = manifest.find((f) => f.name === "sample-invoice");
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await page.setInputFiles("#file-input", `${FIXTURE_DIR}${invoiceFixture.file}`);
    await page.click("#run");
    await waitForStatus(page, (s) => s.startsWith("Recognizing"), { timeoutMs: 20000, label: "recognition to start" });
    const resultSectionHiddenMidRun = await page.$eval("#result-section", (el) => el.hidden);
    await waitForStatus(page, (s) => s === "Done.", { timeoutMs: 30000, label: "the run to finish" });

    if (!resultSectionHiddenMidRun) {
      console.error("✗ FAILED: the result/download section was visible during an active run.");
      failed = true;
    } else {
      console.log("✓ Download button is inaccessible (parent section hidden) for the duration of a run.");
    }
    await context.close();
  }

  // --- Cancel: recognize-phase, partway through a batch. Uses a tight
  // 5000ms timeout (not this file's usual 30-60s) waiting for the
  // "Cancelled" status specifically so a regression to the naive "just
  // await worker.terminate()" approach — which hangs forever, since
  // terminate() doesn't reject an in-flight recognize() call, confirmed
  // directly from tesseract.js's own source — fails fast with an
  // unambiguous message instead of a generic multi-second timeout. The
  // bound is generous relative to how fast this actually resolves (the
  // Promise.race settles as soon as cancelRequested flips), not tuned to
  // one engine — this project already hit a real Firefox-specific timing
  // surprise once (see waitForStatus's own history) and isn't repeating it. ---
  {
    console.log(`\n=== cancel: recognize-phase, partway through a 6-item batch ===`);
    const invoiceFixture = manifest.find((f) => f.name === "sample-invoice");
    const manyPaths = Array.from({ length: 6 }, () => `${FIXTURE_DIR}${invoiceFixture.file}`);
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await page.setInputFiles("#file-input", manyPaths);
    await waitForRunEnabled(page, { timeoutMs: 10000 });
    await page.click("#run");
    await waitForStatus(page, (s) => s.includes("3 of 6"), { timeoutMs: 15000, label: "item 3 to start" });
    await page.click("#cancel");
    const status = await waitForStatus(page, (s) => s.startsWith("Cancelled"), { timeoutMs: 5000, label: "the cancelled status (tight bound — a hang here means cancellation regressed)" });

    const fileStatuses = await page.$$eval("#file-list .file-status", (els) => els.map((e) => e.textContent));
    const runReenabled = await waitForRunEnabled(page, { timeoutMs: 2000 }).then(() => true).catch(() => false);
    const fileInputReenabled = await page.$eval("#file-input", (el) => !el.disabled);
    const cancelHidden = await page.$eval("#cancel", (el) => el.hidden);
    console.log(`Status: ${JSON.stringify(status)}`);
    console.log(`File statuses: ${JSON.stringify(fileStatuses)}`);
    console.log(`Run/file-input re-enabled: ${runReenabled}/${fileInputReenabled}, Cancel hidden again: ${cancelHidden}`);

    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
    const zipBytes = new Uint8Array(readFileSync(await download.path()));
    const entries = unzipSync(zipBytes);
    const doneCount = fileStatuses.filter((s) => s === "Done").length;
    const cancelledCount = fileStatuses.filter((s) => s === "Cancelled").length;
    const completedEntry = Object.keys(entries).find((n) => readDocxText(entries[n]).includes(invoiceFixture.expectedText));
    const cancelledEntry = Object.keys(entries).find((n) => readDocxText(entries[n]).includes("[Cancelled — not recognized]"));

    const ok = status.includes(`${doneCount} of 6`) && doneCount > 0 && doneCount < 6
      && doneCount + cancelledCount === 6 && runReenabled && fileInputReenabled && cancelHidden
      && !!completedEntry && !!cancelledEntry;
    if (!ok) {
      console.error("✗ FAILED: recognize-phase cancel didn't stop partway through with correct state and output.");
      failed = true;
    } else {
      console.log(`✓ Cancelled cleanly after ${doneCount}/6 items; UI re-enabled promptly; .docx has real text for completed items and a real placeholder for cancelled ones.`);
    }
    await context.close();
  }

  // --- Same cancel scenario as directly above, but checked through the
  // searchable-PDF format specifically: unlike .docx, this format embeds a
  // real image per page even for a page that never got to run OCR, so it
  // has a failure mode .docx literally cannot have (see the corrupt-image
  // PDF test above) — cancelled pages must still exist in the output,
  // with their real image and no text layer, not just a docx-style text
  // placeholder. ---
  {
    console.log(`\n=== cancel: recognize-phase, partway through a 6-item batch, PDF format ===`);
    const invoiceFixture = manifest.find((f) => f.name === "sample-invoice");
    const manyPaths = Array.from({ length: 6 }, () => `${FIXTURE_DIR}${invoiceFixture.file}`);
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await page.setInputFiles("#file-input", manyPaths);
    await waitForRunEnabled(page, { timeoutMs: 10000 });
    await page.click("#run");
    await waitForStatus(page, (s) => s.includes("3 of 6"), { timeoutMs: 15000, label: "item 3 to start" });
    await page.click("#cancel");
    const status = await waitForStatus(page, (s) => s.startsWith("Cancelled"), { timeoutMs: 5000, label: "the cancelled status" });
    const fileStatuses = await page.$$eval("#file-list .file-status", (els) => els.map((e) => e.textContent));
    const doneCount = fileStatuses.filter((s) => s === "Done").length;

    await page.selectOption("#output-format", "pdf");
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
    const zipBytes = new Uint8Array(readFileSync(await download.path()));
    const entries = unzipSync(zipBytes);
    const names = Object.keys(entries).sort();
    // All 6 pages produce their own numbered .pdf entry regardless of
    // whether OCR reached them — the file itself was always available.
    const expectedNames = Array.from({ length: 6 }, (_, i) => i === 0 ? "sample-invoice.pdf" : `sample-invoice (${i + 1}).pdf`).sort();
    let completedWithText = 0;
    let cancelledNoText = 0;
    for (const [name, bytes] of Object.entries(entries)) {
      const pages = await readPdfPagesText(bytes);
      // Word-level check, not an exact-phrase match: pdf.js's
      // getTextContent() sometimes emits its own extra whitespace-only
      // items for a large horizontal gap between words, which combined
      // with the join(" ") below can produce irregular spacing (e.g. two
      // or three spaces between some words) — real, correctly-extracted
      // text, just not byte-identical to the fixture's single-spaced
      // expectedText. The single-image searchable-PDF test above already
      // established this same word-level check for exactly this reason.
      if (["Invoice", "88214", "942.50"].every((w) => pages[0]?.includes(w))) completedWithText += 1;
      else if (pages[0] === "") cancelledNoText += 1;
    }
    console.log(`Status: ${JSON.stringify(status)}, entries: ${JSON.stringify(names)}`);
    console.log(`Completed-with-text: ${completedWithText}, cancelled-with-no-text: ${cancelledNoText}`);

    const ok = names.length === 6 && names.join(",") === expectedNames.join(",")
      && completedWithText === doneCount && cancelledNoText === 6 - doneCount;
    if (!ok) {
      console.error("✗ FAILED: cancelled PDF export didn't preserve one page per item with the right text/no-text split.");
      failed = true;
    } else {
      console.log(`✓ All 6 pages present (${doneCount} with real recognized text, ${6 - doneCount} with just the image, no text layer).`);
    }
    await context.close();
  }

  // --- Cancel: recognize-phase, before anything completes. Real
  // regression test for a genuine [].every() vacuous-truth bug found
  // during implementation: results.every(r => r.error) on an EMPTY array
  // is true in JS, which would show "Error: all 0 file(s) failed to
  // recognize" instead of a real cancelled status if the cancelled-check
  // didn't take priority. ---
  {
    console.log(`\n=== cancel: recognize-phase, before any item completes ===`);
    const invoiceFixture = manifest.find((f) => f.name === "sample-invoice");
    const manyPaths = Array.from({ length: 3 }, () => `${FIXTURE_DIR}${invoiceFixture.file}`);
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await page.setInputFiles("#file-input", manyPaths);
    await waitForRunEnabled(page, { timeoutMs: 10000 });
    await page.click("#run");
    await waitForStatus(page, (s) => s.startsWith("Recognizing"), { timeoutMs: 15000, label: "recognition to start" });
    await page.click("#cancel");
    const status = await waitForStatus(page, (s) => s.startsWith("Cancelled"), { timeoutMs: 5000, label: "the cancelled status" });

    console.log(`Status: ${JSON.stringify(status)}`);
    const ok = status === "Cancelled — 0 of 3 recognized." && !status.startsWith("Error:");
    if (!ok) {
      console.error(`✗ FAILED: cancelling before any item completed produced the wrong status (possible [].every() vacuous-truth regression): ${JSON.stringify(status)}`);
      failed = true;
    } else {
      console.log("✓ Cancelling with zero completed items reports a real cancelled status, not the vacuous-truth error string.");
    }
    await context.close();
  }

  // --- Cancel button visibility: hidden at rest, and again after a normal
  // (non-cancelled) run completes — regression against it getting stuck
  // visible once a run finishes on its own. ---
  {
    console.log(`\n=== cancel: button hidden at rest and after normal completion ===`);
    const invoiceFixture = manifest.find((f) => f.name === "sample-invoice");
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    const hiddenAtRest = await page.$eval("#cancel", (el) => el.hidden);
    await page.setInputFiles("#file-input", `${FIXTURE_DIR}${invoiceFixture.file}`);
    await waitForRunEnabled(page, { timeoutMs: 10000 });
    await page.click("#run");
    await waitForStatus(page, (s) => s === "Done.", { timeoutMs: 30000, label: "the run to finish" });
    const hiddenAfterDone = await page.$eval("#cancel", (el) => el.hidden);

    console.log(`Hidden at rest: ${hiddenAtRest}, hidden after normal "Done.": ${hiddenAfterDone}`);
    if (!hiddenAtRest || !hiddenAfterDone) {
      console.error("✗ FAILED: the Cancel button was visible when it shouldn't be.");
      failed = true;
    } else {
      console.log("✓ Cancel button stays hidden at rest and after a run completes normally.");
    }
    await context.close();
  }

  // --- Cancel: double-click safety, mirroring the existing synchronous
  // double-click-Run race test — two real clicks in one script turn, not
  // two separate Playwright actions seconds apart (which wouldn't be a
  // race at all — see that test's own comment on this exact methodology
  // trap). ---
  {
    console.log(`\n=== cancel: synchronous double-click doesn't corrupt state ===`);
    const invoiceFixture = manifest.find((f) => f.name === "sample-invoice");
    const manyPaths = Array.from({ length: 4 }, () => `${FIXTURE_DIR}${invoiceFixture.file}`);
    const context = await browser.newContext();
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await page.setInputFiles("#file-input", manyPaths);
    await waitForRunEnabled(page, { timeoutMs: 10000 });
    await page.click("#run");
    await waitForStatus(page, (s) => s.startsWith("Recognizing"), { timeoutMs: 15000, label: "recognition to start" });
    await page.evaluate(() => {
      const btn = document.getElementById('cancel');
      btn.click();
      btn.click();
    });
    const status = await waitForStatus(page, (s) => s.startsWith("Cancelled"), { timeoutMs: 5000, label: "the cancelled status" });

    console.log(`Status: ${JSON.stringify(status)}, page errors: ${JSON.stringify(pageErrors)}`);
    const ok = status.startsWith("Cancelled") && pageErrors.length === 0;
    if (!ok) {
      console.error("✗ FAILED: a synchronous double-click on Cancel produced an error or a corrupted status.");
      failed = true;
    } else {
      console.log("✓ A synchronous double-click on Cancel produces one clean cancellation, no errors.");
    }
    await context.close();
  }

  // --- Cancel: race against natural completion on a single-item run.
  // Clicking Cancel right after Run on a fast, one-item batch can
  // legitimately land either before or after that one item finishes —
  // both "Done." and "Cancelled — 0 of 1 recognized." are correct
  // outcomes; the vacuous-truth error string and a hang are the only two
  // wrong ones. ---
  {
    console.log(`\n=== cancel: race against natural completion (1-item run) ===`);
    const invoiceFixture = manifest.find((f) => f.name === "sample-invoice");
    const context = await browser.newContext();
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await page.setInputFiles("#file-input", `${FIXTURE_DIR}${invoiceFixture.file}`);
    await waitForRunEnabled(page, { timeoutMs: 10000 });
    await page.click("#run");
    await page.click("#cancel").catch(() => {}); // may already be hidden if the run finished first — that's a legitimate outcome, not a failure
    const status = await waitForStatus(
      page,
      (s) => s === "Done." || s.startsWith("Cancelled") || s.startsWith("Error:"),
      { timeoutMs: 10000, label: "a terminal status" },
    );

    console.log(`Status: ${JSON.stringify(status)}, page errors: ${JSON.stringify(pageErrors)}`);
    const ok = (status === "Done." || status.startsWith("Cancelled")) && pageErrors.length === 0;
    if (!ok) {
      console.error(`✗ FAILED: racing Cancel against natural completion produced an illegitimate outcome: ${JSON.stringify(status)}`);
      failed = true;
    } else {
      console.log(`✓ Racing Cancel against natural completion always lands on a legitimate outcome ("${status}"), never hangs or shows the vacuous-truth error.`);
    }
    await context.close();
  }

  // --- Cancel: render-phase (PDF page rasterization), not just the
  // recognize phase. Before this, a cancelled render fell through to the
  // same blank-string success path a fully-successful render uses — this
  // regression-tests the dedicated cancelled-render status added
  // alongside it. Uses a real PDF sized to give a genuinely measurable
  // render window (large per-page canvas — see measure-render-scaling.mjs
  // for why full-resolution-scan-shaped pages are the realistic stress
  // case), built with pdf-lib the same way the MAX_PDF_PAGES boundary
  // tests above do. ---
  {
    console.log(`\n=== cancel: render-phase (PDF rasterization) ===`);
    const pageCount = 40;
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < pageCount; i++) {
      const p = pdfDoc.addPage([2480, 3508]); // full-resolution-scan-shaped page — real render cost per page, not free vector text
      p.drawText(`Page ${i + 1}`, { x: 100, y: 100, size: 40, font, color: rgb(0, 0, 0) });
    }
    const pdfB64 = Buffer.from(await pdfDoc.save()).toString("base64");

    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await selectFilesInBrowser(page, [{ name: "cancel-render-test.pdf", b64: pdfB64, type: "application/pdf" }]);
    await waitForText(page, "#cancel", (t) => t === "Cancel", { timeoutMs: 5000, label: "the Cancel button to appear" });
    await page.waitForTimeout(800); // let a handful of pages render first
    await page.click("#cancel");
    const status = await waitForStatus(page, (s) => s.startsWith("Cancelled"), { timeoutMs: 5000, label: "the render-cancelled status" });

    const renderedCount = await page.$$eval("#file-list .file-name", (els) => els.length);
    const fileInputReenabled = await page.$eval("#file-input", (el) => !el.disabled);
    const cancelHidden = await page.$eval("#cancel", (el) => el.hidden);
    console.log(`Status: ${JSON.stringify(status)}`);
    console.log(`Rendered page count: ${renderedCount} (expected < ${pageCount})`);
    console.log(`file-input re-enabled: ${fileInputReenabled}, Cancel hidden again: ${cancelHidden}`);

    const ok = status.includes("Cancelled") && renderedCount > 0 && renderedCount < pageCount
      && fileInputReenabled && cancelHidden;
    if (!ok) {
      console.error("✗ FAILED: cancelling a PDF render didn't stop early with correct state.");
      failed = true;
    } else {
      console.log(`✓ Render cancelled cleanly after ${renderedCount}/${pageCount} pages, with a real distinct status (not the old blank-string gap).`);
    }
    await context.close();
  }

  // --- Mobile viewport & touch emulation: this project has zero
  // responsive media queries (public/style.css relies entirely on fluid
  // sizing — clamp(), max-width, percentage padding) and had never
  // actually been driven with touch input before. Real device profiles
  // (viewport, user agent, hasTouch, isMobile) via Playwright's bundled
  // `devices`, not guessed dimensions — six of them: three narrow phones
  // (including one Android alternative to the iPhone shapes), one phone
  // in landscape (a real, common orientation this had never been checked
  // in at all), and one tablet (768px — well past the layout's 640px
  // max-width, so this also checks that the fluid design centers
  // correctly once it stops being viewport-constrained, not just that it
  // survives the narrowest phones). ---
  {
    console.log(`\n=== mobile: layout fits without horizontal overflow ===`);
    const layoutDevices = [
      { name: "iPhone SE (320px, narrowest common phone)", profile: devices["iPhone SE"] },
      { name: "Galaxy S9+ (320px Android)", profile: devices["Galaxy S9+"] },
      { name: "iPhone 13 (390px)", profile: devices["iPhone 13"] },
      { name: "Pixel 7 (412px)", profile: devices["Pixel 7"] },
      { name: "iPhone SE landscape (568x320)", profile: devices["iPhone SE landscape"] },
      { name: "iPad Mini (768px tablet)", profile: devices["iPad Mini"] },
    ];
    let allOk = true;
    for (const { name, profile } of layoutDevices) {
      const context = await browser.newContext(mobileContextOptions(profile));
      const page = await context.newPage();
      page.on("pageerror", (e) => console.error("[pageerror]", String(e)));
      await page.goto(`${origin}/index.html`, { waitUntil: "load" });

      const { scrollWidth, viewportWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      }));
      const runBox = await page.$eval("#run", (el) => el.getBoundingClientRect());
      const pickerBox = await page.$eval(".picker-btn", (el) => el.getBoundingClientRect());
      const noOverflow = scrollWidth <= viewportWidth;
      const runVisible = runBox.left >= 0 && runBox.right <= viewportWidth;
      const pickerVisible = pickerBox.left >= 0 && pickerBox.right <= viewportWidth;
      const ok = noOverflow && runVisible && pickerVisible;
      allOk &&= ok;
      console.log(`  ${name}: scrollWidth=${scrollWidth} viewport=${viewportWidth} (${noOverflow ? "no overflow" : "OVERFLOW"}), Run button in-bounds: ${runVisible}, Choose Files in-bounds: ${pickerVisible} ${ok ? "✓" : "✗"}`);
      await context.close();
    }
    if (!allOk) {
      console.error("✗ FAILED: layout overflows or clips a key control at a real mobile viewport width.");
      failed = true;
    } else {
      console.log("✓ No horizontal overflow and key controls stay in-bounds at any of the six device widths/orientations.");
    }
  }

  // --- Mobile: real end-to-end interactions driven with touch input
  // (tap(), not click()) on real device profiles — confirms the app's
  // actual controls work under touch, not just mouse, and across more
  // than just the single-file happy path. File selection itself still
  // goes through setInputFiles()/selectFilesInBrowser(): no automation
  // tool can drive a real OS file-picker dialog regardless of
  // touch/mobile emulation, on any engine — that's a platform limitation
  // the app's own code has no way to satisfy either way. What these test
  // is that Run, Download, Copy, and the large-batch confirm() dialog all
  // work under a real tap, on real narrow viewports, through real
  // recognition — not just the first one already covered. ---
  {
    console.log(`\n=== mobile touch: single file, tap Run + tap Download (iPhone SE) ===`);
    const invoiceFixture = manifest.find((f) => f.name === "sample-invoice");
    const context = await browser.newContext(mobileContextOptions(devices["iPhone SE"]));
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await page.setInputFiles("#file-input", `${FIXTURE_DIR}${invoiceFixture.file}`);
    await waitForRunEnabled(page, { timeoutMs: 10000 });
    await page.tap("#run");
    await waitForStatus(page, (s) => s === "Done.", { timeoutMs: 30000, label: "the run to finish" });

    const recognized = (await page.inputValue("#result")).trim();
    const [download] = await Promise.all([page.waitForEvent("download"), page.tap("#download")]);
    const downloadOk = !!(await download.path());

    const ok = recognized === invoiceFixture.expectedText && downloadOk;
    console.log(`Recognized via touch-driven run: ${JSON.stringify(recognized)}`);
    console.log(`Download tapped successfully: ${downloadOk}`);
    if (!ok) {
      console.error("✗ FAILED: a touch-driven single-file run didn't complete correctly.");
      failed = true;
    } else {
      console.log("✓ Full run (tap Run, tap Download) works correctly on a real mobile viewport with touch input.");
    }
    await context.close();
  }

  {
    console.log(`\n=== mobile touch: multi-file batch, tap Run + tap Copy + tap Download -> zip (Pixel 7) ===`);
    const invoiceFixture = manifest.find((f) => f.name === "sample-invoice");
    const tableFixture = manifest.find((f) => f.name === "table");
    const context = await browser.newContext(mobileContextOptions(devices["Pixel 7"]));
    // clipboard-write is Chromium-only in Playwright's permission model —
    // grant it there so the real success path gets exercised, and skip it
    // entirely elsewhere rather than relying on a .catch() around the
    // call: confirmed the hard way that on WebKit, granting an unsupported
    // permission doesn't reject grantPermissions() itself — it silently
    // records an error that's deferred and thrown on the *next* context
    // operation (context.newPage() here), so a .catch() on the grant call
    // never sees it. Either way the assertion below accepts both graceful
    // outcomes the app itself can now produce (see the app.js fix below),
    // so skipping the grant on unsupported engines costs nothing.
    if (engineName === "chromium") {
      await context.grantPermissions(["clipboard-write"], { origin });
    }
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await page.setInputFiles("#file-input", [`${FIXTURE_DIR}${invoiceFixture.file}`, `${FIXTURE_DIR}${tableFixture.file}`]);
    await waitForRunEnabled(page, { timeoutMs: 10000 });
    await page.tap("#run");
    await waitForStatus(page, (s) => s === "Done.", { timeoutMs: 30000, label: "the run to finish" });

    const fileStatuses = await page.$$eval("#file-list .file-status", (els) => els.map((e) => e.textContent));
    await page.tap("#copy");
    // A real headless/CI browser can deny clipboard-write even with the
    // permission grant above (found the hard way: CI's Chromium denied it
    // outright — see app.js's copyButton handler, which now handles that
    // rejection instead of leaving the button stuck). Either outcome here
    // proves the tap reached the handler and it completed without
    // hanging or throwing uncaught; "Copy text" (unchanged) would mean it
    // didn't.
    const copyButtonText = await waitForText(page, "#copy", (t) => t === "Copied!" || t === "Copy failed", { timeoutMs: 5000, label: "the Copy button to update after tap" });
    const [download] = await Promise.all([page.waitForEvent("download"), page.tap("#download")]);
    const zipBytes = new Uint8Array(readFileSync(await download.path()));
    const names = Object.keys(unzipSync(zipBytes)).sort();

    const bothDone = fileStatuses.length === 2 && fileStatuses.every((s) => s === "Done");
    const copiedOk = copyButtonText === "Copied!" || copyButtonText === "Copy failed";
    const zipOk = JSON.stringify(names) === JSON.stringify(["sample-invoice.docx", "table.docx"]);
    console.log(`Per-file statuses: ${JSON.stringify(fileStatuses)}`);
    console.log(`Copy button after tap: ${JSON.stringify(copyButtonText)}`);
    console.log(`Zip entries: ${JSON.stringify(names)}`);

    if (!bothDone || !copiedOk || !zipOk) {
      console.error("✗ FAILED: a touch-driven multi-file batch (tap Run, tap Copy, tap Download) didn't complete correctly.");
      failed = true;
    } else {
      console.log("✓ Multi-file batch, Copy, and zip Download all work correctly under touch input.");
    }
    await context.close();
  }

  {
    console.log(`\n=== mobile touch: large-batch confirm() dialog, tap Run (iPhone 13) ===`);
    const invoiceFixture = manifest.find((f) => f.name === "sample-invoice");
    const manyPaths = Array.from({ length: 26 }, () => `${FIXTURE_DIR}${invoiceFixture.file}`);
    const context = await browser.newContext(mobileContextOptions(devices["iPhone 13"]));
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));
    let dialogMessage = null;
    page.on("dialog", async (dialog) => { dialogMessage = dialog.message(); await dialog.accept(); });

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await page.setInputFiles("#file-input", manyPaths);
    await waitForRunEnabled(page, { timeoutMs: 10000 });
    await page.tap("#run");
    await waitForStatus(page, (s) => s === "Done.", { timeoutMs: 60000, label: "the run to finish" });

    const fileStatuses = await page.$$eval("#file-list .file-status", (els) => els.map((e) => e.textContent));
    const dialogMentionsCount = dialogMessage?.includes("26") ?? false;
    console.log(`Dialog fired: ${!!dialogMessage} (mentions 26: ${dialogMentionsCount})`);
    console.log(`26/26 statuses "Done": ${fileStatuses.length === 26 && fileStatuses.every((s) => s === "Done")}`);

    const ok = !!dialogMessage && dialogMentionsCount && fileStatuses.length === 26 && fileStatuses.every((s) => s === "Done");
    if (!ok) {
      console.error("✗ FAILED: tapping Run above the large-batch threshold on a mobile viewport didn't behave correctly.");
      failed = true;
    } else {
      console.log("✓ The large-batch confirm() dialog fires and completes correctly from a touch tap on a mobile viewport.");
    }
    await context.close();
  }

  {
    console.log(`\n=== mobile touch: per-file error, tap Run + tap Download (Galaxy S9+) ===`);
    const invoiceFixture = manifest.find((f) => f.name === "sample-invoice");
    const context = await browser.newContext(mobileContextOptions(devices["Galaxy S9+"]));
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await page.setInputFiles("#file-input", [`${FIXTURE_DIR}${invoiceFixture.file}`, `${FIXTURE_DIR}corrupt-image.png`]);
    await waitForRunEnabled(page, { timeoutMs: 10000 });
    await page.tap("#run");
    await waitForStatus(page, (s) => s === "Done.", { timeoutMs: 30000, label: "the run to finish" });

    const fileStatuses = await page.$$eval("#file-list .file-status", (els) => els.map((e) => e.textContent));
    const [download] = await Promise.all([page.waitForEvent("download"), page.tap("#download")]);
    const zipBytes = new Uint8Array(readFileSync(await download.path()));
    const entries = unzipSync(zipBytes);
    const errorDocxText = entries["corrupt-image.docx"] ? readDocxText(entries["corrupt-image.docx"]) : null;

    console.log(`Per-file statuses: ${JSON.stringify(fileStatuses)}`);
    console.log(`corrupt-image.docx text: ${JSON.stringify(errorDocxText)}`);

    const ok = fileStatuses.length === 2 && fileStatuses[0] === "Done" && fileStatuses[1].startsWith("Error:")
      && errorDocxText?.includes("Error recognizing this page");
    if (!ok) {
      console.error("✗ FAILED: a per-file error didn't surface correctly through a touch-driven run and download.");
      failed = true;
    } else {
      console.log("✓ A per-file error (bad image alongside a good one) surfaces correctly through tap Run and tap Download.");
    }
    await context.close();
  }

  {
    console.log(`\n=== mobile touch: tap Cancel mid-run (iPhone 13) ===`);
    const invoiceFixture = manifest.find((f) => f.name === "sample-invoice");
    const manyPaths = Array.from({ length: 4 }, () => `${FIXTURE_DIR}${invoiceFixture.file}`);
    const context = await browser.newContext(mobileContextOptions(devices["iPhone 13"]));
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await page.setInputFiles("#file-input", manyPaths);
    await waitForRunEnabled(page, { timeoutMs: 10000 });
    await page.tap("#run");
    await waitForStatus(page, (s) => s.startsWith("Recognizing"), { timeoutMs: 15000, label: "recognition to start" });
    await page.tap("#cancel");
    const status = await waitForStatus(page, (s) => s.startsWith("Cancelled"), { timeoutMs: 5000, label: "the cancelled status" });
    const cancelHidden = await page.$eval("#cancel", (el) => el.hidden);

    console.log(`Status: ${JSON.stringify(status)}, Cancel hidden again: ${cancelHidden}`);
    const ok = status.startsWith("Cancelled") && cancelHidden;
    if (!ok) {
      console.error("✗ FAILED: tapping Cancel mid-run on a mobile viewport didn't stop the run correctly.");
      failed = true;
    } else {
      console.log("✓ Tapping Cancel mid-run works correctly on a real mobile viewport with touch input.");
    }
    await context.close();
  }

  // --- Accessibility: a real automated audit (axe-core, via
  // @axe-core/playwright — the standard tool for this, not a hand-rolled
  // check), against the real running page in three real states, not just
  // the empty landing page. Interactive states can introduce issues the
  // static markup doesn't have — the file list and result panel are both
  // built dynamically by app.js, so they're exactly the parts a purely
  // static HTML review would miss. ---
  {
    console.log(`\n=== accessibility: automated audit (axe-core) across real UI states ===`);
    const invoiceFixture = manifest.find((f) => f.name === "sample-invoice");
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", String(e)));

    await page.goto(`${origin}/index.html`, { waitUntil: "load" });

    let allViolations = [];
    async function auditState(label) {
      const results = await new AxeBuilder({ page }).analyze();
      console.log(`  ${label}: ${results.violations.length} violation(s)`);
      for (const v of results.violations) {
        console.log(`    ✗ [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s)) — ${v.helpUrl}`);
        for (const node of v.nodes) console.log(`        ${node.target.join(" ")}`);
      }
      allViolations.push(...results.violations.map((v) => ({ ...v, state: label })));
    }

    await auditState("initial load (empty state)");

    await page.setInputFiles("#file-input", `${FIXTURE_DIR}${invoiceFixture.file}`);
    await waitForRunEnabled(page, { timeoutMs: 10000 });
    await auditState("file selected (file-list populated)");

    await page.click("#run");
    // A brand-new interactive element (#cancel) is only ever visible in
    // this exact state — it would otherwise ship completely unaudited.
    await waitForStatus(page, (s) => s.startsWith("Recognizing"), { timeoutMs: 20000, label: "recognition to start" });
    await auditState("run in progress (cancel button visible)");
    await waitForStatus(page, (s) => s === "Done.", { timeoutMs: 30000, label: "the run to finish" });
    await auditState("run complete (result panel visible)");

    if (allViolations.length > 0) {
      console.error(`✗ FAILED: ${allViolations.length} accessibility violation(s) found across ${new Set(allViolations.map((v) => v.state)).size} state(s) — see details above.`);
      failed = true;
    } else {
      console.log("✓ No accessibility violations found in any of the four states audited.");
    }
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
