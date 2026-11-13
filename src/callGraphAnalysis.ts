import type { CallGraph, CallGraphEdge, CallGraphNode } from './types.js';

export interface StaticCallSymbol {
  node: CallGraphNode;
  containerName?: string;
  source: string;
}

export interface StaticCallSite {
  name: string;
  qualifier?: string;
  line: number;
  expression: string;
}

const NON_CALLS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'yield', 'await', 'sizeof', 'typeof',
  'def', 'class', 'function', 'fn', 'func', 'print', 'assert', 'super', 'with', 'match'
]);

function stripQuotedText(line: string): string {
  let result = '';
  let quote = '';
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? '';
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = '';
      }
      result += ' ';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      result += ' ';
      continue;
    }
    if (character === '#') {
      result += ' '.repeat(line.length - index);
      break;
    }
    if (character === '/' && line[index + 1] === '/') {
      result += ' '.repeat(line.length - index);
      break;
    }
    result += character;
  }
  return result;
}

export function extractStaticCallSites(source: string, startLine = 1): StaticCallSite[] {
  const result: StaticCallSite[] = [];
  for (const [offset, original] of source.split(/\r?\n/).entries()) {
    const line = stripQuotedText(original);
    const declaration = line.match(/\b(?:def|function|fn|func|class)\s+([A-Za-z_$][\w$]*)\s*\(/)?.[1];
    for (const match of line.matchAll(/\b([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/g)) {
      const expression = (match[1] ?? '').replace(/\s+/g, '');
      const parts = expression.split('.');
      const name = parts.at(-1) ?? '';
      const qualifier = parts.length > 1 ? parts.slice(0, -1).join('.') : undefined;
      if (!name || NON_CALLS.has(name.toLowerCase()) || (!qualifier && declaration === name)) continue;
      result.push({ name, qualifier, line: startLine + offset, expression });
    }
  }
  return result;
}

function sameContainer(left?: string, right?: string): boolean {
  if (!left || !right) return false;
  const leftClass = left.split('.').at(-1)?.toLowerCase();
  const rightClass = right.split('.').at(-1)?.toLowerCase();
  return Boolean(leftClass && leftClass === rightClass);
}

function resolveCall(
  caller: StaticCallSymbol,
  site: StaticCallSite,
  candidates: StaticCallSymbol[]
): { targets: StaticCallSymbol[]; kind: CallGraphEdge['kind']; confidence: number } | undefined {
  const withoutSelf = candidates.filter((candidate) => candidate.node.id !== caller.node.id);
  if (!withoutSelf.length) return undefined;
  const sameFile = withoutSelf.filter((candidate) => candidate.node.filePath === caller.node.filePath);
  const qualifier = site.qualifier?.split('.').at(-1)?.toLowerCase();
  if (qualifier === 'self' || qualifier === 'this' || qualifier === 'cls' || qualifier === 'super') {
    const classMethods = sameFile.filter((candidate) => sameContainer(candidate.containerName, caller.containerName));
    if (classMethods.length === 1) return { targets: classMethods, kind: 'calls', confidence: 0.98 };
  }
  if (qualifier) {
    const qualified = withoutSelf.filter((candidate) => {
      const owner = candidate.containerName?.split('.').at(-1)?.toLowerCase();
      return owner === qualifier;
    });
    if (qualified.length === 1) return { targets: qualified, kind: 'calls', confidence: 0.94 };
  }
  const sameScope = sameFile.filter((candidate) => sameContainer(candidate.containerName, caller.containerName));
  if (sameScope.length === 1) return { targets: sameScope, kind: 'calls', confidence: 0.96 };
  if (sameFile.length === 1) return { targets: sameFile, kind: 'calls', confidence: 0.92 };
  if (withoutSelf.length === 1) return { targets: withoutSelf, kind: 'calls', confidence: 0.88 };
  return { targets: withoutSelf.slice(0, 4), kind: 'references', confidence: 0.48 };
}

export function buildStaticCallGraph(symbols: StaticCallSymbol[]): CallGraph {
  const byName = new Map<string, StaticCallSymbol[]>();
  for (const symbol of symbols) {
    const key = symbol.node.symbolName.split('.').at(-1)?.toLowerCase() ?? '';
    if (key) byName.set(key, [...(byName.get(key) ?? []), symbol]);
  }
  const edges = new Map<string, CallGraphEdge>();
  let unresolvedCallCount = 0;
  for (const caller of symbols) {
    for (const site of extractStaticCallSites(caller.source, caller.node.startLine)) {
      const resolution = resolveCall(caller, site, byName.get(site.name.toLowerCase()) ?? []);
      if (!resolution) {
        unresolvedCallCount += 1;
        continue;
      }
      for (const target of resolution.targets) {
        const key = `${caller.node.id}->${target.node.id}`;
        const edge: CallGraphEdge = {
          from: caller.node.id,
          to: target.node.id,
          kind: resolution.kind,
          confidence: resolution.confidence,
          callSiteLine: site.line,
          expression: site.expression
        };
        const existing = edges.get(key);
        if (!existing || edge.confidence > existing.confidence) edges.set(key, edge);
      }
    }
  }
  return {
    nodes: symbols.map((symbol) => symbol.node),
    edges: [...edges.values()],
    totalProjectSymbols: symbols.length,
    unresolvedCallCount,
    truncated: false
  };
}

export function sliceCallGraph(graph: CallGraph, seedId: string | undefined, maxNodes: number): CallGraph {
  const selected = new Set<string>();
  const roots = seedId
    ? [seedId]
    : graph.nodes
        .filter((node) => /^(?:main|train|run|fit|predict|inference|forward)$/i.test(node.symbolName.split('.').at(-1) ?? ''))
        .slice(0, 24)
        .map((node) => node.id);
  if (!seedId) {
    for (const node of graph.nodes.slice(0, maxNodes)) selected.add(node.id);
  }
  for (const id of roots.length ? roots : graph.nodes.slice(0, Math.min(24, maxNodes)).map((node) => node.id)) {
    selected.add(id);
  }
  let frontier = seedId ? [...selected] : [];
  for (let depth = 0; depth < 6 && frontier.length && selected.size < maxNodes; depth += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of graph.edges) {
        const neighbor = edge.from === id ? edge.to : edge.to === id ? edge.from : undefined;
        if (neighbor && !selected.has(neighbor)) {
          selected.add(neighbor);
          next.push(neighbor);
          if (selected.size >= maxNodes) break;
        }
      }
      if (selected.size >= maxNodes) break;
    }
    frontier = next;
  }
  const nodes = graph.nodes
    .filter((node) => selected.has(node.id))
    .map((node) => ({ ...node, root: node.id === seedId || (!seedId && roots.includes(node.id)) }));
  return {
    ...graph,
    nodes,
    edges: graph.edges.filter((edge) => selected.has(edge.from) && selected.has(edge.to)),
    truncated: selected.size < graph.nodes.length
  };
}
