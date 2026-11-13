const vscode = acquireVsCodeApi();
const messages = document.getElementById('messages');
const prompt = document.getElementById('prompt');
const send = document.getElementById('send');
const stop = document.getElementById('stop');
const busyLabel = document.getElementById('busy-label');
const dropOverlay = document.getElementById('drop-overlay');
const selectionContext = document.getElementById('selection-context');
const selectionPreview = document.getElementById('selection-preview');
const clearSelection = document.getElementById('clear-selection');
const askSelection = document.getElementById('ask-selection');
const codeContext = document.getElementById('code-context');
const codePreview = document.getElementById('code-preview');
const clearCode = document.getElementById('clear-code');
const contextToggle = document.getElementById('context-toggle');
const contextPopover = document.getElementById('context-popover');
const paperAttachment = document.getElementById('paper-attachment');
const paperAttachmentTitle = document.getElementById('paper-attachment-title');
const paperAttachmentState = document.getElementById('paper-attachment-state');
const paperAttachmentProgress = document.getElementById('paper-attachment-progress');
const cancelPaperAttachment = document.getElementById('cancel-paper-attachment');
let thinkingElement;
let isBusy = false;
let pendingSubmission;
let canCancel = false;
let dragDepth = 0;
let currentPaperHash;
let paperAttachmentPreparing = false;
let paperAttachmentVisible = false;
let activePdfReader;
const paperPreviewJobs = new Map();
const paperRasterSessions = new Map();
const paperPageJobs = new Map();
let streamingElement;
let streamingText = '';
let streamRenderTimer;
let canWithdraw = false;
let quotedText = '';
let quotedCitations = [];
let pendingSelectedText = '';
let pendingSelectedCitations = [];
const answerByArticle = new WeakMap();

function post(type, extra = {}) {
  vscode.postMessage({ type, ...extra });
}

function isNearConversationEnd() {
  return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
}

function cancelStreamRender() {
  clearTimeout(streamRenderTimer);
  streamRenderTimer = undefined;
}

function renderStreamingText() {
  streamRenderTimer = undefined;
  if (!streamingElement) return;
  const follow = isNearConversationEnd();
  streamingElement.querySelector('.content').innerHTML = renderMarkdown(streamingText);
  if (follow) messages.scrollTop = messages.scrollHeight;
}

for (const button of document.querySelectorAll('[data-action]')) {
  button.addEventListener('click', () => post(button.dataset.action));
}

function setContextPopover(open) {
  contextPopover.hidden = !open;
  contextToggle.setAttribute('aria-expanded', String(open));
}

contextToggle.addEventListener('click', () => setContextPopover(contextPopover.hidden));
document.addEventListener('click', (event) => {
  if (
    !contextPopover.hidden &&
    !contextPopover.contains(event.target) &&
    !contextToggle.contains(event.target)
  ) {
    setContextPopover(false);
  }
});

function updateContextSummary() {
  const paper = document.getElementById('paper-status').textContent;
  const code = document.getElementById('index-status').textContent;
  const model = document.getElementById('model-status').textContent;
  contextToggle.title = `Paper: ${paper}\nCode: ${code}\nModel: ${model}`;
}

function updateSendAvailability() {
  send.disabled = isBusy || Boolean(pendingSubmission) || paperAttachmentPreparing;
  prompt.disabled = isBusy || Boolean(pendingSubmission);
  send.title = paperAttachmentPreparing ? 'Wait for the PDF to finish preparing' : '';
}

function setPaperAttachmentCard({
  title = '',
  state = '',
  progress = 0,
  preparing = false,
  blocked = preparing,
  visible = true
} = {}) {
  paperAttachmentVisible = visible;
  paperAttachmentPreparing = visible && blocked;
  paperAttachment.hidden = !visible;
  paperAttachmentTitle.textContent = title;
  paperAttachmentState.textContent = state;
  const boundedProgress = Math.max(0, Math.min(100, Number(progress) || 0));
  paperAttachmentProgress.style.setProperty('--paper-progress', `${boundedProgress * 3.6}deg`);
  paperAttachmentProgress.setAttribute('aria-valuenow', String(Math.round(boundedProgress)));
  paperAttachmentProgress.classList.remove('opening');
  paperAttachmentProgress.classList.toggle('loading', visible && preparing);
  paperAttachmentProgress.classList.toggle('ready', visible && !preparing && boundedProgress >= 100);
  updateSendAvailability();
}

cancelPaperAttachment.addEventListener('click', () => {
  activePdfReader?.abort();
  activePdfReader = undefined;
  setPaperAttachmentCard({ visible: false });
  post('cancelPaperAttachment');
});

function submit() {
  const text = prompt.value.trim();
  if (!text || send.disabled) {
    return;
  }
  pendingSubmission = { text, quotedText, quotedCitations };
  updateSendAvailability();
  post('ask', pendingSubmission);
  prompt.value = '';
  setQuotedText('');
}

