# CodeChasing

CodeChasing is an early VS Code extension for understanding research code together with its paper. It keeps paper citations and code locations as real, clickable anchors instead of asking a model to invent page numbers or line ranges.

This repository currently contains MVP 0.24.3:

- chat normally without attaching a paper or repository context;
- import one PDF per VS Code workspace;
- drag a PDF anywhere onto the assistant conversation, or use the + tool to upload;
- show the selected PDF as a cancellable composer attachment with real preparation progress, block contextual sending until it is ready, and retain the PDF card on the user message that submitted it;
- prepare PDF text and precise highlight coordinates locally without opening its viewer;
- render and cache the first PDF page invisibly inside the existing assistant Webview, so opening the separate reader can display a prepared preview immediately while its selectable layer takes over;
- open the PDF on demand in a closable VS Code editor tab with bundled PDF.js;
- extract compact, content-addressed anchors for paragraphs, headings, figure labels, and captions;
- ask questions grounded in paper and selected code, including Chinese questions over English papers;
- click a paper citation to return to and highlight its source region;
- click a code citation to open and select the source range;
- scan workspace symbols using installed language servers, with a syntax fallback;
- dynamically expand selected code into likely callers and callees for the current question;
- retrieve relevant code automatically for explicit code questions even when ordinary-chat code retrieval is disabled;
- explore the project iteratively before answering by listing directories, searching arbitrary text, reading requested files and line ranges, and following discoveries across modules;
- explore the complete extracted PDF with repeated full-document searches and targeted page reads rather than relying on one initial retrieval result;
- keep the attached paper available to every follow-up turn, use recent conversation as the retrieval query, read all pages for whole-paper requests, and directly target surrounding pages for exact section or paragraph requests;
- automatically attempt one evidence-grounded rewrite when a draft omits usable paper anchors, while presenting concise source warnings instead of internal audit markers;
- show a continuous **Thinking** state while the model investigates the project or paper;
- configure OpenAI-compatible, Anthropic, or Gemini APIs;
- choose automatic, minimal, low, medium, high, or extra-high reasoning effort;
- see an animated status card during retrieval and model reasoning;
- press Enter to send and Shift+Enter to insert a new line;
- stop an in-flight response, or press Ctrl+C before output begins to withdraw it;
- use compact paper, code, model, and new-chat tools below the composer;
- change reasoning effort directly from the visible reasoning control below the composer;
- open papers faster with first-page priority and lazy rendering for later pages;
- zoom PDF pages in or out and restore fit-to-width from the viewer toolbar;
- select and copy PDF text at every zoom level through a synchronized PDF.js text layer;
- select a passage inside one PDF page, click **询问这段**, and ask about it with its exact page and selection rectangles pinned as evidence;
- keep API keys isolated by provider and endpoint in VS Code SecretStorage;
- render assistant Markdown as formatted headings, emphasis, lists, quotes, tables, links, and code blocks;
- render inline and display LaTeX formulas with locally bundled KaTeX;
- stream model responses token by token with Stop support;
- archive project conversations while opening every new VS Code session with a blank chat;
- restore and continue a saved conversation from the history button below the composer;
- associate imported PDFs with individual conversations, leaving a fresh chat with no paper attached;
- use a centered empty-chat greeting that disappears after the first message;
- align user bubbles on the right and assistant answers on the left;
- move paper, code, and model status into an on-demand compact context popover;
- send retrieved paper and selected-code context without interrupting every message with a confirmation dialog;
- test model connectivity and report request latency;
- start a guided paper-to-code walkthrough that reads shorter papers in full and summarizes longer papers in ordered evidence-preserving batches before connecting them to a project symbol map and key implementations;
- manage, cancel, retry, replace, remove, and refresh paper/code indexes;
- move the CodeChasing assistant to VS Code's right Secondary Side Bar while keeping Explorer on the left;
- click inline `[P…]` and `[C…]` citations directly, including after a conversation is restored;
- select text in an assistant answer and ask a contextual follow-up from the floating **询问这段** action;
- automatically open and highlight cited PDF evidence when a selected-text follow-up asks for its paper location;
- attach an editor code selection to the composer for a free-form model question;
- trace the walkthrough's running example into selected code, summarize concrete/symbolic tensor shapes, and open highlighted PDF evidence;
- show a one-click CodeChasing button in the editor title whenever source code is selected;
- show an in-editor CodeLens action beside the selected code so the action remains visible even when title-bar tools overflow.
- learn evidence-backed paper ↔ code mappings only from locally co-cited claims, persist them per workspace, validate them against later code/PDF changes, and let the user confirm or reject candidates;
- use exact selected paper anchors and overlapping code ranges before semantic search, so reviewed mappings work in both directions without depending on matching question wording;
- build a searchable, zoomable static call graph with high-confidence calls, lower-confidence ambiguous references, clickable code nodes, coverage metadata, and unresolved-call counts;
- preserve a structured running example per conversation, incrementally merge later tensor stages without dropping older source anchors, and open each step's paper/code evidence;
- propagate symbolic tensor shapes through common construction, reshape, permutation, reduction, stacking, broadcasting, interpolation, linear, convolution, embedding, einsum, and matrix-multiplication operations;
- classify formulas separately from prose and retain equation labels, sections, variables, relations, left/right sides, operators, functions, and nearby definition/caption evidence.
- detect scanned or image-only PDF pages during preparation and use the configured vision-capable model to OCR them into searchable, page-linked evidence;
- render relevant PDF pages in the background and send their pixels to OpenAI-compatible, Anthropic, or Gemini vision models for architecture diagrams, plots, tables, formulas, and qualitative image comparisons;
- retain model-assisted OCR and visual descriptions as page-scoped anchors, while attaching the original page images again to final answering and citation-audit calls;

