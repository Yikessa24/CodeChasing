const vscode = acquireVsCodeApi();
const config = window.codeChasingPaper;
const pagesRoot = document.getElementById('pages');
const status = document.getElementById('status');
const zoomOut = document.getElementById('zoom-out');
const zoomIn = document.getElementById('zoom-in');
const fitWidthButton = document.getElementById('fit-width');
const zoomLabel = document.getElementById('zoom-label');
const askPdfSelection = document.getElementById('ask-pdf-selection');
const renderedPages = new Map();
const pageViewports = new Map();
const textLayers = new Map();
const pagePromises = new Map();
const renderPromises = new Map();
let pendingHighlight;
let pageObserver;
let pdfjsLib;
let pdfjsViewer;
let zoom = 1;
let fitMode = true;
let pendingPdfSelection;
let dragSelectionStart;
let resolvePdfData;
let pdfDataChunks = [];
const pdfDataPromise = new Promise((resolve) => {
  resolvePdfData = resolve;
});
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.2;

function installStartupPreview() {
  if (!config.preview?.dataUrl || !config.preview.width || !config.preview.height) {
    return undefined;
  }
  const container = document.createElement('section');
  container.className = 'startup-preview';
  container.style.width = `${config.preview.width}px`;
  container.style.aspectRatio = `${config.preview.width} / ${config.preview.height}`;
  const image = document.createElement('img');
  image.src = config.preview.dataUrl;
  image.alt = 'Prepared preview of PDF page 1';
  container.append(image);
  pagesRoot.append(container);
  status.textContent = 'Prepared preview · opening reader…';
  return container;
}

const startupPreview = installStartupPreview();

function clampZoom(value) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

function updatePageSize(container) {
  const baseWidth = Number(container.dataset.baseWidth);
  const baseHeight = Number(container.dataset.baseHeight);
  if (!baseWidth || !baseHeight) {
    return;
  }
  container.style.width = `${baseWidth * zoom}px`;
  container.style.height = `${baseHeight * zoom}px`;
  const textLayerRecord = textLayers.get(Number(container.dataset.page));
  if (textLayerRecord) {
    const scaledViewport = textLayerRecord.page.getViewport({
      scale: textLayerRecord.baseScale * zoom
    });
    textLayerRecord.element.style.width = `${scaledViewport.width}px`;
    textLayerRecord.element.style.height = `${scaledViewport.height}px`;
    textLayerRecord.element.style.setProperty(
      '--total-scale-factor',
      String(scaledViewport.scale)
    );
    void textLayerRecord.builder.render({ viewport: scaledViewport });
  }
}

function applyZoom() {
  for (const container of renderedPages.values()) {
    updatePageSize(container);
  }
  zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  zoomOut.disabled = zoom <= MIN_ZOOM;
  zoomIn.disabled = zoom >= MAX_ZOOM;
}

function setZoom(nextZoom) {
  fitMode = false;
  zoom = clampZoom(nextZoom);
  applyZoom();
}

function fitToWidth() {
  const firstPage = renderedPages.get(1);
  const baseWidth = Number(firstPage?.dataset.baseWidth);
  if (!baseWidth) {
    return;
  }
  fitMode = true;
  const availableWidth = Math.max(240, document.documentElement.clientWidth - 40);
  zoom = clampZoom(availableWidth / baseWidth);
  applyZoom();
}

zoomOut.addEventListener('click', () => setZoom(zoom - ZOOM_STEP));
zoomIn.addEventListener('click', () => setZoom(zoom + ZOOM_STEP));
fitWidthButton.addEventListener('click', fitToWidth);
window.addEventListener('resize', () => {
  if (fitMode) {
    fitToWidth();
  }
});
window.addEventListener(
  'wheel',
  (event) => {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }
    event.preventDefault();
    setZoom(zoom + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
  },
  { passive: false }
);

function hidePdfSelectionAction() {
  askPdfSelection.hidden = true;
  pendingPdfSelection = undefined;
  for (const marker of document.querySelectorAll('.pdf-selection-highlight')) {
    marker.remove();
  }
}

function elementForNode(node) {
  return node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
}

function clampUnit(value) {
  return Math.min(1, Math.max(0, value));
}