send.addEventListener('click', submit);
prompt.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    submit();
  }
});

function setQuotedText(text, citations = []) {
  quotedText = (text || '').trim().slice(0, 4000);
  quotedCitations = quotedText ? citations : [];
  selectionContext.hidden = !quotedText;
  selectionPreview.textContent = quotedText
    ? quotedText.length > 220
      ? `${quotedText.slice(0, 220)}…`
      : quotedText
    : '';
}

function hideAskSelection() {
  askSelection.hidden = true;
  pendingSelectedText = '';
  pendingSelectedCitations = [];
}

function updateAskSelection() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) {
    hideAskSelection();
    return;
  }
  const selectedText = selection.toString().trim();
  const anchor = selection.anchorNode;
  const anchorElement = anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement;
  const assistantContent = anchorElement?.closest?.('.message.assistant .content');
  if (!assistantContent || !selectedText) {
    hideAskSelection();
    return;
  }
  pendingSelectedText = selectedText.slice(0, 4000);
  const common = selection.getRangeAt(0).commonAncestorContainer;
  const element = common.nodeType === Node.ELEMENT_NODE ? common : common.parentElement;
  const article = element?.closest?.('.message.assistant');
  const answer = answerByArticle.get(article);
  const block = element?.closest?.('p, li, blockquote, td, th, h1, h2, h3, h4, h5, h6');
  const nearbyIds = new Set(
    [...(block?.querySelectorAll?.('.inline-citation[data-citation-id]') || [])].map(
      (button) => button.dataset.citationId
    )
  );
  pendingSelectedCitations = nearbyIds.size
    ? (answer?.citations || []).filter((citation) => nearbyIds.has(citation.citationId))
    : answer?.citations || [];
  const bounds = selection.getRangeAt(0).getBoundingClientRect();
  askSelection.hidden = false;
  const left = Math.min(Math.max(8, bounds.left), window.innerWidth - askSelection.offsetWidth - 8);
  const top = Math.max(8, bounds.top - askSelection.offsetHeight - 7);
  askSelection.style.left = `${left}px`;
  askSelection.style.top = `${top}px`;
}

document.addEventListener('mouseup', () => setTimeout(updateAskSelection, 0));
document.addEventListener('keyup', (event) => {
  if (event.key.startsWith('Arrow') || event.key === 'Shift') {
    setTimeout(updateAskSelection, 0);
  }
});
document.addEventListener('scroll', hideAskSelection, true);
askSelection.addEventListener('mousedown', (event) => event.preventDefault());
askSelection.addEventListener('click', () => {
  setQuotedText(pendingSelectedText, pendingSelectedCitations);
  hideAskSelection();
  window.getSelection()?.removeAllRanges();
  prompt.focus();
});
clearSelection.addEventListener('click', () => setQuotedText(''));

function setSelectedCode(selection) {
  codeContext.hidden = !selection;
  codePreview.textContent = selection
    ? `${selection.filePath}:${selection.startLine}-${selection.endLine}${
        selection.preview ? ` — ${selection.preview}` : ''
      }`
    : '';
}

clearCode.addEventListener('click', () => {
  setSelectedCode();
  post('clearSelectedCode');
});

function cancelPendingLocally() {
  cancelStreamRender();
  document.querySelector('.message.user.pending:last-of-type')?.remove();
  streamingElement?.remove();
  streamingElement = undefined;
  streamingText = '';
  hideThinking();
}

