// Builds a real, searchable "sandwich" PDF from recognized OCR results —
// each page's original image, visually unchanged, with an invisible OCR
// text layer underneath. This is the standard technique real OCR tools
// (OCRmyPDF, Adobe Scan) use: true PDF text-rendering mode 3 ("neither
// fill nor stroke"), not a `drawText({opacity: 0})` alpha-fade, which some
// PDF viewers and search indexes still treat as present. Self-hosted
// pdf-lib — see scripts/copy-vendor-assets.mjs for why dist/pdf-lib.esm.min.js
// specifically, not pdf-lib's own package.json "module" entry.

import {
  PDFDocument, StandardFonts, TextRenderingMode,
  pushGraphicsState, popGraphicsState, beginText, endText,
  setFontAndSize, setCharacterSqueeze, setTextRenderingMode, setTextMatrix, showText,
} from './vendor/pdf-lib.mjs';
import { DEFAULT_RENDER_DPI } from './pdf-to-images.js';

// Every page in this export is built fresh from a rasterized image, not by
// reusing any original PDF's own page geometry — PDF-origin images are
// already flat PNGs by the time OCR runs (pdf-to-images.js), so there's no
// original page transform left to preserve. DEFAULT_RENDER_DPI is reused
// as a single "pixels per 72pt-inch" constant for every image uniformly,
// PDF-origin or directly-uploaded alike, so the output's physical page
// size is at least consistent, even for a directly-uploaded photo that was
// never rendered at any particular DPI.
const POINTS_PER_PIXEL = 72 / DEFAULT_RENDER_DPI;

// A word's bbox height isn't the same as a font's cap-height/ascent, so a
// 1:1 mapping from bbox height to font size runs noticeably large —
// tuned empirically against this project's own real fixtures, not exact.
const FONT_SIZE_FUDGE = 0.85;

// pdf-lib can only embed PNG or JPEG natively (confirmed directly from its
// source — no embedWebp/embedBmp exists anywhere). index.html's file input
// also accepts WebP and BMP, so those need converting to PNG first via a
// canvas round-trip before pdf-lib can touch them at all.
async function toEmbeddableBytes(file) {
  if (file.type === 'image/png' || file.type === 'image/jpeg') {
    return { bytes: new Uint8Array(await file.arrayBuffer()), isJpeg: file.type === 'image/jpeg' };
  }
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), isJpeg: false };
}

// Both embedPng() and embedJpg() can throw — confirmed directly from
// pdf-lib's source, not assumed as a pure pass-through: embedJpg's
// JpegEmbedder throws on "SOI not found", "Invalid JPEG", and unsupported
// channel layouts, and embedPng can equally reject a truncated/corrupt
// file (the same shape as this project's own corrupt-image.png fixture).
// The caller treats any throw here as "this page's image is unusable" and
// falls back to a visible placeholder page — never lets one bad image
// abort the whole document, the same "one bad item doesn't sink the
// batch" rule this codebase already applies per-file (OCR errors) and
// per-page (PDF render errors).
async function embedImage(pdfDoc, file) {
  const { bytes, isJpeg } = await toEmbeddableBytes(file);
  return isJpeg ? pdfDoc.embedJpg(bytes) : pdfDoc.embedPng(bytes);
}

async function addPlaceholderPage(pdfDoc, font, message) {
  // US Letter, in points — a reasonable default when there's no real image
  // to size the page from. Genuinely visible text here (unlike the
  // invisible OCR layer elsewhere), via the ordinary high-level drawText()
  // API — there's no image underneath this page for invisible text to be
  // "under," so the normal supported API is the right tool for once.
  const page = pdfDoc.addPage([612, 792]);
  page.drawText(message, { x: 50, y: 700, size: 12, font, maxWidth: 500, lineHeight: 16 });
}