## Run the development extension

Requirements:

- Node.js 22.13 or newer;
- VS Code 1.101 or newer.

Install and build:

```bash
npm install
npm run check
```

Open this directory in VS Code and press `F5`, or choose **Run CodeChasing Extension** from Run and Debug. A separate Extension Development Host opens.

## First-use flow

1. Open the CodeChasing activity-bar view. At the first layout prompt, choose **Move to right**, then select **Secondary Side Bar** in VS Code's location picker. You can repeat this later with the **⇥ icon** below the composer or the **CodeChasing: Move Assistant to Right Side** command.
2. Select the **gear icon** below the composer and configure a provider, base URL, model name, reasoning effort, and API key. Afterwards, use the visible **Auto/Low/Medium/High** control to change reasoning effort directly.
   Use the **check icon** to test the configured connection.
   Scanned PDFs and questions about figures require a model and gateway that accept image input.
3. Select the **+ icon**, or drop a PDF anywhere on the conversation. Local PDF preparation continues in the background; it records text positions but does not create answer citations before a question exists.
4. Select the **search icon** to scan the local code structure.
5. Select code and click **CodeChasing：询问或追踪这段代码**, which appears next to the selection. Choose either a free-form question or the running-example/tensor-shape trace. The editor-title and context-menu commands remain available as fallbacks.
6. Select **从论文到代码** for a guided end-to-end explanation using one concrete example.
7. Use the paper icon to open the PDF only when needed. Click `[P…]` source chips to open and jump to paper evidence and `[C…]` chips to jump to code. Use the **… icon** to manage indexes.

The selection command also has the default shortcut `Cmd+Alt+P` on macOS and `Ctrl+Alt+P` elsewhere.

CodeChasing starts with a blank conversation and no attached PDF whenever VS Code reloads. Completed conversations and their paper association are saved per workspace. Use the **◷ history icon** to restore a conversation together with its paper, or **↻** to start another blank conversation.

In the composer, Enter sends and Shift+Enter starts a new line. While a request is running, **Stop** cancels generation but keeps the question. Before an answer appears, Ctrl+C cancels the request and withdraws that pending question (unless you are copying selected text).

## Provider configuration

Supported protocols in this MVP:

| Provider type | Intended use | Example base URL |
| --- | --- | --- |
| OpenAI-compatible | OpenAI, DeepSeek, Qwen-compatible gateways, Ollama, LM Studio | `https://api.openai.com/v1` |
| Anthropic | Native Messages API | `https://api.anthropic.com` |
| Gemini | Native `generateContent` API | `https://generativelanguage.googleapis.com` |

For local OpenAI-compatible endpoints, an empty key is allowed. Remote endpoints require a key before CodeChasing sends context.

Reasoning effort is mapped to each API protocol:

- OpenAI-compatible: `reasoning_effort`;
- Anthropic: `output_config.effort`;
- Gemini: `generationConfig.thinkingConfig.thinkingLevel`.

