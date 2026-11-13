import * as vscode from 'vscode';
import type { CallGraph, CallGraphNode } from './types.js';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character] ?? character);
}

function nonce(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function levels(graph: CallGraph): Map<string, number> {
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]));
  for (const edge of graph.edges) indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  const roots = graph.nodes.filter((node) => node.root || (indegree.get(node.id) ?? 0) === 0);
  const queue = (roots.length ? roots : graph.nodes.slice(0, 1)).map((node) => node.id);
  const result = new Map(queue.map((id) => [id, 0]));
  for (let index = 0; index < queue.length; index += 1) {
    const from = queue[index]!;
    const depth = result.get(from) ?? 0;
    for (const edge of graph.edges.filter((candidate) => candidate.from === from)) {
      const nextDepth = Math.min(7, depth + 1);
      if (!result.has(edge.to) || nextDepth < (result.get(edge.to) ?? Number.POSITIVE_INFINITY)) {
        result.set(edge.to, nextDepth);
        queue.push(edge.to);
      }
    }
  }
  for (const node of graph.nodes) if (!result.has(node.id)) result.set(node.id, 0);
  return result;
}

export class CallGraphView implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private currentGraph: CallGraph = { nodes: [], edges: [] };

  public constructor(
    private readonly onOpenCode: (node: CallGraphNode) => Promise<void>
  ) {}

  public show(graph: CallGraph): void {
    this.currentGraph = graph;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'codeChasing.callGraph',
        'CodeChasing Call Graph',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      this.panel.onDidDispose(() => { this.panel = undefined; });
      this.panel.webview.onDidReceiveMessage(async (message: unknown) => {
        if (!message || typeof message !== 'object') return;
        const data = message as Record<string, unknown>;
        if (data.type !== 'openCode' || typeof data.id !== 'string') return;
        const node = this.currentGraph.nodes.find((candidate) => candidate.id === data.id);
        if (node) await this.onOpenCode(node);
      });
    }
    this.panel.title = `Call Graph · ${graph.nodes.length} symbols`;
    this.panel.webview.html = this.html(graph, this.panel.webview);
    this.panel.reveal(vscode.ViewColumn.Active, true);
  }

  public dispose(): void {
    this.panel?.dispose();
  }

  private html(graph: CallGraph, webview: vscode.Webview): string {
    const scriptNonce = nonce();
    const nodeLevels = levels(graph);
    const groups = new Map<number, CallGraphNode[]>();
    for (const node of graph.nodes) {
      const level = nodeLevels.get(node.id) ?? 0;
      groups.set(level, [...(groups.get(level) ?? []), node]);
    }
    const positions = new Map<string, { x: number; y: number }>();
    for (const [level, nodes] of groups) {
      nodes.sort((a, b) => a.symbolName.localeCompare(b.symbolName));
      nodes.forEach((node, index) => positions.set(node.id, { x: 40 + level * 300, y: 48 + index * 96 }));
    }
    const width = Math.max(760, 100 + ((Math.max(0, ...groups.keys()) + 1) * 300));
    const height = Math.max(480, 140 + Math.max(0, ...[...groups.values()].map((nodes) => nodes.length * 96)));
    const edges = graph.edges.map((edge) => {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to) return '';
      const x1 = from.x + 236;
      const y1 = from.y + 30;
      const x2 = to.x;
      const y2 = to.y + 30;
      const mid = (x1 + x2) / 2;
      return `<path class="edge ${edge.kind}" data-from="${escapeHtml(edge.from)}" data-to="${escapeHtml(edge.to)}" d="M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}" marker-end="url(#arrow)"><title>${edge.kind} · confidence ${Math.round(edge.confidence * 100)}%${edge.callSiteLine ? ` · line ${edge.callSiteLine}` : ''}${edge.expression ? ` · ${escapeHtml(edge.expression)}` : ''}</title></path>`;
    }).join('');
    const nodes = graph.nodes.map((node) => {
      const position = positions.get(node.id)!;
      const shortName = node.symbolName.length > 31 ? `${node.symbolName.slice(0, 29)}…` : node.symbolName;
      const path = `${node.filePath}:${node.startLine}`;
      const shortPath = path.length > 37 ? `…${path.slice(-35)}` : path;
      return `<g class="node${node.root ? ' root' : ''}" data-id="${escapeHtml(node.id)}" data-search="${escapeHtml(`${node.symbolName} ${node.filePath}`.toLowerCase())}" transform="translate(${position.x} ${position.y})" tabindex="0" role="button">
        <rect width="236" height="62" rx="9"></rect>
        <text x="12" y="25" class="name">${escapeHtml(shortName)}</text>
        <text x="12" y="47" class="path">${escapeHtml(shortPath)}</text>
        <title>${escapeHtml(node.symbolName)}\n${escapeHtml(node.filePath)}:${node.startLine}-${node.endLine}</title>
      </g>`;
    }).join('');
    return `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${scriptNonce}';">
      <style>
        body{margin:0;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family)}
        header{position:sticky;top:0;z-index:2;padding:9px 14px;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border);display:flex;align-items:center;gap:10px;flex-wrap:wrap}
        header strong{font-size:14px}.legend,.stats{color:var(--vscode-descriptionForeground);font-size:11px}.warning{color:var(--vscode-editorWarning-foreground)}
        input{min-width:180px;flex:1;max-width:340px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:4px 7px;border-radius:4px}
        button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:0;border-radius:4px;padding:4px 8px;cursor:pointer}.canvas{overflow:auto;width:100vw;height:calc(100vh - 74px)}svg{display:block;transform-origin:top left}
        .edge{fill:none;stroke:var(--vscode-charts-blue);stroke-width:1.7;opacity:.75}.edge.references{stroke-dasharray:6 5;stroke:var(--vscode-descriptionForeground);opacity:.55}
        .node{cursor:pointer;transition:opacity .12s}.node.hidden,.edge.hidden{opacity:.06;pointer-events:none}.node rect{fill:var(--vscode-editorWidget-background);stroke:var(--vscode-panel-border);stroke-width:1.2}.node:hover rect,.node:focus rect{stroke:var(--vscode-focusBorder);stroke-width:2}.node.root rect{stroke:var(--vscode-charts-green);stroke-width:2}
        .node text{pointer-events:none}.name{fill:var(--vscode-editor-foreground);font-size:13px;font-weight:600}.path{fill:var(--vscode-descriptionForeground);font-size:10.5px}
      </style></head><body><header><strong>调用关系图</strong><span class="stats">显示 ${graph.nodes.length}/${graph.totalProjectSymbols ?? graph.nodes.length} 个符号 · ${graph.edges.length} 条边 · ${graph.unresolvedCallCount ?? 0} 个未解析调用</span>${graph.truncated ? '<span class="warning">当前为相关子图</span>' : ''}<input id="search" aria-label="Filter symbols" placeholder="筛选函数或文件…"><button id="minus" title="Zoom out">−</button><button id="fit" title="Fit graph">适应</button><button id="plus" title="Zoom in">＋</button><span class="legend">实线：确定调用　虚线：歧义引用　点击节点打开代码</span></header>
      <div class="canvas" id="canvas"><svg id="graph" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="var(--vscode-descriptionForeground)"></path></marker></defs>${edges}${nodes}</svg></div>
      <script nonce="${scriptNonce}">const vscode=acquireVsCodeApi(),svg=document.getElementById('graph'),canvas=document.getElementById('canvas'),search=document.getElementById('search');let zoom=1;const resize=()=>{svg.style.width=String(${width}*zoom)+'px';svg.style.height=String(${height}*zoom)+'px'};const setZoom=z=>{zoom=Math.max(.35,Math.min(2.5,z));resize()};document.getElementById('minus').onclick=()=>setZoom(zoom-.15);document.getElementById('plus').onclick=()=>setZoom(zoom+.15);document.getElementById('fit').onclick=()=>setZoom(Math.min(1,Math.max(.35,(canvas.clientWidth-20)/${width})));for(const node of document.querySelectorAll('.node')){const open=()=>vscode.postMessage({type:'openCode',id:node.dataset.id});node.addEventListener('click',open);node.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open()}})}search.addEventListener('input',()=>{const q=search.value.trim().toLowerCase(),visible=new Set;for(const node of document.querySelectorAll('.node')){const show=!q||node.dataset.search.includes(q);node.classList.toggle('hidden',!show);if(show)visible.add(node.dataset.id)}for(const edge of document.querySelectorAll('.edge'))edge.classList.toggle('hidden',q&&!visible.has(edge.dataset.from)&&!visible.has(edge.dataset.to))});resize()</script>
      </body></html>`;
  }
}
