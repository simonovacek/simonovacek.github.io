const categories = {
  portraits: { input: 'portraits-input', count: 'portraits-count', files: [] },
  groups: { input: 'groups-input', count: 'groups-count', files: [] },
  classes: { input: 'classes-input', count: 'classes-count', files: [] }
};

// Single source of truth for both the preview and the physical PDF layout.
const PRINT_CONFIG = {
  page: { width: 210, height: 297 },
  portrait: { width: 54, height: 72 },
  group: { width: 54, height: 72, rotate: 90 },
  class: { width: 153, height: 103, rotate: 90, itemsPerPage: 2 },
  gap: { primaryX: 9, primaryY: 12, classY: 8.7 },
  layout: { primary: { columns: 3, rows: 3 }, class: { columns: 1, rows: 2 } }
};

let printQueue = [];
let printPages = [];
let currentPageIndex = 0;
let pdfUrl = null;
let classEditorEntry = null;
let classEditorDraft = null;
let classEditorImage = null;
let cropPointers = new Map();
let cropLastDistance = null;

const pluralize = count => `${count} ${count === 1 ? 'fotografie' : 'fotografií'}`;
const groupCopies = () => categories.groups.files.reduce((total, entry) => total + entry.copies, 0);
const chunk = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, index * size + size));
const createId = () => (window.crypto && typeof window.crypto.randomUUID === 'function' && window.crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const clearNode = element => { while (element.firstChild) element.removeChild(element.firstChild); };

function verifyStaticAssetLoading() {
  const cssLink = document.querySelector('link[rel="stylesheet"]');
  const appScript = document.querySelector('script[src]');
  const computed = window.getComputedStyle ? window.getComputedStyle(document.body) : null;
  const status = {
    baseUrl: window.location.origin + window.location.pathname,
    cssPath: cssLink ? cssLink.getAttribute('href') : null,
    jsPath: appScript ? appScript.getAttribute('src') : null,
    cssLoaded: !!cssLink && !!cssLink.sheet,
    jsLoaded: !!window.documentReady && typeof window.__appLoaded === 'boolean',
    fontFamily: computed ? computed.fontFamily : null,
    userAgent: navigator.userAgent
  };
  console.info('[fototisk static check]', status);
  return status;
}

function updateCount(category) {
  const count = categories[category].files.length;
  document.getElementById(categories[category].count).textContent = category === 'groups' && count
    ? `${pluralize(count)} · ${groupCopies()} kopií` : pluralize(count);
}

function renderSelectionStatus(category) {
  const files = categories[category].files;
  const status = document.getElementById(`${category}-status`);
  status.hidden = files.length === 0;
  document.getElementById(`${category}-status-text`).textContent = `Nahráno ${pluralize(files.length)}.`;
  updateCount(category);
}

function renderGroups() {
  const list = document.getElementById('groups-list');
  const total = document.getElementById('groups-total');
  clearNode(list);
  categories.groups.files.forEach(entry => {
    const item = document.createElement('li'); item.className = 'preview-card';
    const image = document.createElement('img'); image.className = 'photo-preview class-photo-preview'; image.src = entry.previewUrl; image.alt = `Náhled: ${entry.file.name}`;
    const body = document.createElement('div'); body.className = 'preview-body';
    const name = document.createElement('p'); name.className = 'preview-name'; name.textContent = entry.file.name; name.title = entry.file.name;
    const controls = document.createElement('div'); controls.className = 'preview-controls';
    const label = document.createElement('label'); label.className = 'copy-control'; label.append('Počet kopií ');
    const input = document.createElement('input');
    input.type = 'number'; input.min = '1'; input.step = '1'; input.value = entry.copies; input.inputMode = 'numeric'; input.setAttribute('aria-label', `Počet kopií pro ${entry.file.name}`);
    input.addEventListener('input', () => { entry.copies = Math.max(1, Number.parseInt(input.value, 10) || 1); updateCount('groups'); total.textContent = `Celkem: ${pluralize(groupCopies())}`; });
    label.append(input);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-button'; remove.textContent = 'Odstranit'; remove.addEventListener('click', () => removeGroup(entry.id));
    controls.append(label, remove); body.append(name, controls); item.append(image, body); list.append(item);
  });
  total.hidden = categories.groups.files.length === 0;
  total.textContent = `Celkem: ${pluralize(groupCopies())}`;
  updateCount('groups');
}

function renderClasses() {
  const section = document.querySelector('[data-category="classes"]');
  let list = document.getElementById('classes-list');
  if (!list) {
    list = document.createElement('ul');
    list.id = 'classes-list';
    list.className = 'preview-grid';
    section.append(list);
  }
  clearNode(list);
  categories.classes.files.forEach(entry => {
    const item = document.createElement('li'); item.className = 'preview-card';
    const image = document.createElement('canvas'); image.className = 'photo-preview class-photo-preview'; image.setAttribute('aria-label', `Náhled: ${entry.file.name}`); image.width = 612; image.height = 412;
    const thumbImage = new Image();
    thumbImage.onload = () => {
      const ctx = image.getContext('2d');
      const crop = getCropRect(thumbImage, PRINT_CONFIG.class.width, PRINT_CONFIG.class.height, true, entry.crop);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.save(); ctx.translate(image.width / 2, image.height / 2); ctx.rotate(Math.PI / 2);
      ctx.drawImage(thumbImage, crop.cropX, crop.cropY, crop.cropWidth, crop.cropHeight, -image.height / 2, -image.width / 2, image.height, image.width);
      ctx.restore();
    };
    thumbImage.src = entry.previewUrl;
    const body = document.createElement('div'); body.className = 'preview-body';
    const name = document.createElement('p'); name.className = 'preview-name'; name.textContent = entry.file.name; name.title = entry.file.name;
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'class-edit-button'; edit.textContent = 'Upravit ořez'; edit.addEventListener('click', () => openClassEditor(entry));
    body.append(name, edit); item.append(image, body); list.append(item);
  });
  updateCount('classes');
}

function showUploadLoading(category, current, total) {
  const box = document.getElementById(`${category}-loading`);
  const text = document.getElementById(`${category}-loading-text`);
  if (!box || !text) return;
  box.hidden = false;
  text.textContent = `Připravuji fotografie… ${current} / ${total}`;
}

function hideUploadLoading(category) {
  const box = document.getElementById(`${category}-loading`);
  if (box) { box.hidden = true; box.style.removeProperty('display'); }
}

function nextFrame() { return new Promise(resolve => requestAnimationFrame(() => resolve())); }

async function addFiles(category, sourceFiles, replace = false) {
  const files = [...sourceFiles].filter(file => file.type.startsWith('image/'));
  if (!files.length) return;
  if (replace) clearFiles(category);
  showUploadLoading(category, 0, files.length);
  await nextFrame();
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    categories[category].files.push({ id: createId(), file, copies: 1, previewUrl: URL.createObjectURL(file), crop: { x: 0.5, y: 0.5, zoom: 1 } });
    showUploadLoading(category, index + 1, files.length);
    if (index % 4 === 3) await nextFrame();
  }
  hideUploadLoading(category);
  category === 'groups' ? renderGroups() : category === 'classes' ? renderClasses() : renderSelectionStatus(category);
}

