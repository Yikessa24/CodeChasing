# Changelog

## 0.25.0

- Compress long conversation history: keep the newest turns raw within a char budget and summarize the excluded prefix into a running summary, merged incrementally after each answer.
- Inject the summary as context (not evidence) into the model prompt and the exploration planner; persist it with saved conversations and restore it on resume.
- Bound worst-case prompt history with per-message truncation protection and explicit degradation when a summary is not ready yet.
- Add executable tests for window selection, truncation protection, prefix hashing, citation-marker stripping, and summary caps.

## 0.24.3

- Detect model API error payloads and SSE error events even when the HTTP response reports success; preserve interrupted output instead of finalizing it as a complete answer.
- Finish OpenAI-compatible and Anthropic streams on their end markers, cancelling the reader and releasing its lock without waiting for the gateway to close its connection.
- Lock the composer immediately during submission, restore text and quoted evidence after pre-send rejection, and retain selected code until the request is accepted.
- Treat malformed citation-audit JSON as an unavailable audit instead of a successful empty audit.
- Cover mid-stream errors across all three providers, delayed connection closure, fragmented UTF-8 packets, repeat submission, and rejected-send recovery in regression tests.

## 0.24.2

- Propagate cancellation through PDF previews, page rendering, and optional OCR; stop renderer tasks and ignore obsolete preparation results.
- Fail pending page requests promptly when the assistant closes or a message cannot be delivered.
- Preserve interrupted answers and their questions in conversation history; save completed answers before optional example extraction, without duplicating them on stop.
- Batch streaming Markdown refreshes and respect the user's scroll position while they read earlier messages.
- Retain source metadata for selection-based questions on newly streamed answers and restore source buttons in saved conversations.
- Add executable regression scenarios for cancellation, network disconnects, stopped post-processing, streaming scroll behavior, and restored citations.

## 0.24.1

- Fix a missing block terminator that prevented the assistant Webview script from parsing.
- Add explicit syntax checks for both shipped Webview scripts to the release gate.
- Fail closed when semantic citation auditing is unavailable instead of preserving weakly checked paper or code citations.
- Stop PDF visual retry work promptly after cancellation.
- Tag model-assisted OCR and visual caches with their provider, endpoint, and model; discard stale model-generated chunks while preserving native PDF text.
- Rebuild legacy paper records with index version 8 so cached visual evidence follows the new provenance rule.

## 0.24.0

- Detect scanned and image-only pages instead of failing when PDF.js exposes no text layer.
- Keep a bounded background PDF raster session in the assistant Webview and render arbitrary pages to JPEG without opening the separate reader.
- Add model-assisted OCR with normalized page boxes and searchable, clickable OCR anchors.
- Add structured visual extraction for architecture diagrams, plots, tables, formulas, qualitative comparisons, labels, axes, legends, and visible values.
- Send page images through OpenAI-compatible `image_url`, Anthropic base64 image blocks, and Gemini `inlineData` parts.
- Reattach the original relevant page images to final answers and citation audits, rather than relying only on an earlier generated caption.
- OCR image-only papers during preparation; inspect page images lazily for ordinary text PDFs and guided walkthroughs, bounded by `codeChasing.maxVisualPages`.
- Rebuild cached PDF records with paper index version 7 and persist OCR/visual page counts.
- Add regression tests for provider image payloads, scan detection, OCR/visual response parsing, visual formula structure, and background page-raster wiring.

## 0.23.0

