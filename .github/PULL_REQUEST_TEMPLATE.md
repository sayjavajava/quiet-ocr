## Summary

<!-- What changed, and why. -->

## Test plan

- [ ] `npm run build` — clean
- [ ] Loaded the real page (`npm run serve`) and ran an actual image through it — recognition
      works, not just "the build succeeded"
- [ ] Checked the Network tab while doing that: only the expected same-origin `/vendor/` assets
      were requested, nothing else — especially if this PR touches `public/app.js` or anything
      that runs after a file is selected
- [ ] If this PR adds any new network call of any kind, explained why below (see `CONTRIBUTING.md`)
- [ ] CI's automated verification passes (see `.github/workflows/`)