function getCropRect(image, widthMm, heightMm, rotate, crop = { x: 0.5, y: 0.5, zoom: 1 }) {
  const sourceWidth = image.naturalWidth;
  const sourceHeight = image.naturalHeight;
  const targetAspect = rotate ? heightMm / widthMm : widthMm / heightMm;
  const sourceAspect = sourceWidth / sourceHeight;
  let baseWidth = sourceWidth;
  let baseHeight = sourceHeight;
  if (sourceAspect > targetAspect) baseWidth = Math.max(1, Math.round(sourceHeight * targetAspect));
  else if (sourceAspect < targetAspect) baseHeight = Math.max(1, Math.round(sourceWidth / targetAspect));
  const zoom = Math.max(1, Number(crop.zoom) || 1);
  const cropWidth = Math.max(1, Math.round(baseWidth / zoom));
  const cropHeight = Math.max(1, Math.round(baseHeight / zoom));
  const maxX = Math.max(0, sourceWidth - cropWidth);
  const maxY = Math.max(0, sourceHeight - cropHeight);
  const centerX = Math.min(1, Math.max(0, Number(crop.x) || 0.5));
  const centerY = Math.min(1, Math.max(0, Number(crop.y) || 0.5));
  return {
    cropWidth, cropHeight,
    cropX: Math.round(maxX * centerX),
    cropY: Math.round(maxY * centerY)
  };
}