- Add persistent, reviewable paper ↔ code mapping edges learned only from locally co-cited evidence; exact selected paper anchors and overlapping code ranges now support deterministic lookup in both directions before semantic retrieval.
- Mark saved mappings stale when either their code content or paper anchor changes, and exclude rejected/stale edges from the visible active count.
- Replace the inline call-name heuristic with a separately tested static-call analyzer that resolves same-class, same-file, qualified, and ambiguous calls with explicit confidence, source lines, unresolved counts, and subgraph coverage metadata.
- Add filtering and zoom controls to the clickable call-graph view.
- Incrementally merge the conversation's structured running example, preserve earlier paper/code anchors, and refresh it on later example, tensor, shape, input/output, and pipeline questions.
- Upgrade shape analysis from operation hints to conservative symbolic propagation across common tensor construction, permutation, reshape, squeeze, flatten, concatenate/stack, reduction, broadcast, interpolation, Linear, Conv, and Embedding operations.
- Structure extracted equations into labels, variables, relations, left/right sides, operators, and functions; recover inline numbered equations and embedded subsection headings, merge multiline continuations, and rebuild cached PDF indexes with index version 6.
- Add regression tests for exact bidirectional mapping lookup, mapping status, persistent-example merging, source-anchor preservation, symbolic shape propagation, static call resolution, graph slicing, and structured formulas.

## 0.22.0

- Upgrade the bundled PDF.js runtime to `6.2.108`, include its local WASM assets, and remove a high-severity arbitrary-JavaScript-execution advisory affecting malicious PDFs.
- Parse real cached 11-page and 28-page papers in the packaged Node-compatible PDF worker as part of the release smoke checks.
- Make the model connection test use the currently selected reasoning effort instead of silently forcing `Auto`.
- Bound the initial project catalogue by `maxRepositoryFiles` while keeping model-directed literal search available across every permitted non-dependency text file.
- Exclude common credential and private-key files from autonomous project listing, search, and model-directed reads; explicitly selected editor text remains user-controlled context.
- Preserve valid paper and code source links with deterministic local validation when the optional semantic citation auditor is unavailable, instead of wiping every citation.
- Reject stale reader-ready, error, and selection messages after a paper is replaced; clear abandoned highlights and cancel superseded preparation work.
- Restore the previous attachment transactionally when a replacement PDF fails, and abort preparation when a chat, history item, or paper is removed.
- Limit in-memory PDF byte and preview caches, warm restored historical papers in the background, and destroy PDF.js loading tasks cleanly.

## 0.21.0

- Render model-generated LaTeX equations with locally bundled KaTeX.
- Support inline `\\(...\\)` / `$...$` and display `\\[...\\]` / `$$...$$` math without a CDN.
- Keep formulas scrollable in narrow assistant panels and preserve literal math-like text inside code spans and fenced code blocks.

## 0.20.0

- Replace keyword-gated paper retrieval with a persistent file-conversation model:
  every turn with an attached paper can search and read the complete extracted PDF.
- Include recent conversation in retrieval and exploration so pronouns and follow-ups
  about earlier answers, citations, and claims continue reading the same paper.
- Read all pages for whole-paper requests and require exact-heading plus surrounding-page
  inspection for section, paragraph, quotation, formula, and table requests.
- Retry an ungrounded paper draft once with the collected evidence, and replace internal
  citation-audit markers with concise user-facing source warnings.

## 0.19.0

- Add genuine background first-page rendering inside the already-open assistant
  Webview, without creating or revealing a PDF editor tab.
- Cache the rendered preview in the extension and display it immediately when the
  standalone reader opens, then replace it with the full selectable PDF.js page.
- Define attachment readiness by completed extraction, byte caching, and preview
  rendering instead of requiring the user to open the reader first.

## 0.18.3

- Keep the PDF attachment progress ring animated continuously from file reading
  through extraction and reader first-page rendering; stop it only on ready,
  failure, or cancellation.

## 0.18.2

- Block PDF-attached sends in both the composer and extension host until the
  reader confirms that its first page has rendered.
- Transfer prepared PDF bytes to the reader in bounded Base64 chunks, avoiding
  stalls caused by one oversized Webview message.

## 0.18.1

- Make PDF attachment `Ready` include an in-memory copy of the complete PDF, so
  the reader no longer starts a second Webview-resource download after opening.
- Send the prepared bytes directly to PDF.js and keep `Loading` visible until its
  first page has actually rendered.

## 0.18.0

