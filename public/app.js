// QuietOCR — runs Tesseract (via WebAssembly) entirely in the browser.
// Images and PDFs never leave this page: they're read into memory from the
// <input type="file">, handed straight to the OCR engine (PDFs are
// rasterized to page images first, entirely client-side — see
// pdf-to-images.js), and nothing derived from them is ever sent anywhere.
// The only network requests this page makes are for its own code
// (tesseract.min.js, worker.min.js, the WASM core, the trained-data file,
// and pdf.js) — all same-origin, from public/vendor/, not a third-party CDN.

import { pdfToImageFiles, isPdfFile } from './pdf-to-images.js';
import { buildDocxBlob } from './docx-export.js';
import { buildSearchablePdfBlob } from './pdf-export.js';
import { zipBlobs } from './zip-export.js';

const fileInput = document.getElementById('file-input');
const fileList = document.getElementById('file-list');
const runButton = document.getElementById('run');
const cancelButton = document.getElementById('cancel');
const statusEl = document.getElementById('status');
const resultSection = document.getElementById('result-section');
const resultEl = document.getElementById('result');
const copyButton = document.getElementById('copy');
const outputFormatSelect = document.getElementById('output-format');
const pdfFormatOption = document.getElementById('pdf-format-option');
const downloadButton = document.getElementById('download');
const languageSelect = document.getElementById('language');

// pdf-export.js's invisible text layer uses StandardFonts.Helvetica, which
// is WinAnsi-encoded (~220 code points — Latin script, including the
// accented letters French/Spanish/German/Portuguese/Italian actually use).
// font.encodeText() throws on anything outside that, and pdf-export.js
// already tolerates that per-word (skips just that one word, so one
// stray OCR-garbage glyph never aborts the whole document) — but for
// these six languages, *every* word would fail to encode, silently
// producing a PDF with the right image and zero actual invisible text: a
// real, silent degradation, not the rare edge case the per-word guard was
// built for. Disabling the option outright for these languages is honest
// about that, rather than shipping a "searchable" PDF that isn't
// searchable. .docx (always fully Unicode, via the `docx` library) is
// unaffected and stays available for every supported language.
const NON_LATIN_LANGS = new Set(['rus', 'ara', 'hin', 'chi_sim', 'jpn', 'kor']);

function updateOutputFormatAvailability() {
  const unavailable = NON_LATIN_LANGS.has(languageSelect.value);
  pdfFormatOption.disabled = unavailable;
  pdfFormatOption.textContent = unavailable
    ? 'Searchable PDF (.pdf) — not available for this language'
    : 'Searchable PDF (.pdf)';
  if (unavailable && outputFormatSelect.value === 'pdf') {
    outputFormatSelect.value = 'docx';
    updateDownloadButtonLabel();
  }
}
languageSelect.addEventListener('change', updateOutputFormatAvailability);
// Run once at load, not just on future change events — a browser can
// restore a <select>'s value from history/back-forward cache on reload
// even without any JS running, which could otherwise leave a non-Latin
// language selected while the PDF option's static HTML (enabled) is what
// actually renders.
updateOutputFormatAvailability();

let selectedFiles = [];
// One entry per originally-selected file (not per rendered PDF page):
// `{ name, indices }`, where `indices` are that file's position(s) in
// `selectedFiles`/`lastResults` — a plain image has one index, a PDF has
// one per rendered page. This is what lets the .docx/.pdf export below
// turn a 5-page PDF back into a single 5-page document instead of 5
// separate one-page ones, even though OCR itself still runs per rendered
// page.
let fileGroups = [];
// Kept at module scope (not local to the Run click handler) so the
// Download click handler — a separate listener — can build the
// searchable-PDF output on demand, from the same data the .docx build
// already used: which file each result came from, and its words.
let lastResults = [];
let docxOutputs = []; // `{ name, blob }[]`, rebuilt after every run
// PDF export embeds a full raster page image per page — a real CPU/memory
// cost `.docx` (pure text) doesn't have, plausibly hundreds of MB for a
// large scanned batch (up to MAX_PDF_PAGES). Built lazily, on first actual
// need, rather than unconditionally every run alongside docxOutputs.
let pdfOutputs = [];
let isBuildingPdf = false;
// Identifies which run pdfOutputs (if any) was built from, so switching
// back to a format already built doesn't rebuild it, while a stale cache
// left over from an earlier run never gets served for a later one.
let currentRunId = 0;
let pdfOutputsRunId = -1;
let previewUrls = [];
let worker = null;
// Belt-and-suspenders alongside fileInput.disabled: that attribute stops a
// real user from reopening the picker mid-run, but doesn't stop a change
// event fired by any other means (a testing tool driving the DOM directly,
// e.g.) from still reaching this handler and reassigning selectedFiles out
// from under the running loop below. This flag is checked regardless of how
// the event arrived.
let isRunning = false;
// Same reasoning as isRunning, for the PDF-rendering phase (which starts on
// file selection, before Run is ever clicked, and previously had no lock at
// all — see MAX_PDF_PAGES's history in pdf-to-images.js).
let isRendering = false;

