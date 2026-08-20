// Builds a real .docx Blob from recognized OCR text, entirely client-side
// (self-hosted `docx` — see scripts/copy-vendor-assets.mjs for why). A
// plain-text download doesn't feel like a real deliverable; a Word
// document users can actually open, keep, and pass around does.

import { Document, Packer, Paragraph } from './vendor/docx.mjs';

/**
 * `pages` is one string per Word page — a single-page image result passes
 * a 1-element array; a multi-page PDF result passes one entry per PDF
 * page, so each PDF page lands on its own Word page (a real page break,
 * not just a blank line) exactly the way the source document was laid out.
 * Each page's text is split into paragraphs on line breaks, since OCR
 * output is already line-broken and collapsing it into one run would lose
 * that structure.
 */
export async function buildDocxBlob(pages) {
  const children = [];
  pages.forEach((pageText, pageIndex) => {
    const lines = pageText.split('\n');
    lines.forEach((line, lineIndex) => {
      children.push(new Paragraph({
        text: line,
        // The very first paragraph of the very first page must not force
        // a leading blank page in the document.
        pageBreakBefore: pageIndex > 0 && lineIndex === 0,
      }));
    });
  });

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBlob(doc);
}
