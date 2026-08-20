// Zips several generated files together into one download — used when more
// than one image/PDF was selected, so the user gets one .zip of .docx
// files instead of N separate browser downloads firing at once.

import { zipSync } from './vendor/fflate.mjs';

/** `entries` is `{ name, blob }[]`. Returns a single `application/zip` Blob. */
export async function zipBlobs(entries) {
  const zipInput = {};
  for (const { name, blob } of entries) {
    zipInput[name] = new Uint8Array(await blob.arrayBuffer());
  }
  const zipped = zipSync(zipInput);
  return new Blob([zipped], { type: 'application/zip' });
}