// Cancellation for both busy phases above. worker.terminate() (tesseract.js)
// does NOT reject an in-flight recognize() call — the pending promise is
// only ever settled by the worker's own message handler, which never fires
// again once the worker is killed. Confirmed directly from tesseract.js's
// source before relying on it: a bare `await worker.recognize(file)` would
// hang forever if cancelled this way. So cancellation races the in-flight
// work against this signal instead of trying to interrupt it directly —
// see the Promise.race in the recognize loop below. The render loop doesn't
// need this (pdf.js page renders are cheap enough — sub-second — to just
// check a flag once per page instead).
let cancelRequested = false;
let cancelResolve = null;
let cancelPromise = null;
function beginCancelable() {
  cancelRequested = false;
  cancelPromise = new Promise((resolve) => { cancelResolve = resolve; });
}
function setCancelVisible(visible) {
  cancelButton.hidden = !visible;
  cancelButton.disabled = false;
  cancelButton.textContent = 'Cancel';
}

// A batch above this size gets a confirmation with a time estimate before
// starting, rather than silently kicking off a multi-minute run on one
// click — a large PDF (expanded to one page per item, see pdf-to-images.js)
// is the realistic way this gets hit, not someone deliberately selecting
// 25+ individual images.
const LARGE_BATCH_THRESHOLD = 25;

// ~1.7s/item is the real measured average across this project's fixtures
// (docs/PERFORMANCE.md's DPI sweep against scanned-multipage.pdf — mixed
// clean/degraded content, ~3.4s recognize for 2 pages), not a guess; ~0.5s
// is the one-time engine-load cost, paid once per batch, not per item.
const ESTIMATED_SECONDS_PER_ITEM = 1.7;
const ESTIMATED_ENGINE_LOAD_SECONDS = 0.5;

function estimateRunSeconds(itemCount) {
  return ESTIMATED_ENGINE_LOAD_SECONDS + itemCount * ESTIMATED_SECONDS_PER_ITEM;
}

