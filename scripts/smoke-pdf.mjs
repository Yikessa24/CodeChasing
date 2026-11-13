import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const filePath = process.argv[2];
if (!filePath) {
  throw new Error('Usage: node scripts/smoke-pdf.mjs /absolute/path/to/paper.pdf');
}

await import(pathToFileURL(resolve('vendor/dom-matrix.mjs')).href);
const pdfjs = await import(
  pathToFileURL(resolve('node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href
);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  resolve('node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')
).href;
const loadingTask = pdfjs.getDocument({
  data: new Uint8Array(await readFile(filePath)),
  useWorkerFetch: false,
  standardFontDataUrl: `${resolve('node_modules/pdfjs-dist/standard_fonts')}/`,
  cMapUrl: `${resolve('node_modules/pdfjs-dist/cmaps')}/`,
  cMapPacked: true,
  wasmUrl: `${resolve('node_modules/pdfjs-dist/wasm')}/`
});

try {
  const pdf = await loadingTask.promise;
  let textItems = 0;
  let characters = 0;
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (item && typeof item === 'object' && 'str' in item && typeof item.str === 'string') {
        textItems += 1;
        characters += item.str.length;
      }
    }
    page.cleanup();
  }
  console.log(JSON.stringify({ pages: pdf.numPages, textItems, characters }));
} finally {
  await loadingTask.destroy();
}