- Replace notification-driven PDF imports with a composer attachment card that
  reports file reading and page preparation progress without opening the PDF viewer.
- Disable sending while a newly attached PDF is still preparing, support cancelling
  or removing it from the card, and guard the same rule in the extension host.
- Preserve a compact PDF attachment card on the user message and in restored chat
  history so each submitted paper remains identifiable.

## 0.17.7

- Make the PDF content area an explicit two-dimensional scroll container below
  the fixed toolbar, restoring vertical scrolling while preserving accessible
  left/right overflow at high zoom.

## 0.17.6

- Fix one-sided horizontal scrolling at high PDF zoom by avoiding negatively
  positioned centered flex overflow; fitting pages remain centered while
  oversized pages expose their full width to the scroll container.

## 0.17.5

- Use PDF.js's production `TextLayerBuilder`, including its native selection
  lifecycle and endpoint handling, while retaining CodeChasing's column-aware
  geometric selection and zoom-independent citation coordinates.

## 0.17.4

- Add column-aware PDF selection so dragging within one column no longer pulls
  text from the neighboring column; custom selections remain copyable and can
  still be sent to the assistant with normalized page coordinates.

## 0.17.3

- Recalculate PDF.js text geometry for every zoom level instead of applying a
  CSS transform to the selectable layer, preventing native selections from
  spanning unrelated page regions.

## 0.17.2

- Align the PDF.js text-layer scale with the rendered viewport so native text
  selections cover only the intended glyphs instead of unrelated page areas.

## 0.17.1

- Routed PDF pointer interaction explicitly to the selectable text layer and disabled pointer capture on the canvas, improving drag selection reliability at high zoom levels.


## 0.17.0

- Added a floating **询问这段** action when selectable PDF text is highlighted within a page.
- Carries the selected paper text, PDF page, and exact normalized selection rectangles into the CodeChasing composer as pinned context.
- Answers can cite the user-selected passage and reopen the original PDF with the exact selection highlighted.
- Renamed the composer quote card to **Selected context** so it consistently covers both assistant-answer and PDF selections.


## 0.16.1

- Added a PDF.js text layer above each rendered canvas so PDF text can be selected and copied without removing zoom support.
- Kept the text layer synchronized with zoom, fit-to-width, lazy page rendering, evidence highlights, and page labels.


## 0.16.0

- Upgraded research questions from one-shot retrieval to a bounded, multi-round exploration loop modeled after coding agents.
- The model can now inspect the project catalogue, list a subdirectory, search literal text across every non-dependency workspace file, and read requested file/line ranges before answering.
- The same exploration loop can search the complete extracted paper and read requested PDF pages, using earlier results to decide the next search.
- Added visible exploration progress, configurable exploration rounds, strict JSON tool-plan validation, traversal protection, binary/oversized-file filtering, and bounded per-read/context sizes.
- Final paper and code citations still point only to exact source excerpts actually collected and must pass the existing semantic citation audit.


## 0.15.0

- Replaced position-based paper chunk IDs with content-addressed evidence anchors so cached and historical citations cannot silently drift after PDF re-preparation.
- Preserved the exact paper hash, page, preview, and highlight boxes in each answer citation; restored conversations now reopen the original cited PDF rather than whichever paper is currently attached.
- Added bilingual paper retrieval and model-assisted query expansion for Chinese questions over English papers, with structural fallback instead of a page-one fallback.
- Added a second, fail-closed citation audit for both paper and code claims before clickable source markers are displayed.
- Rejects scanned or otherwise text-empty PDFs clearly instead of reporting them as successfully prepared.
- Reads shorter papers in full for the guided walkthrough and uses ordered, evidence-preserving batches for longer papers.
- Improved fallback function/class ranges, selected-symbol detection, related caller/callee retrieval, explicit code-question retrieval, and multi-root code navigation.
- Prevented a workspace's last PDF from being attached to unrelated new conversations and blocked paper/context changes while a response is running.
- Preserved stopped partial answers, disabled conflicting toolbar actions during requests, and isolated stored API keys by provider and endpoint.
- Added regression coverage for evidence stability, historical citations, bilingual retrieval, empty PDFs, semantic citation auditing, output limits, and busy-state behavior.

