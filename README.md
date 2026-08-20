# QuietOCR

Pull text out of an image, entirely in your browser.

## What it actually promises — read this before trusting it

**QuietOCR is not offline.** This page needs the network the first time it loads, to fetch its
own code (the OCR engine and English trained-data, self-hosted alongside the page, not from a
third-party CDN). That's a deliberate, different trade-off from this project's sibling,
[OffGridPDF](https://github.com/sayjavajava/offline-pdf-utility), which makes a stricter,
verified-in-CI promise of zero network requests, ever. If you need that guarantee, use that
project instead — it doesn't do OCR, and this doesn't do PDF editing, and neither pretends to be
the other.

**What QuietOCR does promise: your image is never uploaded, to this site or anywhere else.**
Once the page has loaded, recognition runs entirely client-side — in WebAssembly, on your
machine — via [Tesseract](https://github.com/tesseract-ocr/tesseract) compiled to WebAssembly by
[tesseract.js](https://github.com/naptha/tesseract.js). The file you select never leaves the
browser tab.

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
2. Load an image and click "Run OCR".
3. Watch the Network tab. You'll see the initial page load fetch a handful of same-origin files
   under `/vendor/` (the OCR engine + trained-data) — and nothing else, ever, no matter how many
   images you run through it afterward. No request's body or URL contains anything derived from
   your image.

This isn't asserted from memory — the identical check (a real headless browser, network requests
logged, a known test image run through the exact code this page uses) was run against a
prototype of this approach before this repository existed. Recognized text came back an exact
match for the known input, with the network log showing only the expected same-origin asset
fetches.

## Development

```bash
npm install         # pulls tesseract.js, tesseract.js-core (transitively), and English trained-data
npm run build        # copies the OCR engine + trained-data into public/vendor/ (gitignored)
npm run serve         # build, then serve public/ at http://localhost:8080
```

`public/vendor/` is generated, not committed — see `scripts/copy-vendor-assets.mjs`. Self-hosting
these files (rather than pointing at `tesseract.js`'s default CDN) means one fewer third party in
the trust chain and a pinned, known version instead of "whatever the CDN currently serves."

## Scope, for now

English only, image input only (PNG/JPEG/WebP/BMP) — no PDF support yet. Rasterizing a PDF page
and feeding it through the same pipeline is a natural follow-up, not a redesign, if there's
demand for it.

## License

GPL-3.0-or-later. See [`LICENSE`](LICENSE).
