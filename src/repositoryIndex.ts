import * as path from 'node:path';
import * as vscode from 'vscode';
import { findTextLineMatches } from './agenticExploration.js';
import { buildStaticCallGraph, sliceCallGraph, type StaticCallSymbol } from './callGraphAnalysis.js';
import type { CallGraph, CodeContext } from './types.js';
import { compactWhitespace } from './retrieval.js';
import { isSensitiveWorkspacePath } from './workspaceSafety.js';

interface SymbolRecord {
  uri: vscode.Uri;
  name: string;
  containerName?: string;
  kind: vscode.SymbolKind;
  range: vscode.Range;
  languageId: string;
}

const SOURCE_GLOB = '**/*.{py,pyi,ts,tsx,js,jsx,mjs,cjs,java,go,rs,c,cc,cpp,h,hpp}';
const EXCLUDE_GLOB = '{**/{node_modules,.git,dist,out,build,.venv,venv,__pycache__,target,.ssh,.gnupg,.aws,.azure,.kube}/**,**/.env,**/.env.*,**/{credentials.json,service-account.json,service_account.json,id_rsa,id_ed25519},**/{secret,secrets}.*,**/*.{pem,key,p12,pfx,jks,keystore}}';
const MAX_TEXT_FILE_BYTES = 2_000_000;
export type RepositoryIndexStatus = 'idle' | 'indexing' | 'ready' | 'stale' | 'cancelled';

function flattenDocumentSymbols(
  uri: vscode.Uri,
  languageId: string,
  symbols: vscode.DocumentSymbol[],
  parent?: string
): SymbolRecord[] {
  const result: SymbolRecord[] = [];
  for (const symbol of symbols) {
    const containerName = parent;
    result.push({
      uri,
      name: symbol.name,
      containerName,
      kind: symbol.kind,
      range: symbol.range,
      languageId
    });
    result.push(
      ...flattenDocumentSymbols(
        uri,
        languageId,
        symbol.children,
        parent ? `${parent}.${symbol.name}` : symbol.name
      )
    );
  }
  return result;
}

function fallbackSymbols(document: vscode.TextDocument): SymbolRecord[] {
  const patterns = [
    /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/,
    /^\s*class\s+([A-Za-z_][\w]*)/,
    /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/,
    /^\s*(?:pub\s+)?fn\s+([A-Za-z_][\w]*)/,
    /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/
  ];
  const provisional: Array<SymbolRecord & { indent: number }> = [];
  for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber += 1) {
    const line = document.lineAt(lineNumber).text;
    for (const pattern of patterns) {
      const match = pattern.exec(line);
      if (!match?.[1]) {
        continue;
      }
      provisional.push({
        uri: document.uri,
        name: match[1],
        kind: line.includes('class ') ? vscode.SymbolKind.Class : vscode.SymbolKind.Function,
        range: new vscode.Range(lineNumber, 0, lineNumber, line.length),
        languageId: document.languageId,
        indent: line.match(/^\s*/)?.[0].length ?? 0
      });
      break;
    }
  }
  return provisional.map((symbol, index) => {
    const next = provisional
      .slice(index + 1)
      .find((candidate) => candidate.indent <= symbol.indent);
    const endLine = Math.max(
      symbol.range.start.line,
      (next?.range.start.line ?? document.lineCount) - 1
    );
    const { indent: _indent, ...record } = symbol;
    return {
      ...record,
      range: new vscode.Range(
        symbol.range.start,
        new vscode.Position(endLine, document.lineAt(endLine).text.length)
      )
    };
  });
}

function queryTokens(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[a-z_][a-z0-9_.-]{1,}/g) ?? [])];
}

function definitionNames(text: string): string[] {
  return [...text.matchAll(/\b(?:class|def|function|fn|func)\s+([A-Za-z_$][\w$]*)/g)].flatMap(
    (match) => (match[1] ? [match[1]] : [])
  );
}

function symbolQualifiedName(symbol: SymbolRecord): string {
  return symbol.containerName ? `${symbol.containerName}.${symbol.name}` : symbol.name;
}

function graphNodeId(symbol: SymbolRecord): string {
  return `${vscode.workspace.asRelativePath(symbol.uri, false)}:${symbol.range.start.line + 1}:${symbolQualifiedName(symbol)}`;
}

export class RepositoryIndex implements vscode.Disposable {
  private readonly symbolsByFile = new Map<string, SymbolRecord[]>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly statusEmitter = new vscode.EventEmitter<RepositoryIndexStatus>();
  private status: RepositoryIndexStatus = 'idle';

