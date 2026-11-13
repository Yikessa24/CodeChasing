import * as crypto from 'node:crypto';
import type { NormalizedBox, PaperChunk, PaperFormula } from './types.js';

export interface PageTextFragment {
  text: string;
  box: NormalizedBox;
  hasEOL: boolean;
}

interface TextLine {
  text: string;
  boxes: NormalizedBox[];
  x: number;
  y: number;
  height: number;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function mergeBoxes(boxes: NormalizedBox[]): NormalizedBox[] {
  const sorted = boxes
    .filter((box) => box.width > 0 && box.height > 0)
    .map((box) => ({
      x: clamp(box.x),
      y: clamp(box.y),
      width: clamp(box.width),
      height: clamp(box.height)
    }))
    .sort((left, right) => left.y - right.y || left.x - right.x);
  const lines: NormalizedBox[] = [];
  for (const box of sorted) {
    const previous = lines.at(-1);
    const sameLine =
      previous &&
      Math.abs(previous.y - box.y) < Math.max(0.004, box.height * 0.45) &&
      box.x <= previous.x + previous.width + 0.018;
    if (sameLine && previous) {
      const right = Math.max(previous.x + previous.width, box.x + box.width);
      const bottom = Math.max(previous.y + previous.height, box.y + box.height);
      previous.x = Math.min(previous.x, box.x);
      previous.y = Math.min(previous.y, box.y);
      previous.width = right - previous.x;
      previous.height = bottom - previous.y;
    } else {
      lines.push({ ...box });
    }
  }
  return lines;
}

function joinText(left: string, right: string): string {
  if (!left) {
    return right;
  }
  if (/[-‐-―]$/.test(left) && /^[a-z]/.test(right)) {
    return `${left.slice(0, -1)}${right}`;
  }
  if (/^[,.;:!?%)\]}]/.test(right)) {
    return `${left}${right}`;
  }
  return `${left} ${right}`;
}

function toLines(fragments: PageTextFragment[]): TextLine[] {
  const lines: TextLine[] = [];
  let text = '';
  let boxes: NormalizedBox[] = [];

  const flush = (): void => {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized && boxes.length) {
      lines.push({
        text: normalized,
        boxes: [...boxes],
        x: Math.min(...boxes.map((box) => box.x)),
        y: Math.min(...boxes.map((box) => box.y)),
        height: Math.max(...boxes.map((box) => box.height))
      });
    }
    text = '';
    boxes = [];
  };

  for (const fragment of fragments) {
    const value = fragment.text.replace(/\s+/g, ' ').trim();
    if (!value) {
      continue;
    }
    const previous = boxes.at(-1);
    const changedVisualLine =
      previous &&
      Math.abs(previous.y - fragment.box.y) > Math.max(0.005, previous.height * 0.65);
    const headingPrefix = /^(?:\d+(?:\.\d+)*\.?\s+|abstract|introduction|related work|method|experiments?|results?|discussion|conclusions?|references)/i.test(text.trim());
    const changedFromHeadingFont =
      previous && headingPrefix && text.trim().length >= 4 && previous.height > fragment.box.height * 1.18;
    if (changedVisualLine || changedFromHeadingFont) {
      flush();
    }
    text = joinText(text, value);
    boxes.push(fragment.box);
    if (fragment.hasEOL) {
      flush();
    }
  }
  flush();
  return lines;
}

