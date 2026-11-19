import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

const LIB_FILES = new Map([
  ['lib/pdf.mjs', 'pdf.mjs'],
  ['lib/pdf.worker.mjs', 'pdf.worker.mjs'],
  ['lib/pdf_viewer.mjs', 'pdf_viewer.mjs']
]);
const PREFERRED_PORT = 47311;

function contentType(file: string): string {
  if (file.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.wasm')) return 'application/wasm';
  return 'application/pdf';
}

/**
 * Loopback-only static server for pdf.js modules and registered paper PDFs.
 * Webview resource protocol loads serialize through IPC without browser caching;
 * plain HTTP lets the webview cache modules and stream PDF ranges in parallel.
 */
export class PdfAssetServer {
  private server: http.Server | undefined;
  private port: number | undefined;
  private starting: Promise<number | undefined> | undefined;
  private readonly token = crypto.randomBytes(16).toString('hex');
  private readonly papers = new Map<string, string>();

  public constructor(private readonly libRoot: string) {}

  public registerPaper(hash: string, fsPath: string): void {
    this.papers.set(hash, fsPath);
  }

  public start(): Promise<number | undefined> {
    this.starting ??= this.listen();
    return this.starting;
  }

  public base(): string | undefined {
    return this.port === undefined ? undefined : `http://127.0.0.1:${this.port}/t/${this.token}`;
  }

  public dispose(): void {
    this.server?.close();
    this.server = undefined;
    this.port = undefined;
    this.starting = undefined;
  }

  private listen(): Promise<number | undefined> {
    return new Promise((resolve) => {
      const server = http.createServer((request, response) => this.handle(request, response));
      let retried = false;
      server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE' && !retried) {
          retried = true;
          server.listen(0, '127.0.0.1');
          return;
        }
        resolve(undefined);
      });
      server.on('listening', () => {
        const address = server.address();
        this.server = server;
        this.port = typeof address === 'object' && address ? address.port : undefined;
        resolve(this.port);
      });
      server.listen(PREFERRED_PORT, '127.0.0.1');
    });
  }

  private resolveFile(route: string): string | undefined {
    const lib = LIB_FILES.get(route);
    if (lib) return path.join(this.libRoot, lib);
    if (route.startsWith('wasm/')) {
      const name = route.slice(5);
      if (!/^[\w.-]+\.wasm$/.test(name)) return undefined;
      return path.join(this.libRoot, 'wasm', name);
    }
    if (route.startsWith('pdf/')) return this.papers.get(route.slice(4));
    return undefined;
  }

  private handle(request: http.IncomingMessage, response: http.ServerResponse): void {
    const prefix = `/t/${this.token}/`;
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'Range');
    response.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Range, Content-Length');
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (!url.pathname.startsWith(prefix) || (request.method !== 'GET' && request.method !== 'HEAD')) {
      response.writeHead(404);
      response.end();
      return;
    }
    const file = this.resolveFile(url.pathname.slice(prefix.length));
    if (!file) {
      response.writeHead(404);
      response.end();
      return;
    }
    fs.stat(file, (error, stats) => {
      if (error || !stats.isFile()) {
        response.writeHead(404);
        response.end();
        return;
      }
      const type = contentType(file);
      // Paper URLs are content-addressed by sha256, so they can cache forever.
      response.setHeader(
        'Cache-Control',
        url.pathname.startsWith(`${prefix}pdf/`) ? 'public, max-age=31536000, immutable' : 'public, max-age=86400'
      );
      response.setHeader('Accept-Ranges', 'bytes');
      response.setHeader('Content-Type', type);
      const range = request.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
      let start = 0;
      let end = stats.size - 1;
      if (range && (range[1] || range[2])) {
        if (range[1]) {
          start = Number(range[1]);
          end = range[2] ? Math.min(Number(range[2]), end) : end;
        } else {
          start = Math.max(0, stats.size - Number(range[2]));
        }
        if (start > end || start >= stats.size) {
          response.writeHead(416, { 'Content-Range': `bytes */${stats.size}` });
          response.end();
          return;
        }
        response.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${stats.size}`,
          'Content-Length': end - start + 1
        });
      } else {
        response.writeHead(200, { 'Content-Length': stats.size });
      }
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      fs.createReadStream(file, { start, end }).pipe(response);
    });
  }
}