  public readonly onDidChangeStatus = this.statusEmitter.event;

  public constructor() {
    this.subscriptions.push(
      this.statusEmitter,
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri.scheme === 'file') {
          void this.indexDocument(document).then(() => this.setStatus('ready'));
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.symbolsByFile.has(event.document.uri.toString())) {
          this.setStatus('stale');
        }
      })
    );
    const watcher = vscode.workspace.createFileSystemWatcher(SOURCE_GLOB);
    this.subscriptions.push(
      watcher,
      watcher.onDidCreate((uri) => {
        void vscode.workspace.openTextDocument(uri).then((document) => this.indexDocument(document));
      }),
      watcher.onDidDelete((uri) => {
        this.symbolsByFile.delete(uri.toString());
        this.setStatus(this.symbolCount > 0 ? 'ready' : 'idle');
      })
    );
  }

  public get symbolCount(): number {
    let total = 0;
    for (const symbols of this.symbolsByFile.values()) {
      total += symbols.length;
    }
    return total;
  }

  public get currentStatus(): RepositoryIndexStatus {
    return this.status;
  }

  public async listWorkspaceFiles(): Promise<{ paths: string[]; truncated: boolean }> {
    const configuration = vscode.workspace.getConfiguration('codeChasing');
    const maxFiles = configuration.get<number>('maxRepositoryFiles', 5000);
    const uris = await vscode.workspace.findFiles('**/*', EXCLUDE_GLOB, maxFiles + 1);
    const truncated = uris.length > maxFiles;
    return {
      paths: uris
        .slice(0, maxFiles)
        .map((uri) => vscode.workspace.asRelativePath(uri, false))
        .sort((left, right) => left.localeCompare(right)),
      truncated
    };
  }

  public async listDirectory(prefix = '', maxEntries = 500): Promise<string[]> {
    const inventory = await this.listWorkspaceFiles();
    const normalized = prefix.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    return inventory.paths
      .filter((filePath) => !normalized || filePath === normalized || filePath.startsWith(`${normalized}/`))
      .slice(0, maxEntries);
  }

  public async readFileRange(
    filePath: string,
    startLine = 1,
    endLine = startLine + 199
  ): Promise<CodeContext | undefined> {
    const uri = await this.resolveWorkspaceFile(filePath);
    if (!uri) {
      return undefined;
    }
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      const start = Math.min(document.lineCount - 1, Math.max(0, startLine - 1));
      const end = Math.min(document.lineCount - 1, Math.max(start, Math.min(endLine - 1, start + 399)));
      const range = new vscode.Range(start, 0, end, document.lineAt(end).text.length);
      const text = document.getText(range).slice(0, 40_000);
      if (!compactWhitespace(text)) {
        return undefined;
      }
      return {
        id: '',
        filePath: vscode.workspace.asRelativePath(uri, false),
        languageId: document.languageId || path.extname(uri.fsPath).slice(1) || 'text',
        startLine: start + 1,
        endLine: end + 1,
        text
      };
    } catch {
      return undefined;
    }
  }

  public async searchText(
    query: string,
    limit = 20,
    signal?: AbortSignal
  ): Promise<CodeContext[]> {
    const inventory = {
      paths: (await vscode.workspace.findFiles('**/*', EXCLUDE_GLOB))
        .map((uri) => vscode.workspace.asRelativePath(uri, false))
        .sort((left, right) => left.localeCompare(right))
    };
    const contexts: CodeContext[] = [];
    for (let offset = 0; offset < inventory.paths.length && contexts.length < limit; offset += 24) {
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      const batch = inventory.paths.slice(offset, offset + 24);
      const results = await Promise.all(
        batch.map(async (filePath) => {
          const uri = await this.resolveWorkspaceFile(filePath);
          if (!uri) {
            return [];
          }
          try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.size > MAX_TEXT_FILE_BYTES) {
              return [];
            }
            const bytes = await vscode.workspace.fs.readFile(uri);
            if (bytes.includes(0)) {
              return [];
            }
            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            return findTextLineMatches(text, query).map((match) => ({
              filePath,
              line: match.line
            }));
          } catch {
            return [];
          }
        })
      );
      for (const match of results.flat()) {
        const context = await this.readFileRange(
          match.filePath,
          Math.max(1, match.line - 8),
          match.line + 12
        );
        if (context) {
          contexts.push(context);
        }
        if (contexts.length >= limit) {
          break;
        }
      }
    }
    return contexts;
  }

  public async indexWorkspace(
    signal?: AbortSignal,
    onProgress?: (completed: number, total: number) => void
  ): Promise<number> {
    const configuration = vscode.workspace.getConfiguration('codeChasing');
    const maxFiles = configuration.get<number>('maxRepositoryFiles', 5000);
    const uris = (await vscode.workspace.findFiles(SOURCE_GLOB, EXCLUDE_GLOB, maxFiles)).slice(
      0,
      maxFiles
    );

    this.setStatus('indexing');
    let cancelled = false;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'CodeChasing: scanning workspace symbols',
        cancellable: true
      },
      async (progress, token) => {
        this.symbolsByFile.clear();
        for (let index = 0; index < uris.length; index += 1) {
          if (token.isCancellationRequested || signal?.aborted) {
            cancelled = true;
            break;
          }
          const uri = uris[index];
          if (!uri) {
            continue;
          }
          try {
            const document = await vscode.workspace.openTextDocument(uri);
            await this.indexDocument(document);
          } catch {
            // A single unreadable or binary-looking file should not abort the index.
          }
          if (index % 20 === 0) {
            onProgress?.(index + 1, uris.length);
            progress.report({
              message: `${index + 1}/${uris.length}`,
              increment: uris.length > 0 ? (20 / uris.length) * 100 : 100
            });
          }
        }
      }
    );
    this.setStatus(cancelled ? 'cancelled' : 'ready');
    return this.symbolCount;
  }

  public async getOverviewContexts(limit = 6): Promise<CodeContext[]> {
    const ranked = [...this.symbolsByFile.values()]
      .flat()
      .map((symbol) => {
        const filePath = vscode.workspace.asRelativePath(symbol.uri, false).toLowerCase();
        const name = `${symbol.containerName ?? ''}.${symbol.name}`.toLowerCase();
        const keywords = ['main', 'train', 'model', 'forward', 'dataset', 'data', 'loss', 'predict'];
        const score = keywords.reduce(
          (total, keyword) => total + (name.includes(keyword) ? 5 : 0) + (filePath.includes(keyword) ? 2 : 0),
          0
        );
        return { symbol, score };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score);
    const contexts: CodeContext[] = [];
    const seen = new Set<string>();
    for (const { symbol, score } of ranked) {
      const key = `${symbol.uri.toString()}:${symbol.range.start.line}`;
      if (seen.has(key)) {
        continue;
      }
      const context = await this.contextForSymbol(symbol, score);
      if (context) {
        contexts.push(context);
        seen.add(key);
      }
      if (contexts.length >= limit) {
        break;
      }
    }
    return contexts;
  }

  public getProjectMap(maxSymbols = 1200, maxCharacters = 80_000): string {
    const result = [...this.symbolsByFile.values()]
      .flat()
      .sort((left, right) => {
        const pathOrder = left.uri.fsPath.localeCompare(right.uri.fsPath);
        return pathOrder || left.range.start.line - right.range.start.line;
      })
      .slice(0, maxSymbols)
      .map((symbol) => {
        const name = symbol.containerName ? `${symbol.containerName}.${symbol.name}` : symbol.name;
        return `${vscode.workspace.asRelativePath(symbol.uri, false)}:${symbol.range.start.line + 1} :: ${name}`;
      })
      .join('\n');
    return result.length <= maxCharacters
      ? result
      : `${result.slice(0, maxCharacters)}\n… project map truncated …`;
  }

  /**
   * Builds a project-wide static call graph from language-server symbols and call sites.
   * Ambiguous dynamic dispatch remains a lower-confidence reference edge rather than being
   * presented as a certain runtime call.
   */
  public async getCallGraph(seed?: CodeContext, maxNodes = 120): Promise<CallGraph> {
    if (this.symbolsByFile.size === 0) return { nodes: [], edges: [] };
    const callableKinds = new Set([
      vscode.SymbolKind.Function,
      vscode.SymbolKind.Method,
      vscode.SymbolKind.Constructor,
      vscode.SymbolKind.Class
    ]);
    const symbols = [...this.symbolsByFile.values()].flat().filter((symbol) => callableKinds.has(symbol.kind));
    const snapshots: StaticCallSymbol[] = [];
    for (const fileSymbols of this.symbolsByFile.values()) {
      const first = fileSymbols[0];
      if (!first) continue;
      let document: vscode.TextDocument;
      try {
        document = await vscode.workspace.openTextDocument(first.uri);
      } catch {
        continue;
      }
      for (const caller of fileSymbols.filter((symbol) => callableKinds.has(symbol.kind))) {
        const isClass = caller.kind === vscode.SymbolKind.Class;
        const source = isClass
          ? document.lineAt(caller.range.start.line).text
          : document.getText(caller.range);
        snapshots.push({
          node: {
            id: graphNodeId(caller),
            filePath: vscode.workspace.asRelativePath(caller.uri, false),
            symbolName: symbolQualifiedName(caller),
            startLine: caller.range.start.line + 1,
            endLine: caller.range.end.line + 1,
            languageId: caller.languageId
          },
          containerName: caller.containerName,
          source
        });
      }
    }
    let seedId: string | undefined;
    if (seed) {
      const normalizedSeedPath = seed.filePath.replace(/\\/g, '/');
      const owner = symbols
        .filter((symbol) => {
          const filePath = vscode.workspace.asRelativePath(symbol.uri, false).replace(/\\/g, '/');
          const start = symbol.range.start.line + 1;
          const end = symbol.range.end.line + 1;
          return filePath === normalizedSeedPath && start <= seed.startLine && end >= seed.startLine;
        })
        .sort((left, right) =>
          left.range.end.line - left.range.start.line - (right.range.end.line - right.range.start.line)
        )[0];
      seedId = owner ? graphNodeId(owner) : undefined;
    }

    return sliceCallGraph(buildStaticCallGraph(snapshots), seedId, Math.max(1, maxNodes));
  }

  public async getRelatedContexts(seed: CodeContext, limit = 12): Promise<CodeContext[]> {
    if (this.symbolsByFile.size === 0 || limit <= 0) {
      return [];
    }
    const seedTokens = new Set(queryTokens(seed.text));
    const defined = new Set(definitionNames(seed.text));
    if (seed.symbolName) {
      defined.add(seed.symbolName.split('.').at(-1) ?? seed.symbolName);
    }
    const candidates = new Map<SymbolRecord, number>();

    for (const symbols of this.symbolsByFile.values()) {
      for (const symbol of symbols) {
        const relativePath = vscode.workspace.asRelativePath(symbol.uri, false);
        const sameSeed =
          relativePath === seed.filePath &&
          symbol.range.start.line + 1 >= seed.startLine &&
          symbol.range.start.line + 1 <= seed.endLine;
        if (sameSeed) {
          continue;
        }
        const score = seedTokens.has(symbol.name.toLowerCase()) ? 18 : 0;
        if (score > 0) {
          candidates.set(symbol, score);
        }
      }
    }

    if (defined.size) {
      for (const symbols of this.symbolsByFile.values()) {
        const first = symbols[0];
        if (!first) {
          continue;
        }
        try {
          const document = await vscode.workspace.openTextDocument(first.uri);
          const source = document.getText();
          for (const name of defined) {
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            for (const match of source.matchAll(new RegExp(`\\b${escaped}\\b`, 'g'))) {
              const position = document.positionAt(match.index ?? 0);
              const owner = symbols
                .filter((symbol) => symbol.range.contains(position))
                .sort(
                  (left, right) =>
                    left.range.end.line - left.range.start.line -
                    (right.range.end.line - right.range.start.line)
                )[0];
              if (owner) {
                candidates.set(owner, (candidates.get(owner) ?? 0) + 14);
              }
            }
          }
        } catch {
          // Ignore files that changed while resolving references for this question.
        }
      }
    }

    const contexts: CodeContext[] = [];
    for (const [symbol, score] of [...candidates.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, limit)) {
      const context = await this.contextForSymbol(symbol, score);
      if (context) {
        contexts.push(context);
      }
    }
    return contexts;
  }

  public async search(query: string, limit = 5): Promise<CodeContext[]> {
    if (this.symbolsByFile.size === 0) {
      return [];
    }
    const tokens = queryTokens(query);
    const candidates = [...this.symbolsByFile.values()]
      .flat()
      .map((symbol) => {
        const workspacePath = vscode.workspace.asRelativePath(symbol.uri, false);
        const haystack = `${symbol.containerName ?? ''} ${symbol.name} ${workspacePath}`.toLowerCase();
        let score = 0;
        for (const token of tokens) {
          if (symbol.name.toLowerCase() === token) {
            score += 12;
          } else if (symbol.name.toLowerCase().includes(token)) {
            score += 7;
          } else if (haystack.includes(token)) {
            score += 2;
          }
        }
        return { symbol, score };
      })
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);

    const contexts: CodeContext[] = [];
    for (const { symbol, score } of candidates) {
      try {
        const document = await vscode.workspace.openTextDocument(symbol.uri);
        const startLine = Math.max(0, symbol.range.start.line);
        const endLine = Math.min(
          document.lineCount - 1,
          Math.max(startLine, Math.min(symbol.range.end.line, startLine + 120))
        );
        const range = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);
        contexts.push({
          id: `C${contexts.length + 1}`,
          filePath: vscode.workspace.asRelativePath(symbol.uri, false),
          languageId: symbol.languageId,
          symbolName: symbol.containerName
            ? `${symbol.containerName}.${symbol.name}`
            : symbol.name,
          startLine: startLine + 1,
          endLine: endLine + 1,
          text: document.getText(range),
          score
        });
      } catch {
        // Ignore stale files and continue with other candidates.
      }
    }
    return contexts;
  }

  public async getActiveEditorContext(): Promise<CodeContext | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      return undefined;
    }
    const document = editor.document;
    const selection = editor.selection;
    if (selection.isEmpty) {
      return undefined;
    }
    const range = new vscode.Range(selection.start, selection.end);
    const text = document.getText(range);
    if (!compactWhitespace(text)) {
      return undefined;
    }
    const owner = (this.symbolsByFile.get(document.uri.toString()) ?? [])
      .filter((symbol) => symbol.range.contains(range.start))
      .sort(
        (left, right) =>
          left.range.end.line - left.range.start.line -
          (right.range.end.line - right.range.start.line)
      )[0];
    return {
      id: 'C-selected',
      filePath: vscode.workspace.asRelativePath(document.uri, false),
      languageId: document.languageId,
      symbolName: owner
        ? owner.containerName
          ? `${owner.containerName}.${owner.name}`
          : owner.name
        : undefined,
      startLine: range.start.line + 1,
      endLine: range.end.line + 1,
      text
    };
  }

  public dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }

  private async indexDocument(document: vscode.TextDocument): Promise<void> {
    let rawSymbols:
      | vscode.DocumentSymbol[]
      | vscode.SymbolInformation[]
      | undefined;
    try {
      rawSymbols = await vscode.commands.executeCommand<
        vscode.DocumentSymbol[] | vscode.SymbolInformation[]
      >('vscode.executeDocumentSymbolProvider', document.uri);
    } catch {
      rawSymbols = undefined;
    }

    let records: SymbolRecord[] = [];
    if (rawSymbols && rawSymbols.length > 0) {
      const first = rawSymbols[0];
      if (first && 'children' in first) {
        records = flattenDocumentSymbols(
          document.uri,
          document.languageId,
          rawSymbols as vscode.DocumentSymbol[]
        );
      } else {
        records = (rawSymbols as vscode.SymbolInformation[]).map((symbol) => ({
          uri: symbol.location.uri,
          name: symbol.name,
          containerName: symbol.containerName,
          kind: symbol.kind,
          range: symbol.location.range,
          languageId: document.languageId
        }));
      }
    }
    if (records.length === 0) {
      records = fallbackSymbols(document);
    }
    this.symbolsByFile.set(document.uri.toString(), records);
  }

  private async resolveWorkspaceFile(filePath: string): Promise<vscode.Uri | undefined> {
    const normalized = filePath.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (
      !normalized ||
      path.isAbsolute(normalized) ||
      normalized.split('/').includes('..') ||
      isSensitiveWorkspacePath(normalized)
    ) {
      return undefined;
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const folderName = path.basename(folder.uri.fsPath);
      const relative = normalized.startsWith(`${folderName}/`)
        ? normalized.slice(folderName.length + 1)
        : normalized;
      const candidate = vscode.Uri.joinPath(folder.uri, ...relative.split('/'));
      try {
        const stat = await vscode.workspace.fs.stat(candidate);
        if (stat.type === vscode.FileType.File) {
          return candidate;
        }
      } catch {
        // Continue through the remaining workspace roots.
      }
    }
    return undefined;
  }

  private async contextForSymbol(symbol: SymbolRecord, score = 0): Promise<CodeContext | undefined> {
    try {
      const document = await vscode.workspace.openTextDocument(symbol.uri);
      const startLine = Math.max(0, symbol.range.start.line);
      const endLine = Math.min(
        document.lineCount - 1,
        Math.max(startLine, Math.min(symbol.range.end.line, startLine + 120))
      );
      const range = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);
      return {
        id: '',
        filePath: vscode.workspace.asRelativePath(symbol.uri, false),
        languageId: symbol.languageId,
        symbolName: symbol.containerName ? `${symbol.containerName}.${symbol.name}` : symbol.name,
        startLine: startLine + 1,
        endLine: endLine + 1,
        text: document.getText(range),
        score
      };
    } catch {
      return undefined;
    }
  }

  private setStatus(status: RepositoryIndexStatus): void {
    if (this.status === status) {
      return;
    }
    this.status = status;
    this.statusEmitter.fire(status);
  }
}
