export interface NormalizedBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PaperChunk {
  id: string;
  page: number;
  text: string;
  boxes: NormalizedBox[];
  kind?: 'heading' | 'paragraph' | 'formula' | 'figure' | 'table';
  section?: string;
  formula?: PaperFormula;
  source?: 'pdf-text' | 'ocr' | 'vision';
  visual?: PaperVisual;
}

export interface PaperVisual {
  kind: 'figure' | 'diagram' | 'chart' | 'table' | 'formula' | 'image';
  title?: string;
  description: string;
  visibleText?: string;
  latex?: string;
}

export interface PaperFormula {
  label?: string;
  normalizedText: string;
  variables: string[];
  relation?: string;
  leftHandSide?: string;
  rightHandSide?: string;
  operators?: string[];
  functions?: string[];
}

export interface PaperMetadata {
  hash: string;
  title: string;
  sourceUri: string;
  storedPdfUri: string;
  importedAt: string;
  pageCount?: number;
  extractionStatus: 'pending' | 'ready' | 'failed' | 'paused';
  indexVersion?: number;
  ocrPageCount?: number;
  visualPageCount?: number;
  visionModelSignature?: string;
}

export interface PaperRecord {
  metadata: PaperMetadata;
  chunks: PaperChunk[];
}

export interface EvidenceItem extends PaperChunk {
  citationId: string;
  score: number;
}

export interface CodeContext {
  id: string;
  filePath: string;
  languageId: string;
  symbolName?: string;
  startLine: number;
  endLine: number;
  text: string;
  score?: number;
}

export type SemanticMappingStatus = 'candidate' | 'confirmed' | 'rejected' | 'stale';
export type SemanticMappingRelation =
  | 'implements'
  | 'calls'
  | 'input'
  | 'output'
  | 'configures'
  | 'trains'
  | 'evaluates'
  | 'supports';

export interface SemanticMappingEdge {
  id: string;
  paperHash: string;
  paperChunkId: string;
  paperPage: number;
  paperPreview: string;
  paperBoxes?: NormalizedBox[];
  codeFilePath: string;
  codeStartLine: number;
  codeEndLine: number;
  codeSymbolName?: string;
  codeContentHash: string;
  codePreview: string;
  relation: SemanticMappingRelation;
  explanation: string;
  status: SemanticMappingStatus;
  confidence: number;
  sourceConversationId: string;
  createdAt: number;
  updatedAt: number;
}

export interface CallGraphNode {
  id: string;
  filePath: string;
  symbolName: string;
  startLine: number;
  endLine: number;
  languageId: string;
  root?: boolean;
}

export interface CallGraphEdge {
  from: string;
  to: string;
  kind: 'calls' | 'references';
  confidence: number;
  callSiteLine?: number;
  expression?: string;
}

export interface CallGraph {
  nodes: CallGraphNode[];
  edges: CallGraphEdge[];
  totalProjectSymbols?: number;
  unresolvedCallCount?: number;
  truncated?: boolean;
}

export interface TensorTraceStep {
  order: number;
  stage: string;
  variable: string;
  inputShape: string;
  operation: string;
  outputShape: string;
  basis: 'code' | 'paper' | 'inferred' | 'assumed' | 'runtime';
  codeReference?: CodeSelectionReference;
  paperCitation?: PaperCitation;
}

export interface PersistentExample {
  id: string;
  title: string;
  assumptions: string[];
  inputDescription: string;
  dimensions: Record<string, string>;
  trace: TensorTraceStep[];
  updatedAt: number;
}

export interface CodeSelectionReference {
  filePath: string;
  startLine: number;
  endLine: number;
  preview?: string;
}

export interface PaperAttachmentReference {
  hash: string;
  title: string;
  pageCount?: number;
}

export interface PaperCitation {
  citationId: string;
  chunkId: string;
  paperHash?: string;
  page: number;
  preview: string;
  boxes?: NormalizedBox[];
}

export interface PaperTextSelection {
  paperHash: string;
  page: number;
  text: string;
  boxes: NormalizedBox[];
}

export interface AssistantAnswer {
  text: string;
  citations: PaperCitation[];
  codeLocations: Array<{
    codeId: string;
    filePath: string;
    startLine: number;
    endLine: number;
    symbolName?: string;
  }>;
}

export type ProviderType = 'openai-compatible' | 'anthropic' | 'gemini';
export type ReasoningEffort = 'auto' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface ProviderConfig {
  provider: ProviderType;
  baseUrl: string;
  model: string;
  apiKey?: string;
  reasoningEffort: ReasoningEffort;
}

export interface ModelImageInput {
  dataUrl: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  label: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  answer?: AssistantAnswer;
  quotedText?: string;
  quotedCitations?: PaperCitation[];
  codeSelection?: CodeSelectionReference;
  paperAttachment?: PaperAttachmentReference;
  images?: ModelImageInput[];
}