## 0.14.0

- Replaced character-count PDF buckets with compact layout-aware anchors for titles, paragraphs, figure labels, captions, and section headings.
- Automatically rebuilds older cached paper preparations with the new anchor format.
- Sends the complete locally extracted paper for the dedicated end-to-end walkthrough instead of six evenly sampled fragments.
- Added claim-local citation instructions and a local quantity check that catches invalid IDs and mismatched numeric claims, including equivalent units such as `45K` and `0.045M`.
- Reframed upload-time work as local PDF preparation; answer-to-source citations are created dynamically for each question.
- Added a project symbol map for walkthroughs and question-time expansion from selected code to likely callees and callers.
- Tightened code citations so project-map entries cannot be presented as proof of runtime behavior or tensor shapes.

## 0.13.0

- Preloads PDF.js, the document, and the first rendered page in a non-focused background editor tab immediately after import or conversation restoration.
- Reuses the warmed viewer when the paper button or a citation is opened.
- Added zoom in, zoom out, fit-to-width, and a live zoom percentage to the PDF toolbar.
- Preserved normalized evidence highlights at every zoom level.

## 0.12.3

- Removed the repeated blocking HTTP transport warning from message sends and connection tests.
- Kept the one-time **Save anyway** warning when an insecure remote endpoint is configured.
- Added a persistent `HTTP insecure` marker in the compact **ⓘ** model status instead of interrupting chat.

## 0.12.2

- Added a minimal `navigator` compatibility object before PDF.js loads in the VS Code extension host and PDF worker.
- Covered the missing `navigator.platform` and `navigator.userAgent` path with regression assertions.

## 0.12.1

- Added a packaged two-dimensional `DOMMatrix` compatibility layer for PDF.js in the VS Code Node extension host.
- Loaded the same compatibility layer inside the PDF worker before parsing Type3 glyphs and graphical masks.
- Added a regression test for the exact matrix operation that previously caused paper indexing to fail.
- Pinned PDF.js to `5.7.284` so dependency updates cannot silently change the packaged parser.

## 0.12.0

- Replaced the permanent top status panel with a compact on-demand **ⓘ** context popover below the composer.
- Added a centered “你好，想聊些什么？” empty state that disappears after the first message.
- Redesigned the conversation layout with user messages on the right and assistant responses on the left.
- Simplified message surfaces and spacing to resemble a modern chat interface.
- Moved the large paper-to-code walkthrough control into the compact bottom toolbar.

## 0.11.1

- Made paper attachment conversation-specific instead of workspace-global.
- Fresh chats now start without the previous PDF in the header or model context.
- Restoring a saved conversation also restores its associated cached PDF and clickable evidence anchors.
- Migrated the previously selected workspace PDF into existing saved conversations without deleting its local index.

## 0.11.0

- Changed startup behavior to always open a fresh blank conversation instead of restoring the previous chat automatically.
- Added per-workspace conversation archives with titles, timestamps, and a history picker.
- Added a **◷** history button below the composer for restoring and continuing earlier conversations.
- Migrated the previous single saved chat into conversation history without losing it.

## 0.10.2

- Added a CodeLens action beside the selected code so the CodeChasing button is directly visible without right-clicking.
- Retained the editor-title action as a fallback when CodeLens is disabled in VS Code settings.

## 0.10.1

- Added an editor-title CodeChasing button that appears automatically whenever code is selected.
- Kept the existing context-menu command and keyboard shortcut as optional fallback entry points.

## 0.10.0

- Made selected-code analysis a primary two-path workflow: attach the selection for a free-form question, or trace the running example and tensor shapes automatically.
- Preserved the exact selected file and line range in the composer and conversation display.
- Added a structured shape table prompt that distinguishes code facts, paper evidence, symbolic dimensions, and example assumptions.
- Automatically opens and highlights the first cited PDF region after a selected-code trace.