// Places one invisible text run per word, positioned and sized to match
// its real bbox on the page. bbox is confirmed (empirically, against this
// project's own sample-invoice.png fixture — not assumed, since Tesseract's
// pixel/origin convention isn't stated anywhere in tesseract.js's own JS
// source, only in its compiled WASM core) to be top-left-origin image
// pixel coordinates — hence the vertical flip below, since PDF's own
// coordinate origin is bottom-left.
//
// setCharacterSqueeze (the PDF `Tz` horizontal-scaling operator, as a
// percentage) stretches or compresses each word's invisible glyphs so
// their measured advance width matches the bbox's real visual width, even
// though Helvetica's actual letterforms are a different width than
// whatever was on the scanned page — the same trick real sandwich-PDF
// tools (OCRmyPDF, etc.) use, not something invented here.
function drawInvisibleWords(page, font, fontKey, words, pageHeightPt) {
  for (const word of words) {
    if (!word.text) continue;
    const { x0, y0, x1, y1 } = word.bbox;
    const widthPt = (x1 - x0) * POINTS_PER_PIXEL;
    const heightPt = (y1 - y0) * POINTS_PER_PIXEL;
    if (widthPt <= 0 || heightPt <= 0) continue;

    const fontSize = heightPt * FONT_SIZE_FUDGE;
    const x = x0 * POINTS_PER_PIXEL;
    const y = pageHeightPt - (y1 * POINTS_PER_PIXEL);

    // StandardFonts.Helvetica uses WinAnsi encoding (~220 code points) —
    // encodeText()/widthOfTextAtSize() throw synchronously on anything
    // outside it (CJK, Cyrillic, Arabic, Devanagari, stray OCR-garbage
    // glyphs on a noisy scan). This per-word try/catch handles the rare
    // case (a misread character slipping outside WinAnsi on an otherwise
    // WinAnsi-compatible language) by skipping just that one word's
    // invisible run — the same per-item tolerance used throughout this
    // codebase. It is NOT what protects against the *common* case: a
    // language whose script is entirely outside WinAnsi (Russian, Arabic,
    // Hindi, Chinese, Japanese, Korean), where every word would fail here.
    // That's handled one layer up, in app.js's updateOutputFormatAvailability()
    // — the Searchable PDF format option is disabled outright for those
    // languages, so buildSearchablePdfBlob() is never even called with
    // words in an incompatible script to begin with.
    let encoded, naturalWidth;
    try {
      encoded = font.encodeText(word.text);
      naturalWidth = font.widthOfTextAtSize(word.text, fontSize);
    } catch {
      continue;
    }
    if (naturalWidth <= 0) continue;
    const squeezePercent = (widthPt / naturalWidth) * 100;

    page.pushOperators(
      pushGraphicsState(),
      beginText(),
      setTextRenderingMode(TextRenderingMode.Invisible), // Tr 3
      setFontAndSize(fontKey, fontSize),
      setCharacterSqueeze(squeezePercent), // Tz
      setTextMatrix(1, 0, 0, 1, x, y),
      showText(encoded),
      endText(),
      popGraphicsState(),
    );
  }
}

/**
 * `pages` is one entry per output PDF page, in order:
 * `{ file: File, words: {text, bbox, confidence}[] | null }`. `words` is
 * `null` for a page with nothing to draw a text layer from — cancelled
 * before OCR reached it, or OCR errored on it — as opposed to `[]`, which
 * means OCR genuinely ran and found no words (e.g. a blank page). Either
 * way `file` is still embedded: not having recognized text is not the
 * same as not having the image, and every entry in `pages` produces
 * exactly one output page, preserving 1:1 index parity with whatever
 * grouping the caller used (so this export's page N always matches the
 * .docx export's page N for the same run).
 */
export async function buildSearchablePdfBlob(pages) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  for (const { file, words } of pages) {
    let embedded;
    try {
      embedded = await embedImage(pdfDoc, file);
    } catch (error) {
      await addPlaceholderPage(pdfDoc, font, `This page's image could not be embedded: ${error?.message ?? error}`);
      continue;
    }

    const pageWidthPt = embedded.width * POINTS_PER_PIXEL;
    const pageHeightPt = embedded.height * POINTS_PER_PIXEL;
    const page = pdfDoc.addPage([pageWidthPt, pageHeightPt]);
    page.drawImage(embedded, { x: 0, y: 0, width: pageWidthPt, height: pageHeightPt });

    if (words && words.length > 0) {
      // setFont() is pdf-lib's own public API — it registers the font on
      // *this page's* Resources dictionary and, as a side effect, stores
      // the resulting resource name (e.g. "/F1") on page.fontKey. Reading
      // that back is a plain runtime property access: pdf-lib 1.17.1 has
      // no supported public API for setting the PDF text-rendering mode
      // at all, so this is a deliberate, documented reach past its public
      // surface — `fontKey` is only `private` in pdf-lib's TypeScript
      // declarations, which don't exist once vendored as plain .mjs, and
      // it's safe specifically because the exact vendored build is pinned
      // by scripts/copy-vendor-assets.mjs, not fetched live.
      page.setFont(font);
      drawInvisibleWords(page, font, page.fontKey, words, pageHeightPt);
    }
  }

  const bytes = await pdfDoc.save();
  return new Blob([bytes], { type: 'application/pdf' });
}
