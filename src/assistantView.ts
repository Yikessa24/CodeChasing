import * as vscode from 'vscode';
import { abortable, throwIfAborted } from './cancellation.js';
import type {
  AssistantAnswer,
  ChatMessage,
  CodeContext,
  CodeSelectionReference,
  PaperCitation,
  PaperAttachmentReference,
  PaperMetadata,
  PersistentExample,
  ProviderConfig
} from './types.js';
import type { RepositoryIndexStatus } from './repositoryIndex.js';
import type { RenderedPaperPage } from './paperVision.js';

function nonce(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export interface AssistantHandlers {
  ask(text: string, quotedText?: string, quotedCitations?: PaperCitation[]): Promise<void>;
  importPaper(): Promise<void>;
  importDroppedPdf(fileName: string, base64: string): Promise<void>;
  cancelPaperAttachment(): Promise<void>;
  openPaper(): Promise<void>;
  configureProvider(): Promise<void>;
  configureReasoningEffort(): Promise<void>;
  testProvider(): Promise<void>;
  moveToRight(): Promise<void>;
  startWalkthrough(): Promise<void>;
  manageIndexes(): Promise<void>;
  openConversationHistory(): Promise<void>;
  indexWorkspace(): Promise<void>;
  openCallGraph(): Promise<void>;
  manageMappings(): Promise<void>;
  showPersistentExample(): Promise<void>;
  openEvidence(citation: {
    chunkId: string;
    paperHash?: string;
    page?: number;
    preview?: string;
    boxes?: Array<{ x: number; y: number; width: number; height: number }>;
  }): Promise<void>;
  openCode(filePath: string, startLine: number, endLine: number): Promise<void>;
  clearConversation(): Promise<void>;
  clearSelectedCode(): Promise<void>;
  cancelRequest(withdrawMessage: boolean): Promise<void>;
}

export class AssistantViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'codeChasing.assistant';
  private view: vscode.WebviewView | undefined;
  private currentPaper: PaperMetadata | undefined;
  private currentSymbolCount = 0;
  private currentIndexStatus: RepositoryIndexStatus = 'idle';
  private currentModel: ProviderConfig | undefined;
  private currentConversation: ChatMessage[] = [];
  private currentSelectedCode: CodeSelectionReference | undefined;
  private currentPersistentExample: PersistentExample | undefined;
  private currentMappingCount = 0;
  private paperAttachmentPending = false;
  private readonly pendingPaperPreviews = new Map<
    string,
    {
      resolve: (preview: { dataUrl: string; width: number; height: number }) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly pendingPageRenders = new Map<
    string,
    {
      resolve: (pages: RenderedPaperPage[]) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly handlers: AssistantHandlers
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        vscode.Uri.joinPath(this.context.extensionUri, 'dist')
      ]
    };
    webviewView.webview.html = this.html(webviewView.webview);
    webviewView.onDidDispose(() => {
      if (this.view !== webviewView) return;
      this.cancelPaperPreview();
      for (const pending of this.pendingPageRenders.values()) {
        clearTimeout(pending.timer);
        pending.reject(new DOMException('PDF panel was closed', 'AbortError'));
      }
      this.pendingPageRenders.clear();
      this.view = undefined;
    });
    webviewView.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!message || typeof message !== 'object') {
        return;
      }
      const data = message as Record<string, unknown>;
      try {
        switch (data.type) {
          case 'ready':
            this.setPaper(this.currentPaper);
            this.setIndexStatus(this.currentSymbolCount, this.currentIndexStatus);
            this.setModelStatus(this.currentModel);
            this.setConversation(this.currentConversation);
            this.setPersistentExample(this.currentPersistentExample);
            this.setMappingCount(this.currentMappingCount);
            void this.view?.webview.postMessage({
              type: 'selectedCode',
              selection: this.currentSelectedCode
            });
            break;
          case 'ask':
            if (typeof data.text === 'string' && data.text.trim()) {
              await this.handlers.ask(
                data.text.trim(),
                typeof data.quotedText === 'string' ? data.quotedText.trim().slice(0, 4000) : undefined,
                Array.isArray(data.quotedCitations)
                  ? (data.quotedCitations as PaperCitation[]).filter(
                      (citation) =>
                        citation &&
                        typeof citation.chunkId === 'string' &&
                        typeof citation.page === 'number' &&
                        typeof citation.preview === 'string'
                    )
                  : undefined
              );
            }
            break;
          case 'importPaper':
            await this.handlers.importPaper();
            break;
          case 'dropPdf':
            if (typeof data.fileName === 'string' && typeof data.base64 === 'string') {
              await this.handlers.importDroppedPdf(data.fileName, data.base64);
            }
            break;
          case 'cancelPaperAttachment':
            await this.handlers.cancelPaperAttachment();
            break;
          case 'paperPreviewReady':
            if (
              typeof data.hash === 'string' &&
              typeof data.dataUrl === 'string' &&
              typeof data.width === 'number' &&
              typeof data.height === 'number'
            ) {
              const pending = this.pendingPaperPreviews.get(data.hash);
              if (pending) {
                clearTimeout(pending.timer);
                this.pendingPaperPreviews.delete(data.hash);
                pending.resolve({ dataUrl: data.dataUrl, width: data.width, height: data.height });
              }
            }
            break;
          case 'paperPreviewFailed':
            if (typeof data.hash === 'string') {
              const pending = this.pendingPaperPreviews.get(data.hash);
              if (pending) {
                clearTimeout(pending.timer);
                this.pendingPaperPreviews.delete(data.hash);
                pending.reject(
                  new Error(typeof data.message === 'string' ? data.message : 'PDF preview failed')
                );
              }
            }
            break;
          case 'paperPageImagesReady':
            if (typeof data.requestId === 'string' && Array.isArray(data.pages)) {
              const pending = this.pendingPageRenders.get(data.requestId);
              if (pending) {
                clearTimeout(pending.timer);
                this.pendingPageRenders.delete(data.requestId);
                pending.resolve(data.pages.filter(isRenderedPaperPage));
              }
            }
            break;
          case 'paperPageImagesFailed':
            if (typeof data.requestId === 'string') {
              const pending = this.pendingPageRenders.get(data.requestId);
              if (pending) {
                clearTimeout(pending.timer);
                this.pendingPageRenders.delete(data.requestId);
                pending.reject(
                  new Error(
                    typeof data.message === 'string'
                      ? data.message
                      : 'PDF page rendering failed'
                  )
                );
              }
            }
            break;
          case 'openPaper':
            await this.handlers.openPaper();
            break;
          case 'configureProvider':
            await this.handlers.configureProvider();
            break;
          case 'configureReasoningEffort':
            await this.handlers.configureReasoningEffort();
            break;
          case 'testProvider':
            await this.handlers.testProvider();
            break;
          case 'moveToRight':
            await this.handlers.moveToRight();
            break;
          case 'startWalkthrough':
            await this.handlers.startWalkthrough();
            break;
          case 'manageIndexes':
            await this.handlers.manageIndexes();
            break;
          case 'openConversationHistory':
            await this.handlers.openConversationHistory();
            break;
          case 'indexWorkspace':
            await this.handlers.indexWorkspace();
            break;
          case 'openCallGraph':
            await this.handlers.openCallGraph();
            break;
          case 'manageMappings':
            await this.handlers.manageMappings();
            break;
          case 'showPersistentExample':
            await this.handlers.showPersistentExample();
            break;
          case 'clearConversation':
            await this.handlers.clearConversation();
            break;
          case 'clearSelectedCode':
            await this.handlers.clearSelectedCode();
            break;
          case 'cancelRequest':
            await this.handlers.cancelRequest(Boolean(data.withdrawMessage));
            break;
          case 'openEvidence':
            if (data.citation && typeof data.citation === 'object') {
              const citation = data.citation as Record<string, unknown>;
              if (typeof citation.chunkId === 'string') {
                await this.handlers.openEvidence({
                  chunkId: citation.chunkId,
                  paperHash: typeof citation.paperHash === 'string' ? citation.paperHash : undefined,
                  page: typeof citation.page === 'number' ? citation.page : undefined,
                  preview: typeof citation.preview === 'string' ? citation.preview : undefined,
                  boxes: Array.isArray(citation.boxes)
                    ? citation.boxes.filter(
                        (box): box is { x: number; y: number; width: number; height: number } =>
                          Boolean(
                            box &&
                              typeof box === 'object' &&
                              typeof (box as Record<string, unknown>).x === 'number' &&
                              typeof (box as Record<string, unknown>).y === 'number' &&
                              typeof (box as Record<string, unknown>).width === 'number' &&
                              typeof (box as Record<string, unknown>).height === 'number'
                          )
                      )
                    : undefined
                });
              }
            } else if (typeof data.chunkId === 'string') {
              await this.handlers.openEvidence({ chunkId: data.chunkId });
            }
            break;
          case 'openCode':
            if (typeof data.filePath === 'string') {
              await this.handlers.openCode(
                data.filePath,
                Number(data.startLine),
                Number(data.endLine)
              );
            }
            break;
        }
      } catch (error) {
        this.showError(error instanceof Error ? error.message : String(error));
      }
    });
  }

  public async reveal(): Promise<void> {
    await vscode.commands.executeCommand('workbench.view.extension.codeChasing');
  }

  public setPaper(paper: PaperMetadata | undefined, attachmentPending?: boolean): void {
    this.currentPaper = paper;
    if (attachmentPending !== undefined) {
      this.paperAttachmentPending = attachmentPending;
    } else if (!paper) {
      this.paperAttachmentPending = false;
    }
    void this.view?.webview.postMessage({
      type: 'paperStatus',
      paper: paper
        ? {
            hash: paper.hash,
            title: paper.title,
            pageCount: paper.pageCount,
            ocrPageCount: paper.ocrPageCount,
            visualPageCount: paper.visualPageCount,
            extractionStatus: paper.extractionStatus,
            attachmentPending: this.paperAttachmentPending
          }
        : undefined
    });
  }

  public setPaperIndexProgress(hash: string, page: number, pageCount: number): void {
    void this.view?.webview.postMessage({ type: 'paperIndexProgress', hash, page, pageCount });
  }

  public setPaperVisionProgress(
    hash: string,
    completed: number,
    total: number,
    mode: 'ocr' | 'visual'
  ): void {
    void this.view?.webview.postMessage({
      type: 'paperVisionProgress',
      hash,
      completed,
      total,
      mode
    });
  }

  public beginPaperAttachment(title: string): void {
    this.paperAttachmentPending = true;
    void this.view?.webview.postMessage({ type: 'paperAttachmentStart', title });
  }

  public setPaperViewerStatus(status: 'loading' | 'ready' | 'failed'): void {
    void this.view?.webview.postMessage({ type: 'paperViewerStatus', status });
  }

  public async preparePaperPreview(
    paper: PaperMetadata,
    bytes: Uint8Array
  ): Promise<{ dataUrl: string; width: number; height: number }> {
    if (!this.view) {
      throw new Error('The CodeChasing panel must be open to prepare the PDF preview.');
    }
    const previous = this.pendingPaperPreviews.get(paper.hash);
    if (previous) {
      clearTimeout(previous.timer);
      previous.reject(new Error('PDF preview preparation was replaced.'));
      this.pendingPaperPreviews.delete(paper.hash);
    }
    const webview = this.view.webview;
    const pdfModule = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'pdfjs', 'pdf.mjs')
    );
    const workerModule = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'pdfjs', 'pdf.worker.mjs')
    );
    const wasmUrl = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'pdfjs', 'wasm')
    );
    const encoded = Buffer.from(bytes).toString('base64');
    const chunkSize = 512 * 1024;
    const chunkCount = Math.ceil(encoded.length / chunkSize);
    const result = new Promise<{ dataUrl: string; width: number; height: number }>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingPaperPreviews.delete(paper.hash);
          reject(new Error('Background PDF preview preparation timed out.'));
        }, 120_000);
        this.pendingPaperPreviews.set(paper.hash, { resolve, reject, timer });
      }
    );
    const pending = this.pendingPaperPreviews.get(paper.hash);
    void (async () => {
      const delivered = await webview.postMessage({
        type: 'paperPreviewStart',
        hash: paper.hash,
        pdfModule: pdfModule.toString(),
        workerModule: workerModule.toString(),
        wasmUrl: `${wasmUrl.toString()}/`,
        chunkCount
      });
      if (!delivered) throw new Error('PDF renderer is no longer available.');
      for (let index = 0; index < chunkCount; index += 1) {
        if (this.pendingPaperPreviews.get(paper.hash) !== pending) return;
        const received = await webview.postMessage({
          type: 'paperPreviewChunk',
          hash: paper.hash,
          index,
          data: encoded.slice(index * chunkSize, (index + 1) * chunkSize)
        });
        if (!received) throw new Error('PDF renderer is no longer available.');
      }
      if (this.pendingPaperPreviews.get(paper.hash) !== pending) return;
      if (!await webview.postMessage({ type: 'paperPreviewEnd', hash: paper.hash })) {
        throw new Error('PDF renderer is no longer available.');
      }
    })().catch((error: Error) => {
      if (pending && this.pendingPaperPreviews.get(paper.hash) === pending) {
        clearTimeout(pending.timer);
        this.pendingPaperPreviews.delete(paper.hash);
        pending.reject(error);
      }
    });
    return result;
  }

  public cancelPaperPreview(hash?: string): void {
    const targets = hash ? [hash] : [...this.pendingPaperPreviews.keys()];
    for (const target of targets) {
      const pending = this.pendingPaperPreviews.get(target);
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error('PDF preview preparation was cancelled.'));
        this.pendingPaperPreviews.delete(target);
      }
    }
    void this.view?.webview.postMessage({ type: 'cancelPaperPreview', hash });
  }

  public async renderPaperPages(
    paper: PaperMetadata,
    pages: number[],
    options: { scale?: number; quality?: number; signal?: AbortSignal } = {}
  ): Promise<RenderedPaperPage[]> {
    throwIfAborted(options.signal);
    if (!this.view) {
      throw new Error('Open the CodeChasing panel before rendering PDF pages for OCR or vision.');
    }
    const uniquePages = [...new Set(
      pages.map((page) => Math.floor(page)).filter((page) => page > 0)
    )];
    if (!uniquePages.length) return [];
    const requestId = nonce();
    const webview = this.view.webview;
    const cancel = (error: Error) => {
      const pending = this.pendingPageRenders.get(requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingPageRenders.delete(requestId);
      pending.reject(error);
      void webview.postMessage({ type: 'cancelPaperPageImages', requestId });
    };
    return abortable(() => new Promise<RenderedPaperPage[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        cancel(new Error('PDF page rendering timed out.'));
      }, 180_000);
      this.pendingPageRenders.set(requestId, { resolve, reject, timer });
      Promise.resolve(webview.postMessage({
        type: 'paperPageImagesRequest',
        requestId,
        hash: paper.hash,
        pages: uniquePages,
        scale: Math.max(1, Math.min(2.5, options.scale ?? 1.65)),
        quality: Math.max(0.55, Math.min(0.95, options.quality ?? 0.86))
      })).then((delivered) => {
        if (!delivered) cancel(new Error('PDF renderer is no longer available.'));
      }, (error: Error) => cancel(error));
    }), options.signal, () => cancel(new DOMException('Aborted', 'AbortError')));
  }

  public setIndexStatus(
    symbolCount: number,
    status: RepositoryIndexStatus = symbolCount > 0 ? 'ready' : 'idle'
  ): void {
    this.currentSymbolCount = symbolCount;
    this.currentIndexStatus = status;
    void this.view?.webview.postMessage({ type: 'indexStatus', symbolCount, status });
  }

  public setModelStatus(configuration: ProviderConfig | undefined): void {
    this.currentModel = configuration;
    let insecureTransport = false;
    if (configuration) {
      try {
        const url = new URL(configuration.baseUrl);
        insecureTransport =
          url.protocol === 'http:' &&
          !['localhost', '127.0.0.1', '::1'].includes(url.hostname);
      } catch {
        // Invalid URLs are reported when the provider is used.
      }
    }
    void this.view?.webview.postMessage({
      type: 'modelStatus',
      model: configuration
        ? {
            provider: configuration.provider,
            name: configuration.model,
            reasoningEffort: configuration.reasoningEffort,
            insecureTransport
          }
        : undefined
    });
  }

  public setPersistentExample(example?: PersistentExample): void {
    this.currentPersistentExample = example;
    void this.view?.webview.postMessage({
      type: 'persistentExampleStatus',
      example: example ? { title: example.title, steps: example.trace.length } : undefined
    });
  }

  public setMappingCount(count: number): void {
    this.currentMappingCount = count;
    void this.view?.webview.postMessage({ type: 'mappingStatus', count });
  }

  public setBusy(busy: boolean, label?: string, cancellable = false): void {
    void this.view?.webview.postMessage({ type: 'busy', busy, label, cancellable });
  }

  public addUserMessage(
    text: string,
    quotedText?: string,
    codeSelection?: CodeSelectionReference,
    paperAttachment?: PaperAttachmentReference
  ): void {
    void this.view?.webview.postMessage({
      type: 'userMessage',
      text,
      quotedText,
      codeSelection,
      paperAttachment,
      pending: true
    });
  }

  public async attachSelectedCode(context: CodeContext): Promise<void> {
    this.currentSelectedCode = {
      filePath: context.filePath,
      startLine: context.startLine,
      endLine: context.endLine,
      preview: context.text.replace(/\s+/g, ' ').slice(0, 260)
    };
    await this.reveal();
    void this.view?.webview.postMessage({
      type: 'selectedCode',
      selection: this.currentSelectedCode
    });
  }

  public async attachPaperSelection(text: string, citations: PaperCitation[]): Promise<void> {
    await this.reveal();
    void this.view?.webview.postMessage({
      type: 'paperSelection',
      text: text.trim().slice(0, 4000),
      citations
    });
  }

  public clearAttachedCode(): void {
    this.currentSelectedCode = undefined;
    void this.view?.webview.postMessage({ type: 'selectedCode', selection: undefined });
  }

  public showAnswer(answer: AssistantAnswer): void {
    void this.view?.webview.postMessage({ type: 'answer', answer });
  }

  public startStreamingAnswer(): void {
    void this.view?.webview.postMessage({ type: 'streamStart' });
  }

  public appendStreamingAnswer(delta: string): void {
    void this.view?.webview.postMessage({ type: 'streamDelta', delta });
  }

  public finishStreamingAnswer(answer: AssistantAnswer): void {
    void this.view?.webview.postMessage({ type: 'streamEnd', answer });
  }

  public setConversation(messages: ChatMessage[], render = true): void {
    this.currentConversation = messages;
    if (render) {
      void this.view?.webview.postMessage({ type: 'restoreConversation', messages });
    }
  }

  public showError(message: string): void {
    void this.view?.webview.postMessage({ type: 'error', message });
  }

  public clearMessages(): void {
    void this.view?.webview.postMessage({ type: 'clearMessages' });
  }

  public cancelPendingMessage(): void {
    void this.view?.webview.postMessage({ type: 'cancelPendingMessage' });
  }

  public finalizePendingMessage(): void {
    void this.view?.webview.postMessage({ type: 'finalizePendingMessage' });
  }

  private html(webview: vscode.Webview): string {
    const scriptNonce = nonce();
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'assistant.js')
    );
    const style = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'assistant.css')
    );
    const katexScript = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'katex', 'katex.min.js')
    );
    const katexStyle = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'katex', 'katex.min.css')
    );
    return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${scriptNonce}' ${webview.cspSource}; worker-src blob: ${webview.cspSource};" />
    <link rel="stylesheet" href="${katexStyle}" />
    <link rel="stylesheet" href="${style}" />
    <title>CodeChasing</title>
  </head>
  <body>
    <main id="messages" aria-live="polite">
      <section id="empty-state">
        <h1>你好，想聊些什么？</h1>
        <p>可以直接聊天，也可以导入论文或选择代码进行联合分析</p>
      </section>
    </main>
    <footer>
      <section id="context-popover" hidden>
        <div><span class="status-label">Paper</span><span id="paper-status">Not imported</span></div>
        <div><span class="status-label">Code</span><span id="index-status">Not scanned</span></div>
        <div><span class="status-label">Model</span><span id="model-status">Not configured</span></div>
        <div><span class="status-label">Mappings</span><span id="mapping-status">0 candidates</span></div>
        <div><span class="status-label">Example</span><span id="example-status">Not established</span></div>
      </section>
      <div id="paper-attachment" hidden>
        <div class="paper-file-icon" aria-hidden="true"><span>PDF</span></div>
        <div class="paper-attachment-copy">
          <strong id="paper-attachment-title"></strong>
          <span id="paper-attachment-state"></span>
        </div>
        <div id="paper-attachment-progress" class="paper-progress" role="progressbar" aria-label="Preparing PDF"></div>
        <button id="cancel-paper-attachment" title="Cancel and remove PDF" aria-label="Cancel and remove PDF">×</button>
      </div>
      <div id="selection-context" hidden>
        <div><strong>Selected context</strong><span id="selection-preview"></span></div>
        <button id="clear-selection" title="Remove selected context" aria-label="Remove selected context">×</button>
      </div>
      <div id="code-context" hidden>
        <div><strong>Selected code</strong><span id="code-preview"></span></div>
        <button id="clear-code" title="Remove selected code" aria-label="Remove selected code">×</button>
      </div>
      <textarea id="prompt" rows="4" placeholder="例如：这个函数对应论文中的哪一步？"></textarea>
      <div class="send-row">
        <span id="busy-label"></span>
        <div class="request-actions">
          <button id="stop" class="stop" hidden aria-label="Stop generating">■ Stop</button>
          <button id="send" class="primary">Send</button>
        </div>
      </div>
      <div class="composer-toolbar" aria-label="CodeChasing tools">
        <button id="context-toggle" class="icon-button" title="Context status" aria-label="Context status" aria-expanded="false">ⓘ</button>
        <button class="icon-button" data-action="startWalkthrough" title="按流程讲解论文与代码" aria-label="按流程讲解论文与代码">▶</button>
        <button class="icon-button" data-action="importPaper" title="Import PDF" aria-label="Import PDF">+</button>
        <button class="icon-button" data-action="openPaper" title="Open paper" aria-label="Open paper">▤</button>
        <button class="icon-button" data-action="indexWorkspace" title="Scan code structure" aria-label="Scan code structure">⌕</button>
        <button class="icon-button" data-action="openCallGraph" title="Open project call graph" aria-label="Open project call graph">⑂</button>
        <button class="icon-button" data-action="manageMappings" title="Review paper-code mappings" aria-label="Review paper-code mappings">↔</button>
        <button class="icon-button" data-action="showPersistentExample" title="View running example and tensor trace" aria-label="View running example and tensor trace">◇</button>
        <button class="icon-button" data-action="configureProvider" title="Configure model" aria-label="Configure model">⚙</button>
        <button class="icon-button" data-action="testProvider" title="Test model connection" aria-label="Test model connection">✓</button>
        <button id="reasoning-button" class="icon-button reasoning-button" data-action="configureReasoningEffort" title="Change reasoning effort" aria-label="Change reasoning effort">◉ <span id="reasoning-label">Auto</span></button>
        <button class="icon-button" data-action="manageIndexes" title="Manage paper and code indexes" aria-label="Manage indexes">⋯</button>
        <button class="icon-button" data-action="moveToRight" title="Move CodeChasing to the right side" aria-label="Move CodeChasing to the right side">⇥</button>
        <button class="icon-button" data-action="openConversationHistory" title="Conversation history" aria-label="Conversation history">◷</button>
        <button class="icon-button" data-action="clearConversation" title="New chat" aria-label="New chat">↻</button>
        <span class="keyboard-hint">Enter send · Shift+Enter newline</span>
      </div>
    </footer>
    <button id="ask-selection" hidden>询问这段</button>
    <div id="drop-overlay" aria-hidden="true"><strong>Drop PDF to import</strong></div>
    <script nonce="${scriptNonce}" src="${katexScript}"></script>
    <script nonce="${scriptNonce}" src="${script}"></script>
  </body>
</html>`;
  }
}

function isRenderedPaperPage(value: unknown): value is RenderedPaperPage {
  if (!value || typeof value !== 'object') return false;
  const page = value as Record<string, unknown>;
  return (
    typeof page.page === 'number' &&
    Number.isInteger(page.page) &&
    page.page > 0 &&
    typeof page.width === 'number' &&
    page.width > 0 &&
    typeof page.height === 'number' &&
    page.height > 0 &&
    typeof page.dataUrl === 'string' &&
    /^data:image\/(?:jpeg|png|webp);base64,/.test(page.dataUrl) &&
    (page.mimeType === 'image/jpeg' || page.mimeType === 'image/png' || page.mimeType === 'image/webp') &&
    typeof page.label === 'string'
  );
}
