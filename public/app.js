// QuietOCR — runs Tesseract (via WebAssembly) entirely in the browser.
// Images never leave this page: they're read into memory from the
// <input type="file">, handed straight to the OCR engine, and nothing
// derived from them is ever sent anywhere. The only network requests this
// page makes are for its own code (tesseract.min.js, worker.min.js, the
// WASM core, and the trained-data file) — all same-origin, from
// public/vendor/, not a third-party CDN.

const fileInput = document.getElementById('file-input');
const fileList = document.getElementById('file-list');
const runButton = document.getElementById('run');
const statusEl = document.getElementById('status');
const resultSection = document.getElementById('result-section');
const resultEl = document.getElementById('result');
const copyButton = document.getElementById('copy');
const downloadButton = document.getElementById('download');

let selectedFiles = [];
let previewUrls = [];
let worker = null;

function clearPreviewUrls() {
  for (const url of previewUrls) URL.revokeObjectURL(url);
  previewUrls = [];
}

function renderFileList() {
  fileList.innerHTML = '';
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

function setFileStatus(index, text) {
  const li = fileList.children[index];
  if (li) li.querySelector('.file-status').textContent = text;
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

fileInput.addEventListener('change', () => {
  clearPreviewUrls();
  selectedFiles = Array.from(fileInput.files ?? []);
  resultSection.hidden = true;
  statusEl.textContent = '';
  renderFileList();

  runButton.disabled = selectedFiles.length === 0;
  runButton.textContent = selectedFiles.length > 1
    ? `Run OCR on ${selectedFiles.length} images`
    : 'Run OCR';
});

runButton.addEventListener('click', async () => {
  if (selectedFiles.length === 0) return;
  runButton.disabled = true;
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
      setFileStatus(i, 'Recognizing…');

      try {
        const { data } = await worker.recognize(file);
        results.push({ name: file.name, text: data.text });
        setFileStatus(i, 'Done');
      } catch (error) {
        // One bad image (corrupt file, unsupported content) shouldn't sink
        // the rest of the batch — record it and keep going, the same way
        // this fixed once for silent-partial-result bugs shouldn't repeat.
        const message = error?.message ?? String(error);
        results.push({ name: file.name, error: message });
        setFileStatus(i, `Error: ${message}`);
      }
    }

    delete statusEl.dataset.prefix;
    resultEl.value = buildCombinedText(results);
    resultSection.hidden = false;

    const allFailed = results.every((r) => r.error);
    statusEl.textContent = allFailed
      ? `Error: all ${results.length} file(s) failed to recognize`
      : 'Done.';
  } catch (error) {
    statusEl.textContent = `Error: ${error?.message ?? error}`;
    console.error(error);
  } finally {
    if (worker) {
      await worker.terminate();
      worker = null;
    }
    runButton.disabled = false;
  }
});

copyButton.addEventListener('click', async () => {
  await navigator.clipboard.writeText(resultEl.value);
  copyButton.textContent = 'Copied!';
  setTimeout(() => { copyButton.textContent = 'Copy text'; }, 1500);
});

downloadButton.addEventListener('click', () => {
  const blob = new Blob([resultEl.value], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const filename = selectedFiles.length === 1
    ? `${selectedFiles[0].name.replace(/\.[^.]+$/, '')}.txt`
    : 'ocr-results.txt';
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
});
