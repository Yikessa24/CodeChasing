import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { build } from 'esbuild';

const filePath = process.argv[2];
if (!filePath) throw new Error('Usage: node scripts/inspect-paper-structure.mjs /absolute/path.pdf');

const require = createRequire(import.meta.url);
const chunkingBuild = await build({
  entryPoints: ['src/paperChunking.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'silent'
});
const chunkingModule = { exports: {} };
vm.runInNewContext(chunkingBuild.outputFiles[0].text, {
  module: chunkingModule,
  exports: chunkingModule.exports,
  require
});
const { buildPageChunksWithState } = chunkingModule.exports;

await import(pathToFileURL(resolve('vendor/dom-matrix.mjs')).href);
const pdfjs = await import(pathToFileURL(resolve('node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(resolve('node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
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
  const chunks = [];
  let section;
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const fragments = [];
    for (const item of content.items) {
      if (!item || typeof item !== 'object' || !('str' in item) || !item.str) continue;
      const transform = pdfjs.Util.transform(viewport.transform, item.transform);
      const height = Math.max(Math.abs(item.height * viewport.scale), Math.hypot(transform[2] ?? 0, transform[3] ?? 0));
      fragments.push({
        text: item.str,
        hasEOL: item.hasEOL,
        box: {
          x: (transform[4] ?? 0) / viewport.width,
          y: ((transform[5] ?? 0) - height) / viewport.height,
          width: Math.abs(item.width * viewport.scale) / viewport.width,
          height: height / viewport.height
        }
      });
    }
    const structured = buildPageChunksWithState('smoke', pageNumber, fragments, section);
    chunks.push(...structured.chunks);
    section = structured.lastSection;
    page.cleanup();
  }
  const counts = {};
  for (const chunk of chunks) counts[chunk.kind ?? 'unknown'] = (counts[chunk.kind ?? 'unknown'] ?? 0) + 1;
  const formulas = chunks.filter((chunk) => chunk.kind === 'formula');
  console.log(JSON.stringify({
    pages: pdf.numPages,
    chunks: chunks.length,
    counts,
    formulas: formulas.length,
    labeledFormulas: formulas.filter((chunk) => chunk.formula?.label).length,
    headingSamples: chunks.filter((chunk) => chunk.kind === 'heading').slice(0, 30).map((chunk) => ({ page: chunk.page, text: chunk.text.slice(0, 180) })),
    sectionCandidateSamples: chunks.filter((chunk) => /\b(?:introduction|method|architecture|experiments?|results?|retinex|implementation)\b/i.test(chunk.text)).slice(0, 30).map((chunk) => ({ page: chunk.page, kind: chunk.kind, text: chunk.text.slice(0, 180) })),
    embeddedEquationSamples: chunks.filter((chunk) => chunk.kind === 'paragraph' && /[=≈≤≥].*\(?\d+\)?/u.test(chunk.text)).slice(0, 15).map((chunk) => ({ page: chunk.page, section: chunk.section, text: chunk.text.slice(0, 600) })),
    formulaSamples: formulas.slice(0, 8).map((chunk) => ({ page: chunk.page, section: chunk.section, text: chunk.text.slice(0, 180) }))
  }, null, 2));
} finally {
  await loadingTask.destroy();
}
