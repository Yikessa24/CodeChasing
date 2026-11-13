import * as crypto from 'node:crypto';
import type { AssistantAnswer, PersistentExample, TensorTraceStep } from './types.js';

function jsonObject(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = (fenced ?? raw).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return undefined; }
}

function text(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export function parsePersistentExample(
  raw: string,
  answer: AssistantAnswer,
  now = Date.now()
): PersistentExample | undefined {
  const parsed = jsonObject(raw);
  if (!parsed || typeof parsed !== 'object') return undefined;
  const value = parsed as Record<string, unknown>;
  const title = text(value.title, 160);
  const inputDescription = text(value.inputDescription, 1200);
  if (!title || !inputDescription) return undefined;
  const dimensions: Record<string, string> = {};
  if (value.dimensions && typeof value.dimensions === 'object' && !Array.isArray(value.dimensions)) {
    for (const [key, dimension] of Object.entries(value.dimensions as Record<string, unknown>).slice(0, 50)) {
      const normalizedKey = text(key, 80);
      const normalizedValue = text(dimension, 160);
      if (normalizedKey && normalizedValue) dimensions[normalizedKey] = normalizedValue;
    }
  }
  const paperById = new Map(answer.citations.map((citation) => [citation.citationId, citation]));
  const codeById = new Map(answer.codeLocations.map((location) => [location.codeId, location]));
  const allowedBasis = new Set<TensorTraceStep['basis']>(['code', 'paper', 'inferred', 'assumed', 'runtime']);
  const trace: TensorTraceStep[] = [];
  const generatedAssumptions: string[] = [];
  const latestShapeByVariable = new Map<string, string>();
  for (const [index, candidate] of (Array.isArray(value.trace) ? value.trace : []).slice(0, 80).entries()) {
    if (!candidate || typeof candidate !== 'object') continue;
    const step = candidate as Record<string, unknown>;
    const stage = text(step.stage, 180);
    const operation = text(step.operation, 500);
    if (!stage || !operation) continue;
    const basisValue = text(step.basis, 20) as TensorTraceStep['basis'];
    const paperId = text(step.paperId, 20);
    const codeId = text(step.codeId, 20);
    const code = codeById.get(codeId);
    const paper = paperById.get(paperId);
    let basis = allowedBasis.has(basisValue) ? basisValue : 'inferred';
    if (basis === 'code' && !code) basis = 'inferred';
    if (basis === 'paper' && !paper) basis = 'inferred';
    if (basis === 'runtime') {
      basis = 'inferred';
      generatedAssumptions.push(`“${stage}”没有由插件运行时采样验证，因此按静态推断保存。`);
    }
    const variable = text(step.variable, 160) || 'value';
    const inputShape = text(step.inputShape, 220) || 'unknown';
    const outputShape = text(step.outputShape, 220) || 'unknown';
    const previousShape = latestShapeByVariable.get(variable);
    if (
      previousShape &&
      inputShape !== 'unknown' &&
      previousShape !== 'unknown' &&
      previousShape.replace(/\s+/g, '') !== inputShape.replace(/\s+/g, '')
    ) {
      generatedAssumptions.push(
        `${variable} 在“${stage}”前的输入形状 ${inputShape} 与上一已保存输出 ${previousShape} 不一致，需要重新检查中间操作。`
      );
      basis = 'inferred';
    }
    latestShapeByVariable.set(variable, outputShape);
    trace.push({
      order: index + 1,
      stage,
      variable,
      inputShape,
      operation,
      outputShape,
      basis,
      codeReference: code ? {
        filePath: code.filePath,
        startLine: code.startLine,
        endLine: code.endLine,
        preview: code.symbolName
      } : undefined,
      paperCitation: paper
    });
  }
  const assumptions = [...(Array.isArray(value.assumptions) ? value.assumptions : []), ...generatedAssumptions]
    .map((item) => text(item, 300))
    .filter(Boolean)
    .slice(0, 30);
  const id = crypto.createHash('sha256')
    .update(`${title}\n${inputDescription}\n${JSON.stringify(dimensions)}`)
    .digest('hex')
    .slice(0, 20);
  return { id, title, inputDescription, dimensions, assumptions, trace, updatedAt: now };
}

export function persistentExampleContext(example?: PersistentExample): string {
  if (!example) return '(No structured running example has been established yet.)';
  const dimensions = Object.entries(example.dimensions)
    .map(([name, value]) => `${name}=${value}`)
    .join(', ');
  const trace = example.trace
    .map((step) => `${step.order}. ${step.stage}: ${step.variable} ${step.inputShape} --${step.operation}--> ${step.outputShape} [${step.basis}]`)
    .join('\n');
  return `Example: ${example.title}\nInput: ${example.inputDescription}\nDimensions: ${dimensions || '(none)'}\nAssumptions: ${example.assumptions.join('; ') || '(none)'}\nTrace:\n${trace || '(not traced yet)'}`;
}

function exampleTerms(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z_][a-z0-9_-]{1,}|[\u3400-\u9fff]{2,}/g) ?? []);
}

function sameExample(left: PersistentExample, right: PersistentExample): boolean {
  if (left.id === right.id) return true;
  const leftTerms = exampleTerms(`${left.title} ${left.inputDescription}`);
  const rightTerms = exampleTerms(`${right.title} ${right.inputDescription}`);
  let overlap = 0;
  for (const term of leftTerms) if (rightTerms.has(term)) overlap += 1;
  return overlap >= 2 || (overlap >= 1 && Math.min(leftTerms.size, rightTerms.size) <= 3);
}

function stepKey(step: TensorTraceStep): string {
  return `${step.stage}|${step.variable}`.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Merges new model-extracted stages with the already verified conversation trace.
 * Existing source anchors survive when an auxiliary extraction omits them, while a
 * genuinely different input starts a clean example instead of contaminating it.
 */
export function mergePersistentExamples(
  existing: PersistentExample | undefined,
  incoming: PersistentExample
): PersistentExample {
  if (!existing || !sameExample(existing, incoming)) return incoming;
  const merged = existing.trace.map((step) => ({ ...step }));
  const positions = new Map(merged.map((step, index) => [stepKey(step), index]));
  for (const step of incoming.trace) {
    const key = stepKey(step);
    const index = positions.get(key);
    if (index === undefined) {
      positions.set(key, merged.length);
      merged.push({ ...step });
      continue;
    }
    const previous = merged[index]!;
    merged[index] = {
      ...previous,
      ...step,
      codeReference: step.codeReference ?? previous.codeReference,
      paperCitation: step.paperCitation ?? previous.paperCitation,
      basis:
        step.basis === 'inferred' && previous.basis !== 'inferred'
          ? previous.basis
          : step.basis
    };
  }
  const trace = merged.map((step, index) => ({ ...step, order: index + 1 }));
  return {
    ...incoming,
    id: existing.id,
    dimensions: { ...existing.dimensions, ...incoming.dimensions },
    assumptions: [...new Set([...existing.assumptions, ...incoming.assumptions])].slice(0, 40),
    trace,
    updatedAt: Math.max(existing.updatedAt, incoming.updatedAt)
  };
}