function selectionBoxes(range, pageElement) {
  const pageRect = pageElement.getBoundingClientRect();
  if (!pageRect.width || !pageRect.height) {
    return [];
  }
  const boxes = [];
  for (const rect of range.getClientRects()) {
    const left = Math.max(rect.left, pageRect.left);
    const top = Math.max(rect.top, pageRect.top);
    const right = Math.min(rect.right, pageRect.right);
    const bottom = Math.min(rect.bottom, pageRect.bottom);
    if (right - left < 1 || bottom - top < 1) {
      continue;
    }
    const x = clampUnit((left - pageRect.left) / pageRect.width);
    const y = clampUnit((top - pageRect.top) / pageRect.height);
    const width = clampUnit((right - left) / pageRect.width);
    const height = clampUnit((bottom - top) / pageRect.height);
    if (width > 0 && height > 0) {
      boxes.push({ x, y, width: Math.min(width, 1 - x), height: Math.min(height, 1 - y) });
    }
    if (boxes.length >= 120) {
      break;
    }
  }
  return boxes;
}

function normalizedRect(rect, pageRect) {
  const left = Math.max(rect.left, pageRect.left);
  const top = Math.max(rect.top, pageRect.top);
  const right = Math.min(rect.right, pageRect.right);
  const bottom = Math.min(rect.bottom, pageRect.bottom);
  if (right - left < 1 || bottom - top < 1) {
    return undefined;
  }
  const x = clampUnit((left - pageRect.left) / pageRect.width);
  const y = clampUnit((top - pageRect.top) / pageRect.height);
  const width = clampUnit((right - left) / pageRect.width);
  const height = clampUnit((bottom - top) / pageRect.height);
  return { x, y, width: Math.min(width, 1 - x), height: Math.min(height, 1 - y) };
}

function columnSelection(pageElement, start, end) {
  if (!start?.span || !end?.span || start.page !== pageElement || end.page !== pageElement) {
    return undefined;
  }
  const pageRect = pageElement.getBoundingClientRect();
  const startRect = start.span.getBoundingClientRect();
  const endRect = end.span.getBoundingClientRect();
  const startCenter = (startRect.left + startRect.right) / 2;
  const endCenter = (endRect.left + endRect.right) / 2;
  const midpoint = pageRect.left + pageRect.width / 2;
  const sameSide = (startCenter < midpoint) === (endCenter < midpoint);
  const narrowEndpoints =
    startRect.width < pageRect.width * 0.58 && endRect.width < pageRect.width * 0.58;
  const isDrag = Math.hypot(end.x - start.x, end.y - start.y) >= 5;
  if (!sameSide || !narrowEndpoints || !isDrag) {
    return undefined;
  }

  const side = startCenter < midpoint ? 'left' : 'right';
  const top = Math.min(start.y, end.y) - Math.max(startRect.height, endRect.height) * 0.6;
  const bottom = Math.max(start.y, end.y) + Math.max(startRect.height, endRect.height) * 0.6;
  const spans = [...pageElement.querySelectorAll('.textLayer span:not(.markedContent)')]
    .map((span) => ({ span, rect: span.getBoundingClientRect() }))
    .filter(({ span, rect }) => {
      if (!span.textContent?.trim() || rect.width < 1 || rect.height < 1) {
        return false;
      }
      const center = (rect.left + rect.right) / 2;
      const inColumn = side === 'left' ? center < midpoint : center >= midpoint;
      return inColumn && rect.bottom >= top && rect.top <= bottom;
    })
    .sort((a, b) => {
      const lineTolerance = Math.max(2, Math.min(a.rect.height, b.rect.height) * 0.45);
      return Math.abs(a.rect.top - b.rect.top) <= lineTolerance
        ? a.rect.left - b.rect.left
        : a.rect.top - b.rect.top;
    });
  if (!spans.length) {
    return undefined;
  }

  const boxes = spans
    .map(({ rect }) => normalizedRect(rect, pageRect))
    .filter(Boolean)
    .slice(0, 120);
  if (!boxes.length) {
    return undefined;
  }
  const lines = [];
  for (const item of spans) {
    const previous = lines.at(-1);
    const tolerance = Math.max(2, item.rect.height * 0.55);
    if (!previous || Math.abs(previous.top - item.rect.top) > tolerance) {
      lines.push({ top: item.rect.top, parts: [item.span.textContent.trim()] });
    } else {
      previous.parts.push(item.span.textContent.trim());
    }
  }
  return {
    text: lines.map((line) => line.parts.join(' ')).join('\n').slice(0, 4000),
    boxes
  };
}

function paintPdfSelection(pageElement, boxes) {
  for (const marker of document.querySelectorAll('.pdf-selection-highlight')) {
    marker.remove();
  }
  for (const box of boxes) {
    const marker = document.createElement('div');
    marker.className = 'pdf-selection-highlight';
    marker.style.left = `${box.x * 100}%`;
    marker.style.top = `${box.y * 100}%`;
    marker.style.width = `${box.width * 100}%`;
    marker.style.height = `${box.height * 100}%`;
    pageElement.append(marker);
  }
}

