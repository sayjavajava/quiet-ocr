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
  single tab, but it's worth setting expectations: this is not the tool for OCR-ing a
  multi-page document at speed, single image at a time, in a UI with no batching (see the
  "Scope, for now" section of the [README](../README.md)).