function loadEditorImage(entry) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Nelze načíst obrázek ${entry.file.name}.`));
    image.src = entry.previewUrl;
  });
}

function drawCropEditor() {
  const canvas = document.getElementById('crop-canvas');
  const viewport = document.getElementById('crop-viewport');
  if (!canvas || !viewport || !classEditorImage || !classEditorEntry) return;
  const rect = viewport.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  const crop = getCropRect(classEditorImage, PRINT_CONFIG.class.width, PRINT_CONFIG.class.height, true, classEditorDraft);
  ctx.fillStyle = '#eef2f3'; ctx.fillRect(0, 0, rect.width, rect.height);
  ctx.save();
  ctx.translate(rect.width / 2, rect.height / 2);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(classEditorImage, crop.cropX, crop.cropY, crop.cropWidth, crop.cropHeight, -rect.height / 2, -rect.width / 2, rect.height, rect.width);
  ctx.restore();
}

function updateCropFromDrag(dx, dy) {
  if (!classEditorImage || !classEditorDraft) return;
  const viewport = document.getElementById('crop-viewport');
  const rect = viewport.getBoundingClientRect();
  const crop = getCropRect(classEditorImage, PRINT_CONFIG.class.width, PRINT_CONFIG.class.height, true, classEditorDraft);
  // The editor shows the final 90°-rotated print orientation, so horizontal
  // movement maps to the source Y axis and vertical movement to source X.
  classEditorDraft.y = Math.min(1, Math.max(0, classEditorDraft.y + (dx / rect.width) * (crop.cropHeight / classEditorImage.naturalHeight)));
  classEditorDraft.x = Math.min(1, Math.max(0, classEditorDraft.x - (dy / rect.height) * (crop.cropWidth / classEditorImage.naturalWidth)));
  drawCropEditor();
}

function updateCropFromPinch(distance) {
  if (!classEditorDraft || !cropLastDistance || !classEditorImage) return;
  const factor = distance / cropLastDistance;
  classEditorDraft.zoom = Math.min(4, Math.max(1, classEditorDraft.zoom * factor));
  cropLastDistance = distance;
  drawCropEditor();
}

async function openClassEditor(entry) {
  classEditorEntry = entry;
  classEditorDraft = { ...(entry.crop || { x: 0.5, y: 0.5, zoom: 1 }) };
  try { classEditorImage = await loadEditorImage(entry); } catch (error) { alert(error.message); return; }
  const modal = document.getElementById('class-editor');
  modal.hidden = false; modal.setAttribute('aria-hidden', 'false');
  document.getElementById('class-editor-title').textContent = `Upravit ořez · ${entry.file.name}`;
  requestAnimationFrame(drawCropEditor);
}

function closeClassEditor(apply = false) {
  if (apply && classEditorEntry && classEditorDraft) {
    classEditorEntry.crop = { ...classEditorDraft };
  }
  const modal = document.getElementById('class-editor');
  modal.hidden = true; modal.setAttribute('aria-hidden', 'true');
  classEditorEntry = null; classEditorDraft = null; classEditorImage = null; cropPointers.clear(); cropLastDistance = null;
  if (document.getElementById('print-preview')?.hidden) renderClasses();
  else refreshPreviewAfterCropEdit();
}

function attachCropEditorEvents() {
  const viewport = document.getElementById('crop-viewport');
  viewport.addEventListener('pointerdown', event => { viewport.setPointerCapture(event.pointerId); cropPointers.set(event.pointerId, { x: event.clientX, y: event.clientY }); });
  viewport.addEventListener('pointermove', event => {
    if (!cropPointers.has(event.pointerId)) return;
    const previous = cropPointers.get(event.pointerId);
    cropPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (cropPointers.size === 1) updateCropFromDrag(event.clientX - previous.x, event.clientY - previous.y);
    else if (cropPointers.size === 2) {
      const points = [...cropPointers.values()];
      const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      if (cropLastDistance) updateCropFromPinch(distance); else cropLastDistance = distance;
    }
  });
  const release = event => { cropPointers.delete(event.pointerId); if (cropPointers.size < 2) cropLastDistance = null; };
  viewport.addEventListener('pointerup', release); viewport.addEventListener('pointercancel', release); viewport.addEventListener('pointerleave', event => { if (event.buttons === 0) release(event); });
}

function removeGroup(id) {
  const files = categories.groups.files;
  const index = files.findIndex(entry => entry.id === id);
  if (index < 0) return;
  URL.revokeObjectURL(files[index].previewUrl); files.splice(index, 1); renderGroups();
}

function clearFiles(category) {
  categories[category].files.forEach(entry => { if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl); });
  categories[category].files = [];
  category === 'groups' ? renderGroups() : renderSelectionStatus(category);
}

function buildPrintQueue() {
  const queue = [];
  const append = (type, entries, copies = 1) => entries.forEach(entry => {
    const amount = typeof copies === 'function' ? copies(entry) : copies;
    for (let copy = 0; copy < amount; copy += 1) queue.push({ type, entry, file: entry.file, previewUrl: entry.previewUrl, crop: entry.crop });
  });
  append('portrait', categories.portraits.files);
  append('group', categories.groups.files, entry => entry.copies);
  append('class', categories.classes.files);
  printQueue = queue;
  return queue;
}

function buildPrintPages(queue) {
  const primaryItems = queue.filter(item => item.type !== 'class');
  const classItems = queue.filter(item => item.type === 'class');
  printPages = [
    ...chunk(primaryItems, PRINT_CONFIG.layout.primary.columns * PRINT_CONFIG.layout.primary.rows).map(items => ({ layout: 'primary', items })),
    ...chunk(classItems, PRINT_CONFIG.class.itemsPerPage).map(items => ({ layout: 'class', items }))
  ];
  return printPages;
}

function getPdfSlots(page) {
  if (page.layout === 'primary') {
    const { page: sheet, portrait, gap, layout } = PRINT_CONFIG;
    const contentWidth = layout.primary.columns * portrait.width + (layout.primary.columns - 1) * gap.primaryX;
    const contentHeight = layout.primary.rows * portrait.height + (layout.primary.rows - 1) * gap.primaryY;
    const marginX = (sheet.width - contentWidth) / 2;
    const marginY = (sheet.height - contentHeight) / 2;
    return page.items.map((item, index) => ({ item, x: marginX + (index % layout.primary.columns) * (portrait.width + gap.primaryX), y: marginY + Math.floor(index / layout.primary.columns) * (portrait.height + gap.primaryY), width: portrait.width, height: portrait.height }));
  }
  const { page: sheet, class: classPhoto, gap } = PRINT_CONFIG;
  const marginX = (sheet.width - classPhoto.width) / 2;
  const contentHeight = classPhoto.height * PRINT_CONFIG.layout.class.rows + gap.classY;
  const marginY = (sheet.height - contentHeight) / 2;
  return page.items.map((item, index) => ({ item, x: marginX, y: marginY + index * (classPhoto.height + gap.classY), width: classPhoto.width, height: classPhoto.height }));
}

function loadImageForPdf(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Nelze načíst obrázek ${file.name}.`)); };
    image.src = url;
  });
}

