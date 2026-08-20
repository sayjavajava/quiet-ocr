# Security Policy

## What this project actually promises

QuietOCR is **not** offline — see the README for why, and how that's different from this
project's sibling, [OffGridPDF](https://github.com/sayjavajava/offline-pdf-utility). The
security-relevant promise here is narrower and specific: **the file you select is never
transmitted anywhere.** Recognition runs entirely client-side, in WebAssembly. A regression that
breaks that — any code path that sends image data, recognized text, or anything derived from
either to a network request — is treated as a security bug, not a feature bug.

## Reporting a vulnerability

Please **do not open a public issue** for a security report until a fix is available. Use
GitHub's private reporting for this repository — **Security tab → "Report a vulnerability"**. If
that isn't available to you, open a regular issue containing the words "security report" and no
exploit details, and a private channel will be set up in reply.

Include the affected version/commit, a minimal reproduction, and what you'd expect instead.
There's no formal SLA — this is a single-maintainer project — but reports get looked at promptly.

## What's in scope

- **Any code path that transmits a user's file, or anything derived from it** (the recognized
  text, image metadata, etc.) to a network request. This is the core guarantee — see above.
- **Malicious-input handling**: a crafted image causing unexpected code execution, or a crash
  usable for something worse than a crash, in the WebAssembly OCR engine or this page's own code.
- **XSS or script injection** via a filename, recognized text, or image metadata being rendered
  unsanitized in the UI.
- **Dependency vulnerabilities** in anything shipped to the page (`tesseract.js`,
  `tesseract.js-core`, or the trained-data package).
- **Supply-chain integrity of the self-hosted OCR engine**: since `public/vendor/` is generated
  from installed npm packages at build/deploy time (see `scripts/copy-vendor-assets.mjs`), a
  compromised version of `tesseract.js`/`tesseract.js-core` making it into a deployed build is a
  real concern worth reporting, same as any dependency vulnerability.

## What's out of scope

This app has no server, no accounts, and no persisted user data — those categories of report
don't apply. General bug reports with no security impact belong in a regular issue.
