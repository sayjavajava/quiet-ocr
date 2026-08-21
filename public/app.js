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
import { zipBlobs } from './zip-export.js';

const fileInput = document.getElementById('file-input');
const fileList = document.getElementById('file-list');
const runButton = document.getElementById('run');
const statusEl = document.getElementById('status');
const resultSection = document.getElementById('result-section');
const resultEl = document.getElementById('result');
const copyButton = document.getElementById('copy');
const downloadButton = document.getElementById('download');

let selectedFiles = [];
// One entry per originally-selected file (not per rendered PDF page):
// `{ name, indices }`, where `indices` are that file's position(s) in
// `selectedFiles`/`results` — a plain image has one index, a PDF has one
// per rendered page. This is what lets the .docx export below turn a
// 5-page PDF back into a single 5-page Word document instead of 5 separate
// one-page ones, even though OCR itself still runs per rendered page.
let fileGroups = [];
let docxOutputs = []; // `{ name, blob }[]`, rebuilt after every run
let previewUrls = [];
let worker = null;
// Belt-and-suspenders alongside fileInput.disabled: that attribute stops a
// real user from reopening the picker mid-run, but doesn't stop a change
// event fired by any other means (a testing tool driving the DOM directly,
// e.g.) from still reaching this handler and reassigning selectedFiles out
// from under the running loop below. This flag is checked regardless of how
// the event arrived.
let isRunning = false;

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
  if (isRunning) return;
  clearPreviewUrls();
  const rawFiles = Array.from(fileInput.files ?? []);
  resultSection.hidden = true;
  runButton.disabled = true;

  // PDFs are expanded into one page-image per page *here*, at selection
  // time, not at Run time — so the file list the user sees before clicking
  // Run is exactly what will actually be processed, and Run itself never
  // needs to know a PDF was ever involved: it's the same File[] pipeline
  // multi-image batches already use.
  const hasPdf = rawFiles.some(isPdfFile);
  if (hasPdf) statusEl.textContent = 'Rendering PDF page(s)…';

  const expanded = [];
  const groups = [];
  const renderErrors = [];
  for (const file of rawFiles) {
    if (!isPdfFile(file)) {
      groups.push({ name: file.name, indices: [expanded.length] });
      expanded.push(file);
      continue;
    }
    try {
      const pages = await pdfToImageFiles(file, {
        onPageError: (pageNumber, error) => {
          renderErrors.push(`${file.name} page ${pageNumber}: ${error?.message ?? error}`);
        },
      });
      const startIndex = expanded.length;
      groups.push({ name: file.name, indices: pages.map((_, i) => startIndex + i) });
      expanded.push(...pages);
    } catch (error) {
      renderErrors.push(`${file.name}: ${error?.message ?? error}`);
    }
  }

  selectedFiles = expanded;
  fileGroups = groups;
  statusEl.textContent = renderErrors.length > 0
    ? `Rendered with errors — ${renderErrors.join('; ')}`
    : '';
  renderFileList();

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
      `There's no pause or cancel once it starts. Continue?`
    );
    if (!proceed) {
      isRunning = false;
      runButton.disabled = false;
      return;
    }
  }

  // A new selection mid-run would reassign selectedFiles/fileGroups out
  // from under the loop below — silently truncating it, and pairing the
  // wrong file's recognized text with the wrong filename in the .docx
  // export.
  fileInput.disabled = true;
  resultSection.hidden = true;
  statusEl.textContent = 'Loading OCR engine…';

  const results = [];

  try {
    // One worker for the whole batch, not one per image — creating a
    // worker has a real, measured fixed cost (~500ms, see
    // docs/PERFORMANCE.md) independent of image content, so reusing it
    // across a batch avoids paying that cost once per image.
    worker = await Tesseract.createWorker('eng', 1 /* OEM_LSTM_ONLY */, {
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
      const file = selectedFiles[i];
      const prefix = selectedFiles.length > 1
        ? `Recognizing ${i + 1} of ${selectedFiles.length} (${file.name}): `
        : 'Recognizing: ';
      statusEl.dataset.prefix = prefix;
      statusEl.textContent = `${prefix}…`;
      setFileStatus(i, 'Recognizing…', 'working');

      try {
        const { data } = await worker.recognize(file);
        results.push({ name: file.name, text: data.text });
        setFileStatus(i, 'Done', 'done');
      } catch (error) {
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
        const message = (error?.message ?? String(error)).replace(/^error:\s*/i, '');
        results.push({ name: file.name, error: message });
        setFileStatus(i, `Error: ${message}`, 'error');
      }
    }

    delete statusEl.dataset.prefix;
    resultEl.value = buildCombinedText(results);
    resultSection.hidden = false;

    // One .docx per originally-selected file (a multi-page PDF's pages
    // land on separate pages of the *same* document, via fileGroups —
    // built at selection time, see the change handler above), not per
    // rendered image — an N-page PDF should come back as one N-page Word
    // document, not N single-page ones.
    // Two files with the same name (a real scenario — a repeated fixture
    // in a test batch, or genuinely two files named "scan.pdf" from two
    // different folders) would otherwise both produce "scan.docx" and
    // silently collapse into one entry when zipped, losing one of the two
    // documents with no error or warning. uniqueDocxName is computed
    // synchronously as the first thing in each iteration — before the
    // async buildDocxBlob call — so Array.prototype.map's guaranteed
    // in-order synchronous invocation keeps `seenNames` correct regardless
    // of which iteration's blob finishes building first.
    const seenNames = new Map();
    function uniqueDocxName(originalName) {
      const base = `${originalName.replace(/\.[^.]+$/, '')}.docx`;
      const count = (seenNames.get(base) ?? 0) + 1;
      seenNames.set(base, count);
      if (count === 1) return base;
      const dot = base.lastIndexOf('.');
      return `${base.slice(0, dot)} (${count})${base.slice(dot)}`;
    }

    docxOutputs = await Promise.all(
      fileGroups.map(async (group) => {
        const name = uniqueDocxName(group.name);
        const pages = group.indices.map((i) => {
          const r = results[i];
          return r.error ? `[Error recognizing this page: ${r.error}]` : r.text;
        });
        const blob = await buildDocxBlob(pages);
        return { name, blob };
      }),
    );
    downloadButton.textContent = docxOutputs.length > 1 ? 'Download .zip' : 'Download .docx';
    downloadButton.disabled = docxOutputs.length === 0;

    const allFailed = results.every((r) => r.error);
    statusEl.textContent = allFailed
      ? `Error: all ${results.length} file(s) failed to recognize`
      : 'Done.';
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
    runButton.disabled = false;
  }
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

downloadButton.addEventListener('click', async () => {
  if (docxOutputs.length === 0) return;

  const { blob, filename } = docxOutputs.length === 1
    ? { blob: docxOutputs[0].blob, filename: docxOutputs[0].name }
    : { blob: await zipBlobs(docxOutputs), filename: 'ocr-results.zip' };

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
});
