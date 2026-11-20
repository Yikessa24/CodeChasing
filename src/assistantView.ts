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
  importDroppedPdfPath(uri: string): Promise<void>;
  cancelPaperAttachment(): Promise<void>;
  openPaper(): Promise<void>;
  configureProvider(): Promise<void>;
  configureModel(): Promise<void>;
  testProvider(): Promise<void>;
  moveToRight(): Promise<void>;
  startWalkthrough(): Promise<void>;
  manageIndexes(): Promise<void>;
  openConversationHistory(): Promise<void>;
  indexWorkspace(): Promise<void>;
  openCallGraph(): Promise<void>;
  manageMappings(): Promise<void>;
  showPersistentExample(): Promise<void>;
  resetPersistentExample(): Promise<void>;
  pdfAssetBase(): string | undefined;
  registerPaperAsset(paper: PaperMetadata): void;
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
  private currentModelLabel: string | undefined;
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
            this.setModelStatus(this.currentModel, this.currentModelLabel);
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
          case 'dropPdfPath':
            if (typeof data.uri === 'string' && data.uri.trim()) {
              await this.handlers.importDroppedPdfPath(data.uri.trim());
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
          case 'configureModel':
            await this.handlers.configureModel();
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
          case 'resetPersistentExample':
            await this.handlers.resetPersistentExample();
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
    const assetBase = this.handlers.pdfAssetBase();
    this.handlers.registerPaperAsset(paper);
    const pdfModule = assetBase
      ? `${assetBase}/lib/pdf.mjs`
      : webview
          .asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'pdfjs', 'pdf.mjs'))
          .toString();
    const workerModule = assetBase
      ? `${assetBase}/lib/pdf.worker.mjs`
      : webview
          .asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'pdfjs', 'pdf.worker.mjs')
          )
          .toString();
    const wasmUrl = assetBase
      ? `${assetBase}/wasm/`
      : `${webview
          .asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'pdfjs', 'wasm'))
          .toString()}/`;
    const pdfUrl = assetBase ? `${assetBase}/pdf/${paper.hash}` : undefined;
    const encoded = pdfUrl ? '' : Buffer.from(bytes).toString('base64');
    const chunkSize = 512 * 1024;
    const chunkCount = pdfUrl ? 0 : Math.ceil(encoded.length / chunkSize);
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
        pdfModule,
        workerModule,
        wasmUrl,
        pdfUrl,
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

  public setModelStatus(
    configuration: ProviderConfig | undefined,
    displayName?: string
  ): void {
    this.currentModel = configuration;
    this.currentModelLabel = configuration ? displayName : undefined;
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
            label: displayName ?? configuration.model,
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

  public showPersistentExample(example: PersistentExample): void {
    void this.view?.webview.postMessage({ type: 'persistentExample', example });
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
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${scriptNonce}' ${webview.cspSource} http://127.0.0.1:*; worker-src blob: ${webview.cspSource} http://127.0.0.1:*; connect-src ${webview.cspSource} http://127.0.0.1:*;" />
    <link rel="stylesheet" href="${katexStyle}" />
    <link rel="stylesheet" href="${style}?v=${scriptNonce}" />
    <title>CodeChasing</title>
  </head>
  <body>
    <main id="messages" aria-live="polite">
      <section id="empty-state">
        <h1>论文 ↔ 代码，互相作证</h1>
        <p class="empty-problem">论文里的方法对应代码哪一段？这段代码又对应论文哪个公式？这里每个回答都带可点击的论文页码与代码行出处。</p>
        <button class="primary empty-cta" data-action="startWalkthrough">▶ 从论文到代码，一键精读</button>
        <p class="empty-steps">
          <button class="empty-step" id="empty-step-paper" data-action="importPaper">① + 导入论文 PDF</button>
          <span class="empty-step-arrow">→</span>
          <button class="empty-step" id="empty-step-code" data-action="indexWorkspace">② ⌕ 扫描代码</button>
          <span class="empty-step-arrow">→</span>
          <span class="empty-step">③ 提问或一键精读</span>
        </p>
        <p class="empty-cta-note" id="empty-cta-note" hidden>论文与代码已就绪，可以开始。</p>
        <button class="empty-sample" id="empty-sample" hidden>问：这篇论文的核心方法对应仓库哪些代码？</button>
        <p class="empty-alt">也可以直接聊天，或在编辑器选中代码后右键提问。</p>
      </section>
    </main>
    <footer>
      <section id="context-popover" hidden>
        <div><span class="status-label">论文</span><span id="paper-status">未导入</span></div>
        <div><span class="status-label">代码</span><span id="index-status">未扫描</span></div>
        <div><span class="status-label">模型</span><span id="model-status">未配置</span></div>
        <div><span class="status-label">对应关系</span><span id="mapping-status">0 条</span></div>
        <div><span class="status-label">贯穿样例</span><span id="example-status">未建立</span></div>
      </section>
      <div id="paper-attachment" hidden>
        <div class="paper-file-icon" aria-hidden="true"><span>PDF</span></div>
        <div class="paper-attachment-copy">
          <strong id="paper-attachment-title"></strong>
          <span id="paper-attachment-state"></span>
        </div>
        <div id="paper-attachment-progress" class="paper-progress" role="progressbar" aria-label="正在准备 PDF"></div>
        <button id="cancel-paper-attachment" title="取消准备并移除这篇 PDF" aria-label="取消准备并移除这篇 PDF">×</button>
      </div>
      <div id="selection-context" hidden>
        <div><strong>划选上下文</strong><span id="selection-preview"></span></div>
        <button id="clear-selection" title="移除划选上下文" aria-label="移除划选上下文">×</button>
      </div>
      <div id="code-context" hidden>
        <div><strong>选中代码</strong><span id="code-preview"></span></div>
        <button id="clear-code" title="移除选中代码" aria-label="移除选中代码">×</button>
      </div>
      <textarea id="prompt" rows="4" placeholder="例如：这个函数对应论文中的哪一步？"></textarea>
      <div class="send-row">
        <span id="busy-label"></span>
        <div class="request-actions">
          <button id="stop" class="stop" hidden aria-label="停止生成">■ 停止</button>
          <button id="send" class="primary">发送</button>
        </div>
      </div>
      <div class="composer-toolbar" aria-label="CodeChasing 工具">
        <button id="context-toggle" class="icon-button" title="上下文状态：论文 / 代码 / 模型 / 对应关系 / 样例" aria-label="上下文状态" aria-expanded="false">ⓘ</button>
        <span class="toolbar-divider" aria-hidden="true"></span>
        <button class="icon-button core-action" data-action="startWalkthrough" title="按流程讲解论文与代码" aria-label="按流程讲解论文与代码">▶ <span>精读</span></button>
        <button class="icon-button core-action" data-action="manageMappings" title="查看与审核论文↔代码对应关系" aria-label="查看与审核论文↔代码对应关系">↔ <span>对应</span></button>
        <button class="icon-button core-action" data-action="showPersistentExample" title="查看贯穿样例与张量形状追踪" aria-label="查看贯穿样例与张量形状追踪">◇ <span>样例</span></button>
        <span class="toolbar-divider" aria-hidden="true"></span>
        <button class="icon-button" data-action="importPaper" title="导入论文 PDF" aria-label="导入论文 PDF">+</button>
        <button class="icon-button" data-action="openPaper" title="打开论文阅读器" aria-label="打开论文阅读器">▤</button>
        <button class="icon-button" data-action="indexWorkspace" title="扫描代码结构" aria-label="扫描代码结构">⌕</button>
        <button class="icon-button" data-action="openCallGraph" title="打开项目调用图（模型判断核心函数）" aria-label="打开项目调用图">⑂</button>
        <button class="icon-button" data-action="configureProvider" title="配置模型提供商与 API key" aria-label="配置模型提供商">⚙</button>
        <button class="icon-button" data-action="testProvider" title="测试模型连接" aria-label="测试模型连接">✓</button>
        <button id="model-button" class="icon-button model-button" data-action="configureModel" title="切换模型与推理强度" aria-label="切换模型与推理强度">▣ <span id="model-label">…</span></button>
        <button class="icon-button" data-action="manageIndexes" title="管理论文与代码索引" aria-label="管理索引">⋯</button>
        <button class="icon-button" data-action="moveToRight" title="把 CodeChasing 移到右侧副侧边栏" aria-label="移到右侧">⇥</button>
        <button class="icon-button" data-action="openConversationHistory" title="历史对话：选择并继续之前的对话" aria-label="历史对话">◷</button>
        <button class="icon-button" data-action="clearConversation" title="新对话（当前对话会自动存入历史）" aria-label="新对话">↻</button>
        <span class="keyboard-hint">Enter 发送 · Shift+Enter 换行</span>
      </div>
    </footer>
    <button id="ask-selection" hidden>询问这段</button>
    <div id="drop-overlay" aria-hidden="true"><strong>松开导入这篇 PDF</strong></div>
    <script nonce="${scriptNonce}" src="${katexScript}"></script>
    <script nonce="${scriptNonce}" src="${script}?v=${scriptNonce}"></script>
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
