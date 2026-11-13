import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const flush = () => new Promise((resolve) => setImmediate(resolve));
const config = { provider: 'openai-compatible', baseUrl: 'http://localhost', model: 'test', reasoningEffort: 'auto' };
let network = async () => { throw new Error('Unexpected network call'); };
const notices = [];
const vscode = {
  workspace: { getConfiguration: () => ({ get: (key, fallback) => config[key] ?? fallback }) },
  window: { showWarningMessage: (message) => notices.push(message), showErrorMessage: (message) => notices.push(message) }
};
async function load(source, exports = '') {
  const contents = await readFile(source, 'utf8');
  const bundle = await build({
    stdin: { contents: contents + exports, resolveDir: new URL('../src/', import.meta.url).pathname, loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false, logLevel: 'silent'
  });
  const module = { exports: {} };
  vm.runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, require: (id) => id === 'vscode' ? vscode : require(id),
    console, Buffer, TextDecoder, TextEncoder, URL, AbortController, DOMException,
    setTimeout, clearTimeout, fetch: (...args) => network(...args)
  });
  return module.exports;
}
const { CodeChasingApplication } = await load('src/extension.ts', '\nexport { CodeChasingApplication };');
const { AssistantViewProvider } = await load('src/assistantView.ts');
const { createChatProvider } = await load('src/modelProviders.ts');
const { parseCitationAuditResponse } = await load('src/citationValidation.ts');
function appFixture() {
  const app = Object.create(CodeChasingApplication.prototype);
  const events = [];
  Object.assign(app, {
    chatHistory: [], paperAttachmentGeneration: 1, paperBackgroundReady: false,
    assistantView: new Proxy({}, { get: (_, name) => (...args) => { events.push({ name, args }); } }),
    paperStore: { getCurrent: async () => undefined },
    repositoryIndex: { getActiveEditorContext: async () => undefined },
    providerConfigurationWithSecret: async () => config,
    buildMessages: () => [{ role: 'user', content: 'hello' }],
    saveCurrentConversation: async () => { app.saved = structuredClone(app.chatHistory); }
  });
  return { app, events };
}

// Report errors embedded in otherwise-successful HTTP streams for all providers.
for (const [provider, delta] of [
  ['openai-compatible', { choices: [{ delta: { content: 'Partial' } }] }],
  ['anthropic', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Partial' } }],
  ['gemini', { candidates: [{ content: { parts: [{ text: 'Partial' }] } }] }]
]) {
  network = async () => new Response(
    `data: ${JSON.stringify(delta)}\n\ndata: {"error":{"message":"gateway overload"}}\n\n`
  );
  const pieces = [];
  await assert.rejects(createChatProvider({ ...config, provider, apiKey: 'test-only' }).stream(
    [{ role: 'user', content: 'hello' }], (delta) => pieces.push(delta)
  ), /gateway overload/);
  assert.equal(pieces.join(''), 'Partial');
}

// The protocol terminator, not a gateway's delayed socket close, completes the turn.
{
  let cancelled = false;
  network = async () => new Response(new ReadableStream({
    start(controller) {
      const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\ndata: [DONE]\r\n\r\n');
      // Exercise UTF-8 and event delimiters split across arbitrary network packets.
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    },
    cancel() { cancelled = true; }
  }));
  let timer;
  try {
    const result = await Promise.race([
      createChatProvider(config).stream([], () => {}),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('stream did not finish')), 1000); })
    ]);
    assert.equal(result, '你好');
    assert.equal(cancelled, true);
  } finally { clearTimeout(timer); }
}

network = async () => new Response('event: error\ndata: temporarily unavailable\n\n');
await assert.rejects(createChatProvider(config).stream([], () => {}), /temporarily unavailable/);
for (const malformed of ['{}', '{"validPaperIds":"P1","validCodeIds":[]}', '{"validPaperIds":[null],"validCodeIds":[]}']) {
  assert.equal(parseCitationAuditResponse(malformed, ['P1'], []), undefined);
}
assert.ok(parseCitationAuditResponse('{"validPaperIds":[],"validCodeIds":[]}', ['P1'], []));