async function imageForPdf(file, widthMm, heightMm, rotate, cropState = { x: 0.5, y: 0.5, zoom: 1 }) {
  const image = await loadImageForPdf(file);
  const crop = getCropRect(image, widthMm, heightMm, rotate, cropState);
  const dpi = 400;
  const targetWidth = Math.max(1, Math.round(widthMm / 25.4 * dpi));
  const targetHeight = Math.max(1, Math.round(heightMm / 25.4 * dpi));
  const canvas = document.createElement('canvas');
  canvas.width = rotate ? targetHeight : targetWidth;
  canvas.height = rotate ? targetWidth : targetHeight;
  // Keep image processing in the standard sRGB color space where supported.
  // This is a canvas color-space setting, not an embedded ICC profile.
  let context;
  try { context = canvas.getContext('2d', { alpha: false, colorSpace: 'srgb' }); }
  catch (_) { context = canvas.getContext('2d', { alpha: false }); }
  if (!context) throw new Error(`Pro fotografii ${file.name} se nepodařilo připravit obraz.`);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  if (rotate) {
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate(Math.PI / 2);
    context.drawImage(image, crop.cropX, crop.cropY, crop.cropWidth, crop.cropHeight, -targetWidth / 2, -targetHeight / 2, targetWidth, targetHeight);
  } else {
    context.drawImage(image, crop.cropX, crop.cropY, crop.cropWidth, crop.cropHeight, 0, 0, targetWidth, targetHeight);
  }
  return canvas.toDataURL('image/jpeg', 1.0);
}

