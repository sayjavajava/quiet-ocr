// Rasterizes each page of a PDF into a PNG File, so a PDF can flow through
// the exact same batch OCR pipeline (public/app.js) that a set of selected
// images already does — no separate PDF-specific run path. Self-hosted
// pdf.js (public/vendor/), same reasoning as the OCR engine itself: one
// fewer third party in the trust chain, a pinned version, no CDN
// dependency. See docs/PERFORMANCE.md for why the render scale below was
// chosen, not guessed.

// pdf.js 6.2.108 calls `Map.prototype.getOrInsertComputed()` (and the
// WeakMap equivalent) directly, with no fallback, throughout its rendering
// path — confirmed by grepping the installed package for the call sites,
// not assumed. That method is a very recently standardized JS engine
// feature (per MDN, it only reached cross-browser "newly available" status
// in early 2026), so most real users' browsers today still don't have it
// natively — this isn't a workaround for one outdated test environment,
// it's required for PDF input to work for real visitors.
//
// Minimal shim, matching the spec (callback invoked with the key), added
// via a fixed, literal property name on each built-in's prototype — not a
// dynamic key, and only installed when the native method is genuinely
// missing (a no-op the moment browsers catch up).
function getOrInsertComputedShim(key, callback) {
  if (!this.has(key)) this.set(key, callback(key));
  return this.get(key);
}
if (!Map.prototype.getOrInsertComputed) {
  Object.defineProperty(Map.prototype, "getOrInsertComputed", {
    value: getOrInsertComputedShim,
    writable: true,
    configurable: true,
  });
}
if (!WeakMap.prototype.getOrInsertComputed) {
  Object.defineProperty(WeakMap.prototype, "getOrInsertComputed", {
    value: getOrInsertComputedShim,
    writable: true,
    configurable: true,
  });
}

import * as pdfjsLib from './vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.mjs';

// pdf.js viewport scale is relative to the PDF's native 72 DPI. 200 DPI is
// the measured middle ground between OCR accuracy and render+recognize
// time — see docs/PERFORMANCE.md's "PDF input" section for the real
// 150/200/300 DPI comparison this was picked from, run against
// test/fixtures/sample-multipage.pdf via scripts/measure-fixture-accuracy.mjs.
export const DEFAULT_RENDER_DPI = 200;

export function isPdfFile(file) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

/**
 * Renders every page of `file` to a PNG and returns one File per page, in
 * page order, named `${basename}-page-{n}.png`. A page that fails to
 * render (corrupt content, an unsupported PDF feature) is skipped with its
 * error reported via `onPageError`, rather than aborting the whole
 * document — the same "one bad item doesn't sink the batch" rule the
 * multi-image batch feature already applies to OCR itself.
 */
export async function pdfToImageFiles(file, { dpi = DEFAULT_RENDER_DPI, onPageError } = {}) {
  const scale = dpi / 72;
  const baseName = file.name.replace(/\.pdf$/i, '');
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;

  const files = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    try {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, viewport }).promise;

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      files.push(new File([blob], `${baseName}-page-${pageNumber}.png`, { type: 'image/png' }));
    } catch (error) {
      onPageError?.(pageNumber, error);
    }
  }
  return files;
}
