import * as esbuild from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

await mkdir(resolve(root, 'dist/pdfjs'), { recursive: true });
await mkdir(resolve(root, 'dist/pdfjs-node'), { recursive: true });
await mkdir(resolve(root, 'dist/katex'), { recursive: true });
await Promise.all([
  cp(resolve(root, 'node_modules/pdfjs-dist/wasm'), resolve(root, 'dist/pdfjs/wasm'), {
    recursive: true
  }),
  cp(resolve(root, 'node_modules/pdfjs-dist/wasm'), resolve(root, 'dist/pdfjs-node/wasm'), {
    recursive: true
  }),
  cp(resolve(root, 'node_modules/katex/dist/katex.min.js'), resolve(root, 'dist/katex/katex.min.js')),
  cp(resolve(root, 'node_modules/katex/dist/katex.min.css'), resolve(root, 'dist/katex/katex.min.css')),
  cp(resolve(root, 'node_modules/katex/dist/fonts'), resolve(root, 'dist/katex/fonts'), {
    recursive: true
  }),
  cp(resolve(root, 'node_modules/pdfjs-dist/build/pdf.mjs'), resolve(root, 'dist/pdfjs/pdf.mjs')),
  cp(resolve(root, 'node_modules/pdfjs-dist/build/pdf.worker.mjs'), resolve(root, 'dist/pdfjs/pdf.worker.mjs')),
  cp(
    resolve(root, 'node_modules/pdfjs-dist/web/pdf_viewer.mjs'),
    resolve(root, 'dist/pdfjs/pdf_viewer.mjs')
  ),
  cp(
    resolve(root, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs'),
    resolve(root, 'dist/pdfjs-node/pdf.mjs')
  ),
  cp(
    resolve(root, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'),
    resolve(root, 'dist/pdfjs-node/pdf.worker.mjs')
  ),
  cp(resolve(root, 'vendor/dom-matrix.mjs'), resolve(root, 'dist/pdfjs-node/dom-matrix.mjs')),
  cp(
    resolve(root, 'vendor/pdf.worker-wrapper.mjs'),
    resolve(root, 'dist/pdfjs-node/pdf.worker-wrapper.mjs')
  ),
  cp(
    resolve(root, 'node_modules/pdfjs-dist/standard_fonts'),
    resolve(root, 'dist/pdfjs-node/standard_fonts'),
    { recursive: true }
  ),
  cp(
    resolve(root, 'node_modules/pdfjs-dist/cmaps'),
    resolve(root, 'dist/pdfjs-node/cmaps'),
    { recursive: true }
  )
]);

const options = {
  entryPoints: [resolve(root, 'src/extension.ts')],
  bundle: true,
  outfile: resolve(root, 'dist/extension.js'),
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info'
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  console.log('CodeChasing build is watching for changes.');
} else {
  await esbuild.build(options);
}