function loadJsPdf() {
  if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
  const library = document.getElementById('jspdf-library');
  return new Promise((resolve, reject) => {
    library.addEventListener('load', () => window.jspdf && window.jspdf.jsPDF ? resolve(window.jspdf.jsPDF) : reject(new Error('Knihovnu pro PDF se nepodařilo načíst.')), { once: true });
    library.addEventListener('error', () => reject(new Error('Knihovnu pro PDF se nepodařilo načíst.')), { once: true });
  });
}

async function createPdf() {
  const jsPDF = await loadJsPdf();
  const documentPdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true, putOnlyUsedFonts: true });
  // Descriptive PDF metadata improves identification/compatibility, but does not
  // itself alter image brightness or force a printer's color-management behavior.
  documentPdf.setProperties({
    title: 'FotoTisk – fotografie pro tisk na A4',
    subject: 'Fotografické rozložení pro tisk; obrazová data připravena v RGB/sRGB',
    author: 'FotoTisk',
    creator: 'FotoTisk (jsPDF)',
    keywords: 'FotoTisk, fotografie, A4, RGB, sRGB, tisk'
  });
  const imageCache = new Map();
  for (let pageIndex = 0; pageIndex < printPages.length; pageIndex += 1) {
    if (pageIndex > 0) documentPdf.addPage('a4', 'portrait');
    for (const slot of getPdfSlots(printPages[pageIndex])) {
      const { item, x, y, width, height } = slot;
      const currentCrop = item.entry?.crop || item.crop;
      const cacheKey = `${item.type}-${item.file.name}-${item.file.lastModified}-${width}-${height}-${currentCrop ? JSON.stringify(currentCrop) : ''}`;
      const rotate = item.type === 'group' ? PRINT_CONFIG.group.rotate : item.type === 'class' ? PRINT_CONFIG.class.rotate : 0;
      if (!imageCache.has(cacheKey)) imageCache.set(cacheKey, imageForPdf(item.file, width, height, rotate === 90, currentCrop));
      const imageData = await imageCache.get(cacheKey);
      documentPdf.addImage(imageData, 'JPEG', x, y, width, height, undefined, undefined);
    }
  }
  return documentPdf.output('blob');
}

async function handlePdfCreation() {
  const button = document.getElementById('create-pdf'); const status = document.getElementById('pdf-status');
  if (!printPages.length) { status.textContent = 'Nejsou k dispozici žádné fotografie pro PDF.'; status.hidden = false; return; }
  button.disabled = true; button.textContent = 'Vytvářím PDF…'; status.textContent = 'Připravuji PDF…'; status.hidden = false;
  try {
    const pdfBlob = await createPdf();
    if (pdfUrl) URL.revokeObjectURL(pdfUrl); pdfUrl = URL.createObjectURL(pdfBlob);
    const openLink = document.createElement('a'); openLink.href = pdfUrl; openLink.target = '_blank'; openLink.rel = 'noopener'; openLink.textContent = 'Otevřít PDF';
    const downloadLink = document.createElement('a'); downloadLink.href = pdfUrl; downloadLink.download = 'fototisk.pdf'; downloadLink.textContent = 'Stáhnout PDF';
    clearNode(status);
    status.append('PDF bylo připraveno: ', openLink, ' · ', downloadLink);
    const notice = document.createElement('div');
    notice.className = 'pdf-notice';
    const noticeTitle = document.createElement('strong');
    noticeTitle.textContent = 'Důležité:';
    notice.append(noticeTitle, 'Pro nejlepší kvalitu je potřeba PDF tisknout přes Canon PRINT.');
    status.append(notice);
  } catch (error) { status.textContent = error.message || 'PDF se nepodařilo vytvořit.'; }
  finally { button.disabled = false; button.textContent = 'Vytvořit PDF'; }
}