function cancelRequest(withdrawMessage) {
  if (!isBusy || !canCancel) {
    return;
  }
  if (withdrawMessage) {
    cancelPendingLocally();
  } else {
    document.querySelector('.message.user.pending:last-of-type')?.classList.remove('pending');
    hideThinking();
  }
  post('cancelRequest', { withdrawMessage });
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function renderMath(expression, displayMode) {
  const source = expression.trim();
  if (!source) {
    return '';
  }
  if (!globalThis.katex?.renderToString) {
    return `<code class="math-fallback">${escapeHtml(source)}</code>`;
  }
  try {
    return globalThis.katex.renderToString(source, {
      displayMode,
      throwOnError: false,
      strict: 'ignore',
      trust: false,
      output: 'htmlAndMathml'
    });
  } catch {
    return `<code class="math-fallback">${escapeHtml(source)}</code>`;
  }
}

function renderInline(source) {
  const tokens = [];
  let value = source
    .replace(/`([^`\n]+)`/g, (_, code) => {
      const token = `\uE000${tokens.length}\uE001`;
      tokens.push(`<code>${escapeHtml(code)}</code>`);
      return token;
    })
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
      const token = `\uE000${tokens.length}\uE001`;
      tokens.push(
        `<a href="${escapeHtml(url)}" title="${escapeHtml(url)}">${escapeHtml(label)}</a>`
      );
      return token;
    })
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, expression) => {
      const token = `\uE000${tokens.length}\uE001`;
      tokens.push(`<span class="math-display">${renderMath(expression, true)}</span>`);
      return token;
    })
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, expression) => {
      const token = `\uE000${tokens.length}\uE001`;
      tokens.push(`<span class="math-inline">${renderMath(expression, false)}</span>`);
      return token;
    })
    .replace(/\$\$([^$]+?)\$\$/g, (_, expression) => {
      const token = `\uE000${tokens.length}\uE001`;
      tokens.push(`<span class="math-display">${renderMath(expression, true)}</span>`);
      return token;
    })
    .replace(/(^|[^\\$])\$([^$\n]+?)\$/g, (_, prefix, expression) => {
      const token = `\uE000${tokens.length}\uE001`;
      tokens.push(`<span class="math-inline">${renderMath(expression, false)}</span>`);
      return `${prefix}${token}`;
    });
  value = escapeHtml(value)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
  return value.replace(/\uE000(\d+)\uE001/g, (_, index) => tokens[Number(index)] || '');
}

function tableCells(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
}

function isTableSeparator(line) {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isBlockStart(lines, index) {
  const line = lines[index] || '';
  return (
    /^\s*```/.test(line) ||
    /^\s*(?:\\\[|\$\$)/.test(line) ||
    /^\s{0,3}#{1,6}\s+/.test(line) ||
    /^\s{0,3}(?:[-*_]\s*){3,}$/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*[-+*]\s+/.test(line) ||
    /^\s*\d+[.)]\s+/.test(line) ||
    (line.includes('|') && isTableSeparator(lines[index + 1] || ''))
  );
}

