import type { EvidenceItem } from './types.js';

interface Quantity {
  value: number;
  kind: 'count' | 'percent';
}

function quantities(text: string): Quantity[] {
  const matches = text.matchAll(/(?<![\w.])(\d+(?:,\d{3})*(?:\.\d+)?)\s*(k|m|b|%|％)?/gi);
  const result: Quantity[] = [];
  for (const match of matches) {
    const raw = Number((match[1] ?? '').replaceAll(',', ''));
    if (!Number.isFinite(raw)) {
      continue;
    }
    const unit = (match[2] ?? '').toLowerCase();
    const multiplier = unit === 'k' ? 1e3 : unit === 'm' ? 1e6 : unit === 'b' ? 1e9 : 1;
    result.push({ value: raw * multiplier, kind: unit === '%' || unit === '％' ? 'percent' : 'count' });
  }
  return result;
}

function equivalent(left: Quantity, right: Quantity): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  const scale = Math.max(1, Math.abs(left.value), Math.abs(right.value));
  return Math.abs(left.value - right.value) / scale < 0.0001;
}

function precedingClaim(text: string, citationOffset: number): string {
  const prefix = text.slice(Math.max(0, citationOffset - 700), citationOffset);
  const boundary = Math.max(
    prefix.lastIndexOf('\n'),
    prefix.lastIndexOf('。'),
    prefix.lastIndexOf('！'),
    prefix.lastIndexOf('？'),
    prefix.lastIndexOf('. '),
    prefix.lastIndexOf('! '),
    prefix.lastIndexOf('? ')
  );
  return prefix.slice(boundary + 1).trim();
}

export interface CitationValidationResult {
  text: string;
  validIds: string[];
  mismatchCount: number;
}

export interface ParsedCitationAudit {
  validPaperIds: string[];
  validCodeIds: string[];
}

export function unavailableCitationAudit(): ParsedCitationAudit {
  return { validPaperIds: [], validCodeIds: [] };
}

export function parseCitationAuditResponse(
  response: string,
  paperIds: string[],
  codeIds: string[]
): ParsedCitationAudit | undefined {
  const jsonText = response.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonText) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(jsonText) as {
      validPaperIds?: unknown;
      validCodeIds?: unknown;
    };
    if (
      !parsed ||
      !Array.isArray(parsed.validPaperIds) ||
      !Array.isArray(parsed.validCodeIds) ||
      !parsed.validPaperIds.every((id) => typeof id === 'string') ||
      !parsed.validCodeIds.every((id) => typeof id === 'string')
    ) return undefined;
    const allowedPaper = new Set(paperIds);
    const allowedCode = new Set(codeIds);
    return {
      validPaperIds: Array.isArray(parsed.validPaperIds)
        ? parsed.validPaperIds.filter(
            (id): id is string => typeof id === 'string' && allowedPaper.has(id)
          )
        : [],
      validCodeIds: Array.isArray(parsed.validCodeIds)
        ? parsed.validCodeIds.filter(
            (id): id is string => typeof id === 'string' && allowedCode.has(id)
          )
        : []
    };
  } catch {
    return undefined;
  }
}

/**
 * Performs a conservative local check that quantities in the cited claim occur in
 * the cited evidence. It catches common fluent-model failures such as attaching a
 * real anchor to an invented parameter count, while leaving translation to the model.
 */
export function validatePaperCitations(
  answer: string,
  evidence: EvidenceItem[]
): CitationValidationResult {
  const evidenceById = new Map(evidence.map((item) => [item.citationId, item]));
  const validIds = new Set<string>();
  let mismatchCount = 0;
  const text = answer.replace(/(?:\s*\[P\d+\])+/g, (cluster, offset: number) => {
    const ids = [...cluster.matchAll(/\[(P\d+)]/g)]
      .map((match) => match[1])
      .filter((id): id is string => Boolean(id));
    const items = ids
      .map((id) => evidenceById.get(id))
      .filter((item): item is EvidenceItem => Boolean(item));
    if (items.length !== ids.length) {
      mismatchCount += 1;
      return ' [无效引用]';
    }

    const claimQuantities = quantities(precedingClaim(answer, offset));
    const evidenceQuantities = quantities(items.map((item) => item.text).join('\n'));
    const quantitiesSupported = claimQuantities.every((claim) =>
      evidenceQuantities.some((source) => equivalent(claim, source))
    );
    if (!quantitiesSupported) {
      mismatchCount += 1;
      return ' [证据不匹配]';
    }
    for (const id of ids) {
      validIds.add(id);
    }
    return cluster;
  });

  return { text, validIds: [...validIds], mismatchCount };
}
