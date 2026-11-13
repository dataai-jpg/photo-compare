// Downloads the OCR engine files into ./vendor so the app can read text with no internet.
// Usage (Node 18+):  node fetch-vendor.mjs
import { mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

const CDN = 'https://cdn.jsdelivr.net';
const FILES = [
  ['/npm/tesseract.js@5/dist/tesseract.min.js',            'vendor/tesseract.min.js'],
  ['/npm/tesseract.js@5/dist/worker.min.js',               'vendor/worker.min.js'],
  ['/npm/tesseract.js-core@5/tesseract-core-lstm.wasm.js',      'vendor/tesseract-core-lstm.wasm.js'],
  ['/npm/tesseract.js-core@5/tesseract-core-simd-lstm.wasm.js', 'vendor/tesseract-core-simd-lstm.wasm.js'],
  ['/npm/tesseract.js-core@5/tesseract-core.wasm.js',           'vendor/tesseract-core.wasm.js'],
  ['/npm/tesseract.js-core@5/tesseract-core-simd.wasm.js',      'vendor/tesseract-core-simd.wasm.js'],
  ['/gh/naptha/tessdata@gh-pages/4.0.0_fast/eng.traineddata.gz', 'vendor/lang/eng.traineddata.gz']
];

let failed = 0;
for (const [url, out] of FILES) {
  try {
    const res = await fetch(CDN + url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, buf);
    console.log('ok  ', out, (buf.length / 1024 / 1024).toFixed(2) + ' MB');
  } catch (e) {
    failed++;
    console.error('FAIL', out, e.message);
  }
}
if (failed) { console.error('\n' + failed + ' file(s) failed. Re-run, or download them manually into ./vendor.'); process.exit(1); }
console.log('\nDone. Deploy the whole pwa folder, open it once online, then it works offline.');