function positionSelectionAction(bounds) {
  askPdfSelection.hidden = false;
  const left = Math.min(
    Math.max(8, bounds.left + bounds.width / 2 - askPdfSelection.offsetWidth / 2),
    window.innerWidth - askPdfSelection.offsetWidth - 8
  );
  const top = Math.max(52, bounds.top - askPdfSelection.offsetHeight - 8);
  askPdfSelection.style.left = `${left}px`;
  askPdfSelection.style.top = `${top}px`;
}

function updatePdfSelectionAction(releasePoint) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) {
    hidePdfSelectionAction();
    return;
  }
  const text = selection.toString().trim().slice(0, 4000);
  const anchorPage = elementForNode(selection.anchorNode)?.closest?.('.pdf-page');
  const focusPage = elementForNode(selection.focusNode)?.closest?.('.pdf-page');
  if (!text || !anchorPage || anchorPage !== focusPage) {
    hidePdfSelectionAction();
    return;
  }
  const range = selection.getRangeAt(0);
  const customSelection = columnSelection(anchorPage, dragSelectionStart, releasePoint);
  const boxes = customSelection?.boxes ?? selectionBoxes(range, anchorPage);
  const page = Number(anchorPage.dataset.page);
  if (!page || !boxes.length) {
    hidePdfSelectionAction();
    return;
  }
  pendingPdfSelection = { text: customSelection?.text ?? text, page, boxes };
  const bounds = range.getBoundingClientRect();
  if (customSelection) {
    selection.removeAllRanges();
    paintPdfSelection(anchorPage, boxes);
  }
  positionSelectionAction(bounds);
}

document.addEventListener('mousedown', (event) => {
  if (event.button !== 0 || event.target === askPdfSelection) {
    return;
  }
  for (const marker of document.querySelectorAll('.pdf-selection-highlight')) {
    marker.remove();
  }
  const span = event.target.closest?.('.textLayer span:not(.markedContent)');
  const page = span?.closest?.('.pdf-page');
  dragSelectionStart = span && page ? { x: event.clientX, y: event.clientY, span, page } : undefined;
});
document.addEventListener('mouseup', (event) => {
  const span = event.target.closest?.('.textLayer span:not(.markedContent)');
  const page = span?.closest?.('.pdf-page');
  const releasePoint = span && page ? { x: event.clientX, y: event.clientY, span, page } : undefined;
  setTimeout(() => updatePdfSelectionAction(releasePoint), 0);
});
document.addEventListener('keyup', (event) => {
  if (event.key.startsWith('Arrow') || event.key === 'Shift') {
    setTimeout(updatePdfSelectionAction, 0);
  }
});
document.addEventListener('scroll', hidePdfSelectionAction, true);
askPdfSelection.addEventListener('mousedown', (event) => event.preventDefault());
askPdfSelection.addEventListener('click', () => {
  if (!pendingPdfSelection) {
    return;
  }
  vscode.postMessage({ type: 'askPdfSelection', hash: config.hash, ...pendingPdfSelection });
  window.getSelection()?.removeAllRanges();
  hidePdfSelectionAction();
});

document.addEventListener('copy', (event) => {
  if (!pendingPdfSelection || !window.getSelection()?.isCollapsed) {
    return;
  }
  event.clipboardData?.setData('text/plain', pendingPdfSelection.text);
  event.preventDefault();
});

function applyHighlight(message) {
  const pageView = renderedPages.get(message.page);
  if (!pageView) {
    pendingHighlight = message;
    return;
  }
  for (const overlay of document.querySelectorAll('.evidence-highlight')) {
    overlay.remove();
  }
  for (const box of message.boxes || []) {
    const marker = document.createElement('div');
    marker.className = 'evidence-highlight';
    marker.style.left = `${box.x * 100}%`;
    marker.style.top = `${box.y * 100}%`;
    marker.style.width = `${box.width * 100}%`;
    marker.style.height = `${box.height * 100}%`;
    pageView.append(marker);
  }
  pageView.scrollIntoView({ behavior: 'smooth', block: 'center' });
  pendingHighlight = undefined;
}

