#!/usr/bin/env node
/**
 * Runs real OCR against every fixture in test/fixtures/manifest.json and
 * prints the actual recognized text + word accuracy. Not part of CI — this
 * is what you run by hand after regenerating fixtures, to see real numbers
 * before deciding what threshold scripts/verify.mjs should enforce. Never
 * set a threshold without running this first.
 */
import { chromium } from "playwright";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startServer } from "./serve.mjs";
import { wordAccuracy, parseLabelledBlocks } from "./text-accuracy.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC_DIR = `${ROOT}public`;
const FIXTURE_DIR = `${ROOT}test/fixtures/`;
const PORT = 8932;

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

for (const fixture of manifest) {
  const page = await browser.newPage();
  await page.goto(`${origin}/index.html`, { waitUntil: "load" });
  if (fixture.lang) await page.selectOption("#language", fixture.lang);
  await page.setInputFiles("#file-input", `${FIXTURE_DIR}${fixture.file}`);
  await page.click("#run");
  await page.waitForFunction(
    () => document.getElementById("status").textContent === "Done." ||
      /^Error:/.test(document.getElementById("status").textContent),
    { timeout: 60000 },
  );
  console.log(`\n=== ${fixture.name} (${fixture.mode}) ===`);

  if (fixture.mode === "pdf-word-accuracy") {
    const recognized = await page.inputValue("#result");
    const blocks = parseLabelledBlocks(recognized);
    fixture.expectedPages.forEach((expectedText, i) => {
      const text = (blocks[i]?.text ?? "").trim();
      const accuracy = wordAccuracy(expectedText, text);
      console.log(`  page ${i + 1}: ${(accuracy * 100).toFixed(1)}% | expected: ${JSON.stringify(expectedText)} | recognized: ${JSON.stringify(text)}`);
    });
  } else {
    const recognized = (await page.inputValue("#result")).trim();
    const accuracy = wordAccuracy(fixture.expectedText, recognized);
    console.log("Expected: ", JSON.stringify(fixture.expectedText));
    console.log("Recognized:", JSON.stringify(recognized));
    console.log(`Word accuracy: ${(accuracy * 100).toFixed(1)}%`);
    if (fixture.mode === "exact") {
      console.log(recognized === fixture.expectedText ? "✓ exact match" : "✗ NOT an exact match");
    }
  }
  await page.close();
}

await browser.close();
server.close();
