import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { PaperChunk, PaperMetadata, PaperRecord } from './types.js';

const CURRENT_PAPER_KEY = 'codeChasing.currentPaper';
export const PAPER_INDEX_VERSION = 8;

export class PaperStore {
  private readonly papersDirectory: vscode.Uri;

  public constructor(private readonly context: vscode.ExtensionContext) {
    const baseDirectory = context.storageUri ?? context.globalStorageUri;
    this.papersDirectory = vscode.Uri.joinPath(baseDirectory, 'papers');
  }

  public async importPaper(source: vscode.Uri): Promise<PaperMetadata> {
    const bytes = await vscode.workspace.fs.readFile(source);
    return this.importBytes(path.basename(source.fsPath), bytes, source.toString());
  }

  public async importBytes(
    fileName: string,
    bytes: Uint8Array,
    sourceUri = `dropped:${fileName}`
  ): Promise<PaperMetadata> {
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    await vscode.workspace.fs.createDirectory(this.papersDirectory);

    const existing = await this.readRecord(hash);
    if (existing?.metadata.extractionStatus === 'ready') {
      await this.context.workspaceState.update(CURRENT_PAPER_KEY, hash);
      return existing.metadata;
    }

    const paperDirectory = vscode.Uri.joinPath(this.papersDirectory, hash);
    await vscode.workspace.fs.createDirectory(paperDirectory);
    const storedPdf = vscode.Uri.joinPath(paperDirectory, 'paper.pdf');
    await vscode.workspace.fs.writeFile(storedPdf, bytes);

    const metadata: PaperMetadata = {
      hash,
      title: path.basename(fileName, path.extname(fileName)),
      sourceUri,
      storedPdfUri: storedPdf.toString(),
      importedAt: new Date().toISOString(),
      extractionStatus: 'pending',
      indexVersion: PAPER_INDEX_VERSION
    };

    await this.writeRecord({ metadata, chunks: [] });
    await this.context.workspaceState.update(CURRENT_PAPER_KEY, hash);
    return metadata;
  }

  public async getCurrent(): Promise<PaperRecord | undefined> {
    const hash = this.context.workspaceState.get<string>(CURRENT_PAPER_KEY);
    if (!hash) {
      return undefined;
    }
    return this.readRecord(hash);
  }

  public async getByHash(hash: string): Promise<PaperRecord | undefined> {
    return this.readRecord(hash);
  }

  public async selectCurrent(hash?: string): Promise<void> {
    await this.context.workspaceState.update(CURRENT_PAPER_KEY, hash);
  }

  public async saveExtraction(
    hash: string,
    pageCount: number,
    chunks: PaperChunk[],
    visionModelSignature?: string
  ): Promise<PaperRecord | undefined> {
    const record = await this.readRecord(hash);
    if (!record) {
      return undefined;
    }

    record.metadata.pageCount = pageCount;
    record.metadata.extractionStatus = 'ready';
    record.metadata.indexVersion = PAPER_INDEX_VERSION;
    record.chunks = chunks;
    record.metadata.visionModelSignature = chunks.some(
      (chunk) => chunk.source === 'ocr' || chunk.source === 'vision'
    )
      ? visionModelSignature
      : undefined;
    this.updateDerivedMetadata(record);
    await this.writeRecord(record);
    return record;
  }

  public async appendChunks(
    hash: string,
    chunks: PaperChunk[],
    visionModelSignature?: string
  ): Promise<PaperRecord | undefined> {
    const record = await this.readRecord(hash);
    if (!record) return undefined;
    const merged = new Map(record.chunks.map((chunk) => [chunk.id, chunk]));
    for (const chunk of chunks) merged.set(chunk.id, chunk);
    record.chunks = [...merged.values()].sort((left, right) => left.page - right.page);
    if (chunks.some((chunk) => chunk.source === 'ocr' || chunk.source === 'vision')) {
      record.metadata.visionModelSignature = visionModelSignature;
    }
    this.updateDerivedMetadata(record);
    await this.writeRecord(record);
    return record;
  }

  public async markExtractionFailed(hash: string): Promise<void> {
    const record = await this.readRecord(hash);
    if (!record) {
      return;
    }
    record.metadata.extractionStatus = 'failed';
    await this.writeRecord(record);
  }

  public async resetExtraction(hash: string): Promise<PaperMetadata | undefined> {
    const record = await this.readRecord(hash);
    if (!record) {
      return undefined;
    }
    record.metadata.extractionStatus = 'pending';
    record.metadata.pageCount = undefined;
    record.metadata.ocrPageCount = undefined;
    record.metadata.visualPageCount = undefined;
    record.metadata.visionModelSignature = undefined;
    record.chunks = [];
    await this.writeRecord(record);
    return record.metadata;
  }

  public async invalidateModelAssistedChunks(hash: string): Promise<PaperRecord | undefined> {
    const record = await this.readRecord(hash);
    if (!record) return undefined;
    record.chunks = record.chunks.filter(
      (chunk) => chunk.source !== 'ocr' && chunk.source !== 'vision'
    );
    record.metadata.visionModelSignature = undefined;
    record.metadata.ocrPageCount = undefined;
    record.metadata.visualPageCount = undefined;
    record.metadata.extractionStatus = record.chunks.length ? 'ready' : 'pending';
    await this.writeRecord(record);
    return record;
  }

  public async markExtractionPaused(hash: string): Promise<PaperMetadata | undefined> {
    const record = await this.readRecord(hash);
    if (!record) {
      return undefined;
    }
    record.metadata.extractionStatus = 'paused';
    await this.writeRecord(record);
    return record.metadata;
  }

  public async removeCurrent(): Promise<void> {
    await this.context.workspaceState.update(CURRENT_PAPER_KEY, undefined);
  }

  private recordUri(hash: string): vscode.Uri {
    return vscode.Uri.joinPath(this.papersDirectory, hash, 'record.json');
  }

  private async readRecord(hash: string): Promise<PaperRecord | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.recordUri(hash));
      const record = JSON.parse(new TextDecoder().decode(bytes)) as PaperRecord;
      if (record.metadata.indexVersion !== PAPER_INDEX_VERSION) {
        record.metadata.indexVersion = PAPER_INDEX_VERSION;
        record.metadata.extractionStatus = 'pending';
        record.metadata.pageCount = undefined;
        record.metadata.ocrPageCount = undefined;
        record.metadata.visualPageCount = undefined;
        record.metadata.visionModelSignature = undefined;
        record.chunks = [];
        await this.writeRecord(record);
      }
      return record;
    } catch {
      return undefined;
    }
  }

  private async writeRecord(record: PaperRecord): Promise<void> {
    const paperDirectory = vscode.Uri.joinPath(this.papersDirectory, record.metadata.hash);
    await vscode.workspace.fs.createDirectory(paperDirectory);
    const bytes = new TextEncoder().encode(JSON.stringify(record));
    await vscode.workspace.fs.writeFile(this.recordUri(record.metadata.hash), bytes);
  }

  private updateDerivedMetadata(record: PaperRecord): void {
    record.metadata.ocrPageCount = new Set(
      record.chunks.filter((chunk) => chunk.source === 'ocr').map((chunk) => chunk.page)
    ).size;
    record.metadata.visualPageCount = new Set(
      record.chunks.filter((chunk) => chunk.source === 'vision').map((chunk) => chunk.page)
    ).size;
  }
}