// A rejected PDF-bound send must retain the selected editor code for retry.
{
  const { app, events } = appFixture();
  const selection = { filePath: 'model.py', text: 'def forward(x): return x' };
  app.pendingCodeContext = selection;
  app.pendingPaperAttachmentHash = 'paper';
  app.paperStore.getCurrent = async () => ({ metadata: { hash: 'paper', extractionStatus: 'pending' } });
  await assert.rejects(app.ask('hello'), /still being prepared/);
  assert.equal(app.pendingCodeContext, selection);
  assert.equal(events.filter((event) => event.name === 'clearAttachedCode').length, 0);
}

// An optional OCR page must not turn cancellation into a saved/ready paper.
{
  const { app } = appFixture();
  let saves = 0;
  app.paperIndexer = { extract: async () => ({ chunks: [{ text: 'native text' }], pageCount: 10, ocrPages: [3] }) };
  app.preparePaperInBackground = async () => true;
  app.analyzePaperPages = async () => {
    app.activePaperIndex.abort();
    throw new DOMException('Aborted', 'AbortError');
  };
  app.paperStore.saveExtraction = async () => { saves++; };
  app.startPaperIndexing({ hash: 'paper' });
  await flush();
  assert.equal(saves, 0);
  assert.equal(notices.length, 0);
  assert.equal(app.activePaperIndex, undefined);
}

// Cancellation after render success must prevent even a signal-ignoring provider call.
{
  const { app } = appFixture();
  const controller = new AbortController();
  let requests = 0;
  app.assistantView = { renderPaperPages: async () => { controller.abort(); return [{}]; } };
  await assert.rejects(
    app.analyzePaperPages({ complete: async () => { requests++; } }, { pageCount: 1 }, [1], 'ocr', controller.signal),
    { name: 'AbortError' }
  );
  assert.equal(requests, 0);
}

