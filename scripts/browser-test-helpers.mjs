/**
 * Shared helpers for the Playwright-driven end-to-end scripts
 * (scripts/verify.mjs, scripts/verify-large-pdf.mjs) — kept in one place so
 * fixes to how a .docx is parsed or how files are selected in the browser
 * don't need to be repeated in every script that needs them.
 */
import { unzipSync, strFromU8 } from "fflate";

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