`Auto` omits the reasoning parameter and uses the provider default. Explicit levels require support from the selected model; unsupported values can produce a provider error. Gemini maps `xhigh` to `high`, and Anthropic maps `minimal` to `low`.

## Privacy model

PDF extraction, evidence retrieval, symbol scanning, and code-range resolution are local. Retrieved paper evidence and explicitly selected editor code are sent to the configured model without a per-message confirmation by default. Short auxiliary model calls may translate retrieval terms, choose candidate code symbols, and audit whether citations actually support the answer. The dedicated walkthrough sends shorter extracted papers directly; longer papers are processed in ordered, bounded batches before the final explanation. Related repository-code retrieval remains disabled by default for ordinary chat, but an explicit code question can still retrieve relevant code. To restore the confirmation dialog, enable `codeChasing.confirmContextBeforeSend` in VS Code settings.

For scanned pages and visual questions, rendered JPEG page images are also sent to the configured model. Image-only pages are processed during PDF preparation; text-based papers render only the pages selected for a visual question or walkthrough. `codeChasing.maxVisualPages` bounds page images per visual request.

Autonomous repository exploration excludes common credential material such as `.env*`, private-key files, cloud credential directories, and files named like `credentials` or `secrets`. A code range that you explicitly select in the editor can still be attached, because that is a direct user action.

API keys are stored through VS Code SecretStorage and isolated by provider plus normalized endpoint. They are not written to workspace settings or Webview storage.

To prevent code snippets from being sent by default, disable:

```json
{
  "codeChasing.sendCodeByDefault": false
}
```

This version does not execute repository code, collect runtime tensors, upload an entire repository, or build a cloud index.

For research questions, CodeChasing does not place the whole repository or PDF into one prompt. It gives the configured model bounded local read tools and lets it perform up to eight search/read rounds by default, similar to a coding agent. Every non-dependency workspace text file remains searchable even if it is outside the compact initial symbol catalogue. Increase `codeChasing.maxExplorationRounds` for unusually broad questions. Only the excerpts actually read for the question are sent into the final answer context and made eligible for citations.

## Evidence guarantees and current limits

Paper page numbers and highlight boxes originate from PDF.js extraction. Paper anchors are content-addressed, and each saved citation keeps its paper hash, page, preview, and highlight snapshot so later PDF re-preparation cannot silently redirect it. Code file and line ranges originate from the editor selection or local symbol scan. Citation IDs are assigned only to evidence supplied for the current question. Invalid IDs and conflicting numeric claims are removed before display. A second semantic audit can reject unsupported citations; if that auxiliary audit is unavailable or malformed, CodeChasing falls back to deterministic local ID, source-range, and numeric checks instead of silently deleting otherwise valid source links.

Known limits:

- born-digital text anchors remain more exact than model-assisted OCR boxes;
- OCR and diagram understanding require a configured vision-capable model; a text-only model or incompatible gateway produces a clear retryable preparation error;
- OCR and visual descriptions are model-assisted interpretations of page pixels. The original relevant page image is supplied again while answering and auditing, but very small labels or dense plots can still require manual inspection;
- visual questions inspect a bounded set of relevant page images rather than uploading every page image on every turn;
- the initial symbol catalogue depends on the installed language server, while model-directed text search also covers configuration and other text files;
- caller/callee expansion is static and reports ambiguous dispatch as lower-confidence references; exact runtime dispatch still requires executing or instrumenting the repository;
- symbolic shape propagation is conservative; data-dependent values and runtime-only branches remain assumptions unless the user supplies observed execution evidence;
- paper-code mappings form a persistent reviewed evidence graph, but a new edge is intentionally not learned unless one answer sentence locally cites both a valid paper anchor and a valid code anchor.

## Architecture

```text
VS Code extension
├── Assistant Webview
├── PDF.js paper viewer
├── PaperStore (workspace-local artifacts)
├── RepositoryIndex (symbols, ranges, and static call graph)
├── SemanticMappingStore (reviewed paper ↔ code graph)
├── Persistent running example and symbolic shape trace
├── Hybrid lightweight evidence retrieval
└── Provider adapters
    ├── OpenAI-compatible
    ├── Anthropic
    └── Gemini
```

The next architectural milestone is optional sandboxed runtime instrumentation for confirming dynamic dispatch and data-dependent tensor dimensions without weakening the current evidence boundaries.