// Cancelling a queued render rejects promptly, releases its timer, and sends a cancel message.
{
  const view = new AssistantViewProvider({}, {});
  const sent = [];
  view.view = { webview: { postMessage: async (message) => { sent.push(message); return true; } } };
  const controller = new AbortController();
  const rendering = view.renderPaperPages({ hash: 'paper' }, [1], { signal: controller.signal });
  const rejected = assert.rejects(rendering, { name: 'AbortError' });
  await flush();
  controller.abort();
  await rejected;
  assert.equal(view.pendingPageRenders.size, 0);
  assert.equal(sent.at(-1).type, 'cancelPaperPageImages');
  assert.equal(sent.at(-1).requestId, sent[0].requestId);
  const before = sent.length;
  await assert.rejects(view.renderPaperPages({ hash: 'paper' }, [2], { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(sent.length, before);
}

// A dropped webview message must fail immediately rather than waiting three minutes.
{
  const view = new AssistantViewProvider({}, {});
  view.view = { webview: { postMessage: async () => false } };
  await assert.rejects(view.renderPaperPages({ hash: 'paper' }, [1]), /no longer available/);
  assert.equal(view.pendingPageRenders.size, 0);
}

// Network failure after the first token keeps both the question and partial answer.
network = async () => {
  let first = true;
  return { ok: true, body: { getReader: () => ({ cancel: async () => {}, releaseLock() {}, read: async () => {
    if (!first) throw new Error('Simulated network disconnect');
    first = false;
    return { done: false, value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Partial answer [P1]"}}]}\n\n') };
  } }) } };
};
{
  const { app, events } = appFixture();
  await app.askWithOptions('hello');
  assert.equal(app.saved.length, 2);
  assert.match(app.saved[1].content, /Partial answer/);
  assert.match(app.saved[1].content, /中断/);
  assert.doesNotMatch(app.saved[1].content, /\[P1]/);
  assert.equal(events.filter((event) => event.name === 'showError').length, 1);
  assert.equal(app.activeRequest, undefined);
}

// Stopping auxiliary example extraction cannot duplicate or discard an already saved answer.
network = async () => new Response('data: {"choices":[{"delta":{"content":"Complete answer"}}]}\n\ndata: [DONE]\n\n');
{
  const { app } = appFixture();
  app.persistentExample = {};
  app.extractPersistentExample = async () => {
    assert.equal(app.saved.length, 2, 'answer must be durable before auxiliary work starts');
    await app.cancelRequest(false);
    throw new DOMException('Aborted', 'AbortError');
  };
  await app.askWithOptions('example');
  assert.equal(app.chatHistory.length, 2);
  assert.equal(app.saved[1].content, 'Complete answer');
}

// Run the actual assistant script with a small DOM to exercise message handling.
class Element {
  constructor() {
    this.children = []; this.dataset = {}; this.textContent = ''; this.value = '';
    this.scrollTop = 0; this.scrollHeight = 1000; this.clientHeight = 400;
    this.classList = { add() {}, remove() {}, toggle() {} };
    this.style = { setProperty() {} };
  }
  append(...children) { this.children.push(...children); }
  insertBefore(child) { this.children.unshift(child); }
  replaceChildren(...children) { this.children = children; }
  addEventListener() {}
  setAttribute() {}
  remove() {}
  querySelector(selector) { return this.children.find((child) => child.className?.split(' ').includes(selector.slice(1))); }
  querySelectorAll() { return []; }
}
const nodes = new Map();
const timers = new Map();
let timerId = 0;
let listener;
const sentMessages = [];
const ui = vm.createContext({
  console,
  acquireVsCodeApi: () => ({ postMessage(message) { sentMessages.push(message); } }),
  document: {
    getElementById: (id) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); },
    querySelector: () => undefined, querySelectorAll: () => [],
    createElement: () => new Element(), addEventListener() {},
    createTreeWalker: () => ({ nextNode: () => false })
  },
  NodeFilter: { SHOW_TEXT: 4 },
  window: { addEventListener: (type, callback) => { if (type === 'message') listener = callback; } },
  setTimeout: (callback) => { const id = ++timerId; timers.set(id, callback); return id; },
  clearTimeout: (id) => timers.delete(id)
});
vm.runInContext(await readFile('media/assistant.js', 'utf8'), ui);
const emit = (type, extra = {}) => listener({ data: { type, ...extra } });
emit('streamStart');
emit('streamDelta', { delta: 'hello' });
emit('streamDelta', { delta: ' world' });
assert.equal(timers.size, 1, 'multiple deltas should share a render batch');
const messageList = nodes.get('messages');
messageList.scrollTop = 100;
for (const [id, callback] of [...timers]) { timers.delete(id); callback(); }
assert.equal(messageList.scrollTop, 100, 'stream updates must not pull a reader down');
messageList.scrollTop = 600;
emit('streamDelta', { delta: '!' });
for (const [id, callback] of [...timers]) { timers.delete(id); callback(); }
assert.equal(messageList.scrollTop, 1000, 'readers at the bottom should follow new output');
const answer = { text: 'hello world!', citations: [{ citationId: 'P1', page: 2, preview: 'source' }], codeLocations: [] };
emit('streamEnd', { answer });
ui.article = messageList.children.at(-1);
assert.equal(vm.runInContext('answerByArticle.get(article).citations[0].citationId', ui), 'P1');
assert.equal(timers.size, 0);
emit('restoreConversation', { messages: [{ role: 'assistant', content: answer.text, answer }] });
assert.ok(messageList.children.at(-1).querySelector('.sources'), 'history must restore source buttons');
emit('busy', { busy: false });
vm.runInContext("setQuotedText('quoted paragraph'); prompt.value = 'my question'; submit();", ui);
assert.equal(nodes.get('send').disabled, true);
vm.runInContext("prompt.value = 'my question'; submit();", ui);
assert.equal(sentMessages.filter((message) => message.type === 'ask').length, 1, 'pending acknowledgement must block repeat submissions');
emit('error', { message: 'Paper is still preparing' });
assert.equal(nodes.get('prompt').value, 'my question');
assert.equal(vm.runInContext('quotedText', ui), 'quoted paragraph');
assert.equal(nodes.get('send').disabled, false, 'rejected sends must unlock the composer');
vm.runInContext('submit()', ui);
emit('userMessage', { text: 'my question', pending: true });
assert.equal(vm.runInContext('pendingSubmission', ui), undefined);
assert.equal(nodes.get('send').disabled, true, 'accepted messages stay locked until completion');
console.log('Cancellation, interrupted-history, streaming-scroll, and citation-selection regressions passed');
