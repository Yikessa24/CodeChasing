import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js';
import {
  buildPageChunksWithState,
  type PageTextFragment
} from './paperChunking.js';
import { pagesNeedingOcr, type PageTextMetric } from './paperVision.js';
import type { PaperChunk, PaperMetadata } from './types.js';

type PdfJsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

function isTextItem(item: unknown): item is TextItem {
  return Boolean(item && typeof item === 'object' && 'str' in item);
}

export class PaperIndexer {
  private readonly moduleUrl: string;
  private readonly domMatrixUrl: string;
  private readonly workerUrl: string;
  private readonly standardFontDataUrl: string;
  private readonly cMapUrl: string;
  private readonly wasmUrl: string;

  public constructor(context: vscode.ExtensionContext) {
    this.moduleUrl = pathToFileURL(
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'pdfjs-node', 'pdf.mjs').fsPath
    ).href;
    this.domMatrixUrl = pathToFileURL(
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'pdfjs-node', 'dom-matrix.mjs').fsPath
    ).href;
    this.workerUrl = pathToFileURL(
      vscode.Uri.joinPath(
        context.extensionUri,
        'dist',
        'pdfjs-node',
        'pdf.worker-wrapper.mjs'
      ).fsPath
    ).href;
    this.standardFontDataUrl =
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'pdfjs-node', 'standard_fonts').fsPath +
      path.sep;
    this.cMapUrl =
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'pdfjs-node', 'cmaps').fsPath + path.sep;
    this.wasmUrl =
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'pdfjs-node', 'wasm').fsPath + path.sep;
  }

  public async extract(
    paper: PaperMetadata,
    signal: AbortSignal,
    onProgress?: (page: number, pageCount: number) => void
  ): Promise<{
    pageCount: number;
    chunks: PaperChunk[];
    pageTextMetrics: PageTextMetric[];
    ocrPages: number[];
  }> {
    await import(this.domMatrixUrl);
    const pdfjs = (await import(this.moduleUrl)) as PdfJsModule;
    pdfjs.GlobalWorkerOptions.workerSrc = this.workerUrl;
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.parse(paper.storedPdfUri));
    if (signal.aborted) {
      throw new DOMException('Paper indexing cancelled', 'AbortError');
    }
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      useWorkerFetch: false,
      standardFontDataUrl: this.standardFontDataUrl,
      cMapUrl: this.cMapUrl,
      cMapPacked: true,
      wasmUrl: this.wasmUrl
    });
    const document = await loadingTask.promise;
    const chunks: PaperChunk[] = [];
    const pageTextMetrics: PageTextMetric[] = [];
    let currentSection: string | undefined;
    try {
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        if (signal.aborted) {
          throw new DOMException('Paper indexing cancelled', 'AbortError');
        }
        onProgress?.(pageNumber, document.numPages);
        const page = await document.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const fragments: PageTextFragment[] = [];

        for (const item of content.items) {
          if (!isTextItem(item) || !item.str) {
            continue;
          }
          const transform = pdfjs.Util.transform(viewport.transform, item.transform);
          const height = Math.max(
            Math.abs(item.height * viewport.scale),
            Math.hypot(transform[2] ?? 0, transform[3] ?? 0)
          );
          const width = Math.abs(item.width * viewport.scale);
          fragments.push({
            text: item.str,
            hasEOL: item.hasEOL,
            box: {
              x: (transform[4] ?? 0) / viewport.width,
              y: ((transform[5] ?? 0) - height) / viewport.height,
              width: width / viewport.width,
              height: height / viewport.height
            }
          });
        }
        const structured = buildPageChunksWithState(
          paper.hash,
          pageNumber,
          fragments,
          currentSection
        );
        chunks.push(...structured.chunks.map((chunk) => ({ ...chunk, source: 'pdf-text' as const })));
        pageTextMetrics.push({
          page: pageNumber,
          characterCount: fragments.reduce(
            (total, fragment) => total + fragment.text.replace(/\s+/g, '').length,
            0
          ),
          fragmentCount: fragments.length
        });
        currentSection = structured.lastSection;
        page.cleanup();
      }
      return {
        pageCount: document.numPages,
        chunks,
        pageTextMetrics,
        ocrPages: pagesNeedingOcr(pageTextMetrics)
      };
    } finally {
      await loadingTask.destroy();
    }
  }
}