window.addEventListener('message', (event) => {
  if (event.data?.type === 'pdfDataStart') {
    pdfDataChunks = new Array(Number(event.data.chunkCount) || 0);
  } else if (event.data?.type === 'pdfDataChunk') {
    pdfDataChunks[Number(event.data.index)] = event.data.data || '';
  } else if (event.data?.type === 'pdfDataEnd') {
    const binary = atob(pdfDataChunks.join(''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    pdfDataChunks = [];
    resolvePdfData?.(bytes);
    resolvePdfData = undefined;
  } else if (event.data?.type === 'highlight') {
    applyHighlight(event.data);
  }
});

vscode.postMessage({ type: 'viewerReady' });

function getPage(pdf, pageNumber) {
  if (!pagePromises.has(pageNumber)) {
    pagePromises.set(pageNumber, pdf.getPage(pageNumber));
  }
  return pagePromises.get(pageNumber);
}

async function createPageShell(pdf, pageNumber) {
  if (renderedPages.has(pageNumber)) {
    return renderedPages.get(pageNumber);
  }
  const page = await getPage(pdf, pageNumber);
  const viewport = page.getViewport({ scale: 1.25 });
  const container = document.createElement('section');
  container.className = 'pdf-page';
  container.dataset.page = String(pageNumber);
  container.dataset.baseWidth = String(viewport.width);
  container.dataset.baseHeight = String(viewport.height);
  container.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
  updatePageSize(container);

  const label = document.createElement('span');
  label.className = 'page-label';
  label.textContent = String(pageNumber);
  container.append(label);
  pagesRoot.append(container);
  renderedPages.set(pageNumber, container);
  pageViewports.set(pageNumber, viewport);
  pageObserver.observe(container);
  if (pendingHighlight?.page === pageNumber) {
    applyHighlight(pendingHighlight);
  }
  return container;
}

async function renderPage(pdf, pageNumber) {
  if (renderPromises.has(pageNumber)) {
    return renderPromises.get(pageNumber);
  }
  const task = (async () => {
    const container = await createPageShell(pdf, pageNumber);
    if (container.dataset.rendered === 'true') {
      return;
    }
    container.dataset.rendered = 'true';
    const page = await getPage(pdf, pageNumber);
    const viewport = pageViewports.get(pageNumber);
    const canvas = document.createElement('canvas');
    const outputScale = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    container.prepend(canvas);
    const textLayerBuilder = new pdfjsViewer.TextLayerBuilder({ pdfPage: page });
    const textLayerElement = textLayerBuilder.div;
    const textViewport = page.getViewport({ scale: viewport.scale * zoom });
    textLayerElement.style.width = `${textViewport.width}px`;
    textLayerElement.style.height = `${textViewport.height}px`;
    textLayerElement.style.setProperty('--total-scale-factor', String(textViewport.scale));
    textLayers.set(pageNumber, {
      builder: textLayerBuilder,
      element: textLayerElement,
      page,
      baseScale: viewport.scale
    });
    await Promise.all([
      page.render({
        canvasContext: canvas.getContext('2d'),
        viewport,
        transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0]
      }).promise,
      textLayerBuilder.render({
        viewport: textViewport,
        textContentParams: { includeMarkedContent: true, disableNormalization: true }
      }).then(() => {
        if (!textLayerElement.isConnected) {
          container.append(textLayerElement);
        }
      })
    ]);
    pageObserver.unobserve(container);
  })();
  renderPromises.set(pageNumber, task);
  return task;
}

async function prepareRemainingPages(pdf) {
  for (let pageNumber = 2; pageNumber <= pdf.numPages; pageNumber += 1) {
    await createPageShell(pdf, pageNumber);
  }
}

async function render() {
  try {
    pdfjsLib = await import(config.pdfModule);
    globalThis.pdfjsLib = pdfjsLib;
    pdfjsViewer = await import(config.viewerModule);
    pdfjsLib.GlobalWorkerOptions.workerSrc = config.workerModule;
    status.textContent = 'Loading prepared PDF…';
    const pdfData = await pdfDataPromise;
    const loadingTask = pdfjsLib.getDocument({ data: pdfData, wasmUrl: config.wasmUrl });
    window.addEventListener('pagehide', () => void loadingTask.destroy(), { once: true });
    const pdf = await loadingTask.promise;
    pageObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            void renderPage(pdf, Number(entry.target.dataset.page)).catch(() => {
              entry.target.dataset.rendered = 'false';
            });
          }
        }
      },
      { rootMargin: '900px 0px' }
    );

    status.textContent = `${pdf.numPages} pages · opening…`;
    await createPageShell(pdf, 1);
    await renderPage(pdf, 1);
    startupPreview?.remove();
    fitToWidth();
    status.textContent = `${pdf.numPages} pages · ready`;
    vscode.postMessage({ type: 'pdfReady', hash: config.hash, pages: pdf.numPages });

    void prepareRemainingPages(pdf).catch(() => undefined);
  } catch (error) {
    status.textContent = 'Failed to load PDF';
    vscode.postMessage({
      type: 'pdfError',
      hash: config.hash,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

void render();
