// QuietOCR — runs Tesseract (via WebAssembly) entirely in the browser.
// The image never leaves this page: it's read into memory from the
// <input type="file">, handed straight to the OCR engine, and nothing
// derived from it is ever sent anywhere. The only network requests this
// page makes are for its own code (tesseract.min.js, worker.min.js, the
// WASM core, and the trained-data file) — all same-origin, from
// public/vendor/, not a third-party CDN.

const fileInput = document.getElementById('file-input');
const preview = document.getElementById('preview');
const runButton = document.getElementById('run');
const statusEl = document.getElementById('status');
const resultSection = document.getElementById('result-section');
const resultEl = document.getElementById('result');
const copyButton = document.getElementById('copy');
const downloadButton = document.getElementById('download');

let selectedFile = null;
let worker = null;

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0] ?? null;
  selectedFile = file;
  resultSection.hidden = true;
  statusEl.textContent = '';

  if (!file) {
    preview.hidden = true;
    runButton.disabled = true;
    return;
  }

  preview.src = URL.createObjectURL(file);
  preview.hidden = false;
  runButton.disabled = false;
});

runButton.addEventListener('click', async () => {
  if (!selectedFile) return;
  runButton.disabled = true;
  resultSection.hidden = true;
  statusEl.textContent = 'Loading OCR engine…';

  try {
    // Created fresh per run rather than reused, to keep this first version
    // simple; a worker pool would be the obvious follow-up for repeated use.
    worker = await Tesseract.createWorker('eng', 1 /* OEM_LSTM_ONLY */, {
      corePath: 'vendor/tesseract-core-lstm.wasm.js',
      workerPath: 'vendor/worker.min.js',
      langPath: 'vendor',
      gzip: true,
      logger: (m) => {
        if (m.status && typeof m.progress === 'number') {
          statusEl.textContent = `${m.status}… ${Math.round(m.progress * 100)}%`;
        }
      },
    });

    statusEl.textContent = 'Recognizing…';
    const { data } = await worker.recognize(selectedFile);

    resultEl.value = data.text;
    resultSection.hidden = false;
    statusEl.textContent = 'Done.';
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
  const baseName = (selectedFile?.name ?? 'scan').replace(/\.[^.]+$/, '');
  a.href = url;
  a.download = `${baseName}.txt`;
  a.click();
  URL.revokeObjectURL(url);
});
