/**
 * Shared helpers for the Playwright-driven end-to-end scripts
 * (scripts/verify.mjs, scripts/verify-large-pdf.mjs) — kept in one place so
 * fixes to how a .docx is parsed or how files are selected in the browser
 * don't need to be repeated in every script that needs them.
 */
import { inflateSync } from "node:zlib";
import { unzipSync, strFromU8 } from "fflate";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

/** A .docx is itself a zip; pull its main body XML and strip tags to check content. */
export function readDocxText(docxBytes) {
  const xml = strFromU8(unzipSync(docxBytes)["word/document.xml"]);
  return xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Splits a .docx's paragraphs back into per-Word-page text, using the same
 * <w:pageBreakBefore/> marker docx-export.js writes (see its comment on
 * why that's the real element, not w:type="page"). Needed to check
 * page-by-page word accuracy on a .docx built from imperfect OCR text
 * (readDocxText alone would only give one blob for the whole document).
 */
export function readDocxPages(docxBytes) {
  const xml = strFromU8(unzipSync(docxBytes)["word/document.xml"]);
  const paragraphs = xml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) ?? [];
  const pages = [[]];
  for (const p of paragraphs) {
    if (p.includes("<w:pageBreakBefore/>") && pages[pages.length - 1].length > 0) pages.push([]);
    const text = [...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join("");
    pages[pages.length - 1].push(text);
  }
  return pages.map((lines) => lines.join("\n"));
}

/**
 * Reads a generated searchable-PDF's real text content back per page, the
 * same way a real PDF viewer's "select all"/search would see it — proof
 * the invisible OCR text layer (public/pdf-export.js) actually exists and
 * is extractable, not just that a PDF-shaped file was produced. Runs
 * directly in Node against downloaded bytes (pdfjs-dist's own
 * Node-compatible legacy build — distinct from the browser build already
 * vendored as public/vendor/pdf.min.mjs for the app itself), the same way
 * readDocxText/readDocxPages above never need the Playwright browser
 * context either. `verbosity: 0` silences a benign
 * "standardFontDataUrl not provided" warning this build otherwise logs on
 * every call — it doesn't affect text extraction, only glyph rendering,
 * which this helper never does.
 */
export async function readPdfPagesText(pdfBytes) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBytes), verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(content.items.map((item) => item.str).join(" "));
  }
  return pages;
}

/**
 * Regression coverage against pdf-export.js's invisible text ever sliding
 * to a `drawText({opacity: 0})` alpha-fade instead — not the same thing to
 * some PDF viewers/search indexes as the real "neither fill nor stroke"
 * text-rendering mode. Confirmed empirically (not assumed) that pdf-lib
 * Flate-compresses content streams by default: the literal `3 Tr` operator
 * pdf-lib emits for TextRenderingMode.Invisible is never found in a
 * generated PDF's raw bytes, only after inflating each `stream`/`endstream`
 * block — a plain non-decompressing `bytes.includes('3 Tr')` would always
 * report false regardless of whether the real invisible-text operator is
 * actually there, so this must decompress first or it isn't testing
 * anything.
 */
export function pdfHasInvisibleTextOperator(pdfBytes) {
  const buf = Buffer.isBuffer(pdfBytes) ? pdfBytes : Buffer.from(pdfBytes);
  const raw = buf.toString("latin1");
  const streamRe = /stream\r?\n/g;
  let match;
  while ((match = streamRe.exec(raw))) {
    const start = match.index + match[0].length;
    const end = raw.indexOf("endstream", start);
    if (end === -1) continue;
    try {
      if (inflateSync(buf.subarray(start, end)).toString("latin1").includes("3 Tr")) return true;
    } catch {
      // Not every stream in the file is Flate-compressed content (some are
      // uncompressed, some are a different filter entirely, e.g. the
      // embedded image's own DCTDecode/FlateDecode-PNG-predictor data) —
      // inflateSync failing on one of those is expected, not an error.
    }
  }
  return false;
}

/**
 * Selects files by constructing real File objects inside the page, rather
 * than page.setInputFiles() with an OS file path. Needed specifically for
 * Unicode filenames: this environment has no UTF-8 locale configured
 * (LC_CTYPE=POSIX), which breaks Playwright's OS-level file-path handling
 * for any non-ASCII name — confirmed directly (every accented/emoji/CJK
 * filename tried via setInputFiles left the input with 0 files selected,
 * even though the same paths are readable from Node directly) — and is
 * unrelated to whether the app itself handles a File with a Unicode .name
 * correctly. A File built in the page is what a real browser hands JS
 * regardless of the host OS's locale, which is the thing actually worth
 * testing here. Also the natural way to hand the browser a fixture that
 * only exists in memory (e.g. a PDF built on the fly), with no temp file
 * or OS path involved at all.
 */
export async function selectFilesInBrowser(page, entries) {
  await page.evaluate((entries) => {
    function b64ToBytes(b64) {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    }
    const dt = new DataTransfer();
    for (const { name, b64, type } of entries) dt.items.add(new File([b64ToBytes(b64)], name, { type }));
    const input = document.getElementById("file-input");
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, entries);
}

/**
 * Polls #status by hand (fixed interval, explicit deadline) instead of
 * page.waitForFunction. Found necessary the hard way: a Firefox CI run of
 * the 26-item large-batch test threw "Timeout 30000ms exceeded" from a
 * waitForFunction call whose own options literally said `{ timeout: 60000
 * }` — a real, reproducible mismatch between the configured timeout and
 * the one Playwright reported, on this Playwright version, only surfaced
 * under Firefox. Rather than chase that mismatch further, this sidesteps
 * it entirely: the deadline is a plain Date.now() comparison this code
 * controls directly, and a timeout here reports the last-seen status
 * text, which plain waitForFunction's TimeoutError does not.
 */
export async function waitForStatus(page, predicate, options = {}) {
  return waitForText(page, "#status", predicate, { label: "status", ...options });
}

/**
 * General form of waitForStatus, for any element's text content — e.g. a
 * button label that changes after a tap (see the "Copied!" check in
 * verify.mjs). Default interval is deliberately tight (50ms), not a
 * round-number guess: found the hard way that #status can pass through a
 * transient state (e.g. "Recognizing…") and settle on its final value in
 * well under 300ms for the smallest fixture — a 300ms poll interval
 * missed that transient state outright on some runs (confirmed directly:
 * a 10ms-interval diagnostic saw it reliably in 5/5 runs, each completing
 * in ~650-700ms total, meaning the transient window itself can be
 * narrower than 300ms). Cheap enough to poll this often — it's a single
 * page.textContent() call each time.
 */
export async function waitForText(page, selector, predicate, { timeoutMs, intervalMs = 50, label = selector } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = await page.textContent(selector);
    if (predicate(text)) return text;
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}. Last text: ${JSON.stringify(text)}`);
    }
    await page.waitForTimeout(intervalMs);
  }
}

/** Same reasoning as waitForStatus, for the #run button's disabled state. */
export async function waitForRunEnabled(page, { timeoutMs = 30000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const disabled = await page.$eval("#run", (el) => el.disabled);
    if (!disabled) return;
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for #run to become enabled.`);
    }
    await page.waitForTimeout(intervalMs);
  }
}