function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^\s*```\s*([\w+-]*)/);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      index += index < lines.length ? 1 : 0;
      const language = fence[1] ? ` class="language-${escapeHtml(fence[1])}"` : '';
      output.push(`<pre><code${language}>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    const trimmed = line.trim();
    if (trimmed.startsWith('\\[') || trimmed.startsWith('$$')) {
      const latex = [];
      const bracketed = trimmed.startsWith('\\[');
      const opening = bracketed ? '\\[' : '$$';
      const closing = bracketed ? '\\]' : '$$';
      let current = trimmed.slice(opening.length);
      let closed = false;
      while (true) {
        const closingIndex = current.indexOf(closing);
        if (closingIndex >= 0) {
          latex.push(current.slice(0, closingIndex));
          closed = true;
          break;
        }
        latex.push(current);
        index += 1;
        if (index >= lines.length) {
          break;
        }
        current = lines[index];
      }
      if (closed) {
        output.push(`<div class="math-display">${renderMath(latex.join('\n'), true)}</div>`);
        index += 1;
        continue;
      }
      output.push(`<p>${renderInline(line.trim())}</p>`);
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) {
      const level = heading[1].length;
      output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s{0,3}(?:[-*_]\s*){3,}$/.test(line)) {
      output.push('<hr>');
      index += 1;
      continue;
    }

    if (line.includes('|') && isTableSeparator(lines[index + 1] || '')) {
      const headers = tableCells(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      output.push(
        `<table><thead><tr>${headers.map((cell) => `<th>${renderInline(cell)}</th>`).join('')}</tr></thead>` +
          `<tbody>${rows.map((row) => `<tr>${headers.map((_, cellIndex) => `<td>${renderInline(row[cellIndex] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`
      );
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      output.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`);
      continue;
    }

    const unordered = line.match(/^\s*[-+*]\s+(.+)/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)/);
    if (unordered || ordered) {
      const tag = unordered ? 'ul' : 'ol';
      const items = [];
      const pattern = unordered ? /^\s*[-+*]\s+(.+)/ : /^\s*\d+[.)]\s+(.+)/;
      while (index < lines.length) {
        const item = lines[index].match(pattern);
        if (!item) {
          break;
        }
        items.push(`<li>${renderInline(item[1])}</li>`);
        index += 1;
      }
      output.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines, index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    output.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
  }
  return output.join('');
}

stop.addEventListener('click', () => cancelRequest(false));
document.addEventListener('keydown', (event) => {
  if (!isBusy || !canCancel || !canWithdraw || event.key.toLowerCase() !== 'c' || !event.ctrlKey || event.metaKey) {
    return;
  }
  const active = document.activeElement;
  const inputHasSelection =
    active instanceof HTMLTextAreaElement && active.selectionStart !== active.selectionEnd;
  const documentHasSelection = Boolean(window.getSelection()?.toString());
  if (inputHasSelection || documentHasSelection) {
    return;
  }
  event.preventDefault();
  cancelRequest(true);
});

function decorateInlineCitations(content, answer) {
  if (!answer) {
    return;
  }
  const paperCitations = new Map(
    (answer.citations || []).map((citation) => [citation.citationId, citation])
  );
  const codeCitations = new Map(
    (answer.codeLocations || []).map((location) => [location.codeId, location])
  );
  if (!paperCitations.size && !codeCitations.size) {
    return;
  }

  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.parentElement?.closest('code, pre, button') && /\[(?:P|C)\d+\]/.test(node.textContent || '')) {
      textNodes.push(node);
    }
  }

  for (const node of textNodes) {
    const text = node.textContent || '';
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const match of text.matchAll(/\[((?:P|C)\d+)\]/g)) {
      const citationId = match[1];
      const start = match.index ?? 0;
      fragment.append(document.createTextNode(text.slice(cursor, start)));
      const paperCitation = paperCitations.get(citationId);
      const codeCitation = codeCitations.get(citationId);
      if (paperCitation || codeCitation) {
        const button = document.createElement('button');
        button.className = `inline-citation${codeCitation ? ' code-citation' : ''}`;
        button.dataset.citationId = citationId;
        button.textContent = `[${citationId}]`;
        if (paperCitation) {
          button.title = `Open paper page ${paperCitation.page}: ${paperCitation.preview}`;
          button.setAttribute('aria-label', `Open paper evidence ${citationId}, page ${paperCitation.page}`);
          button.addEventListener('click', () =>
            post('openEvidence', { citation: paperCitation })
          );
        } else {
          button.title = `${codeCitation.filePath}:${codeCitation.startLine}-${codeCitation.endLine}`;
          button.setAttribute('aria-label', `Open code evidence ${citationId}`);
          button.addEventListener('click', () => post('openCode', codeCitation));
        }
        fragment.append(button);
      } else {
        fragment.append(document.createTextNode(match[0]));
      }
      cursor = start + match[0].length;
    }
    fragment.append(document.createTextNode(text.slice(cursor)));
    node.replaceWith(fragment);
  }
}

function messageElement(
  role,
  text,
  pending = false,
  markdown = false,
  answer,
  selectedText,
  codeSelection,
  attachedPaper
) {
  const follow = role === 'user' || isNearConversationEnd();
  document.getElementById('empty-state')?.remove();
  const article = document.createElement('article');
  article.className = `message ${role}${pending ? ' pending' : ''}`;
  if (answer) {
    answerByArticle.set(article, answer);
  }
  const roleElement = document.createElement('div');
  roleElement.className = 'role';
  roleElement.textContent = role === 'user' ? 'You' : role === 'error' ? 'Error' : 'CodeChasing';
  const content = document.createElement('div');
  content.className = 'content';
  if (markdown) {
    content.classList.add('markdown');
    content.innerHTML = renderMarkdown(text);
    decorateInlineCitations(content, answer);
  } else {
    content.textContent = text;
  }
  article.append(roleElement, content);
  if (attachedPaper) {
    const fileCard = document.createElement('div');
    fileCard.className = 'message-paper-attachment';
    const icon = document.createElement('span');
    icon.className = 'message-paper-icon';
    icon.textContent = 'PDF';
    const copy = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = attachedPaper.title;
    const detail = document.createElement('small');
    detail.textContent = attachedPaper.pageCount ? `PDF · ${attachedPaper.pageCount} pages` : 'PDF';
    copy.append(title, detail);
    fileCard.append(icon, copy);
    article.insertBefore(fileCard, content);
  }
  if (selectedText) {
    const quote = document.createElement('blockquote');
    quote.className = 'message-selection';
    quote.textContent = selectedText;
    article.insertBefore(quote, content);
  }
  if (codeSelection) {
    const codeReference = document.createElement('div');
    codeReference.className = 'message-code-selection';
    codeReference.textContent = `${codeSelection.filePath}:${codeSelection.startLine}-${codeSelection.endLine}`;
    article.insertBefore(codeReference, content);
  }
  messages.append(article);
  if (follow) messages.scrollTop = messages.scrollHeight;
  return article;
}

function appendSources(article, answer) {
  if (answer.citations?.length) {
    const sources = document.createElement('div');
    sources.className = 'sources';
    for (const citation of answer.citations) {
      const button = document.createElement('button');
      button.className = 'source-chip';
      button.title = citation.preview;
      button.textContent = `[${citation.citationId}] p.${citation.page}`;
      button.addEventListener('click', () => post('openEvidence', { citation }));
      sources.append(button);
    }
    article.append(sources);
  }
  if (answer.codeLocations?.length) {
    const locations = document.createElement('div');
    locations.className = 'sources';
    for (const location of answer.codeLocations) {
      const button = document.createElement('button');
      button.className = 'source-chip code-chip';
      button.textContent = `[${location.codeId}] ${location.symbolName || location.filePath}`;
      button.title = `${location.filePath}:${location.startLine}-${location.endLine}`;
      button.addEventListener('click', () => post('openCode', location));
      locations.append(button);
    }
    article.append(locations);
  }
}

function showThinking(label) {
  const follow = isNearConversationEnd();
  document.getElementById('empty-state')?.remove();
  if (!thinkingElement) {
    thinkingElement = document.createElement('article');
    thinkingElement.className = 'message assistant thinking';
    const role = document.createElement('div');
    role.className = 'role';
    role.textContent = 'CodeChasing';
    const row = document.createElement('div');
    row.className = 'thinking-row';
    const labelElement = document.createElement('span');
    labelElement.className = 'thinking-label';
    const dots = document.createElement('span');
    dots.className = 'thinking-dots';
    dots.innerHTML = '<i></i><i></i><i></i>';
    row.append(labelElement, dots);
    thinkingElement.append(role, row);
    messages.append(thinkingElement);
  }
  thinkingElement.querySelector('.thinking-label').textContent = 'Thinking';
  if (follow) messages.scrollTop = messages.scrollHeight;
}

function hideThinking() {
  thinkingElement?.remove();
  thinkingElement = undefined;
}

function resetMessages() {
  cancelStreamRender();
  streamingElement = undefined;
  streamingText = '';
  hideThinking();
  setQuotedText('');
  setSelectedCode();
  messages.replaceChildren();
  showEmptyState();
}

function showEmptyState() {
  const emptyState = document.createElement('section');
  emptyState.id = 'empty-state';
  const heading = document.createElement('h1');
  heading.textContent = '你好，想聊些什么？';
  const description = document.createElement('p');
  description.textContent = '可以直接聊天，也可以导入论文或选择代码进行联合分析';
  emptyState.append(heading, description);
  messages.append(emptyState);
}

function restoreConversation(history) {
  cancelStreamRender();
  hideThinking();
  streamingElement = undefined;
  streamingText = '';
  messages.replaceChildren();
  if (!history?.length) {
    showEmptyState();
    return;
  }
  for (const item of history) {
    if (item.role === 'user') {
      messageElement(
        'user',
        item.content,
        false,
        false,
        undefined,
        item.quotedText,
        item.codeSelection,
        item.paperAttachment
      );
    } else if (item.role === 'assistant') {
      const article = messageElement('assistant', item.content, false, true, item.answer);
      if (item.answer) appendSources(article, item.answer);
    }
  }
  messages.scrollTop = messages.scrollHeight;
}

function uploadPdf(file) {
  if (!file || (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf')) {
    messageElement('error', '请拖入 PDF 文件。');
    return;
  }
  if (file.size > 50 * 1024 * 1024) {
    messageElement('error', '当前版本支持最大 50 MB 的 PDF。');
    return;
  }
  setPaperAttachmentCard({
    title: file.name,
    state: 'Reading file…',
    progress: 2,
    preparing: true,
    visible: true
  });
  const reader = new FileReader();
  activePdfReader = reader;
  reader.onabort = () => {
    if (activePdfReader === reader) {
      activePdfReader = undefined;
    }
  };
  reader.onerror = () => {
    activePdfReader = undefined;
    setPaperAttachmentCard({ visible: false });
    messageElement('error', '无法读取这个 PDF 文件。');
  };
  reader.onprogress = (event) => {
    if (event.lengthComputable) {
      setPaperAttachmentCard({
        title: file.name,
        state: 'Reading file…',
        progress: Math.max(2, Math.min(10, (event.loaded / event.total) * 10)),
        preparing: true,
        visible: true
      });
    }
  };
  reader.onload = () => {
    if (activePdfReader !== reader) {
      return;
    }
    activePdfReader = undefined;
    const result = typeof reader.result === 'string' ? reader.result : '';
    const base64 = result.includes(',') ? result.slice(result.indexOf(',') + 1) : '';
    if (!base64) {
      setPaperAttachmentCard({ visible: false });
      messageElement('error', 'PDF 文件内容为空。');
      return;
    }
    post('dropPdf', { fileName: file.name, base64 });
    setPaperAttachmentCard({
      title: file.name,
      state: 'Preparing PDF…',
      progress: 10,
      preparing: true,
      visible: true
    });
  };
  reader.readAsDataURL(file);
}

async function renderPaperPreview(job) {
  try {
    if (paperAttachmentVisible && currentPaperHash === job.hash) {
      setPaperAttachmentCard({
        title: paperAttachmentTitle.textContent,
        state: 'Rendering first page in background…',
        progress: 99,
        preparing: true,
        visible: true
      });
    }
    const pdfjs = await import(job.pdfModule);
    pdfjs.GlobalWorkerOptions.workerSrc = job.workerModule;
    const binary = atob(job.chunks.join(''));
    if (job.cancelled) {
      return;
    }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    job.chunks = [];
    job.loadingTask = pdfjs.getDocument({ data: bytes, wasmUrl: job.wasmUrl });
    const pdf = await job.loadingTask.promise;
    if (job.cancelled) {
      await job.loadingTask.destroy();
      return;
    }
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1.25 });
    const outputScale = Math.min(window.devicePixelRatio || 1, 1.5);
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width * outputScale);
    canvas.height = Math.ceil(viewport.height * outputScale);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) {
      throw new Error('Canvas is unavailable for PDF preview rendering.');
    }
    await page.render({
      canvasContext: context,
      viewport,
      transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0]
    }).promise;
    if (job.cancelled) {
      await job.loadingTask.destroy();
      return;
    }
    const dataUrl = canvas.toDataURL('image/jpeg', 0.84);
    page.cleanup();
    const previousSession = paperRasterSessions.get(job.hash);
    if (previousSession) {
      await previousSession.loadingTask.destroy();
    }
    paperRasterSessions.set(job.hash, { pdf, loadingTask: job.loadingTask });
    while (paperRasterSessions.size > 2) {
      const oldestHash = paperRasterSessions.keys().next().value;
      if (!oldestHash || oldestHash === job.hash) break;
      const oldest = paperRasterSessions.get(oldestHash);
      paperRasterSessions.delete(oldestHash);
      await oldest?.loadingTask.destroy();
    }
    paperPreviewJobs.delete(job.hash);
    post('paperPreviewReady', {
      hash: job.hash,
      dataUrl,
      width: viewport.width,
      height: viewport.height
    });
  } catch (error) {
    try {
      await job.loadingTask?.destroy();
    } catch {
      // The loading task may already have transferred or released its worker resources.
    }
    paperPreviewJobs.delete(job.hash);
    if (!job.cancelled) {
      post('paperPreviewFailed', {
        hash: job.hash,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

async function renderRequestedPaperPages(message) {
  const requestId = message.requestId;
  const job = { hash: message.hash, cancelled: false, task: undefined };
  paperPageJobs.set(requestId, job);
  try {
    const session = paperRasterSessions.get(message.hash);
    if (!session) {
      throw new Error('The background PDF renderer is not ready. Retry paper preparation.');
    }
    const pages = [...new Set((Array.isArray(message.pages) ? message.pages : [])
      .map((page) => Math.floor(Number(page)))
      .filter((page) => page > 0 && page <= session.pdf.numPages))];
    const scale = Math.max(1, Math.min(2.5, Number(message.scale) || 1.65));
    const quality = Math.max(0.55, Math.min(0.95, Number(message.quality) || 0.86));
    const rendered = [];
    for (const pageNumber of pages) {
      if (job.cancelled) return;
      const page = await session.pdf.getPage(pageNumber);
      if (job.cancelled) return;
      let viewport = page.getViewport({ scale });
      const maximumPixels = 4_000_000;
      if (viewport.width * viewport.height > maximumPixels) {
        const correction = Math.sqrt(maximumPixels / (viewport.width * viewport.height));
        viewport = page.getViewport({ scale: scale * correction });
      }
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error(`Canvas is unavailable for PDF page ${pageNumber}.`);
      job.task = page.render({ canvasContext: context, viewport });
      await job.task.promise;
      job.task = undefined;
      if (job.cancelled) return;
      rendered.push({
        page: pageNumber,
        width: viewport.width,
        height: viewport.height,
        mimeType: 'image/jpeg',
        label: `PDF page ${pageNumber}`,
        dataUrl: canvas.toDataURL('image/jpeg', quality)
      });
      page.cleanup();
    }
    post('paperPageImagesReady', { requestId, pages: rendered });
  } catch (error) {
    if (job.cancelled) return;
    post('paperPageImagesFailed', {
      requestId,
      message: error instanceof Error ? error.message : String(error)
    });
  } finally {
    paperPageJobs.delete(requestId);
  }
}

document.addEventListener('dragenter', (event) => {
  event.preventDefault();
  dragDepth += 1;
  dropOverlay.classList.add('visible');
});
document.addEventListener('dragover', (event) => {
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'copy';
  }
});
document.addEventListener('dragleave', (event) => {
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    dropOverlay.classList.remove('visible');
  }
});
document.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.remove('visible');
  uploadPdf(event.dataTransfer?.files?.[0]);
});

window.addEventListener('message', (event) => {
  const message = event.data;
  switch (message.type) {
    case 'paperPreviewStart':
      paperPreviewJobs.set(message.hash, {
        hash: message.hash,
        pdfModule: message.pdfModule,
        workerModule: message.workerModule,
        wasmUrl: message.wasmUrl,
        chunks: new Array(Number(message.chunkCount) || 0),
        cancelled: false
      });
      break;
    case 'paperPreviewChunk': {
      const job = paperPreviewJobs.get(message.hash);
      if (job) {
        job.chunks[Number(message.index)] = message.data || '';
      }
      break;
    }
    case 'paperPreviewEnd': {
      const job = paperPreviewJobs.get(message.hash);
      if (job) {
        void renderPaperPreview(job);
      }
      break;
    }
    case 'paperPageImagesRequest':
      void renderRequestedPaperPages(message);
      break;
    case 'cancelPaperPageImages': {
      const job = paperPageJobs.get(message.requestId);
      if (job) {
        job.cancelled = true;
        job.task?.cancel();
      }
      break;
    }
    case 'cancelPaperPreview':
      for (const job of paperPageJobs.values()) {
        if (!message.hash || job.hash === message.hash) {
          job.cancelled = true;
          job.task?.cancel();
        }
      }
      for (const [hash, job] of paperPreviewJobs) {
        if (!message.hash || hash === message.hash) {
          job.cancelled = true;
          void job.loadingTask?.destroy();
          paperPreviewJobs.delete(hash);
        }
      }
      for (const [hash, session] of paperRasterSessions) {
        if (!message.hash || hash === message.hash) {
          paperRasterSessions.delete(hash);
          void session.loadingTask.destroy();
        }
      }
      break;
    case 'paperStatus': {
      const target = document.getElementById('paper-status');
      if (!message.paper) {
        currentPaperHash = undefined;
        target.textContent = 'Not imported';
        setPaperAttachmentCard({ visible: false });
      } else {
        currentPaperHash = message.paper.hash;
        const pages = message.paper.pageCount ? ` · ${message.paper.pageCount} pages` : '';
        const analysis = [
          message.paper.ocrPageCount ? `OCR ${message.paper.ocrPageCount}` : '',
          message.paper.visualPageCount ? `visual ${message.paper.visualPageCount}` : ''
        ].filter(Boolean).join(' · ');
        const state =
          message.paper.extractionStatus === 'ready'
            ? 'Ready'
            : message.paper.extractionStatus === 'failed'
              ? 'Preparation failed'
              : message.paper.extractionStatus === 'paused'
                ? 'Paused'
                : 'Preparing…';
        target.textContent = `${message.paper.title}${pages} · ${state}${analysis ? ` · ${analysis}` : ''}`;
        if (message.paper.attachmentPending) {
          const ready = message.paper.extractionStatus === 'ready';
          const failed = message.paper.extractionStatus === 'failed';
          setPaperAttachmentCard({
            title: `${message.paper.title}.pdf`,
            state: ready
              ? `Ready · background loaded${message.paper.pageCount ? ` · ${message.paper.pageCount} pages` : ''}`
              : failed
                ? 'Preparation failed · remove and retry'
                : message.paper.extractionStatus === 'paused'
                  ? 'Preparation paused'
                  : 'Preparing PDF…',
            progress: ready ? 100 : failed ? 0 : 10,
            preparing: !ready && !failed && message.paper.extractionStatus !== 'paused',
            blocked: !ready,
            visible: true
          });
        } else {
          setPaperAttachmentCard({ visible: false });
        }
      }
      updateContextSummary();
      break;
    }
    case 'paperIndexProgress':
      if (message.hash === currentPaperHash) {
        document.getElementById('paper-status').textContent =
          `Preparing PDF · ${message.page}/${message.pageCount}`;
        updateContextSummary();
        if (paperAttachmentVisible) {
          const percent = message.pageCount > 0
            ? 10 + (message.page / message.pageCount) * 88
            : 10;
          setPaperAttachmentCard({
            title: paperAttachmentTitle.textContent,
            state: `Preparing PDF · ${message.page}/${message.pageCount}`,
            progress: percent,
            preparing: true,
            visible: true
          });
        }
      }
      break;
    case 'paperVisionProgress':
      if (message.hash === currentPaperHash) {
        const label = message.mode === 'ocr' ? 'OCR and visual reading' : 'Visual reading';
        document.getElementById('paper-status').textContent =
          `${label} · ${message.completed}/${message.total}`;
        updateContextSummary();
        if (paperAttachmentVisible) {
          const percent = message.total > 0
            ? 10 + (message.completed / message.total) * 88
            : 10;
          setPaperAttachmentCard({
            title: paperAttachmentTitle.textContent,
            state: `${label} · ${message.completed}/${message.total}`,
            progress: percent,
            preparing: true,
            visible: true
          });
        }
      }
      break;
    case 'paperViewerStatus':
      if (paperAttachmentVisible) {
        if (message.status === 'loading') {
          paperAttachmentPreparing = false;
          paperAttachmentState.textContent = 'Paper ready · reader opening…';
          paperAttachmentProgress.classList.remove('ready');
          paperAttachmentProgress.classList.add('loading', 'opening');
        } else if (message.status === 'ready') {
          paperAttachmentPreparing = false;
          paperAttachmentState.textContent = 'Ready · reader loaded';
          paperAttachmentProgress.classList.remove('loading', 'opening');
          paperAttachmentProgress.classList.add('ready');
        } else {
          paperAttachmentPreparing = false;
          paperAttachmentState.textContent = 'Paper ready · reader failed';
          paperAttachmentProgress.classList.remove('loading', 'opening', 'ready');
        }
        updateSendAvailability();
      }
      break;
    case 'paperAttachmentStart':
      setPaperAttachmentCard({
        title: message.title,
        state: 'Reading file…',
        progress: 2,
        preparing: true,
        visible: true
      });
      break;
    case 'indexStatus': {
      const labels = {
        idle: 'Not scanned',
        indexing: `Scanning · ${message.symbolCount} symbols`,
        ready: `${message.symbolCount} symbols · Ready`,
        stale: `${message.symbolCount} symbols · Stale`,
        cancelled: `${message.symbolCount} symbols · Paused`
      };
      document.getElementById('index-status').textContent = labels[message.status] || `${message.symbolCount} symbols`;
      updateContextSummary();
      break;
    }
    case 'modelStatus':
      document.getElementById('model-status').textContent = message.model
        ? `${message.model.name} · ${message.model.reasoningEffort}${
            message.model.insecureTransport ? ' · HTTP insecure' : ''
          }`
        : 'Not configured';
      document.getElementById('reasoning-label').textContent = message.model
        ? message.model.reasoningEffort
        : 'Auto';
      updateContextSummary();
      break;
    case 'mappingStatus': {
      const target = document.getElementById('mapping-status');
      if (target) target.textContent = `${Number(message.count) || 0} saved`;
      updateContextSummary();
      break;
    }
    case 'persistentExampleStatus': {
      const target = document.getElementById('example-status');
      if (target) {
        target.textContent = message.example
          ? `${message.example.title} · ${Number(message.example.steps) || 0} steps`
          : 'Not established';
      }
      updateContextSummary();
      break;
    }
    case 'busy':
      isBusy = Boolean(message.busy);
      canCancel = isBusy && Boolean(message.cancellable);
      if (isBusy) {
        canWithdraw = true;
      } else {
        canWithdraw = false;
      }
      updateSendAvailability();
      for (const button of document.querySelectorAll('[data-action]')) {
        button.disabled = isBusy;
      }
      stop.hidden = !canCancel;
      busyLabel.textContent = message.busy ? 'Thinking' : '';
      if (message.busy) {
        showThinking('Thinking');
      } else {
        hideThinking();
      }
      break;
    case 'userMessage':
      pendingSubmission = undefined;
      isBusy = true;
      updateSendAvailability();
      setSelectedCode();
      messageElement(
        'user',
        message.text,
        Boolean(message.pending),
        false,
        undefined,
        message.quotedText,
        message.codeSelection,
        message.paperAttachment
      );
      break;
    case 'selectedCode':
      setSelectedCode(message.selection);
      prompt.focus();
      break;
    case 'paperSelection':
      setQuotedText(message.text, message.citations || []);
      prompt.focus();
      break;
    case 'error':
      if (pendingSubmission) {
        prompt.value = pendingSubmission.text;
        setQuotedText(pendingSubmission.quotedText, pendingSubmission.quotedCitations);
        pendingSubmission = undefined;
        updateSendAvailability();
      }
      cancelStreamRender();
      hideThinking();
      streamingElement = undefined;
      streamingText = '';
      document.querySelector('.message.user.pending:last-of-type')?.classList.remove('pending');
      messageElement('error', message.message);
      break;
    case 'clearMessages':
      resetMessages();
      break;
    case 'restoreConversation':
      restoreConversation(message.messages);
      break;
    case 'streamStart':
      cancelStreamRender();
      streamingElement?.remove();
      streamingElement = undefined;
      streamingText = '';
      break;
    case 'streamDelta': {
      canWithdraw = false;
      hideThinking();
      if (!streamingElement) {
        streamingElement = messageElement('assistant', '', false, true);
      }
      streamingText += message.delta || '';
      if (streamRenderTimer === undefined) {
        streamRenderTimer = setTimeout(renderStreamingText, 50);
      }
      break;
    }
    case 'streamEnd': {
      cancelStreamRender();
      hideThinking();
      const follow = isNearConversationEnd();
      if (!streamingElement) {
        streamingElement = messageElement('assistant', '', false, true);
      }
      streamingText = message.answer.text;
      const content = streamingElement.querySelector('.content');
      content.innerHTML = renderMarkdown(streamingText);
      answerByArticle.set(streamingElement, message.answer);
      decorateInlineCitations(content, message.answer);
      appendSources(streamingElement, message.answer);
      if (follow) messages.scrollTop = messages.scrollHeight;
      streamingElement = undefined;
      streamingText = '';
      document.querySelector('.message.user.pending:last-of-type')?.classList.remove('pending');
      break;
    }
    case 'cancelPendingMessage':
      cancelPendingLocally();
      break;
    case 'finalizePendingMessage':
      cancelStreamRender();
      renderStreamingText();
      document.querySelector('.message.user.pending:last-of-type')?.classList.remove('pending');
      streamingElement = undefined;
      streamingText = '';
      hideThinking();
      break;
    case 'answer': {
      document.querySelector('.message.user.pending:last-of-type')?.classList.remove('pending');
      const article = messageElement('assistant', message.answer.text, false, true, message.answer);
      appendSources(article, message.answer);
      break;
    }
  }
});

post('ready');
