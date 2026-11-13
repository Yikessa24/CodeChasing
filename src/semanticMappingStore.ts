import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type {
  AssistantAnswer,
  CodeContext,
  SemanticMappingEdge,
  SemanticMappingRelation,
  SemanticMappingStatus
} from './types.js';

const MAPPINGS_KEY = 'codeChasing.semanticMappings.v1';
const MAX_MAPPINGS = 500;

export function mappingCodeHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 20);
}

function relationFromText(text: string): SemanticMappingRelation {
  if (/训练|优化|反向传播|train|optim/i.test(text)) return 'trains';
  if (/评估|测试|指标|evaluate|metric|test/i.test(text)) return 'evaluates';
  if (/输入|送入|接收|input|consume/i.test(text)) return 'input';
  if (/输出|返回|产生|output|return|produce/i.test(text)) return 'output';
  if (/配置|参数|初始化|config|initiali[sz]/i.test(text)) return 'configures';
  if (/调用|call|invoke/i.test(text)) return 'calls';
  if (/实现|对应|落地|implement|correspond/i.test(text)) return 'implements';
  return 'supports';
}

function claimSegments(text: string): string[] {
  return text
    .split(/(?<=[。！？!?;；])\s*|\n+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Creates only evidence-backed candidates: a claim must contain at least one valid
 * paper anchor and one valid code anchor in the same local sentence/bullet.
 */
export function deriveSemanticMappings(
  answer: AssistantAnswer,
  codeContexts: CodeContext[],
  paperHash: string,
  conversationId: string,
  now = Date.now()
): SemanticMappingEdge[] {
  const paperById = new Map(answer.citations.map((citation) => [citation.citationId, citation]));
  const codeById = new Map(answer.codeLocations.map((location) => [location.codeId, location]));
  const contextByRange = new Map(
    codeContexts.map((context) => [
      `${context.filePath}:${context.startLine}-${context.endLine}`,
      context
    ])
  );
  const result = new Map<string, SemanticMappingEdge>();
  const segments = claimSegments(answer.text).map((segment) => ({
    segment,
    paperIds: [...new Set([...segment.matchAll(/\[(P\d+)]/g)].map((match) => match[1]))]
      .filter((id): id is string => Boolean(id && paperById.has(id))),
    codeIds: [...new Set([...segment.matchAll(/\[(C\d+)]/g)].map((match) => match[1]))]
      .filter((id): id is string => Boolean(id && codeById.has(id)))
  }));

  const addPairs = (
    segment: string,
    paperIds: string[],
    codeIds: string[],
    confidence: number
  ): void => {
    if (!paperIds.length || !codeIds.length) return;
    const explanation = segment
      .replace(/\[(?:P|C)\d+]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 800);
    for (const paperId of paperIds) {
      const paper = paperById.get(paperId);
      if (!paper) continue;
      for (const codeId of codeIds) {
        const code = codeById.get(codeId);
        if (!code) continue;
        const context = contextByRange.get(
          `${code.filePath}:${code.startLine}-${code.endLine}`
        );
        const hash = mappingCodeHash(context?.text ?? `${code.filePath}:${code.startLine}-${code.endLine}`);
        const id = mappingCodeHash(`${paperHash}\n${paper.chunkId}\n${code.filePath}\n${code.symbolName ?? ''}\n${hash}`);
        result.set(id, {
          id,
          paperHash,
          paperChunkId: paper.chunkId,
          paperPage: paper.page,
          paperPreview: paper.preview,
          paperBoxes: paper.boxes,
          codeFilePath: code.filePath,
          codeStartLine: code.startLine,
          codeEndLine: code.endLine,
          codeSymbolName: code.symbolName,
          codeContentHash: hash,
          codePreview: (context?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 1000),
          relation: relationFromText(explanation),
          explanation,
          status: 'candidate',
          confidence,
          sourceConversationId: conversationId,
          createdAt: now,
          updatedAt: now
        });
      }
    }
  };

  for (const segment of segments) {
    addPairs(segment.segment, segment.paperIds, segment.codeIds, 0.78);
  }
  // Models often put the paper fact and its implementation in two adjacent bullets.
  // Preserve this useful pattern as a lower-confidence candidate for user review.
  for (let index = 0; index < segments.length - 1; index += 1) {
    const left = segments[index]!;
    const right = segments[index + 1]!;
    if (left.paperIds.length && !left.codeIds.length && right.codeIds.length && !right.paperIds.length) {
      addPairs(`${left.segment} ${right.segment}`, left.paperIds, right.codeIds, 0.62);
    } else if (left.codeIds.length && !left.paperIds.length && right.paperIds.length && !right.codeIds.length) {
      addPairs(`${left.segment} ${right.segment}`, right.paperIds, left.codeIds, 0.62);
    }
  }
  return [...result.values()];
}

function terms(value: string): Set<string> {
  return new Set(
    (value.toLowerCase().match(/[a-z_][a-z0-9_.-]{1,}|[\u3400-\u9fff]{1,2}/g) ?? [])
      .filter((term) => term.length > 1 || /[\u3400-\u9fff]/.test(term))
  );
}

export class SemanticMappingStore {
  public constructor(private readonly context: vscode.ExtensionContext) {}

  public list(paperHash?: string): SemanticMappingEdge[] {
    return this.context.workspaceState
      .get<SemanticMappingEdge[]>(MAPPINGS_KEY, [])
      .filter((edge) => !paperHash || edge.paperHash === paperHash)
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  public activeCount(paperHash?: string): number {
    return this.list(paperHash).filter((edge) => edge.status !== 'rejected' && edge.status !== 'stale').length;
  }

  /** Exact paper-anchor lookup used before semantic keyword retrieval. */
  public findByPaperChunks(
    chunkIds: Iterable<string>,
    paperHash?: string,
    limit = 20
  ): SemanticMappingEdge[] {
    const ids = new Set(chunkIds);
    if (!ids.size) return [];
    return this.list(paperHash)
      .filter((edge) => edge.status !== 'rejected' && edge.status !== 'stale' && ids.has(edge.paperChunkId))
      .sort((left, right) => {
        const status = Number(right.status === 'confirmed') - Number(left.status === 'confirmed');
        return status || right.confidence - left.confidence || right.updatedAt - left.updatedAt;
      })
      .slice(0, limit);
  }

  /** Exact/overlapping code-range lookup makes code → paper independent of wording. */
  public findByCodeRange(
    filePath: string,
    startLine: number,
    endLine: number,
    paperHash?: string,
    limit = 20
  ): SemanticMappingEdge[] {
    const normalizedPath = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
    return this.list(paperHash)
      .filter((edge) => {
        if (edge.status === 'rejected' || edge.status === 'stale') return false;
        const edgePath = edge.codeFilePath.replace(/\\/g, '/').replace(/^\.\//, '');
        return edgePath === normalizedPath && edge.codeStartLine <= endLine && edge.codeEndLine >= startLine;
      })
      .sort((left, right) => {
        const status = Number(right.status === 'confirmed') - Number(left.status === 'confirmed');
        const leftOverlap = Math.max(0, Math.min(endLine, left.codeEndLine) - Math.max(startLine, left.codeStartLine) + 1);
        const rightOverlap = Math.max(0, Math.min(endLine, right.codeEndLine) - Math.max(startLine, right.codeStartLine) + 1);
        return status || rightOverlap - leftOverlap || right.confidence - left.confidence;
      })
      .slice(0, limit);
  }

  public async add(edges: SemanticMappingEdge[]): Promise<void> {
    if (!edges.length) return;
    const current = this.list();
    const byId = new Map(current.map((edge) => [edge.id, edge]));
    for (const edge of edges) {
      const existing = byId.get(edge.id);
      byId.set(edge.id, existing
        ? {
            ...edge,
            status: existing.status,
            confidence: Math.max(existing.confidence, edge.confidence),
            createdAt: existing.createdAt,
            updatedAt: Date.now()
          }
        : edge);
    }
    await this.context.workspaceState.update(
      MAPPINGS_KEY,
      [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_MAPPINGS)
    );
  }

  public async setStatus(id: string, status: SemanticMappingStatus): Promise<void> {
    const next = this.list().map((edge) =>
      edge.id === id ? { ...edge, status, updatedAt: Date.now() } : edge
    );
    await this.context.workspaceState.update(MAPPINGS_KEY, next);
  }

  public async remove(id: string): Promise<void> {
    await this.context.workspaceState.update(
      MAPPINGS_KEY,
      this.list().filter((edge) => edge.id !== id)
    );
  }

  public search(query: string, paperHash?: string, limit = 8): SemanticMappingEdge[] {
    const needles = terms(query);
    return this.list(paperHash)
      .filter((edge) => edge.status !== 'rejected' && edge.status !== 'stale')
      .map((edge) => {
        const haystack = terms(
          `${edge.explanation} ${edge.paperPreview} ${edge.codeFilePath} ${edge.codeSymbolName ?? ''}`
        );
        let score = edge.status === 'confirmed' ? 8 : 2;
        let overlap = 0;
        for (const term of needles) {
          if (haystack.has(term)) {
            score += Math.min(6, term.length);
            overlap += 1;
          }
        }
        return { edge, score, overlap };
      })
      .filter(({ overlap }) => overlap > 0 || needles.size === 0)
      .sort((a, b) => b.score - a.score || b.edge.updatedAt - a.edge.updatedAt)
      .slice(0, limit)
      .map(({ edge }) => edge);
  }
}
