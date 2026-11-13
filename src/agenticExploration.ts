export type ExplorationAction =
  | { tool: 'list_files'; path?: string }
  | { tool: 'search_code'; query: string }
  | { tool: 'read_file'; path: string; startLine?: number; endLine?: number }
  | { tool: 'search_paper'; query: string }
  | { tool: 'read_paper_pages'; pages: number[] };

export interface ExplorationPlan {
  done: boolean;
  actions: ExplorationAction[];
}

function jsonObject(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = (fenced ?? raw).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return undefined;
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : fallback;
}

export function parseExplorationPlan(raw: string, maxActions = 4): ExplorationPlan | undefined {
  const parsed = jsonObject(raw);
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }
  const value = parsed as { done?: unknown; actions?: unknown };
  if (!Array.isArray(value.actions)) {
    return undefined;
  }
  const actions: ExplorationAction[] = [];
  for (const candidate of value.actions.slice(0, maxActions)) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }
    const action = candidate as Record<string, unknown>;
    if (action.tool === 'list_files') {
      actions.push({
        tool: 'list_files',
        path: typeof action.path === 'string' ? action.path.slice(0, 500) : undefined
      });
    } else if (action.tool === 'search_code' && typeof action.query === 'string') {
      actions.push({ tool: 'search_code', query: action.query.slice(0, 500) });
    } else if (
      action.tool === 'read_file' &&
      typeof action.path === 'string' &&
      action.path.trim()
    ) {
      const startLine = positiveInteger(action.startLine, 1);
      const endLine = Math.min(
        startLine + 399,
        Math.max(startLine, positiveInteger(action.endLine, startLine + 199))
      );
      actions.push({
        tool: 'read_file',
        path: action.path.slice(0, 1000),
        startLine,
        endLine
      });
    } else if (action.tool === 'search_paper' && typeof action.query === 'string') {
      actions.push({ tool: 'search_paper', query: action.query.slice(0, 500) });
    } else if (action.tool === 'read_paper_pages' && Array.isArray(action.pages)) {
      const pages = [
        ...new Set(
          action.pages
            .map((page) => positiveInteger(page, 0))
            .filter((page) => page > 0)
            .slice(0, 8)
        )
      ];
      if (pages.length) {
        actions.push({ tool: 'read_paper_pages', pages });
      }
    }
  }
  return { done: value.done === true, actions };
}

export function findTextLineMatches(
  text: string,
  query: string,
  maxMatches = 3
): Array<{ line: number; preview: string }> {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) {
    return [];
  }
  const terms = [
    needle,
    ...needle
      .split(/[^\p{L}\p{N}_.$-]+/u)
      .filter((term) => term.length >= 2)
      .sort((left, right) => right.length - left.length)
  ];
  const uniqueTerms = [...new Set(terms)];
  const lines = text.split(/\r?\n/);
  const matches: Array<{ line: number; preview: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const lower = line.toLowerCase();
    if (!uniqueTerms.some((term) => lower.includes(term))) {
      continue;
    }
    matches.push({ line: index + 1, preview: line.trim().slice(0, 500) });
    if (matches.length >= maxMatches) {
      break;
    }
  }
  return matches;
}
