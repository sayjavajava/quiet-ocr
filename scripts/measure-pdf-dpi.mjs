#!/usr/bin/env node
/**
 * Sweeps render DPI against test/fixtures/scanned-multipage.pdf — a PDF
 * whose pages are themselves raster images (page 1: noisy-scan.png,
 * degraded; page 2: paragraph.png, clean), the shape a real scanned or
 * photographed PDF actually has. Unlike sample-multipage.pdf (clean vector
 * text, which renders identically at any DPI), this fixture is exactly
 * the case DEFAULT_RENDER_DPI (public/pdf-to-images.js) was picked without
 * testing — the earlier DPI sweep only used vector text and got 100% at
 * every DPI, which doesn't validate anything for genuinely degraded input.
 *
 * Not part of CI — run by hand when reconsidering DEFAULT_RENDER_DPI.
 * Prints real render+recognize timing and real word accuracy per DPI, so
 * that value is chosen from a measurement, not carried forward unverified.
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startServer } from "./serve.mjs";
import { wordAccuracy, parseLabelledBlocks } from "./text-accuracy.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC_DIR = `${ROOT}public`;
const FIXTURE_PATH = `${ROOT}test/fixtures/scanned-multipage.pdf`;
const PORT = 8934;

const EXPECTED_PAGES = [
  "The quarterly report shows a steady increase in revenue across all regions. Customer satisfaction scores improved by 12% compared to the previous period, while operational costs remained flat. The board recommends continuing the current strategy through the next fiscal year.",
  "The quarterly report shows a steady increase in revenue across all regions. Customer satisfaction scores improved by 12% compared to the previous period, while operational costs remained flat. The board recommends continuing the current strategy through the next fiscal year.",
];
const PAGE_LABELS = ["page 1 (noisy-scan)", "page 2 (paragraph)"];

const pdfBase64 = readFileSync(FIXTURE_PATH).toString("base64");

const server = await startServer(PUBLIC_DIR, PORT);
const origin = `http://127.0.0.1:${PORT}`;

const launchOptions = {};
if (process.env.PLAYWRIGHT_CHROMIUM_PATH) launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const browser = await chromium.launch(launchOptions);

const dpiList = process.argv.slice(2).length
  ? process.argv.slice(2).map(Number)
  : [150, 200, 250, 300];

for (const dpi of dpiList) {
  const page = await browser.newPage();
  await page.goto(`${origin}/index.html`, { waitUntil: "load" });

  const result = await page.evaluate(async ({ pdfBase64, dpi }) => {
    const { pdfToImageFiles } = await import("./pdf-to-images.js");
    function b64ToFile(b64, name, type) {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new File([bytes], name, { type });
    }
    const pdfFile = b64ToFile(pdfBase64, "scanned-multipage.pdf", "application/pdf");

    const pageErrors = [];
    const t0 = performance.now();
    const files = await pdfToImageFiles(pdfFile, {
      dpi,
      onPageError: (n, e) => pageErrors.push(`page ${n}: ${e?.message ?? e}`),
    });
    const renderMs = performance.now() - t0;
    if (pageErrors.length) return { renderMs, recognizeMs: 0, texts: [], pageErrors };

    const worker = await Tesseract.createWorker("eng", 1, {
      corePath: "vendor/tesseract-core-lstm.wasm.js",
      workerPath: "vendor/worker.min.js",
      langPath: "vendor",
      gzip: true,
    });

    const texts = [];
    const t1 = performance.now();
    for (const f of files) {
      const { data } = await worker.recognize(f);
      texts.push(data.text.trim());
    }
    const recognizeMs = performance.now() - t1;
    await worker.terminate();

    return { renderMs, recognizeMs, texts };
  }, { pdfBase64, dpi });

  console.log(`\n=== DPI ${dpi} ===`);
  if (result.pageErrors?.length) {
    console.log("PAGE ERRORS:", result.pageErrors);
    await page.close();
    continue;
  }
  console.log(`Render: ${result.renderMs.toFixed(0)}ms, Recognize (${result.texts.length} pages): ${result.recognizeMs.toFixed(0)}ms, total: ${(result.renderMs + result.recognizeMs).toFixed(0)}ms`);
  result.texts.forEach((text, i) => {
    const acc = wordAccuracy(EXPECTED_PAGES[i], text);
    console.log(`  ${PAGE_LABELS[i]}: accuracy ${(acc * 100).toFixed(1)}% | recognized: ${JSON.stringify(text)}`);
  });

  await page.close();
}

await browser.close();
server.close();