function renderPreviewSummary() {
  const stats = [['Portréty', categories.portraits.files.length], ['Skupinové', groupCopies()], ['Třídní', categories.classes.files.length], ['Celkem', printQueue.length]];
  const summary = document.getElementById('preview-summary'); clearNode(summary);
  stats.forEach(([label, count]) => { const item = document.createElement('div'); item.className = 'preview-stat'; item.innerHTML = `<span>${label}</span><strong>${pluralize(count)}</strong>`; summary.append(item); });
}

function drawPreviewCanvas(canvas, item, width, height) {
  const image = new Image();
  image.onload = () => {
    const rect = canvas.getBoundingClientRect();
    const cssWidth = Math.max(1, rect.width || canvas.clientWidth || 1);
    const cssHeight = Math.max(1, rect.height || canvas.clientHeight || 1);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#eef2f3';
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    const rotate = item.type === 'group' ? PRINT_CONFIG.group.rotate : item.type === 'class' ? PRINT_CONFIG.class.rotate : 0;
    const crop = getCropRect(image, width, height, rotate === 90, item.entry?.crop || item.crop);
    const sourceWidth = crop.cropWidth;
    const sourceHeight = crop.cropHeight;

    ctx.save();
    ctx.translate(cssWidth / 2, cssHeight / 2);
    if (rotate === 90) {
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(image, crop.cropX, crop.cropY, sourceWidth, sourceHeight, -cssHeight / 2, -cssWidth / 2, cssHeight, cssWidth);
    } else {
      ctx.drawImage(image, crop.cropX, crop.cropY, sourceWidth, sourceHeight, -cssWidth / 2, -cssHeight / 2, cssWidth, cssHeight);
    }
    ctx.restore();
  };
  image.src = item.previewUrl;
}

function refreshPreviewAfterCropEdit() {
  const activePreview = !document.getElementById('print-preview').hidden;
  if (!activePreview) return;
  const currentPage = currentPageIndex;
  buildPrintPages(buildPrintQueue());
  currentPageIndex = Math.min(currentPage, Math.max(0, printPages.length - 1));
  renderPreviewSummary();
  renderCurrentPage();
}

function renderCurrentPage() {
  const pageElement = document.getElementById('a4-page');
  const indicator = document.getElementById('page-indicator');
  const layoutInfo = document.getElementById('layout-info');
  const previous = document.getElementById('previous-page');
  const next = document.getElementById('next-page');
  clearNode(pageElement);
  if (!printPages.length) {
    layoutInfo.textContent = '';
    pageElement.className = 'a4-page'; indicator.textContent = 'Žádné fotografie k náhledu.'; previous.disabled = true; next.disabled = true; return;
  }
  const page = printPages[currentPageIndex];
  pageElement.className = `a4-page ${page.layout}-layout`;
  const slots = getPdfSlots(page);
  const { width: pageWidth, height: pageHeight } = PRINT_CONFIG.page;

  layoutInfo.textContent = page.layout === 'primary'
    ? `A4 · fotografie ${PRINT_CONFIG.portrait.width} × ${PRINT_CONFIG.portrait.height} mm · mezera ${PRINT_CONFIG.gap.primaryY} mm`
    : `A4 · třídní fotografie ${PRINT_CONFIG.class.width} × ${PRINT_CONFIG.class.height} mm · mezera ${PRINT_CONFIG.gap.classY} mm`;

  slots.forEach(({ item, x, y, width, height }) => {
    const slot = document.createElement('div');
    slot.className = `print-slot ${item.type}`;
    slot.style.left = `${x / pageWidth * 100}%`;
    slot.style.top = `${y / pageHeight * 100}%`;
    slot.style.width = `${width / pageWidth * 100}%`;
    slot.style.height = `${height / pageHeight * 100}%`;

    const canvas = document.createElement('canvas');
    canvas.className = 'print-preview-canvas';
    canvas.setAttribute('aria-label', `${item.type === 'class' ? 'Náhled třídní fotografie' : item.type === 'group' ? 'Náhled skupinové fotografie' : 'Náhled portrétu'}: ${item.file.name}`);
    slot.append(canvas);

    if (item.type === 'class' && item.entry) {
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'slot-edit-button';
      edit.textContent = 'Upravit ořez';
      edit.addEventListener('click', event => {
        event.stopPropagation();
        openClassEditor(item.entry);
      });
      slot.append(edit);
    }

    pageElement.append(slot);
    requestAnimationFrame(() => drawPreviewCanvas(canvas, item, width, height));
  });
  indicator.textContent = `Strana ${currentPageIndex + 1} z ${printPages.length}`;
  previous.disabled = currentPageIndex === 0; next.disabled = currentPageIndex === printPages.length - 1;
}

