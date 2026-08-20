# Contributing

Thanks for considering it. Single-maintainer project, lightweight process — a few things below
matter more than style preferences, though.

## Before you start

For anything beyond a trivial fix, open an issue first to discuss the approach.

## Setup

```bash
git clone https://github.com/sayjavajava/quiet-ocr.git
cd quiet-ocr
npm install
npm run serve   # builds public/vendor/, then serves public/ at http://localhost:8080
```

`public/vendor/` is generated from installed npm packages by `scripts/copy-vendor-assets.mjs` —
gitignored, never commit it, never hand-edit it.

## Before opening a PR

- **Actually load the page and run an image through it.** `npm run serve`, open
  `http://localhost:8080`, pick a real image with real text, click "Run OCR", confirm it comes
  back correct. This project's whole value is "OCR that genuinely works and genuinely doesn't
  upload your file" — a change that only compiles hasn't demonstrated either of those.
- **Check the Network tab while you do it.** Nothing beyond the initial page load (the same-origin
  files under `/vendor/`) should ever be requested — no matter what image you run through it, no
  matter how many times. If your change adds a new network call of any kind, that's the one thing
  in this project that needs to be justified explicitly in the PR description, not just merged.
- CI runs an automated version of the same check on every PR — see `.github/workflows/`.

## What's in scope

Improvements to accuracy, language support, UI, and the build/deploy pipeline are all welcome.
What's explicitly **not** in scope: anything that would require uploading the user's file
somewhere (see `SECURITY.md` for why that's treated as a security boundary, not a preference) or
that would make this pretend to be fully offline the way its sibling,
[OffGridPDF](https://github.com/sayjavajava/offline-pdf-utility), actually is. If an idea needs
either of those, it likely belongs in a different project, not a mode flag in this one.

## Code style

Plain HTML/CSS/JS, no framework, no build step beyond copying vendor assets — keep it that way
unless there's a concrete reason to add tooling. Comments should explain *why*, not *what*.
