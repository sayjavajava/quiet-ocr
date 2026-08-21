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
differentiate accuracy by DPI the way `noisy-scan` differentiates image fixtures. The 200 DPI
default originally picked from this table turned out to be unvalidated for the case that
actually matters: a real scanned or photographed PDF's pages are themselves raster images
(a photo, not vector text), and upscaling a raster image at different DPIs is a genuinely
different operation than rendering vector text at different DPIs.

**Re-measured against `test/fixtures/scanned-multipage.pdf`** (`scripts/measure-pdf-dpi.mjs`)
— page 1 reuses the degraded `noisy-scan.png`, page 2 the clean `paragraph.png`, both already
seeded/reproducible fixtures, sized in PDF points 1:1 with their pixel dimensions:

| DPI | Render (2 pages) | Recognize (2 pages) | Total | Degraded-page accuracy | Clean-page accuracy |
| --: | ----------------: | --------------------: | ------: | ------: | ------: |
| 150 | 166 ms | 3,409 ms | 3,575 ms | 95.0% | 100% |
| 200 | 156 ms | 3,699 ms | 3,854 ms | 90.0% | 100% |
| 250 | 183 ms | 4,064 ms | 4,246 ms | 95.0% | 100% |
| 300 | 273 ms | 4,559 ms | 4,831 ms | 92.5% | 100% |

The clean page holds 100% at every DPI, same as the vector-text fixture. The degraded page
does **not** show a "higher DPI is better" trend — it's non-monotonic across 150→300 DPI
(95.0 → 90.0 → 95.0 → 92.5), because upscaling an already-raster image doesn't add real
information; different scale factors just interact differently with pdf.js's own image
resampling and Tesseract's preprocessing. Time, on the other hand, rises consistently —
~35% slower at 300 DPI than 150 DPI for zero accuracy benefit.

**`DEFAULT_RENDER_DPI` changed from 200 to 150** on this evidence: it's the cheapest option
tested and its accuracy on the one fixture that actually stresses DPI choice (95.0%) beats
the old 200 DPI default (90.0%) and ties the higher DPIs. `scanned-multipage` is now a
permanent fixture in `test/fixtures/manifest.json`, checked in CI at an 85% threshold (real
margin below the 95%/100% measured above), so this default is now actually regression-tested
against raster/degraded content — not just vector text.

## Large-batch confirmation

A batch above `LARGE_BATCH_THRESHOLD` (25 items — see `public/app.js`) — the realistic way
to hit this is a single large PDF, expanded to one page-image per page before the count is
checked — shows a confirmation dialog with a time estimate
(`~1.7s/item + 0.5s engine load`) before starting, since a multi-minute run shouldn't begin
on one click with no warning. That estimate is deliberately conservative; see the real
60-page measurement below for how it compares to an actual run.

## A truly large PDF, end-to-end

`scripts/verify-large-pdf.mjs` drives a genuinely large PDF (60 pages, generated on the fly
with distinct, known text per page — not committed, same reasoning as `large-photo` above)
through the real pipeline in a real browser: render every page → OCR every page with one
worker → download the resulting `.docx` and check every single page's content and order,
not just that the run completed. Separate from `npm run verify` because it's genuinely slow
by design; run it by hand with `npm run build && npm run verify-large-pdf`.

Real measured run (2026-08-21, headless Chromium):

| Phase                          | Time     |
| ------------------------------- | --------: |
| Render (60 pages)               | 1.2 s     |
| Engine load                     | 1.1 s     |
| Recognize (60 pages)            | 54.1 s (~902 ms/page) |
| **Total**                       | **56.4 s** |

- **Every one of the 60 pages** came back at or above 96.2% word accuracy (worst: page 34),
  in the correct order, correctly paired with its own page break in the `.docx` — the
  render→OCR→export pipeline holds up at this scale, not just at 2-3 pages.
- **JS heap grew from 3.3 MB to 6.4 MB** across the full run (measured via the CDP
  `Performance.getMetrics` `JSHeapUsedSize` counter) — modest growth, no runaway leak, for
  a run that creates 60 canvases/blobs and one long-lived Tesseract worker.
- **The real run (56s) is well under half the confirmation dialog's own conservative
  estimate (~102s for 60 items)** — the estimate is intentionally pessimistic (see above),
  and this is the first real data point confirming it errs in the safe direction rather
  than underselling how long a large run actually takes.
- The main-thread rendering loop referenced above did **not** visibly stall or drop input
  during this run at 60 pages; whether that holds at, say, 500+ pages remains unverified —
  the synchronous main-thread design itself is unchanged.

## How far rendering scales, and where the hard cap comes from

`scripts/measure-render-scaling.mjs` drives `public/pdf-to-images.js`'s render phase directly
(file selection only — it never clicks Run, so OCR time is excluded entirely) across escalating
page counts, in two content profiles, since the real limit depends on what's actually on each
page, not just the count:

- **scan**: one real, full-resolution scanned-page image (A4 @ 300dpi, 2480×3508 — the same
  synthetic shape `scripts/bench.mjs` uses for OCR benchmarking) reused on every page. This is
  the realistic worst case — an actual phone-scanned or flatbed-scanned document, which is what
  someone hitting a real page-count problem is most likely to have selected.
- **text**: clean vector text per page (`sample-multipage.pdf`'s style) — the cheap case, for
  contrast.

Real measured results (2026-08-21, headless Chromium):

| Profile | Last fully successful | Broke at | How |
| --- | ---: | ---: | --- |
| scan (full-res image/page) | 500 pages (163.3 s, ~327 ms/page) | 600 pages | exceeded a 3-minute practical timeout |
| text (vector text/page) | 8,000 pages (139.8 s, ~17 ms/page) | 16,000 pages | exceeded the same 3-minute timeout |

**Neither profile ever crashed or ran out of memory** in the tested range. JS heap stayed
essentially flat the entire time (e.g. the scan profile: ~0.6 MB → 4.6–5.4 MB regardless of
whether it was rendering 5 pages or 600) — no leak, garbage collection keeps up, and render time
per page converges to a steady state rather than degrading. The only thing that actually broke
either profile was a deliberately-chosen 3-minute ceiling, not a technical wall: this app has no
progress bar beyond the per-page status list and no pause/cancel once a run starts, so a
synchronous wait longer than that isn't a usable experience regardless of whether the browser
would technically survive it.

**`MAX_PDF_PAGES = 300`** (`public/pdf-to-images.js`) is set from this data, not guessed — a PDF
over that page count is now rejected outright, before the expensive per-page render loop starts
(checked via `pdf.numPages` immediately after the document loads), with a clear message telling
the user to split the file. 300 pages is:
- a real margin below 500 (the last realistic-scan page count actually verified safe) and below
  600 (where pure rendering alone already became impractical);
- combined with real measured OCR cost for degraded/scanned content (~1.7 s/page, the DPI sweep
  above), a 300-page document's worst-case *total* time (render + OCR) is roughly 10 minutes —
  already a lot for a no-cancel operation, which is exactly why the cap doesn't sit any higher
  even though rendering alone stayed healthy well past that point.

This closes half of the previously-flagged gap. **Still open:** there's still no pause/cancel
once a run is underway (a 300-page worst-case document is still a real ~10-minute wait with no
way to stop it), and rendering still happens synchronously in the same main-thread loop that
drives the UI — that architecture is unchanged, it just now has a real, evidenced ceiling on how
far it's ever asked to go.