const uploadInfoModal = document.getElementById('upload-info-modal');
const uploadInfoOk = document.getElementById('upload-info-ok');
let pendingPicker = null;

function openUploadInfo(category, input, replacesSelection) {
  const openPicker = () => {
    input.value = '';
    input.click();
  };
  if (category !== 'portraits') {
    openPicker();
    return;
  }
  pendingPicker = openPicker;
  uploadInfoModal.hidden = false;
  uploadInfoModal.setAttribute('aria-hidden', 'false');
  uploadInfoOk.focus();
}

function closeUploadInfoAndOpenPicker() {
  uploadInfoModal.hidden = true;
  uploadInfoModal.setAttribute('aria-hidden', 'true');
  const picker = pendingPicker;
  pendingPicker = null;
  if (picker) picker();
}

Object.entries(categories).forEach(([category, data]) => {
  const input = document.getElementById(data.input); const zone = input.closest('.drop-zone'); const replacesSelection = category !== 'groups';
  const openPicker = () => openUploadInfo(category, input, replacesSelection);
  input.addEventListener('change', () => addFiles(category, input.files, replacesSelection));
  zone.querySelector('.choose-files').addEventListener('click', openPicker);
  if (replacesSelection) { const section = zone.closest('.upload-section'); section.querySelector('.replace-files').addEventListener('click', openPicker); section.querySelector('.clear-files').addEventListener('click', () => clearFiles(category)); }
  if (category === 'classes') renderClasses();
});

uploadInfoOk.addEventListener('click', closeUploadInfoAndOpenPicker);
uploadInfoModal.addEventListener('click', event => { if (event.target === uploadInfoModal) closeUploadInfoAndOpenPicker(); });

document.getElementById('print-form').addEventListener('submit', event => {
  event.preventDefault(); buildPrintPages(buildPrintQueue()); currentPageIndex = 0; renderPreviewSummary(); renderCurrentPage();
  document.getElementById('print-preview').hidden = false; document.querySelector('.app-shell').classList.add('preview-active'); window.scrollTo(0, 0);
});
document.getElementById('previous-page').addEventListener('click', () => { if (currentPageIndex > 0) { currentPageIndex -= 1; renderCurrentPage(); } });
document.getElementById('next-page').addEventListener('click', () => { if (currentPageIndex < printPages.length - 1) { currentPageIndex += 1; renderCurrentPage(); } });
document.getElementById('back-to-upload').addEventListener('click', () => { document.querySelector('.app-shell').classList.remove('preview-active'); document.getElementById('print-preview').hidden = true; });
document.getElementById('create-pdf').addEventListener('click', handlePdfCreation);
document.getElementById('close-class-editor').addEventListener('click', () => closeClassEditor(false));
document.getElementById('cancel-class-crop').addEventListener('click', () => closeClassEditor(false));
document.getElementById('apply-class-crop').addEventListener('click', () => closeClassEditor(true));
document.getElementById('class-editor').addEventListener('click', event => { if (event.target.id === 'class-editor') closeClassEditor(false); });
attachCropEditorEvents();
window.addEventListener('resize', () => { if (classEditorEntry) drawCropEditor(); });
window.addEventListener('beforeunload', () => { Object.values(categories).flatMap(category => category.files).forEach(entry => URL.revokeObjectURL(entry.previewUrl)); if (pdfUrl) URL.revokeObjectURL(pdfUrl); });
window.__appLoaded = true;
window.documentReady = true;
window.addEventListener('load', () => verifyStaticAssetLoading());
