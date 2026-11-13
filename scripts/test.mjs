import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);

const result = await build({
  entryPoints: ['src/retrieval.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'silent'
});

const bundled = result.outputFiles?.[0]?.text;
assert.ok(bundled, 'retrieval bundle should be generated');
const module = { exports: {} };
vm.runInNewContext(bundled, { module, exports: module.exports, console });
const { retrieveEvidence, expandStructuralEvidence } = module.exports;

const citationBuild = await build({
  entryPoints: ['src/citationValidation.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'silent'
});
const citationModule = { exports: {} };
vm.runInNewContext(citationBuild.outputFiles[0].text, {
  module: citationModule,
  exports: citationModule.exports
});
const unavailableAudit = citationModule.exports.unavailableCitationAudit();
assert.equal(
  unavailableAudit.validPaperIds.length + unavailableAudit.validCodeIds.length,
  0,
  'an unavailable semantic citation audit must fail closed'
);

const visionProviderBuild = await build({
  entryPoints: ['src/modelProviders.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'silent'
});
const visionProviderModule = { exports: {} };
vm.runInNewContext(visionProviderBuild.outputFiles[0].text, {
  module: visionProviderModule,
  exports: visionProviderModule.exports,
  require,
  fetch,
  TextDecoder,
  AbortController
});
const imageMessage = {
  role: 'user',
  content: 'Inspect PDF page 2.',
  images: [{
    dataUrl: 'data:image/jpeg;base64,ZmFrZQ==',
    mimeType: 'image/jpeg',
    label: 'PDF page 2'
  }]
};
const openAiVisionPayload = visionProviderModule.exports.openAIMessagePayload(imageMessage);
assert.equal(openAiVisionPayload.content[1].type, 'image_url');
assert.match(openAiVisionPayload.content[1].image_url.url, /^data:image\/jpeg;base64,/);
const anthropicVisionPayload = visionProviderModule.exports.anthropicMessagePayload(imageMessage);
assert.equal(anthropicVisionPayload.content[0].source.media_type, 'image/jpeg');
assert.equal(anthropicVisionPayload.content[0].source.data, 'ZmFrZQ==');
const geminiVisionPayload = visionProviderModule.exports.geminiMessagePayload(imageMessage);
assert.equal(geminiVisionPayload.parts[0].inlineData.mimeType, 'image/jpeg');
assert.equal(geminiVisionPayload.parts[0].inlineData.data, 'ZmFrZQ==');

const paperVisionBuild = await build({
  entryPoints: ['src/paperVision.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'silent'
});
const paperVisionModule = { exports: {} };
vm.runInNewContext(paperVisionBuild.outputFiles[0].text, {
  module: paperVisionModule,
  exports: paperVisionModule.exports,
  require
});
assert.deepEqual(
  [...paperVisionModule.exports.pagesNeedingOcr([
    { page: 1, characterCount: 0, fragmentCount: 0 },
    { page: 2, characterCount: 1200, fragmentCount: 80 },
    { page: 3, characterCount: 20, fragmentCount: 2 }
  ])],
  [1, 3]
);
const visualChunks = paperVisionModule.exports.parsePaperVisionResponse(
  JSON.stringify({
    pages: [{
      page: 2,
      ocr: [{ text: '3 Proposed Method', kind: 'heading', box: [0.1, 0.1, 0.5, 0.05] }],
      visuals: [{
        kind: 'diagram',
        title: 'Overview',
        description: 'Three feature branches merge into one decoder.',
        visibleText: 'Input, Branch A, Branch B, Output',
        box: [120, 200, 750, 500]
      }, {
        kind: 'formula',
        description: 'A normalized weighted sum.',
        latex: 'y = \\sum_i w_i x_i',
        box: [0.2, 0.75, 0.6, 0.08]
      }]
    }]
  }),
  'paperhash',
  [2],
  'ocr'
);
assert.equal(visualChunks.filter((chunk) => chunk.source === 'ocr').length, 1);
assert.equal(visualChunks.filter((chunk) => chunk.source === 'vision').length, 2);
assert.equal(visualChunks.find((chunk) => chunk.visual?.kind === 'diagram')?.page, 2);
assert.equal(visualChunks.find((chunk) => chunk.visual?.kind === 'diagram')?.boxes[0].x, 0.12);
assert.equal(visualChunks.find((chunk) => chunk.kind === 'formula')?.formula?.relation, '=');
assert.match(paperVisionModule.exports.paperVisionPrompt([2, 4], 'visual'), /2, 4/);

const workspaceSafetyBuild = await build({
  entryPoints: ['src/workspaceSafety.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'silent'
});
const workspaceSafetyModule = { exports: {} };
vm.runInNewContext(workspaceSafetyBuild.outputFiles[0].text, {
  module: workspaceSafetyModule,
  exports: workspaceSafetyModule.exports
});
const { isSensitiveWorkspacePath } = workspaceSafetyModule.exports;
for (const sensitivePath of [
  '.env',
  'config/.env.production',
  '.ssh/id_rsa',
  'certs/server.pem',
  'cloud/service-account-prod.json',
  'config/secrets.yaml'
]) {
  assert.equal(isSensitiveWorkspacePath(sensitivePath), true, `${sensitivePath} must be protected`);
}

const mappingBuild = await build({
  entryPoints: ['src/semanticMappingStore.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
  write: false,
  logLevel: 'silent'
});
const mappingModule = { exports: {} };
vm.runInNewContext(mappingBuild.outputFiles[0].text, {
  module: mappingModule,
  exports: mappingModule.exports,
  require: (id) => id === 'vscode' ? {} : require(id)
});
const mappedAnswer = {
  text: 'The paper operation is implemented by Model.forward. [P1] [C1]',
  citations: [{ citationId: 'P1', chunkId: 'paper:p3:h1', page: 3, preview: 'paper method', boxes: [] }],
  codeLocations: [{ codeId: 'C1', filePath: 'src/model.py', startLine: 10, endLine: 20, symbolName: 'Model.forward' }]
};
const learnedMappings = mappingModule.exports.deriveSemanticMappings(
  mappedAnswer,
  [{ id: '', filePath: 'src/model.py', languageId: 'python', startLine: 10, endLine: 20, symbolName: 'Model.forward', text: 'def forward(self, x):\n    return self.block(x)' }],
  'paper',
  'conversation',
  100
);
assert.equal(learnedMappings.length, 1, 'a locally co-cited paper/code claim should produce one mapping');
assert.equal(learnedMappings[0].relation, 'implements');
assert.equal(learnedMappings[0].status, 'candidate');
const adjacentMappings = mappingModule.exports.deriveSemanticMappings(
  { ...mappedAnswer, text: 'The paper defines the operation. [P1]\nModel.forward implements it. [C1]' },
  [{ id: '', filePath: 'src/model.py', languageId: 'python', startLine: 10, endLine: 20, symbolName: 'Model.forward', text: 'def forward(self, x):\n    return self.block(x)' }],
  'paper',
  'conversation'
);
assert.equal(adjacentMappings.length, 1, 'adjacent paper/code bullets should become a reviewable candidate');
assert.equal(adjacentMappings[0].confidence, 0.62);
assert.equal(
  mappingModule.exports.deriveSemanticMappings(
    { ...mappedAnswer, text: 'Paper-only claim. [P1]' },
    [],
    'paper',
    'conversation'
  ).length,
  0,
  'paper-only claims must not be promoted to paper-code mappings'
);
const mappingState = new Map();
const mappingStore = new mappingModule.exports.SemanticMappingStore({
  workspaceState: {
    get: (key, fallback) => mappingState.has(key) ? mappingState.get(key) : fallback,
    update: async (key, value) => { mappingState.set(key, value); }
  }
});
await mappingStore.add(learnedMappings);
assert.equal(mappingStore.findByPaperChunks(['paper:p3:h1'], 'paper').length, 1, 'paper anchors must support exact paper → code lookup');
assert.equal(mappingStore.findByCodeRange('src/model.py', 15, 15, 'paper').length, 1, 'an overlapping selection must support exact code → paper lookup');
assert.equal(mappingStore.findByCodeRange('src/other.py', 15, 15, 'paper').length, 0);
await mappingStore.setStatus(learnedMappings[0].id, 'rejected');
assert.equal(mappingStore.activeCount('paper'), 0, 'rejected mappings must not be advertised as active');

const exampleBuild = await build({
  entryPoints: ['src/persistentExample.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'silent'
});
const exampleModule = { exports: {} };
vm.runInNewContext(exampleBuild.outputFiles[0].text, {
  module: exampleModule,
  exports: exampleModule.exports,
  require
});
const persistent = exampleModule.exports.parsePersistentExample(
  JSON.stringify({
    title: 'One image',
    inputDescription: 'A batch of low-light RGB images',
    dimensions: { B: '8', C: '3', H: '256', W: '256' },
    assumptions: ['B=8 is an example assumption'],
    trace: [{ stage: 'encoder', variable: 'x', inputShape: '[B,C,H,W]', operation: 'permute', outputShape: '[B,H,W,C]', basis: 'code', paperId: 'P1', codeId: 'C1' }]
  }),
  mappedAnswer,
  100
);
assert.equal(persistent.trace.length, 1);
assert.equal(persistent.trace[0].paperCitation.chunkId, 'paper:p3:h1');
assert.equal(persistent.trace[0].codeReference.filePath, 'src/model.py');
assert.match(exampleModule.exports.persistentExampleContext(persistent), /\[B,H,W,C\]/);
const mergedPersistent = exampleModule.exports.mergePersistentExamples(
  persistent,
  {
    ...persistent,
    trace: [
      { order: 1, stage: 'encoder', variable: 'x', inputShape: '[B,C,H,W]', operation: 'permute', outputShape: '[B,H,W,C]', basis: 'inferred' },
      { order: 2, stage: 'head', variable: 'logits', inputShape: '[B,H,W,C]', operation: 'linear', outputShape: '[B,H,W,10]', basis: 'code' }
    ],
    dimensions: { C: '3', K: '10' },
    assumptions: ['K=10 comes from the configured head'],
    updatedAt: 200
  }
);
assert.equal(mergedPersistent.trace.length, 2, 'new trace stages should be appended without losing prior stages');
assert.equal(mergedPersistent.trace[0].codeReference.filePath, 'src/model.py', 'old exact anchors should survive an auxiliary extraction that omits them');
assert.equal(mergedPersistent.dimensions.B, '8');
assert.equal(mergedPersistent.dimensions.K, '10');

const shapeBuild = await build({
  entryPoints: ['src/shapeInference.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'silent'
});
const shapeModule = { exports: {} };
vm.runInNewContext(shapeBuild.outputFiles[0].text, {
  module: shapeModule,
  exports: shapeModule.exports
});
const shapeFacts = shapeModule.exports.inferStaticShapeFacts([{
  filePath: 'src/model.py', startLine: 20, endLine: 26, languageId: 'python', id: '',
  text: 'self.head = nn.Linear(C, 10)\nB, C, H, W = x.shape\ny = x.permute(0, 2, 3, 1)\nz = y.reshape(B, H * W, C)\nlogits = self.head(z)\npooled = logits.mean(dim=1)\nexpanded = pooled.unsqueeze(1)'
}]);
assert.deepEqual([...shapeFacts.map((fact) => fact.operation)], ['Linear', 'shape destructuring', 'permute', 'reshape', 'Linear', 'mean', 'unsqueeze']);
assert.equal(shapeFacts.find((fact) => fact.variable === 'y')?.outputShape, '[B, H, W, C]');
assert.equal(shapeFacts.find((fact) => fact.variable === 'logits')?.outputShape, '[B, H * W, 10]');
assert.equal(shapeFacts.find((fact) => fact.variable === 'pooled')?.outputShape, '[B, 10]');
assert.equal(shapeFacts.find((fact) => fact.variable === 'expanded')?.outputShape, '[B, 1, 10]');
const attentionShapeFacts = shapeModule.exports.inferStaticShapeFacts([{
  filePath: 'src/attention.py', startLine: 1, endLine: 4, languageId: 'python', id: '',
  text: "B, H, Q, D = q.shape\nB, H, D, K = k.shape\nscores = torch.einsum('bhqd,bhdk->bhqk', q, k)\nscores2 = torch.matmul(q, k)"
}]);
assert.equal(attentionShapeFacts.find((fact) => fact.variable === 'scores')?.outputShape, '[B, H, Q, K]');
assert.equal(attentionShapeFacts.find((fact) => fact.variable === 'scores2')?.outputShape, '[B, H, Q, K]');

const graphBuild = await build({
  entryPoints: ['src/callGraphAnalysis.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'silent'
});
const graphModule = { exports: {} };
vm.runInNewContext(graphBuild.outputFiles[0].text, { module: graphModule, exports: graphModule.exports });
const graph = graphModule.exports.buildStaticCallGraph([
  { node: { id: 'model:forward', filePath: 'model.py', symbolName: 'Model.forward', startLine: 10, endLine: 14, languageId: 'python' }, containerName: 'Model', source: 'def forward(self, x):\n    y = self.encode(x)\n    return helper(y)' },
  { node: { id: 'model:encode', filePath: 'model.py', symbolName: 'Model.encode', startLine: 20, endLine: 22, languageId: 'python' }, containerName: 'Model', source: 'def encode(self, x):\n    return x' },
  { node: { id: 'utils:helper', filePath: 'utils.py', symbolName: 'helper', startLine: 1, endLine: 2, languageId: 'python' }, source: 'def helper(x):\n    return x' }
]);
assert.equal(graph.edges.find((edge) => edge.from === 'model:forward' && edge.to === 'model:encode')?.confidence, 0.98, 'self.method calls should resolve to the same class');
assert.equal(graph.edges.find((edge) => edge.from === 'model:forward' && edge.to === 'utils:helper')?.kind, 'calls');
const slicedGraph = graphModule.exports.sliceCallGraph(graph, 'model:forward', 2);
assert.equal(slicedGraph.nodes.length, 2);
assert.equal(slicedGraph.truncated, true);
for (const sourcePath of ['src/model.py', 'configs/train.yaml', 'docs/architecture.md']) {
  assert.equal(isSensitiveWorkspacePath(sourcePath), false, `${sourcePath} must remain readable`);
}

const explorationBuild = await build({
  entryPoints: ['src/agenticExploration.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'silent'
});
const explorationModule = { exports: {} };
vm.runInNewContext(explorationBuild.outputFiles[0].text, {
  module: explorationModule,
  exports: explorationModule.exports
});
const explorationPlan = explorationModule.exports.parseExplorationPlan(
  '```json\n{"done":false,"actions":[{"tool":"search_code","query":"build_model"},{"tool":"read_file","path":"src/model.py","startLine":20,"endLine":9999},{"tool":"read_paper_pages","pages":[2,2,7]}]}\n```'
);
assert.equal(explorationPlan.actions.length, 3);
assert.equal(explorationPlan.actions[1].endLine, 419, 'agent file reads must be bounded');
assert.deepEqual([...explorationPlan.actions[2].pages], [2, 7]);
assert.equal(
  explorationModule.exports.parseExplorationPlan('not json'),
  undefined,
  'malformed exploration plans must fail closed'
);
const lineMatches = explorationModule.exports.findTextLineMatches(
  'first\nmodel = build_model(config)\nlast',
  'build_model',
  3
);
assert.equal(lineMatches[0].line, 2);
assert.match(lineMatches[0].preview, /build_model/);

const chunks = [
  { id: 'intro', page: 1, text: 'We introduce a general forecasting model.', boxes: [] },
  {
    id: 'method',
    page: 4,
    text: 'Causal episode contextualization aligns every episode by its end index.',
    boxes: []
  },
  { id: 'results', page: 8, text: '实验结果显示模型在三个数据集上取得提升。', boxes: [] }
];

const english = retrieveEvidence('Where is causal episode alignment described?', chunks, 2);
assert.equal(english[0]?.id, 'method');
assert.equal(english[0]?.citationId, 'P1');

const chinese = retrieveEvidence('实验结果在哪里？', chunks, 1);
assert.equal(chinese[0]?.id, 'results');

const bilingual = retrieveEvidence(
  '实验结果怎么样？',
  [
    { id: 'title', page: 1, text: 'A Paper Title', boxes: [] },
    { id: 'method-en', page: 3, text: 'Our architecture contains two modules.', boxes: [] },
    {
      id: 'experiment-en',
      page: 8,
      text: 'Experimental results on benchmark datasets show improved performance.',
      boxes: []
    }
  ],
  1
);
assert.equal(bilingual[0]?.id, 'experiment-en');

const fallback = retrieveEvidence('unmatched-token', chunks, 1);
assert.equal(fallback.length, 1);

const longChunkBias = retrieveEvidence(
  'loss',
  [
    { id: 'short', page: 1, text: 'loss loss', boxes: [] },
    { id: 'long', page: 2, text: `loss loss loss ${'filler '.repeat(600)}`, boxes: [] }
  ],
  2
);
assert.equal(
  longChunkBias[0]?.id,
  'short',
  'BM25 length normalization must prefer the dense short chunk over a diluted long one'
);

const chunkingBuild = await build({
  entryPoints: ['src/paperChunking.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'silent'
});
const chunkingModule = { exports: {} };
vm.runInNewContext(chunkingBuild.outputFiles[0].text, {
  module: chunkingModule,
  exports: chunkingModule.exports,
  require
});
const box = (x, y, width = 0.3, height = 0.012) => ({ x, y, width, height });
const preciseChunks = chunkingModule.exports.buildPageChunks('paper', 1, [
  { text: 'A Paper Title', box: box(0.1, 0.05, 0.8, 0.03), hasEOL: true },
  { text: 'Author One, Author Two', box: box(0.25, 0.11, 0.5), hasEOL: true },
  { text: 'Figure label: Model 0.045M', box: box(0.1, 0.3), hasEOL: true },
  { text: 'Figure 1. Parameter comparison.', box: box(0.1, 0.38), hasEOL: true },
  { text: 'Abstract', box: box(0.1, 0.48, 0.15, 0.02), hasEOL: true },
  { text: 'This paragraph contains the supported research claim.', box: box(0.1, 0.52), hasEOL: true }
]);
assert.ok(preciseChunks.length >= 5, 'headings, figure labels, and separated blocks should not share one anchor');
assert.equal(preciseChunks[0].text, 'A Paper Title');
assert.ok(preciseChunks.every((chunk) => chunk.boxes.length <= 1));
const formulaChunks = chunkingModule.exports.buildPageChunks('paper', 2, [
  { text: '3.2 Objective', box: box(0.1, 0.1, 0.4, 0.025), hasEOL: true },
  { text: 'L = L_rec + lambda L_prior (7)', box: box(0.25, 0.2, 0.5, 0.018), hasEOL: true },
  { text: 'The objective balances reconstruction and prior terms.', box: box(0.1, 0.3), hasEOL: true }
]);
const formulaChunk = formulaChunks.find((chunk) => chunk.kind === 'formula');
assert.ok(formulaChunk, 'equation-like PDF text should become a structured formula anchor');
assert.equal(formulaChunk.formula.label, '7');
assert.equal(formulaChunk.section, '3.2 Objective');
assert.equal(formulaChunk.formula.relation, '=');
assert.ok(formulaChunk.formula.leftHandSide, 'structured formula should expose its left-hand side');
assert.ok(formulaChunk.formula.rightHandSide, 'structured formula should expose its right-hand side');
const formulaRetrieval = retrieveEvidence('请解释公式', formulaChunks, 1);
assert.equal(formulaRetrieval[0].kind, 'formula');
const formulaNeighborhood = expandStructuralEvidence(formulaRetrieval, formulaChunks, 2);
assert.ok(formulaNeighborhood.length > 1, 'formula retrieval should include nearby variable definitions');
const multilineFormula = chunkingModule.exports.buildPageChunks('paper', 3, [
  { text: '4.1 Loss', box: box(0.1, 0.1, 0.3, 0.025), hasEOL: true },
  { text: 'L_total = L_rec +', box: box(0.2, 0.2, 0.5, 0.018), hasEOL: true },
  { text: '+ lambda L_prior = min_theta E(x) (12)', box: box(0.2, 0.245, 0.6, 0.018), hasEOL: true }
]).filter((chunk) => chunk.kind === 'formula');
assert.equal(multilineFormula.length, 1, 'nearby multiline equation fragments should share one stable formula anchor');
assert.equal(multilineFormula[0].formula.label, '12');
assert.match(multilineFormula[0].text, /L_total.*L_prior/);
const reorderedChunks = chunkingModule.exports.buildPageChunks('paper', 1, [
  { text: 'A Paper Title', box: box(0.1, 0.05, 0.8, 0.03), hasEOL: true },
  { text: 'A newly inserted subtitle', box: box(0.2, 0.08, 0.6, 0.02), hasEOL: true },
  { text: 'Author One, Author Two', box: box(0.25, 0.11, 0.5), hasEOL: true }
]);
assert.equal(
  reorderedChunks.find((chunk) => chunk.text === 'A Paper Title')?.id,
  preciseChunks[0].id,
  'content-addressed anchors must not drift when another block is inserted'
);
assert.throws(
  () => chunkingModule.exports.requireExtractableText([]),
  /No extractable text/,
  'image-only PDFs must not be marked ready with zero anchors'
);

const anchorBuild = await build({
  entryPoints: ['src/evidenceAnchors.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'silent'
});
const anchorModule = { exports: {} };
vm.runInNewContext(anchorBuild.outputFiles[0].text, {
  module: anchorModule,
  exports: anchorModule.exports
});
const migratedRecord = {
  metadata: { hash: 'hash', extractionStatus: 'ready' },
  chunks: [
    {
      id: 'hash:p1:hnew',
      page: 1,
      text: 'The exact historical evidence remains available after re-chunking.',
      boxes: [box(0.1, 0.2)]
    },
    {
      id: 'hash:p1:c0',
      page: 1,
      text: 'A different block reused the old ordinal ID.',
      boxes: [box(0.1, 0.4)]
    }
  ]
};
const resolvedHistorical = anchorModule.exports.resolvePaperCitation(migratedRecord, {
  chunkId: 'hash:p1:c0',
  page: 1,
  preview: 'The exact historical evidence remains available after re-chunking.',
  boxes: []
});
assert.equal(resolvedHistorical?.id, 'hash:p1:hnew');
assert.doesNotMatch(resolvedHistorical?.text || '', /different block/);
assert.equal(
  anchorModule.exports.stripTransientCitationMarkers('Earlier [P1] and [C2]'),
  'Earlier [source from that earlier answer] and [source from that earlier answer]'
);

const validationBuild = await build({
  entryPoints: ['src/citationValidation.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'silent'
});
const validationModule = { exports: {} };
vm.runInNewContext(validationBuild.outputFiles[0].text, {
  module: validationModule,
  exports: validationModule.exports
});
const citationEvidence = [
  {
    id: 'parameters',
    page: 1,
    text: 'Multinex 0.045M Param. GLARE 59.48M Param.',
    boxes: [],
    citationId: 'P1',
    score: 1
  }
];
const supportedCitation = validationModule.exports.validatePaperCitations(
  'Multinex has about 45K parameters. [P1]',
  citationEvidence
);
assert.equal([...supportedCitation.validIds].join(','), 'P1');
assert.equal(supportedCitation.mismatchCount, 0);
const inventedCitation = validationModule.exports.validatePaperCitations(
  'Multinex has 99M parameters. [P1]',
  citationEvidence
);
assert.equal(inventedCitation.validIds.length, 0);
assert.match(inventedCitation.text, /证据不匹配/);
const parsedAudit = validationModule.exports.parseCitationAuditResponse(
  '```json\n{"validPaperIds":["P1","P999"],"validCodeIds":["C1"]}\n```',
  ['P1'],
  ['C1']
);
assert.equal([...parsedAudit.validPaperIds].join(','), 'P1');
assert.equal([...parsedAudit.validCodeIds].join(','), 'C1');
assert.equal(
  validationModule.exports.parseCitationAuditResponse('not json', ['P1'], ['C1']),
  undefined,
  'malformed semantic-audit output must fail closed'
);

const providerBuild = await build({
  entryPoints: ['src/modelProviders.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'silent'
});
const providerBundle = providerBuild.outputFiles?.[0]?.text;
assert.ok(providerBundle, 'provider bundle should be generated');
const providerModule = { exports: {} };
const encoder = new TextEncoder();
const mockFetch = async () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n')
        );
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":"stream"}}]}\n\ndata: [DONE]\n\n')
        );
        controller.close();
      }
    }),
    { status: 200 }
  );
vm.runInNewContext(providerBundle, {
  module: providerModule,
  exports: providerModule.exports,
  fetch: mockFetch,
  Response,
  TextDecoder,
  URL,
  encodeURIComponent
});
const provider = providerModule.exports.createChatProvider({
  provider: 'openai-compatible',
  baseUrl: 'https://example.test/v1',
  model: 'test-model',
  reasoningEffort: 'auto'
});
const streamedDeltas = [];
const streamed = await provider.stream(
  [{ role: 'user', content: 'hello' }],
  (delta) => streamedDeltas.push(delta)
);
assert.equal(streamed, 'Hello stream');
assert.deepEqual(streamedDeltas, ['Hello ', 'stream']);

let anthropicRequest;
const anthropicModule = { exports: {} };
vm.runInNewContext(providerBundle, {
  module: anthropicModule,
  exports: anthropicModule.exports,
  fetch: async (_url, init) => {
    anthropicRequest = JSON.parse(init.body);
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'OK' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  },
  Response,
  TextDecoder,
  URL,
  encodeURIComponent
});
await anthropicModule.exports
  .createChatProvider({
    provider: 'anthropic',
    baseUrl: 'https://example.test',
    model: 'test-model',
    apiKey: 'secret',
    reasoningEffort: 'auto'
  })
  .complete([{ role: 'user', content: 'hello' }]);
assert.equal(anthropicRequest.max_tokens, 8000);

let geminiRequest;
const geminiModule = { exports: {} };
vm.runInNewContext(providerBundle, {
  module: geminiModule,
  exports: geminiModule.exports,
  fetch: async (_url, init) => {
    geminiRequest = JSON.parse(init.body);
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  },
  Response,
  TextDecoder,
  URL,
  encodeURIComponent
});
await geminiModule.exports
  .createChatProvider({
    provider: 'gemini',
    baseUrl: 'https://example.test',
    model: 'test-model',
    apiKey: 'secret',
    reasoningEffort: 'auto'
  })
  .complete([{ role: 'user', content: 'hello' }]);
assert.equal(geminiRequest.generationConfig.maxOutputTokens, 8000);

const assistantScript = await readFile('media/assistant.js', 'utf8');
const markdownStart = assistantScript.indexOf('function escapeHtml');
const markdownEnd = assistantScript.indexOf("stop.addEventListener", markdownStart);
assert.ok(markdownStart >= 0 && markdownEnd > markdownStart, 'Markdown renderer should be present');
const markdownContext = {
  input: [
    '# 标题',
    '',
    '> **重点**',
    '',
    '- 一项',
    '- 二项',
    '',
    '| A | B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '```js',
    'const x = 1;',
    '```',
    '',
    '\\[ [B,C,H,W] \\rightarrow [B,H,W,C] \\]',
    '',
    '行内形状为 \\(C_f = 40\\)，价格 `$5` 保持代码。',
    '',
    '<img src=x onerror=alert(1)>'
  ].join('\n'),
  result: '',
  katex: {
    renderToString(expression, options) {
      return `<math data-display="${options.displayMode}">${expression}</math>`;
    }
  }
};
vm.runInNewContext(
  `${assistantScript.slice(markdownStart, markdownEnd)}; result = renderMarkdown(input);`,
  markdownContext
);
assert.match(markdownContext.result, /<h1>标题<\/h1>/);
assert.match(markdownContext.result, /<table>/);
assert.match(markdownContext.result, /<pre><code class="language-js">/);
assert.match(markdownContext.result, /class="math-display"/);
assert.match(markdownContext.result, /data-display="true"/);
assert.match(markdownContext.result, /class="math-inline"/);
assert.match(markdownContext.result, /data-display="false"/);
assert.match(markdownContext.result, /<code>\$5<\/code>/);
assert.match(markdownContext.result, /&lt;img src=x onerror=alert\(1\)&gt;/);
assert.doesNotMatch(markdownContext.result, /<img/);
assert.match(assistantScript, /globalThis\.katex/);
assert.match(assistantScript, /quotedCitations/);
assert.match(assistantScript, /button\.disabled = isBusy/);
assert.match(assistantScript, /paperAttachmentPreparing/);
assert.match(assistantScript, /classList\.toggle\('loading', visible && preparing\)/);
assert.match(assistantScript, /case 'paperAttachmentStart'/);
assert.match(assistantScript, /case 'paperPreviewStart'/);
assert.match(assistantScript, /Rendering first page in background/);
assert.match(assistantScript, /paperRasterSessions/);
assert.match(assistantScript, /case 'paperPageImagesRequest'/);
assert.match(assistantScript, /post\('paperPageImagesReady'/);
assert.match(assistantScript, /maximumPixels = 4_000_000/);
assert.match(assistantScript, /message-paper-attachment/);
assert.match(assistantScript, /post\('cancelPaperAttachment'\)/);

const extensionSource = await readFile('src/extension.ts', 'utf8');
const repositorySource = await readFile('src/repositoryIndex.ts', 'utf8');
for (const tool of ['list_files', 'search_code', 'read_file', 'search_paper', 'read_paper_pages']) {
  assert.match(extensionSource, new RegExp(tool), `${tool} must be wired into exploration`);
}
assert.match(extensionSource, /exploreResearchContext\(/);
assert.match(extensionSource, /pendingPaperAttachmentHash/);
assert.doesNotMatch(extensionSource, /const explicitlyAsksAboutPaper/);
assert.match(extensionSource, /const wantsResearchContext = Boolean\(paper\)/);
assert.match(extensionSource, /recentResearchConversation\(\)/);
assert.match(extensionSource, /repairPaperGrounding\(/);
assert.match(extensionSource, /The attached PDF is still being prepared/);
assert.match(extensionSource, /preparePaperInBackground\(record\.metadata, generation, false, controller.signal\)/);
assert.match(extensionSource, /preparePaperPreview\(metadata, bytes\)/);
assert.match(extensionSource, /analyzePaperPages\(/);
assert.match(extensionSource, /requestsPaperVision\(text\)/);
assert.match(extensionSource, /source === 'vision'/);
assert.doesNotMatch(extensionSource, /void this\.pdfViewer\.preload\(metadata\)/);
assert.match(extensionSource, /const provider = createChatProvider\(config\)/);
assert.doesNotMatch(extensionSource, /validPaperIds: new Set\(validatePaperCitations\(answer, evidence\)\.validIds\)/);
assert.match(extensionSource, /validPaperIds: new Set\(unavailable\.validPaperIds\)/);
assert.match(extensionSource, /引用审查未能完成/);
assert.match(repositorySource, /findFiles\('\*\*\/\*', EXCLUDE_GLOB, maxFiles \+ 1\)/);
assert.match(repositorySource, /\.slice\(0, maxFiles\)/);
assert.match(repositorySource, /findFiles\('\*\*\/\*', EXCLUDE_GLOB\)/);
assert.match(repositorySource, /readFileRange\(/);
assert.match(repositorySource, /searchText\(/);
assert.match(repositorySource, /getCallGraph\(/);
assert.match(extensionSource, /deriveSemanticMappings\(/);
assert.match(extensionSource, /extractPersistentExample\(/);
assert.match(extensionSource, /staticShapeContext\(codeContexts\)/);
const pdfViewerScript = await readFile('media/pdfViewer.js', 'utf8');
const pdfViewerStyle = await readFile('media/pdfViewer.css', 'utf8');
assert.match(pdfViewerScript, /new pdfjsViewer\.TextLayerBuilder/);
assert.match(
  pdfViewerScript,
  /setProperty\('--total-scale-factor', String\(textViewport\.scale\)\)/
);
assert.match(pdfViewerScript, /disableNormalization: true/);
assert.match(pdfViewerScript, /textLayerRecord\.builder\.render\(\{ viewport: scaledViewport \}\)/);
assert.doesNotMatch(pdfViewerScript, /textLayer\.style\.transform = `scale/);
assert.match(pdfViewerScript, /globalThis\.pdfjsLib = pdfjsLib/);
assert.match(pdfViewerScript, /import\(config\.viewerModule\)/);
assert.match(pdfViewerScript, /type === 'pdfDataStart'/);
assert.match(pdfViewerScript, /type === 'pdfDataChunk'/);
assert.match(pdfViewerScript, /type === 'pdfDataEnd'/);
assert.match(pdfViewerScript, /getDocument\(\{ data: pdfData, wasmUrl: config\.wasmUrl \}\)/);
assert.match(pdfViewerScript, /type: 'askPdfSelection', hash: config\.hash/);
assert.match(pdfViewerScript, /loadingTask\.destroy\(\)/);
assert.match(pdfViewerScript, /type: 'pdfError'/);
assert.match(pdfViewerScript, /installStartupPreview/);
assert.match(pdfViewerScript, /startupPreview\?\.remove\(\)/);
assert.match(pdfViewerScript, /askPdfSelection/);
assert.match(pdfViewerScript, /selectionBoxes\(/);
assert.match(pdfViewerScript, /function columnSelection\(/);
assert.match(pdfViewerScript, /sameSide/);
assert.match(pdfViewerScript, /paintPdfSelection\(/);
assert.match(pdfViewerScript, /addEventListener\('copy'/);
assert.match(pdfViewerScript, /const page = Number\(anchorPage\.dataset\.page\)/);
assert.match(pdfViewerStyle, /\.textLayer ::selection/);
assert.match(pdfViewerStyle, /#ask-pdf-selection/);
assert.match(pdfViewerStyle, /\.pdf-page canvas[\s\S]*pointer-events: none/);
assert.match(pdfViewerStyle, /\.textLayer[\s\S]*pointer-events: auto/);
assert.match(pdfViewerStyle, /\.pdf-selection-highlight/);
assert.match(pdfViewerStyle, /#pages[\s\S]*align-items: flex-start/);
assert.match(pdfViewerStyle, /\.pdf-page[\s\S]*margin-inline: auto/);
assert.doesNotMatch(pdfViewerStyle, /#pages\s*\{[^}]*align-items:\s*center/);
assert.match(pdfViewerStyle, /body\s*\{[^}]*display:\s*flex[^}]*overflow:\s*hidden/);
assert.match(pdfViewerStyle, /#pages\s*\{[^}]*flex:\s*1 1 auto[^}]*min-height:\s*0[^}]*overflow:\s*auto/);
assert.doesNotMatch(pdfViewerStyle, /overscroll-behavior:\s*contain/);
assert.match(assistantScript, /case 'paperSelection'/);
assert.match(extensionSource, /:selection:\$\{digest\}/);
assert.match(extensionSource, /citation\.chunkId\.includes\(':selection:'\)/);

function minimalPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length 47 >>\nstream\nBT /F1 18 Tf 30 100 Td (Hello CodeChasing) Tj ET\nendstream'
  ];
  let source = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    source += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(source);
}

const pdfModuleUrl = pathToFileURL('node_modules/pdfjs-dist/legacy/build/pdf.mjs').href;
const pdfWorkerUrl = pathToFileURL('node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs').href;
delete globalThis.DOMMatrix;
delete globalThis.navigator;
await import(pathToFileURL(resolve('vendor/dom-matrix.mjs')).href);
assert.equal(typeof globalThis.DOMMatrix, 'function');
assert.equal(typeof globalThis.navigator.platform, 'string');
assert.equal(typeof globalThis.navigator.userAgent, 'string');
const matrix = new globalThis.DOMMatrix()
  .scaleSelf(0.5, -0.25)
  .translateSelf(0, -4);
assert.deepEqual(
  [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f],
  [0.5, 0, 0, -0.25, 0, 1],
  'DOMMatrix polyfill should support the Type3-glyph transform used by PDF.js'
);
const pdfjs = await import(pdfModuleUrl);
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
const loadingTask = pdfjs.getDocument({
  data: minimalPdf(),
  useWorkerFetch: false,
  standardFontDataUrl: `${resolve('node_modules/pdfjs-dist/standard_fonts')}/`,
  cMapUrl: `${resolve('node_modules/pdfjs-dist/cmaps')}/`,
  cMapPacked: true,
  wasmUrl: `${resolve('node_modules/pdfjs-dist/wasm')}/`
});
const pdf = await loadingTask.promise;
const firstPage = await pdf.getPage(1);
const textContent = await firstPage.getTextContent();
assert.match(textContent.items.map((item) => item.str || '').join(' '), /Hello CodeChasing/);
await loadingTask.destroy();

const historyBuild = await build({
  entryPoints: ['src/historyCompression.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'silent'
});
const historyModule = { exports: {} };
vm.runInNewContext(historyBuild.outputFiles[0].text, {
  module: historyModule,
  exports: historyModule.exports,
  require,
  console
});
const {
  selectHistoryWindow,
  historyPrefixHash,
  parseHistorySummary,
  serializeHistoryForSummary,
  HISTORY_RAW_CHAR_BUDGET,
  HISTORY_SUMMARY_MAX_CHARS
} = historyModule.exports;

const shortHistory = [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'hi' }
];
assert.deepEqual(
  JSON.parse(JSON.stringify(selectHistoryWindow(shortHistory))),
  { excluded: [], tail: shortHistory }
);

const longHistory = [];
for (let index = 0; index < 12; index += 1) {
  longHistory.push({ role: 'user', content: `question ${index} ${'x'.repeat(1500)}` });
  longHistory.push({ role: 'assistant', content: `answer ${index} ${'y'.repeat(3000)}` });
}
const historyWindow = selectHistoryWindow(longHistory);
assert.ok(historyWindow.excluded.length > 0, 'long history must exclude a prefix for summarization');
assert.equal(historyWindow.excluded.length + historyWindow.tail.length, longHistory.length);
assert.deepEqual(historyWindow.tail.at(-1), longHistory.at(-1), 'newest message stays raw');
const tailCost = historyWindow.tail.reduce(
  (total, message) => total + message.content.length + (message.quotedText?.length ?? 0),
  0
);
assert.ok(tailCost <= HISTORY_RAW_CHAR_BUDGET + 2500, 'raw tail stays within the char budget');

const hugeHistory = [
  { role: 'user', content: 'a'.repeat(50_000) },
  { role: 'assistant', content: 'b'.repeat(50_000) },
  { role: 'user', content: 'latest question' }
];
const hugeWindow = selectHistoryWindow(hugeHistory);
assert.equal(hugeWindow.tail.length, 2, 'at least the two newest messages survive');
assert.deepEqual(hugeWindow.tail.at(-1), hugeHistory.at(-1));
assert.ok(hugeWindow.tail[0].content.length < 50_000, 'oversized message is truncated');

assert.equal(
  historyPrefixHash(longHistory.slice(0, 4)),
  historyPrefixHash(longHistory.slice(0, 4)),
  'prefix hash is stable'
);
assert.notEqual(
  historyPrefixHash(longHistory.slice(0, 4)),
  historyPrefixHash(longHistory.slice(0, 5)),
  'prefix hash changes when the prefix grows'
);

const serialized = serializeHistoryForSummary([
  { role: 'assistant', content: 'fact [P1] and code [C2]' }
]);
assert.ok(
  !serialized.includes('[P1]') && !serialized.includes('[C2]'),
  'summary input strips transient citation markers'
);

assert.equal(parseHistorySummary('   '), undefined);
assert.equal(parseHistorySummary('z'.repeat(9000)).length, HISTORY_SUMMARY_MAX_CHARS);

console.log('agentic exploration, retrieval, citations, streaming, Markdown, history compression, and PDF tests passed');
