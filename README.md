# QuietOCR

[![License: GPL-3.0-or-later](https://img.shields.io/github/license/sayjavajava/quiet-ocr)](LICENSE)

Pull text out of images or PDFs, entirely in your browser.

## What it actually promises — read this before trusting it

**QuietOCR is not offline.** This page needs the network the first time it loads, to fetch its
own code (the OCR engine and English trained-data, self-hosted alongside the page, not from a
third-party CDN). That's a deliberate, different trade-off from this project's sibling,
[OffGridPDF](https://github.com/sayjavajava/offline-pdf-utility), which makes a stricter,
verified-in-CI promise of zero network requests, ever. If you need that guarantee, use that
project instead — it doesn't do OCR, and this doesn't do PDF editing, and neither pretends to be
the other.

**What QuietOCR does promise: your file is never uploaded, to this site or anywhere else.** Once
the page has loaded, recognition runs entirely client-side — in WebAssembly, on your machine — via
[Tesseract](https://github.com/tesseract-ocr/tesseract) compiled to WebAssembly by
[tesseract.js](https://github.com/naptha/tesseract.js). A PDF is rasterized into page images
entirely in-browser too (via a self-hosted [pdf.js](https://github.com/mozilla/pdf.js)) before
those images go through the same OCR path — the PDF itself never leaves the tab either. Nothing
you select ever leaves the browser tab.

## Why this exists

The natural way to build "offline-friendly, zero-network OCR" turned out not to work: bundling
the OCR engine into a single self-contained file (the same model
[OffGridPDF](https://github.com/sayjavajava/offline-pdf-utility) uses for PDF tools) hits a real,
reproducible blocker under `file://` — `tesseract.js`'s worker does a nested `importScripts()`
call to load its WASM core, which browsers refuse for a page with no origin. That's documented in
detail in that project's private engineering notes (F-18). Loosening just the "zero network"
constraint — allowing the page to fetch its own code, while keeping the "never transmit your
data" guarantee — sidesteps that blocker entirely and lets this use the well-tested, standard
`tesseract.js` API rather than something hand-rolled.

## Verifying the "never uploads" claim yourself

Don't take it on faith — check it:

1. Open this page's DevTools → Network tab before selecting a file.
2. Load an image or PDF and click "Run OCR".
3. Watch the Network tab. You'll see the initial page load fetch a handful of same-origin files
   under `/vendor/` (the OCR engine, pdf.js, and trained-data) — and nothing else, ever, no matter
   how many images or PDFs you run through it afterward. No request's body or URL contains
   anything derived from your file.

This isn't asserted from memory — the identical check (a real headless browser, network requests
logged, a known test image run through the exact code this page uses) was run against a
prototype of this approach before this repository existed. Recognized text came back an exact
match for the known input, with the network log showing only the expected same-origin asset
fetches.

## Development

```bash
npm install         # pulls tesseract.js, tesseract.js-core (transitively), English trained-data, pdf.js, docx, and fflate
npm run build        # copies the OCR engine, pdf.js, trained-data, docx, and fflate into public/vendor/ (gitignored)
npm run serve         # build, then serve public/ at http://localhost:8080
```

`public/vendor/` is generated, not committed — see `scripts/copy-vendor-assets.mjs`. Self-hosting
these files (rather than pointing at `tesseract.js`'s default CDN) means one fewer third party in
the trust chain and a pinned, known version instead of "whatever the CDN currently serves."

## Scope, for now

**Twelve languages**, one at a time per run — English, French, Spanish, German, Portuguese,
Italian, Russian, Arabic, Hindi, Chinese (Simplified), Japanese, and Korean, picked via the
language selector before you run OCR. Not simultaneous multi-language recognition (a document
mixing, say, English and French in one run) — that's a real Tesseract capability this app doesn't
expose yet. Every language listed was verified before being added, not just wired up and assumed
to work: real font rendering checked (no missing-glyph boxes), real recognition accuracy measured
against clean text, and — since a real scan is rarely clean — real accuracy measured again under
the same degraded conditions (rotated, noisy, blurred) English's own test fixtures already use,
per language, not just for English. See
[`test/fixtures/manifest.json`](test/fixtures/manifest.json)'s per-language fixtures and
[`docs/PERFORMANCE.md`](docs/PERFORMANCE.md)'s "Multi-language OCR accuracy under degraded
conditions" section for the real numbers — accuracy under degradation varies meaningfully by
language (77–100%), documented plainly rather than smoothed over. Each language's trained-data
file (0.7–3MB) is only ever fetched when you actually select that language — choosing English
costs nothing extra for the other eleven sitting unused in `/vendor/`.

Input is images (PNG/JPEG/WebP/BMP) and PDFs — a selected PDF is rasterized into
one page-image per page (client-side, via a self-hosted `pdfjs-dist`) before those images go
through the exact same OCR path as directly-selected images, so PDF pages show up in the file
list exactly like images do, each with its own status.

You can select multiple images and/or PDFs at once — every page/image is recognized one at a
time against a single OCR engine instance (reused across the whole run, rather than paying the
~500ms engine-load cost per item — see [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md)), with each
result labelled by source filename in the on-screen preview. Selecting more than 25 pages/images
shows a time estimate and asks for confirmation before starting, since a large run is genuinely
long — a full page at scanning resolution takes ~17 seconds on its own. **You can cancel a run
at any time** once it starts (a Cancel button appears during both PDF rendering and recognition);
whatever finished before you cancelled is still recognized and downloadable, with a clear
placeholder for anything that didn't get to run. A single PDF is capped at 300 pages, rejected
outright with a clear message before any page renders — set from a real measured breaking point,
not a guess; see [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md)'s "PDF input" section for the real
numbers this is based on, including a real browser-compatibility issue found and fixed while
building PDF support (a very recent JS engine method pdf.js depends on that not all current
browsers have yet).

**Output is a real Word document — or a real searchable PDF, your choice.** By default each image
or PDF becomes its own `.docx` (a multi-page PDF becomes one `.docx` with a real page break
between each page's text, not a wall of text); select more than one file and you get a single
`.zip` of all the generated files. Switch the format to **Searchable PDF** and you get your
original page image back, pixel-for-pixel unchanged, with a real invisible text layer underneath
it instead — select, search, and copy text right over the visible scan in any PDF viewer, the
same "sandwich PDF" technique tools like OCRmyPDF use. Both formats are built and packaged
entirely client-side (self-hosted [`docx`](https://github.com/dolanmiu/docx),
[`pdf-lib`](https://github.com/Hopding/pdf-lib), and [`fflate`](https://github.com/101arrowz/fflate))
— nothing is uploaded to generate them. The on-screen text preview and "Copy text" are still
there for quickly grabbing a snippet without downloading anything.

**Searchable PDF isn't available for Russian, Arabic, Hindi, Chinese, Japanese, or Korean** —
its invisible text layer uses a Latin-script font (WinAnsi encoding), which those languages'
recognized text can't be placed into at all, not just imperfectly. Rather than silently hand back
a "searchable" PDF with no actual searchable text, the format option is disabled for those six
languages specifically; `.docx` (always fully Unicode) is unaffected and covers all twelve
languages. French, Spanish, German, Portuguese, and Italian's accented Latin characters are
covered by WinAnsi, so Searchable PDF works normally for those.

## Performance

See [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) for real, measured engine-load and
recognition-time numbers (`npm run bench`) across fixtures from a short single line to a
full scanned page.

## License

GPL-3.0-or-later. See [`LICENSE`](LICENSE).

## Security

Found a way this page transmits your file, or any other vulnerability? Please don't open a
public issue — see [`SECURITY.md`](SECURITY.md) for how to report it privately.

## Contribution Guidelines

We welcome contributions! See [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, what a PR should
include, and what's in/out of scope. Participation is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Contact

Questions or feedback — [GitHub Issues](https://github.com/sayjavajava/quiet-ocr/issues).