## 0.9.1

- Disabled the per-message paper/code context confirmation dialog by default for uninterrupted chat.
- Added the optional `codeChasing.confirmContextBeforeSend` setting for users who want the confirmation back.

## 0.9.0

- Added an **询问这段** action when text is selected inside an assistant answer.
- Added a removable selected-answer context card above the composer and preserved it in conversation history.
- Used selected answer text as a paper-retrieval hint while still grounding responses in actual PDF evidence.
- Automatically opens and highlights the cited PDF region for selected-text questions asking where something appears in the paper.

## 0.8.1

- Turned inline `[P…]` paper citations into clickable buttons that open and highlight their PDF evidence.
- Turned inline `[C…]` code citations into clickable buttons that open their exact source range.
- Persisted grounded citation metadata with new conversation history so citations remain clickable after reload.

## 0.8.0

- Added a first-run action for moving CodeChasing to VS Code's right Secondary Side Bar while leaving Explorer on the left.
- Added a visible `⇥` layout button below the composer and a matching Command Palette action.
- Kept layout placement under VS Code's native location picker so the chosen position is remembered by the workbench.

## 0.7.0

- Added streaming responses for OpenAI-compatible, Anthropic, and Gemini providers, with a non-streaming compatibility fallback.
- Persisted workspace conversations and restored them after VS Code reloads.
- Added a modal context preview showing paper pages and exact code ranges before transmission.
- Disabled automatic related-code retrieval by default.
- Added a model connection test with latency reporting and remote HTTP transport warnings.
- Added a guided “从论文到代码” walkthrough using one running example and overview evidence.
- Added paper/code index management: refresh, cancel, retry, pause, replace, remove, and stale-state display.
- Added incremental code-index updates for saved, created, and deleted source files.

## 0.6.0

- Decoupled PDF indexing from the visible PDF viewer.
- Imported papers now index locally in the background without opening a tab.
- Kept the PDF viewer as an on-demand, closable editor tab opened from the paper tool or citations.
- Added live `Indexing`/`Ready` paper status and automatic resume after extension reload.
- Reused completed indexes when the same PDF is imported again.

## 0.5.0

- Rendered model responses as sanitized Markdown instead of displaying raw Markdown symbols.
- Added VS Code-themed styles for headings, lists, quotes, links, tables, inline code, and fenced code blocks.
- Kept user messages and errors as literal text.

## 0.4.0

- Simplified all in-chat progress text to `Thinking`.
- Added a visible reasoning-effort control below the composer.
- Removed the permanent PDF drop zone; the entire conversation now accepts dropped PDFs.
- Improved PDF opening with first-page priority, lazy page rendering, reduced canvas density, and extraction reuse.

## 0.3.0

- Added Enter-to-send and Shift+Enter for new lines, including IME-safe handling.
- Added a Stop button for cancelling an in-flight response.
- Added Ctrl+C cancellation that withdraws a pending question before output begins.
- Moved paper, code, model, and new-chat actions below the composer as compact icons.

## 0.2.0

- Added normal multi-turn chat without requiring a paper or indexed repository.
- Added PDF drag-and-drop and click-to-upload in the assistant view.
- Added an animated, stage-specific thinking indicator while requests are running.
- Added user-selectable reasoning effort with provider-specific request mapping.
- Added model and reasoning status to the assistant header.
- Added a New chat action for clearing in-memory conversation history.
- Improved custom Anthropic gateway authentication with both bearer and API-key headers.

## 0.1.0

- Added the CodeChasing activity-bar assistant.
- Added PDF import, in-editor rendering, local evidence extraction, and source highlighting.
- Added selected-code and workspace-symbol context.
- Added clickable paper and code citations.
- Added OpenAI-compatible, Anthropic, and Gemini provider adapters.
- Added VS Code SecretStorage for API keys.
