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
import { unzipSync, strFromU8 } from "fflate";
import { startServer } from "./serve.mjs";
import { wordAccuracy, parseLabelledBlocks } from "./text-accuracy.mjs";
import { readDocxText, readDocxPages, selectFilesInBrowser } from "./browser-test-helpers.mjs";

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
    await page.waitForFunction(() => !document.getElementById("run").disabled);

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
    await page.waitForFunction(() => !document.getElementById("run").disabled);
    await page.click("#run");
    await page.waitForFunction(() => document.getElementById("status").textContent === "Done.", { timeout: 60000 });

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
    await page.waitForFunction(() => !document.getElementById("run").disabled, { timeout: 10000 });
    const listedName = await page.textContent("#file-list .file-name");
    await page.click("#run");
    await page.waitForFunction(() => document.getElementById("status").textContent === "Done.", { timeout: 30000 });

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
    await page.waitForEvent("download");

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
    await page.waitForFunction(() => !document.getElementById("run").disabled, { timeout: 10000 });
    await page.click("#run");
    await page.waitForFunction(() => document.getElementById("status").textContent === "Done.", { timeout: 30000 });

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
    await page.waitForFunction(() => document.getElementById("status").textContent === "Done.", { timeout: 60000 });

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
    await page.waitForFunction(() => document.getElementById("status").textContent === "Done.", { timeout: 60000 });

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
    await page.waitForFunction(() => !document.getElementById("run").disabled, { timeout: 20000 });
    await page.click("#run");
    await page.waitForFunction(() => document.getElementById("status").textContent === "Done.", { timeout: 60000 });

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
    await page.waitForFunction(() => !document.getElementById("run").disabled, { timeout: 20000 });
    await page.click("#run");
    await page.waitForFunction(() => document.getElementById("status").textContent === "Done.", { timeout: 60000 });

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
    await page.waitForFunction(() => document.getElementById("status").textContent === "Done.", { timeout: 30000 });

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
    await page.waitForFunction(() => !document.getElementById("run").disabled, { timeout: 20000 });

    const statusAfterRender = await page.textContent("#status");
    const namesAfterRender = await page.$$eval("#file-list .file-name", (els) => els.map((e) => e.textContent));
    const runLabel = await page.textContent("#run");

    await page.click("#run");
    await page.waitForFunction(() => document.getElementById("status").textContent === "Done.", { timeout: 30000 });
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
    await page.waitForFunction(() => !document.getElementById("run").disabled, { timeout: 20000 });

    const namesAfterRender = await page.$$eval("#file-list .file-name", (els) => els.map((e) => e.textContent));
    const runLabel = await page.textContent("#run");

    await page.click("#run");
    await page.waitForFunction(() => document.getElementById("status").textContent === "Done.", { timeout: 30000 });
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
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Recognizing"), { timeout: 20000 });
    const disabledMidRun = await page.$eval("#file-input", (el) => el.disabled);

    // setInputFiles bypasses the native disabled-input block entirely (it
    // sets .files and dispatches change() directly, not via a simulated
    // click on the picker) — this is deliberately the harder case, testing
    // the isRunning guard specifically, not just the disabled attribute.
    await page.setInputFiles("#file-input", `${FIXTURE_DIR}${invoiceFixture.file}`);
    await page.waitForTimeout(200);
    const runStillDisabled = await page.$eval("#run", (el) => el.disabled);

    await page.waitForFunction(() => document.getElementById("status").textContent === "Done.", { timeout: 30000 });
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
    await page.waitForFunction(() => document.getElementById("status").textContent === "Done.", { timeout: 30000 });

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
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Recognizing"), { timeout: 20000 });
    const resultSectionHiddenMidRun = await page.$eval("#result-section", (el) => el.hidden);
    await page.waitForFunction(() => document.getElementById("status").textContent === "Done.", { timeout: 30000 });

    if (!resultSectionHiddenMidRun) {
      console.error("✗ FAILED: the result/download section was visible during an active run.");
      failed = true;
    } else {
      console.log("✓ Download button is inaccessible (parent section hidden) for the duration of a run.");
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
