# Performance

Numbers below come from `npm run bench` (`scripts/bench.mjs`), run in a real headless
Chromium, not estimated. Each fixture ran 3 times in a fresh browser context; "median" is
the median across those runs. Reproduce locally with:

```bash
npm run build
npm run bench
```

## Why engine-load and recognize() are measured separately

This project creates a new Tesseract worker for every OCR run rather than pooling one
(see `public/app.js`) — a deliberate simplicity trade-off for a first version, called out
there as the obvious follow-up. That means every run pays a fixed engine-load cost on top
of the actual recognition work, and the two scale completely differently: engine load is
flat regardless of image content, while recognize() time scales with image size and how
much text is on the page. Reporting one combined number would hide that.

## Results — 2026-08-20

| Fixture                     | Engine load (median) | Recognize (median) | Total (median) |
| ---------------------------- | --------------------: | -------------------: | ---------------: |
| sample-invoice (single line) | 521 ms                | 413 ms                | 934 ms           |
| paragraph (5 lines)          | 476 ms                | 1,838 ms              | 2,333 ms         |
| table (4 lines, monospace)   | 504 ms                | 915 ms                | 1,419 ms         |
| noisy-scan (degraded photo)  | 491 ms                | 1,583 ms              | 2,100 ms         |
| large-photo (A4 @ 300dpi)    | 582 ms                | 16,633 ms             | 17,225 ms        |

`large-photo` is a synthetic 2480×3508px page (A4 at 300dpi — the resolution a real phone
scanning app or flatbed scanner typically produces) generated on the fly by
`scripts/bench.mjs`, not committed to the repo. It's 32 lines of body text across the full
page, sized to actually exercise recognize()'s scaling rather than the small, mostly-empty
canvases the accuracy fixtures use.

## Takeaways

- **Engine load is ~500ms and flat**, independent of image content — this is the real,
  current cost of creating a fresh worker per run. As of the multi-image batch feature,
  a single "Run OCR" click on N selected images creates one worker and reuses it across
  all N `recognize()` calls, so this ~500ms is paid once per batch, not once per image —
  confirmed by `scripts/verify.mjs`'s batch check, which asserts both images in a
  2-image batch complete and are individually labelled in the output.
- **Recognize() time scales with content, not just pixel count.** `table` (700×260px, dense
  monospace text) takes longer than `sample-invoice` despite being a similarly small image,
  because there's more text to recognize.
- **A full-page scan takes real time** — 16–17 seconds for one A4 page at scanning
  resolution. That's expected for a WebAssembly LSTM model running on the main thread of a
  single tab — a multi-page document (via batch upload or PDF input, see below) is a
  genuinely long-running operation with no pause/cancel yet (see the "Scope, for now"
  section of the [README](../README.md)).

## PDF input

PDF pages are rasterized client-side (`public/pdf-to-images.js`, via a self-hosted
`pdfjs-dist@6.2.108`) into page images, which then flow through the exact same batch OCR
pipeline as directly-selected images — no separate code path.

**A real, load-bearing compatibility bug was found and fixed while building this, not
after shipping:** `pdfjs-dist@6.2.108` calls `Map.prototype.getOrInsertComputed()` (and the
`WeakMap` equivalent) directly throughout its rendering path, with no fallback — confirmed
by grepping the installed package's source for every call site, not assumed. That method is
a very recently standardized JS engine feature (per MDN, it only reached cross-browser
"newly available" status in early 2026), and it's genuinely absent from the Chromium build
this project's own test suite runs against (verified directly: `typeof
Map.prototype.getOrInsertComputed` is `"undefined"` in both that Chromium build and current
Node). Since this method is that new, a real, non-trivial share of visitors' actual browsers
today likely still lack it too — this isn't a test-environment-only issue. Fixed with a
minimal, spec-matching inline shim in `pdf-to-images.js`, installed only when the native
method is missing.

**Render DPI was measured, not guessed**, via a script sweeping `test/fixtures/sample-multipage.pdf`
(3 pages of clean vector text — not a scan) at 150/200/300 DPI, run against the real
pipeline end-to-end (render → OCR):

| DPI | Render (3 pages) | Recognize (3 pages) | Total | Accuracy |
| --: | ----------------: | --------------------: | ------: | --------: |
| 150 | 180 ms             | 1,326 ms               | 1,506 ms | 100% (3/3 pages) |
| 200 | 150 ms             | 1,518 ms               | 1,667 ms | 100% (3/3 pages) |
| 300 | 213 ms             | 1,820 ms               | 2,033 ms | 100% (3/3 pages) |

This fixture is clean vector text rasterized to an image, not a scan — it doesn't
differentiate accuracy by DPI the way `noisy-scan` differentiates image fixtures. **200 DPI
was picked as the default** as a time/headroom balance: noticeably cheaper than 300 DPI with
no accuracy loss on this fixture, while still rendering well above the resolution a genuinely
degraded scanned PDF page would need for Tesseract to do well (general OCR guidance puts that
around 300 DPI, hence keeping meaningful headroom above 150). This default isn't validated
yet against an actually degraded/scanned PDF — only against clean vector text — see the
private backlog (F-3) for that open item.

**Known gaps, not yet addressed:** no page-count cap or time-estimate warning before running
a large PDF (a 100-page PDF at these per-page costs is several minutes with no progress
beyond the per-page status list), and rendering happens synchronously in the same
main-thread loop that drives the UI — negligible at 3 pages, unverified at real-world PDF
sizes.
