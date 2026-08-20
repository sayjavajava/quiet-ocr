/**
 * Word-level accuracy scoring for OCR output — standard Word Error Rate
 * (Levenshtein distance over word sequences), not string equality.
 * Exact match is only a reasonable bar for the one short, clean, no-wrap
 * fixture; everything else needs a threshold, because real OCR output
 * legitimately varies in ways that don't mean "broken" (a stray comma, a
 * "0" read as "O") — see test/fixtures/manifest.json for which fixtures
 * use which mode.
 */

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function words(text) {
  return normalize(text).split(" ").filter(Boolean);
}

/** Levenshtein distance over two arrays of tokens (word-level, not char-level). */
function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/** 1.0 = every word matched; 0.0 = nothing recognizable. Never negative. */
export function wordAccuracy(expected, actual) {
  const expectedWords = words(expected);
  const actualWords = words(actual);
  if (expectedWords.length === 0) return actualWords.length === 0 ? 1 : 0;
  const distance = editDistance(expectedWords, actualWords);
  return Math.max(0, 1 - distance / expectedWords.length);
}

/**
 * Splits app.js's multi-file combined output (`=== name ===` header lines,
 * each followed by that file's recognized text) back into `{ name, text }`
 * blocks, in order — used to score each page of a rasterized PDF (or each
 * file of a batch) independently instead of accuracy-scoring the whole
 * concatenated output as one blob, which would hide which specific
 * page/file is wrong. Locates blocks by header position rather than
 * splitting on a fixed "\n\n" separator, because Tesseract's own output
 * often ends a block with extra trailing newlines of its own — a fixed
 * two-newline split silently merges the next header into the previous
 * block's text when that happens.
 */
export function parseLabelledBlocks(combinedText) {
  const headers = [...combinedText.matchAll(/^=== (.+) ===$/gm)];
  if (headers.length === 0) return [{ name: null, text: combinedText }];
  return headers.map((header, i) => {
    const start = header.index + header[0].length;
    const end = i + 1 < headers.length ? headers[i + 1].index : combinedText.length;
    return { name: header[1], text: combinedText.slice(start, end).replace(/^\n+/, "") };
  });
}
