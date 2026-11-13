import type { EvidenceItem, PaperChunk } from './types.js';

function tokenize(text: string): string[] {
  const normalized = text.toLowerCase();
  const latin: string[] = normalized.match(/[a-z_][a-z0-9_.-]{1,}|\d+(?:\.\d+)?/g) ?? [];
  const chineseRuns = normalized.match(/[\u3400-\u9fff]+/g) ?? [];
  const chinese: string[] = [];

  for (const run of chineseRuns) {
    for (const char of run) {
      chinese.push(char);
    }
    for (let index = 0; index < run.length - 1; index += 1) {
      chinese.push(run.slice(index, index + 2));
    }
  }

  const bilingualTerms: Array<[RegExp, string[]]> = [
    [/实验|结果|表现|性能/, ['experiment', 'results', 'performance', 'benchmark']],
    [/模型|方法|架构|结构/, ['model', 'method', 'architecture', 'framework']],
    [/参数|规模|参数量/, ['parameter', 'parameters', 'param', 'size']],
    [/损失|目标函数/, ['loss', 'objective']],
    [/数据集|基准/, ['dataset', 'datasets', 'benchmark']],
    [/训练|优化/, ['training', 'train', 'optimization']],
    [/推理|预测/, ['inference', 'prediction', 'predict']],
    [/频率|频域/, ['frequency', 'spectrum']],
    [/专家|混合专家/, ['expert', 'experts', 'mixture']],
    [/消融/, ['ablation']],
    [/输入/, ['input']],
    [/输出/, ['output']],
    [/结论|总结/, ['conclusion']],
    [/限制|局限/, ['limitation', 'limitations']],
    [/公式|方程|等式/, ['formula', 'equation', 'eq']],
    [/图表|架构图|图像/, ['figure', 'diagram', 'architecture']],
    [/表格/, ['table']]
  ];
  for (const [pattern, terms] of bilingualTerms) {
    if (pattern.test(normalized)) {
      latin.push(...terms);
    }
  }

  return [...new Set([...latin, ...chinese])];
}

function termFrequency(text: string, token: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const found = text.indexOf(token, offset);
    if (found < 0) {
      return count;
    }
    count += 1;
    offset = found + Math.max(1, token.length);
  }
}

export function retrieveEvidence(
  query: string,
  chunks: PaperChunk[],
  limit: number
): EvidenceItem[] {
  if (chunks.length === 0) {
    return [];
  }

  const tokens = tokenize(query);
  const loweredQuery = query.trim().toLowerCase();
  const documentFrequency = new Map<string, number>();

  for (const token of tokens) {
    const frequency = chunks.reduce(
      (total, chunk) => total + (chunk.text.toLowerCase().includes(token) ? 1 : 0),
      0
    );
    documentFrequency.set(token, frequency);
  }

  const averageLength =
    chunks.reduce((total, chunk) => total + chunk.text.length, 0) / chunks.length || 1;
  const ranked = chunks
    .map((chunk) => {
      const lowered = chunk.text.toLowerCase();
      let score = loweredQuery.length > 3 && lowered.includes(loweredQuery) ? 12 : 0;
      // BM25 (k1=1.2, b=0.75): saturate tf and normalize chunk length so long chunks no longer outscore dense anchors.
      const lengthNorm = 0.25 + 0.75 * (lowered.length / averageLength);
      for (const token of tokens) {
        const tf = termFrequency(lowered, token);
        if (tf === 0) {
          continue;
        }
        const df = documentFrequency.get(token) ?? 0;
        const idf = Math.log(1 + (chunks.length - df + 0.5) / (df + 0.5));
        score += ((tf * 2.2) / (tf + 1.2 * lengthNorm)) * idf * Math.min(3, token.length);
      }
      if (/公式|方程|等式|formula|equation|\beq\b/i.test(query) && chunk.kind === 'formula') score += 18;
      if (/图表|架构图|figure|diagram/i.test(query) && chunk.kind === 'figure') score += 14;
      if (/表格|table/i.test(query) && chunk.kind === 'table') score += 14;
      if (chunk.section && loweredQuery.length > 2 && chunk.section.toLowerCase().includes(loweredQuery)) score += 8;
      return { chunk, score };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);

  // A zero lexical score is common when a user asks in a different language.
  // Prefer structurally useful sections over silently treating the first chunks as relevant.
  if (ranked.length === 0) {
    const sectionPattern = /abstract|introduction|method|approach|architecture|experiment|result|discussion|conclusion/i;
    const structural = chunks.filter((chunk) => sectionPattern.test(chunk.text));
    const pool = structural.length >= limit ? structural : chunks;
    const selected = new Map<string, PaperChunk>();
    for (let index = 0; index < Math.min(limit, pool.length); index += 1) {
      const position = pool.length <= limit
        ? index
        : Math.floor((index * (pool.length - 1)) / Math.max(1, limit - 1));
      const chunk = pool[position];
      if (chunk) {
        selected.set(chunk.id, chunk);
      }
    }
    return [...selected.values()].map((chunk, index) => ({
      ...chunk,
      citationId: `P${index + 1}`,
      score: 0
    }));
  }

  return ranked.map(({ chunk, score }, index) => ({
    ...chunk,
    citationId: `P${index + 1}`,
    score
  }));
}

/** Adds nearby definitions/captions needed to interpret a selected formula, figure, or table. */
export function expandStructuralEvidence(
  selected: EvidenceItem[],
  chunks: PaperChunk[],
  radius = 2
): EvidenceItem[] {
  const byId = new Map(selected.map((item) => [item.id, item]));
  for (const item of selected) {
    if (!['formula', 'figure', 'table'].includes(item.kind ?? '')) continue;
    const index = chunks.findIndex((chunk) => chunk.id === item.id);
    if (index < 0) continue;
    for (let offset = -radius; offset <= radius; offset += 1) {
      const neighbor = chunks[index + offset];
      if (!neighbor || neighbor.page !== item.page || byId.has(neighbor.id)) continue;
      byId.set(neighbor.id, {
        ...neighbor,
        citationId: '',
        score: Math.max(0, item.score - Math.abs(offset))
      });
    }
  }
  return [...byId.values()];
}

export function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