function formatEstimate(seconds) {
  if (seconds < 60) return `~${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  return `~${minutes} minute${minutes === 1 ? '' : 's'}`;
}

// tesseract.js's word-level output is a nested tree
// (blocks[].paragraphs[].lines[].words[]), not a flat list — confirmed
// directly from its type definitions, not assumed. Flattened here into a
// plain { text, bbox: {x0,y0,x1,y1}, confidence }[] once, right after
// recognize(), so pdf-export.js's per-word placement logic doesn't need to
// know anything about Tesseract's internal document structure.
function flattenWords(blocks) {
  const words = [];
  for (const block of blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        for (const word of line.words ?? []) {
          words.push({ text: word.text, bbox: word.bbox, confidence: word.confidence });
        }
      }
    }
  }
  return words;
}

// Two files with the same name (a real scenario — a repeated fixture in a
// test batch, or genuinely two files named "scan.pdf" from two different
// folders) would otherwise both produce e.g. "scan.docx" and silently
// collapse into one entry when zipped, losing one of the two documents
// with no error or warning. Each output format gets its own fresh naming
// state (a completed .docx build's names must not affect a later .pdf
// build's own numbering) — call this once per build, then call the
// returned function synchronously, in order, once per file group, so
// Array.prototype.map's guaranteed in-order synchronous invocation keeps
// the counts correct regardless of which iteration's blob finishes
// building first.
function makeUniqueNamer(extension) {
  const seenNames = new Map();
  return (originalName) => {
    const base = `${originalName.replace(/\.[^.]+$/, '')}.${extension}`;
    const count = (seenNames.get(base) ?? 0) + 1;
    seenNames.set(base, count);
    if (count === 1) return base;
    const dot = base.lastIndexOf('.');
    return `${base.slice(0, dot)} (${count})${base.slice(dot)}`;
  };
}

function updateDownloadButtonLabel() {
  const isMulti = fileGroups.length > 1;
  const format = outputFormatSelect.value;
  downloadButton.textContent = isMulti ? 'Download .zip' : (format === 'pdf' ? 'Download .pdf' : 'Download .docx');
}

function clearPreviewUrls() {
  for (const url of previewUrls) URL.revokeObjectURL(url);
  previewUrls = [];
}

function renderFileList() {
  fileList.replaceChildren();
  for (const file of selectedFiles) {
    const url = URL.createObjectURL(file);
    previewUrls.push(url);

    const li = document.createElement('li');
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = file.name;
    const status = document.createElement('span');
    status.className = 'file-status';
    li.append(img, name, status);
    fileList.appendChild(li);
  }
  fileList.hidden = selectedFiles.length === 0;
}

// `state` drives the status pill's color (see style.css) — purely visual,
// derived from the same three states the text already distinguishes.
function setFileStatus(index, text, state = 'working') {
  const li = fileList.children[index];
  if (!li) return;
  const statusEl = li.querySelector('.file-status');
  statusEl.textContent = text;
  statusEl.dataset.state = state;
}

// Single file: plain recognized text, unchanged from before batching existed
// (this is also what scripts/verify.mjs's exact-match check depends on for
// the sample-invoice fixture). Multiple files: each result labelled with its
// source filename, in selection order, so it's clear which text came from
// which image.
function buildCombinedText(results) {
  if (results.length === 1) {
    const only = results[0];
    return only.error ? `Error: ${only.error}` : only.text;
  }
  return results
    .map((r) => `=== ${r.name} ===\n${r.error ? `Error: ${r.error}` : r.text}`)
    .join('\n\n');
}

fileInput.addEventListener('change', async () => {
  if (isRunning || isRendering) return;
  clearPreviewUrls();
  const rawFiles = Array.from(fileInput.files ?? []);
  resultSection.hidden = true;
  runButton.disabled = true;

  // PDFs are expanded into one page-image per page *here*, at selection
  // time, not at Run time — so the file list the user sees before clicking
  // Run is exactly what will actually be processed, and Run itself never
  // needs to know a PDF was ever involved: it's the same File[] pipeline
  // multi-image batches already use. Cancellation is only wired up for this
  // whole phase when a PDF is actually involved — a plain image selection
  // is effectively instant and never needs a lock or a Cancel button.
  const hasPdf = rawFiles.some(isPdfFile);
  if (hasPdf) {
    isRendering = true;
    beginCancelable();
    setCancelVisible(true);
    fileInput.disabled = true;
    statusEl.textContent = 'Rendering PDF page(s)…';
  }

  const expanded = [];
  const groups = [];
  const renderErrors = [];
  let cancelledRender = false;
  for (const file of rawFiles) {
    if (hasPdf && cancelRequested) { cancelledRender = true; break; }
    if (!isPdfFile(file)) {
      groups.push({ name: file.name, indices: [expanded.length] });
      expanded.push(file);
      continue;
    }
    try {
      const pages = await pdfToImageFiles(file, {
        isCancelled: () => cancelRequested,
        onPageStart: (pageNumber, totalPages) => {
          statusEl.textContent = `Rendering ${file.name}: page ${pageNumber} of ${totalPages}…`;
        },
        onPageError: (pageNumber, error) => {
          renderErrors.push(`${file.name} page ${pageNumber}: ${error?.message ?? error}`);
        },
      });
      const startIndex = expanded.length;
      groups.push({ name: file.name, indices: pages.map((_, i) => startIndex + i) });
      expanded.push(...pages);
      if (cancelRequested) { cancelledRender = true; break; }
    } catch (error) {
      renderErrors.push(`${file.name}: ${error?.message ?? error}`);
    }
  }

  selectedFiles = expanded;
  fileGroups = groups;
  if (cancelledRender) {
    statusEl.textContent = `Cancelled — rendered ${expanded.length} page(s)/image(s) before stopping.`;
  } else {
    statusEl.textContent = renderErrors.length > 0
      ? `Rendered with errors — ${renderErrors.join('; ')}`
      : '';
  }
  renderFileList();

  if (hasPdf) {
    isRendering = false;
    setCancelVisible(false);
    fileInput.disabled = false;
  }

  runButton.disabled = selectedFiles.length === 0;
  runButton.textContent = selectedFiles.length > 1
    ? `Run OCR on ${selectedFiles.length} images`
    : 'Run OCR';
});

runButton.addEventListener('click', async () => {
  if (selectedFiles.length === 0 || isRunning) return;

  // Locked as the very first thing this handler does, with nothing —
  // not even the confirm() dialog below — between the guard check above
  // and the lock. A real double-click (or two near-simultaneous
  // programmatic clicks) can reach this listener twice before the first
  // invocation's own synchronous prefix has fully run; reproduced directly
  // (two Tesseract workers got created from one rapid double-click) before
  // this ordering fix — see scripts/verify.mjs's race-condition checks.
  isRunning = true;
  runButton.disabled = true;

  if (selectedFiles.length > LARGE_BATCH_THRESHOLD) {
    const estimate = formatEstimate(estimateRunSeconds(selectedFiles.length));
    const proceed = window.confirm(
      `This will run OCR on ${selectedFiles.length} pages/images, estimated ${estimate}. ` +
      `You can cancel it at any time once it starts. Continue?`
    );
    if (!proceed) {
      isRunning = false;
      runButton.disabled = false;
      return;
    }
  }

  // Cancel's visibility is deliberately wired here, after the confirm()
  // gate above resolves — not as a direct reaction to isRunning, which is
  // already true before that gate (for the double-click guard above). If
  // it just followed isRunning, it would flash visible behind the native
  // confirm() dialog, a button nothing could actually reach while it's up.
  beginCancelable();
  setCancelVisible(true);

  // A new selection mid-run would reassign selectedFiles/fileGroups out
  // from under the loop below — silently truncating it, and pairing the
  // wrong file's recognized text with the wrong filename in the .docx
  // export. languageSelect is locked the same way for the same reason:
  // changing it mid-run wouldn't affect the already-created worker below
  // (recognize() uses whatever language the worker was created with, not
  // whatever the control currently shows), so leaving it interactive would
  // just be misleading about what's actually running.
  fileInput.disabled = true;
  languageSelect.disabled = true;
  resultSection.hidden = true;
  statusEl.textContent = 'Loading OCR engine…';

  // Reset explicitly, not just reassigned on success at the end — a run
  // that throws before reaching that point (e.g. worker creation fails)
  // would otherwise leave the *previous* run's outputs silently valid,
  // with Download still enabled over stale content. Both formats reset
  // together so they can never end up stale relative to each other (one
  // holding this run's data, the other a leftover from the last one).
  currentRunId += 1;
  docxOutputs = [];
  pdfOutputs = [];
  pdfOutputsRunId = -1;
  lastResults = [];
  let wasCancelled = false;

  try {
    // One worker for the whole batch, not one per image — creating a
    // worker has a real, measured fixed cost (~500ms, see
    // docs/PERFORMANCE.md) independent of image content, so reusing it
    // across a batch avoids paying that cost once per image.
    worker = await Tesseract.createWorker(languageSelect.value, 1 /* OEM_LSTM_ONLY */, {
      corePath: 'vendor/tesseract-core-lstm.wasm.js',
      workerPath: 'vendor/worker.min.js',
      langPath: 'vendor',
      gzip: true,
      logger: (m) => {
        if (m.status && typeof m.progress === 'number') {
          statusEl.textContent = `${statusEl.dataset.prefix ?? ''}${m.status}… ${Math.round(m.progress * 100)}%`;
        }
      },
    });

    for (let i = 0; i < selectedFiles.length; i++) {
      if (cancelRequested) { wasCancelled = true; break; }
      const file = selectedFiles[i];
      const prefix = selectedFiles.length > 1
        ? `Recognizing ${i + 1} of ${selectedFiles.length} (${file.name}): `
        : 'Recognizing: ';
      statusEl.dataset.prefix = prefix;
      statusEl.textContent = `${prefix}…`;
      setFileStatus(i, 'Recognizing…', 'working');

      // worker.terminate() does not reject an in-flight recognize() call
      // (see the note by cancelPromise's declaration above) — so cancelling
      // can't interrupt the awaited call directly. Racing it against the
      // cancel signal instead: if cancel wins, the recognize() promise is
      // simply abandoned (never awaited again) rather than relied on to
      // settle, and the worker is terminated for cleanup in the `finally`
      // block below regardless of which branch this took.
      // { blocks: true } asks for word-level boxes alongside the plain
      // text — off by default (see flattenWords below for why), needed for
      // the searchable-PDF export's invisible text layer, which places
      // each word at its own real position rather than one text blob per
      // page.
      const outcome = await Promise.race([
        worker.recognize(file, {}, { blocks: true }).then(
          ({ data }) => ({ type: 'done', data }),
          (error) => ({ type: 'error', error }),
        ),
        cancelPromise.then(() => ({ type: 'cancelled' })),
      ]);

      if (outcome.type === 'cancelled') {
        wasCancelled = true;
        break;
      } else if (outcome.type === 'done') {
        lastResults.push({ name: file.name, text: outcome.data.text, words: flattenWords(outcome.data.blocks) });
        setFileStatus(i, 'Done', 'done');
      } else {
        // One bad image (corrupt file, unsupported content) shouldn't sink
        // the rest of the batch — record it and keep going, the same way
        // this fixed once for silent-partial-result bugs shouldn't repeat.
        //
        // tesseract.js's own rejected Error objects sometimes already carry
        // a leading "Error: " in .message (confirmed directly — a corrupt
        // image throws with .message === "Error: Error attempting to read
        // image."), which would otherwise double up under this file's own
        // "Error: " prefix below. Stripped once here so every place that
        // shows this message (status pill, preview text, the .docx
        // placeholder) inherits the clean version instead of fixing each
        // display site separately.
        const message = (outcome.error?.message ?? String(outcome.error)).replace(/^error:\s*/i, '');
        lastResults.push({ name: file.name, error: message });
        setFileStatus(i, `Error: ${message}`, 'error');
      }
    }

    // Marks both the item that was in flight when cancel landed and every
    // item that never started — lastResults.length is exactly the count of
    // items that got a real (done/error) outcome, since cancelled items
    // are never pushed to it.
    if (wasCancelled) {
      for (let j = lastResults.length; j < selectedFiles.length; j++) {
        setFileStatus(j, 'Cancelled', 'cancelled');
      }
    }

    delete statusEl.dataset.prefix;
    resultEl.value = buildCombinedText(lastResults);
    resultSection.hidden = false;

    // One .docx per originally-selected file (a multi-page PDF's pages
    // land on separate pages of the *same* document, via fileGroups —
    // built at selection time, see the change handler above), not per
    // rendered image — an N-page PDF should come back as one N-page Word
    // document, not N single-page ones.
    const uniqueDocxName = makeUniqueNamer('docx');
    docxOutputs = await Promise.all(
      fileGroups.map(async (group) => {
        const name = uniqueDocxName(group.name);
        const pages = group.indices.map((i) => {
          // Cancelling before every item finishes leaves indices beyond
          // where the loop broke with no entry in `lastResults` at all —
          // guard against that rather than letting `undefined.error` throw
          // (a real gap, not hypothetical: cancelling before item 0
          // finishes leaves `lastResults` empty).
          const r = lastResults[i];
          if (!r) return '[Cancelled — not recognized]';
          return r.error ? `[Error recognizing this page: ${r.error}]` : r.text;
        });
        const blob = await buildDocxBlob(pages);
        return { name, blob };
      }),
    );
    updateDownloadButtonLabel();
    downloadButton.disabled = docxOutputs.length === 0;

    if (wasCancelled) {
      statusEl.textContent = `Cancelled — ${lastResults.length} of ${selectedFiles.length} recognized.`;
    } else {
      // lastResults.length > 0 guards against [].every() on an empty array
      // vacuously returning true — not reachable via this branch today
      // (wasCancelled is checked first, and a non-cancelled run always
      // processes every selected file), but kept as an explicit guard
      // rather than relying on that invariant silently holding forever.
      const allFailed = lastResults.length > 0 && lastResults.every((r) => r.error);
      statusEl.textContent = allFailed
        ? `Error: all ${lastResults.length} file(s) failed to recognize`
        : 'Done.';
    }
  } catch (error) {
    const message = String(error?.message ?? error).replace(/^error:\s*/i, '');
    statusEl.textContent = `Error: ${message}`;
    console.error(error);
  } finally {
    if (worker) {
      await worker.terminate();
      worker = null;
    }
    isRunning = false;
    fileInput.disabled = false;
    languageSelect.disabled = false;
    runButton.disabled = false;
    setCancelVisible(false);
  }
});

cancelButton.addEventListener('click', () => {
  // Guarded the same way isRunning is checked "regardless of how the event
  // arrived" — not just relying on the button being hidden.
  if (!isRendering && !isRunning) return;
  cancelRequested = true;
  cancelResolve?.();
  // Immediate feedback: there's a real window between this click and the
  // loop actually observing cancelRequested — near-instant for the
  // recognize phase (the in-flight Promise.race resolves right away), up
  // to one page's render time for the render phase.
  cancelButton.disabled = true;
  cancelButton.textContent = 'Cancelling…';
});

copyButton.addEventListener('click', async () => {
  // navigator.clipboard.writeText() can reject — a real browser can deny
  // clipboard-write for reasons outside this page's control (permission
  // policy, an embedding context, a locked-down browser profile), not
  // just in an automated/headless environment. Silently doing nothing on
  // that rejection would leave a user thinking the copy worked.
  try {
    await navigator.clipboard.writeText(resultEl.value);
    copyButton.textContent = 'Copied!';
  } catch {
    copyButton.textContent = 'Copy failed';
  }
  setTimeout(() => { copyButton.textContent = 'Copy text'; }, 1500);
});

outputFormatSelect.addEventListener('change', () => {
  updateDownloadButtonLabel();
});

downloadButton.addEventListener('click', async () => {
  // docxOutputs is the "is there anything to download at all" signal
  // regardless of which format is currently selected — it's always built
  // eagerly, right after every run, so its length reliably tracks whether
  // this run produced anything, the same way it did before the PDF format
  // existed.
  if (docxOutputs.length === 0 || isBuildingPdf) return;

  if (outputFormatSelect.value === 'pdf' && pdfOutputsRunId !== currentRunId) {
    // Locked as the first statement, before any await — same discipline
    // as isRunning/isRendering elsewhere in this file, guarding against a
    // rapid double-click starting two concurrent builds.
    isBuildingPdf = true;
    const thisRunId = currentRunId;
    outputFormatSelect.disabled = true;
    downloadButton.disabled = true;
    const labelBeforeBuild = downloadButton.textContent;
    downloadButton.textContent = 'Preparing PDF…';
    try {
      const uniquePdfName = makeUniqueNamer('pdf');
      const built = await Promise.all(
        fileGroups.map(async (group) => {
          const name = uniquePdfName(group.name);
          const pages = group.indices.map((i) => {
            const r = lastResults[i];
            // Same degradation the .docx build already applies for a
            // missing/errored result — but the image is still embedded
            // regardless (pdf-export.js handles that): not having
            // recognized text is not the same as not having the file.
            return { file: selectedFiles[i], words: r && !r.error ? r.words : null };
          });
          const blob = await buildSearchablePdfBlob(pages);
          return { name, blob };
        }),
      );
      // A new run could have started (and reset everything) while this
      // build was in flight — only commit the result if it's still for
      // the run it was built from.
      if (thisRunId === currentRunId) {
        pdfOutputs = built;
        pdfOutputsRunId = thisRunId;
      }
    } finally {
      isBuildingPdf = false;
      outputFormatSelect.disabled = false;
      downloadButton.disabled = docxOutputs.length === 0;
      downloadButton.textContent = labelBeforeBuild;
    }
  }

  const outputs = outputFormatSelect.value === 'pdf' ? pdfOutputs : docxOutputs;
  if (outputs.length === 0) return;

  const { blob, filename } = outputs.length === 1
    ? { blob: outputs[0].blob, filename: outputs[0].name }
    : { blob: await zipBlobs(outputs), filename: 'ocr-results.zip' };

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
});
