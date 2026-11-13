import * as vscode from 'vscode';
import type { NormalizedBox, PaperChunk, PaperMetadata, PaperTextSelection } from './types.js';

function nonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join(
    ''
  );
}

export class PdfViewer implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private currentPaper: PaperMetadata | undefined;
  private pendingHighlight: PaperChunk | undefined;
  private readonly preparedPdfs = new Map<string, Uint8Array>();
  private readonly preparedPreviews = new Map<
    string,
    { dataUrl: string; width: number; height: number }
  >();
  private readyPaperHash: string | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onAskSelection?: (selection: PaperTextSelection) => Promise<void>,
    private readonly onViewerStatus?: (status: 'loading' | 'ready' | 'failed') => void
  ) {}

  public async prepare(paper: PaperMetadata): Promise<void> {
    if (this.preparedPdfs.has(paper.hash)) {
      const cached = this.preparedPdfs.get(paper.hash);
      if (cached) {
        this.preparedPdfs.delete(paper.hash);
        this.preparedPdfs.set(paper.hash, cached);
      }
      return;
    }
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.parse(paper.storedPdfUri));
    this.preparedPdfs.set(paper.hash, bytes);
    this.trimCache(this.preparedPdfs, 2);
  }

  public async preparedBytes(paper: PaperMetadata): Promise<Uint8Array> {
    await this.prepare(paper);
    const bytes = this.preparedPdfs.get(paper.hash);
    if (!bytes) {
      throw new Error('Prepared PDF bytes are unavailable.');
    }
    return bytes;
  }

  public setPreparedPreview(
    paperHash: string,
    preview: { dataUrl: string; width: number; height: number }
  ): void {
    this.preparedPreviews.set(paperHash, preview);
    this.trimCache(this.preparedPreviews, 4);
  }

  public async preload(paper: PaperMetadata): Promise<void> {
    await this.ensurePanel(paper, {
      viewColumn: vscode.ViewColumn.Active,
      preserveFocus: true
    });
  }

  public async open(paper: PaperMetadata): Promise<void> {
    await this.prepare(paper);
    this.onViewerStatus?.(this.readyPaperHash === paper.hash ? 'ready' : 'loading');
    await this.ensurePanel(paper, {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: false
    });
    this.panel?.reveal(vscode.ViewColumn.Beside, false);
  }

  private async ensurePanel(
    paper: PaperMetadata,
    showOptions: { viewColumn: vscode.ViewColumn; preserveFocus?: boolean }
  ): Promise<void> {
    const previousPaperHash = this.currentPaper?.hash;
    const shouldReload = !this.panel || previousPaperHash !== paper.hash;
    if (previousPaperHash && previousPaperHash !== paper.hash) {
      this.pendingHighlight = undefined;
      this.readyPaperHash = undefined;
    }
    this.currentPaper = paper;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'codeChasing.paperViewer',
        `Paper: ${paper.title}`,
        showOptions,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
            vscode.Uri.joinPath(this.context.extensionUri, 'media'),
            vscode.Uri.joinPath(vscode.Uri.parse(paper.storedPdfUri), '..')
          ]
        }
      );
      this.panel.onDidDispose(
        () => {
          this.panel = undefined;
          this.currentPaper = undefined;
          this.pendingHighlight = undefined;
          this.readyPaperHash = undefined;
        },
        undefined,
        this.disposables
      );
      this.panel.webview.onDidReceiveMessage(
        async (message: unknown) => {
          if (!message || typeof message !== 'object') {
            return;
          }
          const data = message as Record<string, unknown>;
          if (data.type === 'viewerReady') {
            await this.postPdfData();
            if (this.pendingHighlight) {
              await this.postHighlight(this.pendingHighlight);
            }
          } else if (data.type === 'pdfReady' && data.hash === this.currentPaper?.hash) {
            this.readyPaperHash = this.currentPaper?.hash;
            this.onViewerStatus?.('ready');
          } else if (data.type === 'pdfError' && data.hash === this.currentPaper?.hash) {
            this.onViewerStatus?.('failed');
          } else if (
            data.type === 'askPdfSelection' &&
            this.currentPaper &&
            data.hash === this.currentPaper.hash &&
            typeof data.text === 'string' &&
            typeof data.page === 'number' &&
            Array.isArray(data.boxes)
          ) {
            const text = data.text.trim().slice(0, 4000);
            const page = Math.floor(data.page);
            const boxes = data.boxes.filter(isNormalizedBox).slice(0, 120);
            if (text && page > 0 && boxes.length) {
              await this.onAskSelection?.({
                paperHash: this.currentPaper.hash,
                page,
                text,
                boxes
              });
            }
          }
        },
        undefined,
        this.disposables
      );
    } else if (!showOptions.preserveFocus) {
      this.panel.title = `Paper: ${paper.title}`;
      this.panel.reveal(showOptions.viewColumn, false);
    }
    if (shouldReload) {
      this.panel.webview.options = {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
          vscode.Uri.joinPath(this.context.extensionUri, 'media'),
          vscode.Uri.joinPath(vscode.Uri.parse(paper.storedPdfUri), '..')
        ]
      };
      this.panel.webview.html = this.html(this.panel.webview, paper);
    }
  }

  public async highlight(chunk: PaperChunk): Promise<void> {
    this.pendingHighlight = chunk;
    if (!this.panel || !this.currentPaper) {
      return;
    }
    this.panel.reveal(vscode.ViewColumn.Beside, false);
    await this.postHighlight(chunk);
  }

  private async postHighlight(chunk: PaperChunk): Promise<void> {
    if (!this.panel) {
      return;
    }
    await this.panel.webview.postMessage({
      type: 'highlight',
      page: chunk.page,
      boxes: chunk.boxes,
      chunkId: chunk.id
    });
  }

  private async postPdfData(): Promise<void> {
    if (!this.panel || !this.currentPaper) {
      return;
    }
    await this.prepare(this.currentPaper);
    const bytes = this.preparedPdfs.get(this.currentPaper.hash);
    if (bytes) {
      const encoded = Buffer.from(bytes).toString('base64');
      const chunkSize = 512 * 1024;
      const chunkCount = Math.ceil(encoded.length / chunkSize);
      await this.panel.webview.postMessage({ type: 'pdfDataStart', chunkCount });
      for (let index = 0; index < chunkCount; index += 1) {
        await this.panel.webview.postMessage({
          type: 'pdfDataChunk',
          index,
          data: encoded.slice(index * chunkSize, (index + 1) * chunkSize)
        });
      }
      await this.panel.webview.postMessage({ type: 'pdfDataEnd' });
    }
  }

  public dispose(): void {
    this.panel?.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.preparedPdfs.clear();
    this.preparedPreviews.clear();
  }

  public close(): void {
    this.panel?.dispose();
  }

  private trimCache<T>(cache: Map<string, T>, maximumEntries: number): void {
    while (cache.size > maximumEntries) {
      const oldest = cache.keys().next().value;
      if (typeof oldest !== 'string') {
        break;
      }
      cache.delete(oldest);
    }
  }

  private html(webview: vscode.Webview, paper: PaperMetadata): string {
    const pdfModule = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'pdfjs', 'pdf.mjs')
    );
    const workerModule = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'pdfjs', 'pdf.worker.mjs')
    );
    const viewerModule = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'pdfjs', 'pdf_viewer.mjs')
    );
    const wasmUrl = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'pdfjs', 'wasm')
    );
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'pdfViewer.js')
    );
    const style = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'pdfViewer.css')
    );
    const scriptNonce = nonce();
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${scriptNonce}' ${webview.cspSource}; worker-src blob: ${webview.cspSource}; connect-src ${webview.cspSource};" />
    <link rel="stylesheet" href="${style}" />
    <title>${escapeHtml(paper.title)}</title>
  </head>
  <body>
    <header>
      <strong title="${escapeHtml(paper.title)}">${escapeHtml(paper.title)}</strong>
      <div id="viewer-controls" aria-label="PDF controls">
        <button id="zoom-out" title="Zoom out" aria-label="Zoom out">−</button>
        <span id="zoom-label">100%</span>
        <button id="zoom-in" title="Zoom in" aria-label="Zoom in">+</button>
        <button id="fit-width" title="Fit page width" aria-label="Fit page width">Fit</button>
      </div>
      <span id="status">Loading…</span>
    </header>
    <main id="pages"></main>
    <button id="ask-pdf-selection" hidden>询问这段</button>
    <script nonce="${scriptNonce}">
      window.codeChasingPaper = ${JSON.stringify({
        hash: paper.hash,
        preview: this.preparedPreviews.get(paper.hash),
        pdfModule: pdfModule.toString(),
        workerModule: workerModule.toString(),
        viewerModule: viewerModule.toString(),
        wasmUrl: `${wasmUrl.toString()}/`
      })};
    </script>
    <script nonce="${scriptNonce}" type="module" src="${script}"></script>
  </body>
</html>`;
  }
}

function isNormalizedBox(value: unknown): value is NormalizedBox {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const box = value as Record<string, unknown>;
  return (
    ['x', 'y', 'width', 'height'].every(
      (key) => typeof box[key] === 'number' && Number.isFinite(box[key])
    ) &&
    Number(box.x) >= 0 &&
    Number(box.y) >= 0 &&
    Number(box.width) > 0 &&
    Number(box.height) > 0 &&
    Number(box.x) + Number(box.width) <= 1.01 &&
    Number(box.y) + Number(box.height) <= 1.01
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    const replacements: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    };
    return replacements[character] ?? character;
  });
}