function median(values: number[]): number {
  if (!values.length) {
    return 0.012;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0.012;
}

function looksLikeHeading(line: TextLine, bodyHeight: number): boolean {
  const text = line.text.trim();
  return (
    text.length <= 110 &&
    (line.height >= bodyHeight * 1.18 ||
      /^(?:abstract|introduction|related work|method(?:ology)?|experiments?|results?|discussion|conclusions?|references|acknowledg(?:e)?ments?|\d+(?:\.\d+)*\s+\S+)/i.test(
        text
      ))
  );
}

function looksLikeSectionHeading(line: TextLine, bodyHeight: number): boolean {
  const text = line.text.trim();
  if (!text || text.length > 140 || /[=≈≠≤≥∑∏∫√×÷⊙]|\b(?:where|peak|frequency bins|amplitude|arxiv|university|department|institute)\b/i.test(text)) {
    return false;
  }
  if (/^(?:abstract|introduction|related work|method(?:ology)?|experiments?|results?|discussion|conclusions?|references|acknowledg(?:e)?ments?)$/i.test(text)) {
    return line.height >= bodyHeight * 1.08;
  }
  const numbered = text.match(/^(\d+)(?:\.\d+)*\.?\s+[A-Z\u3400-\u9fff][\s\S]{2,}$/u);
  if (numbered) {
    return Number(numbered[1]) <= 50 && line.height >= bodyHeight * 1.04;
  }
  const letters = text.match(/[A-Za-z\u3400-\u9fff]/gu)?.length ?? 0;
  const words = text.split(/\s+/).length;
  return line.height >= bodyHeight * 1.55 && letters >= 8 && words >= 2 && !/[.;:,]$/.test(text);
}

function extractSectionHeading(text: string): string | undefined {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const match = normalized.match(/^((?:\d+(?:\.\d+)+\.?|\d+\.)\s+)(.+)$/);
  if (!match) return undefined;
  const prefix = match[1] ?? '';
  const remainder = match[2] ?? '';
  const sentenceBoundary = remainder.indexOf('. ');
  const proseTransition = remainder.match(
    /^(.{3,100}?)(?=\s+(?:We|The|This|These|Those|Our|In\s+this|As\s+noted|Denote|Let|Given|Taking|To\s+(?:enable|facilitate|examine|evaluate|reduce|further)|For\s+convenience|Specifically|LLIE\s+techniques|Retinex\s+theory)\b)/
  )?.[1];
  const sentenceTitle = sentenceBoundary > 0 ? remainder.slice(0, sentenceBoundary + 1) : undefined;
  const title = [sentenceTitle, proseTransition]
    .filter((candidate): candidate is string => Boolean(candidate))
    .sort((left, right) => left.length - right.length)[0] ?? remainder;
  return `${prefix}${title}`.trim().slice(0, 140);
}

function extractInlineSectionHeading(text: string): string | undefined {
  const candidates = [...text.matchAll(/(?:^|[.!?]\s+)(\d+(?:\.\d+)+\.?\s+[A-Z\u3400-\u9fff][\s\S]{3,220})/gu)]
    .map((match) => extractSectionHeading(match[1] ?? ''))
    .filter((candidate): candidate is string => Boolean(candidate));
  return candidates.at(-1);
}

function stableAnchorHash(text: string, boxes: NormalizedBox[]): string {
  const source = `${text}\n${boxes
    .map((box) => [box.x, box.y, box.width, box.height].map((value) => value.toFixed(5)).join(','))
    .join(';')}`;
  return crypto.createHash('sha256').update(source).digest('hex').slice(0, 20);
}

const FORMULA_STOP_WORDS = new Set([
  'and', 'the', 'for', 'with', 'where', 'from', 'this', 'that', 'our', 'are', 'is', 'of',
  'in', 'to', 'we', 'by', 'as', 'or', 'a', 'an', 'eq', 'equation'
]);

function formulaMetadata(text: string): PaperFormula | undefined {
  const compact = text.replace(/\s+/g, ' ').trim().normalize('NFKC');
  if (/\b(?:frequency bins|amplitude|peak\s*=|ccs concepts)\b/i.test(compact)) return undefined;
  const equationLabel = compact.match(/(?:Eq\.?\s*([A-Z]?\d+(?:\.\d+)*)|\(([A-Z]?\d+(?:\.\d+)*)\))\s*$/i);
  const operatorCount = compact.match(/[=≈≃≠≤≥∑∏∫√±×÷∈∉⊂⊆→←↦∂∇]/g)?.length ?? 0;
  const symbolCount = compact.match(/[α-ωΑ-Ω]|[_^]|\b(?:log|exp|softmax|sigmoid|argmax|min|max)\b/gi)?.length ?? 0;
  const candidateVariables = compact.match(/[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)?|[α-ωΑ-Ω]/g) ?? [];
  const proseWords = compact.match(/[A-Za-z]{4,}/g)?.length ?? 0;
  const looksFormula =
    compact.length <= 360 &&
    !(/^•/.test(compact) && !/=/.test(compact)) &&
    (operatorCount >= 2 || (operatorCount >= 1 && (symbolCount >= 1 || candidateVariables.length >= 2)) || symbolCount >= 3) &&
    proseWords <= 18;
  if (!looksFormula) return undefined;
  const variables = [
    ...new Set(
      candidateVariables
        .filter((value) => !FORMULA_STOP_WORDS.has(value.toLowerCase()))
        .slice(0, 40)
    )
  ];
  const relationMatch = compact.match(/(:=|≜|≡|≈|≃|≠|≤|≥|=|<|>)/);
  const relation = relationMatch?.[1];
  const relationIndex = relation ? compact.indexOf(relation) : -1;
  const operators = [
    ...new Set(compact.match(/(?:\+|−|-|×|÷|∑|∏|∫|√|∂|∇|⊙|⊗|softmax|sigmoid|argmax|argmin|log|exp)/gi) ?? [])
  ].slice(0, 30);
  const functions = [
    ...new Set(
      (compact.match(/\b[A-Za-z][A-Za-z0-9_]*\s*(?=\()/g) ?? [])
        .map((value) => value.trim())
        .filter((value) => !FORMULA_STOP_WORDS.has(value.toLowerCase()))
    )
  ].slice(0, 20);
  return {
    label: equationLabel?.[1] ?? equationLabel?.[2],
    normalizedText: compact,
    variables,
    relation,
    leftHandSide: relationIndex >= 0 ? compact.slice(0, relationIndex).trim() : undefined,
    rightHandSide: relationIndex >= 0 ? compact.slice(relationIndex + (relation?.length ?? 1)).replace(/\s*\([A-Z]?\d+(?:\.\d+)*\)\s*$/i, '').trim() : undefined,
    operators,
    functions
  };
}

function bracketBalance(text: string): number {
  let balance = 0;
  for (const character of text) {
    if ('([{'.includes(character)) balance += 1;
    if (')]}'.includes(character)) balance -= 1;
  }
  return balance;
}

function embeddedFormulaChunks(
  chunk: PaperChunk,
  paperHash: string,
  page: number,
  previousSection?: string
): PaperChunk[] {
  if (chunk.kind === 'heading' || !/[=≈≃≠≤≥≡≜]/u.test(chunk.text)) return [];
  const result: PaperChunk[] = [];
  const sectionOffset = chunk.section ? chunk.text.indexOf(chunk.section) : -1;
  for (const label of chunk.text.matchAll(/[,.;]?\s*\(([A-Z]?\d+(?:\.\d+)*)\)(?=\s|$)/gi)) {
    const end = (label.index ?? 0) + label[0].length;
    const before = chunk.text.slice(Math.max(0, end - 430), end);
    const relationIndex = Math.max(
      before.lastIndexOf('='), before.lastIndexOf('≈'), before.lastIndexOf('≃'),
      before.lastIndexOf('≤'), before.lastIndexOf('≥'), before.lastIndexOf('≡'), before.lastIndexOf('≜')
    );
    if (relationIndex < 0) continue;
    const boundarySearch = before.slice(0, Math.max(0, relationIndex - 3));
    const boundaries = [...boundarySearch.matchAll(/(?:[.!?]|\([A-Z]?\d+(?:\.\d+)*\))\s+(?=[A-Zˆ∆Δα-ωΑ-Ω])/gu)];
    const start = boundaries.at(-1)
      ? (boundaries.at(-1)!.index ?? 0) + boundaries.at(-1)![0].length
      : Math.max(0, relationIndex - 180);
    const text = before.slice(start).replace(/^\s*(?:and|where|then)\s+/i, '').trim();
    const formula = formulaMetadata(text);
    if (!formula) continue;
    const boxes = chunk.boxes;
    result.push({
      id: `${paperHash}:p${page}:h${stableAnchorHash(text, boxes)}`,
      page,
      text,
      boxes,
      kind: 'formula',
      section:
        previousSection && sectionOffset > (label.index ?? 0)
          ? previousSection
          : chunk.section,
      formula
    });
  }
  return [...new Map(result.map((item) => [item.id, item])).values()];
}

function mergeFormulaContinuations(
  chunks: PaperChunk[],
  paperHash: string,
  page: number
): PaperChunk[] {
  const result: PaperChunk[] = [];
  for (const chunk of chunks) {
    const previous = result.at(-1);
    const previousBottom = previous?.boxes.length
      ? Math.max(...previous.boxes.map((box) => box.y + box.height))
      : 0;
    const currentTop = chunk.boxes.length ? Math.min(...chunk.boxes.map((box) => box.y)) : 1;
    const continuation =
      previous?.kind === 'formula' &&
      chunk.kind === 'formula' &&
      !previous.formula?.label &&
      previous.section === chunk.section &&
      currentTop >= previousBottom - 0.01 &&
      currentTop - previousBottom < 0.055 &&
      (/(?:[=+,+\-−∑∏︁]|\b(?:sum|prod))\s*$/iu.test(previous.text) ||
        /^\s*(?:[=+\-−×÷]|where\b)/iu.test(chunk.text) ||
        bracketBalance(previous.text) > 0);
    if (!continuation || !previous) {
      result.push(chunk);
      continue;
    }
    const text = `${previous.text} ${chunk.text}`.replace(/\s+/g, ' ').trim();
    const boxes = mergeBoxes([...previous.boxes, ...chunk.boxes]);
    previous.text = text;
    previous.boxes = boxes;
    previous.formula = formulaMetadata(text);
    previous.id = `${paperHash}:p${page}:h${stableAnchorHash(text, boxes)}`;
  }
  return result;
}

function chunkKind(
  text: string,
  lines: TextLine[],
  bodyHeight: number
): { kind: PaperChunk['kind']; formula?: PaperFormula } {
  if (lines.length === 1 && looksLikeSectionHeading(lines[0]!, bodyHeight)) return { kind: 'heading' };
  if (
    /^(?:fig(?:ure)?\.?|图)\s*\d+/i.test(text) ||
    /\b(?:frequency bins|amplitude|peak\s*=)\b/i.test(text) ||
    (/\b(?:conv(?:olution)?|dwconv|fusion block|relu|feature map|input|output)\b/i.test(text) && !/[=≈≃≠≤≥≡≜]/u.test(text))
  ) return { kind: 'figure' };
  if (/^(?:table|表)\s*\d+/i.test(text)) return { kind: 'table' };
  const formula = formulaMetadata(text);
  return formula ? { kind: 'formula', formula } : { kind: 'paragraph' };
}

export interface PageChunkingResult {
  chunks: PaperChunk[];
  lastSection?: string;
}

/**
 * Builds compact visual/semantic anchors. A citation should highlight one heading,
 * paragraph, figure label group, or caption rather than a page-sized character bucket.
 */
export function buildPageChunks(
  paperHash: string,
  page: number,
  fragments: PageTextFragment[],
  initialSection?: string
): PaperChunk[] {
  return buildPageChunksWithState(paperHash, page, fragments, initialSection).chunks;
}

export function buildPageChunksWithState(
  paperHash: string,
  page: number,
  fragments: PageTextFragment[],
  initialSection?: string
): PageChunkingResult {
  const lines = toLines(fragments);
  const bodyHeight = median(lines.map((line) => line.height).filter((height) => height > 0));
  const chunks: PaperChunk[] = [];
  let blockLines: TextLine[] = [];
  let characterCount = 0;
  let currentSection = initialSection;

  const flush = (): void => {
    const text = blockLines.reduce((joined, line) => joinText(joined, line.text), '').trim();
    if (text) {
      const mergedBoxes = mergeBoxes(blockLines.flatMap((line) => line.boxes));
      const classification = chunkKind(text, blockLines, bodyHeight);
      const previousSection = currentSection;
      const detectedSection =
        classification.kind === 'heading'
          ? extractSectionHeading(text) ?? text
          : extractSectionHeading(text) ?? extractInlineSectionHeading(text);
      if (
        detectedSection &&
        classification.kind !== 'heading' &&
        /^\d+(?:\.\d+)+\.?\s+/u.test(detectedSection) &&
        text.length > detectedSection.length + 8
      ) {
        const headingBoxes = mergeBoxes(blockLines[0]?.boxes ?? mergedBoxes);
        chunks.push({
          id: `${paperHash}:p${page}:h${stableAnchorHash(detectedSection, headingBoxes)}`,
          page,
          text: detectedSection,
          boxes: headingBoxes,
          kind: 'heading',
          section: detectedSection
        });
      }
      const chunk: PaperChunk = {
        id: `${paperHash}:p${page}:h${stableAnchorHash(text, mergedBoxes)}`,
        page,
        text,
        boxes: mergedBoxes,
        kind: classification.kind,
        section: detectedSection ?? currentSection,
        formula: classification.formula
      };
      chunks.push(chunk);
      chunks.push(...embeddedFormulaChunks(chunk, paperHash, page, previousSection).filter((formulaChunk) => formulaChunk.id !== chunk.id));
      if (detectedSection) currentSection = detectedSection;
    }
    blockLines = [];
    characterCount = 0;
  };

  for (const line of lines) {
    const previous = blockLines.at(-1);
    const heading = looksLikeHeading(line, bodyHeight);
    const previousHeading = previous ? looksLikeHeading(previous, bodyHeight) : false;
    const changedColumn =
      previous && Math.abs(line.x - previous.x) > 0.22 && line.y + 0.04 < previous.y;
    const verticalGap =
      previous && line.y - (previous.y + previous.height) > Math.max(0.013, bodyHeight * 1.25);
    const startsIndentedParagraph =
      previous &&
      line.x - previous.x > 0.012 &&
      /[.!?]\s*$/.test(previous.text) &&
      characterCount >= 90;
    const exceedsCompactAnchor = characterCount > 0 && characterCount + line.text.length > 460;

    if (
      blockLines.length &&
      (heading || previousHeading || changedColumn || verticalGap || startsIndentedParagraph || exceedsCompactAnchor)
    ) {
      flush();
    }
    blockLines.push(line);
    characterCount += line.text.length + 1;
    if (heading) {
      flush();
    }
  }
  flush();
  return { chunks: mergeFormulaContinuations(chunks, paperHash, page), lastSection: currentSection };
}

export function requireExtractableText(chunks: PaperChunk[]): void {
  if (chunks.length === 0) {
    throw new Error(
      'No extractable text was found. This PDF may be scanned or image-only; OCR is not available yet.'
    );
  }
}
