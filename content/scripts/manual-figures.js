/* eslint-disable no-undef */

var ZRBManualFigures = {
  states: new Map(),
  store: null,
  MAX_REGIONS: 12,
  TOTAL_PIXELS: 3 * 1024 * 1024,
  RESIDENT_BYTES: 24 * 1024 * 1024,
  getStore() {
    if (!this.store) this.store = ZRBManualFigureStore.runtime();
    return this.store;
  },
  live(state) {
    try { return !state.disposed && !state.view?._destroyed && !!state.doc.documentElement && !state.doc.defaultView?.closed; }
    catch (e) { return false; }
  },
  report(state, error) {
    state.error = String(error.message || error);
    try { if (typeof Zotero !== 'undefined') Zotero.debug('[ReadingBilingual manual figure] ' + state.error); } catch (e) {}
  },
  ensure(reader) {
    const internal = reader?._internalReader || reader;
    if (internal?._sdt?.structure?.metadata?.processor?.type !== 'pdf') return;
    for (const primary of [true, false]) {
      try {
        const view = primary ? internal._primarySDTView : internal._secondarySDTView;
        if (view?._destroyed) continue;
        const base = primary ? internal._primaryView : internal._secondaryView;
        const doc = view?._iframeDocument;
        if (!doc?.querySelector('#sdt-content [data-ref-path]') || !base) continue;
        const old = this.states.get(doc);
        if (old) {
          const sameSource = old.structure.metadata?.source?.hash === internal._sdt.structure.metadata?.source?.hash
            && old.structure.metadata?.processor?.version === internal._sdt.structure.metadata?.processor?.version;
          if (old.root === doc.querySelector('#sdt-content') && sameSource
              && Array.from(old.active.values()).every(active => active.figure.isConnected)) {
            this.suppressFallbacks(old); continue;
          }
          this.dispose(old);
        }
        const structure = JSON.parse(JSON.stringify(internal._sdt.structure));
        const state = { reader, doc, view, base, structure, root: doc.querySelector('#sdt-content'), entries: ZRBPDFFigureFallback.blocks(structure.content),
          records: new Map(), active: new Map(), operations: new Map(), disposed: false, editor: null };
        this.states.set(doc, state);
        this.installControls(state);
        state.ready = this.initialize(state).catch(error => this.report(state, error));
      } catch (error) { /* SDT view may have been torn down during the sweep. */ }
    }
  },
  async initialize(state) {
    const source = await ZRBPDFFigureFallback.sourceFingerprint(state);
    if (!source.stable) throw new Error('无法确认 PDF 内容指纹，暂不能保存手动修正');
    state.fingerprint = source.hash;
    let item;
    try { item = Zotero.Items?.get(state.reader.itemID || state.reader._itemID); } catch (e) {}
    state.documentID = item?.key ? `${item.libraryID}:${item.key}`
      : String(state.reader.itemID || state.reader._itemID || source.hash);
    state.structureSignature = await ZRBFigureCache.digest(new TextEncoder().encode(JSON.stringify({
      processor: state.structure.metadata?.processor,
      blocks: state.entries.map(({ ref, block }) => [ref, block.type, block.anchor, block.type === 'caption' ? ZRBPDFFigureFallback.text(block) : '']),
    })));
    if (this.live(state)) await this.loadSaved(state);
  },
  pageBounds(state, pageIndex) {
    const page = state.structure.catalog?.pages?.[pageIndex];
    const rect = page?.viewRect || page?.viewBox;
    if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite)) throw new Error('无法确认 PDF 页面边界');
    return rect;
  },
  validateRegions(state, regions) {
    if (!Array.isArray(regions) || !regions.length || regions.length > this.MAX_REGIONS) throw new Error('请选择 1–12 个区域');
    return regions.map(region => {
      if (!Number.isInteger(region.pageIndex) || region.pageIndex < 0) throw new Error('无效页码');
      const bounds = this.pageBounds(state, region.pageIndex);
      const r = region.rect;
      if (!Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite) || r[2] - r[0] < 0.5 || r[3] - r[1] < 0.5
          || r[0] < bounds[0] || r[1] < bounds[1] || r[2] > bounds[2] || r[3] > bounds[3]) throw new Error('选区为空或超出 PDF 页面');
      return { pageIndex: region.pageIndex, rect: r.slice() };
    });
  },
  entry(state, ref) { return state.entries.find(item => item.ref.join('.') === ref); },
  signature(state, ref) {
    const block = this.entry(state, ref)?.block;
    return block ? JSON.stringify([block.type, block.anchor, block.type === 'caption' ? ZRBPDFFigureFallback.text(block) : '']) : '';
  },
  nativeElements(state) {
    const root = state.doc.querySelector('#sdt-content');
    if (!root) return [];
    const nodes = [];
    for (let node of root.querySelectorAll('figure.sdt-image,figure.sdt-source-crop,img,svg,canvas')) {
      const mediaLeaf = node.matches('img,svg,canvas');
      const block = this.entry(state, node.closest('[data-ref-path]')?.dataset.refPath)?.block;
      const mathMedia = mediaLeaf && (node.closest('math,.sdt-math') || block?.type === 'math');
      const chartMedia = mediaLeaf && (node.closest('.sdt-chart,[data-chart]') || block?.type === 'chart');
      if (node.closest('.zrb-pdf-figure-fallback,.zrb-manual-figure,.zotero-bilingual-card,pre,code')) continue;
      if (node.closest('table') && !chartMedia && !mathMedia) continue;
      if (node.closest('math,.sdt-math') && !mathMedia) continue;
      if (block && ['table', 'caption', 'reference', 'note'].includes(block.type) && !chartMedia && !mathMedia) continue;
      if (block?.type === 'math' && !mathMedia) continue;
      const figure = node.closest('figure.sdt-image,figure.sdt-source-crop');
      if (figure && !figure.querySelector('p,figcaption,table,math,.sdt-math,.zotero-bilingual-card,a:not(:has(img))')) node = figure;
      // Never hide a source figure containing prose/captions/links as a unit.
      if (node.matches('figure') && node.querySelector('p,figcaption,table,math,.sdt-math,.zotero-bilingual-card,a:not(:has(img))')) continue;
      if (!nodes.includes(node)) nodes.push(node);
    }
    return nodes;
  },
  safeLabel(state, ref, regions, element) {
    const block = this.entry(state, ref)?.block;
    if (!block || block.type !== 'paragraph' || block.flowClass !== 'auxiliary' || !regions?.length) return false;
    const text = ZRBPDFFigureFallback.text(block).replace(/\s+/g, ' ').trim();
    // Auxiliary provenance + a repeated label pattern + complete geometric
    // containment. Never infer a footnote/prose role from typography alone.
    if (text.length > 120 || /^(?:chapter|section|part|table|fig(?:ure)?|equation|note)\b/i.test(text)
        || !(/^([a-z]{1,20})\s*\d{1,3}(?:\s+\1\s*\d{1,3})*$/i.test(text) || /^(?:\([a-z]\)\s*)+$/i.test(text))) return false;
    if (!element || element.closest('li,ul,ol,table,math,.sdt-math,.sdt-note,details,h1,h2,h3,h4,h5,h6')
        || element.querySelector('a,math,svg,canvas,table,pre,code,.sdt-math,figcaption,.zotero-bilingual-card')) return false;
    const boxes = block.anchor?.pageRects || [];
    return !!boxes.length && boxes.every(box => {
      if (!ZRBPDFFigureFallback.validRect(box)) return false;
      let remaining = [box.slice(1)];
      for (const region of regions.filter(region => region.pageIndex === box[0])) remaining = remaining.flatMap(rect => this.subtract(rect, region.rect));
      return !remaining.length;
    });
  },
  candidates(state, regions = []) {
    const result = [];
    for (const element of this.nativeElements(state)) {
      const ref = element.closest('[data-ref-path]')?.dataset.refPath || '';
      const nodeIndex = result.filter(item => item.kind === 'native' && item.ref === ref).length;
      result.push({ kind: 'native', ref, nodeIndex, signature: this.signature(state, ref) || element.tagName + ':' + element.className,
        index: result.length });
    }
    for (const element of state.doc.querySelectorAll('.zrb-pdf-figure-fallback')) {
      result.push({ kind: 'fallback', ref: element.dataset.sourceRef, pageIndex: Number(element.dataset.pageIndex), signature: this.signature(state, element.dataset.sourceRef) });
    }
    const elements = regions.length ? new Map(Array.from(state.doc.querySelectorAll('[data-ref-path]')).map(el => [el.dataset.refPath, el])) : null;
    if (regions.length) for (const { ref, block } of state.entries) {
      if (block.type !== 'paragraph' || block.flowClass !== 'auxiliary') continue;
      const key = ref.join('.');
      const element = elements.get(key);
      if (this.safeLabel(state, key, regions, element)) result.push({ kind: 'label', ref: key, signature: this.signature(state, key) });
    }
    return result;
  },
  figureFragments(state, captionRef) {
    const caption = state.entries.find(item => item.ref.join('.') === captionRef && item.block.type === 'caption');
    const images = ZRBPDFFigureFallback.figureSequenceImages(caption, state.entries);
    const pages = new Set(images.flatMap(item => (item.block.anchor?.pageRects || []).filter(ZRBPDFFigureFallback.validRect).map(rect => rect[0])));
    return images.length > 1 && pages.size > 1 ? images : [];
  },
  resolve(state, locator, regions = []) {
    if (!locator) return null;
    if (locator.kind === 'label') {
      const element = Array.from(state.doc.querySelectorAll('[data-ref-path]')).find(el => el.dataset.refPath === locator.ref);
      return this.signature(state, locator.ref) === locator.signature && this.safeLabel(state, locator.ref, regions, element) ? element : null;
    }
    if (locator.kind === 'caption') {
      if (this.entry(state, locator.ref)?.block.type !== 'caption' || this.signature(state, locator.ref) !== locator.signature) return null;
      return Array.from(state.doc.querySelectorAll('[data-ref-path]')).find(el => el.dataset.refPath === locator.ref) || null;
    }
    if (locator.kind === 'fallback') {
      if (this.signature(state, locator.ref) !== locator.signature) return null;
      return Array.from(state.doc.querySelectorAll('.zrb-pdf-figure-fallback')).find(el => el.dataset.sourceRef === locator.ref && Number(el.dataset.pageIndex) === locator.pageIndex) || null;
    }
    if (locator.kind !== 'native') return null;
    const elements = this.nativeElements(state).filter(el => (el.closest('[data-ref-path]')?.dataset.refPath || '') === locator.ref);
    const node = elements[locator.nodeIndex || 0];
    const signature = this.signature(state, locator.ref) || (node && node.tagName + ':' + node.className);
    return node && signature === locator.signature ? node : null;
  },
  locate(state, element) {
    return this.candidates(state).find(locator => this.resolve(state, locator) === element) || null;
  },
  targetFor(state, element) {
    const manual = element.closest?.('.zrb-manual-figure');
    if (manual) return state.records.get(manual.dataset.manualId);
    if (element.dataset.zrbManualMasked) return state.records.get(element.dataset.zrbManualMasked);
    const locator = this.locate(state, element);
    if (!locator) throw new Error('未找到可安全替换的图片节点');
    let captionRef = locator.kind === 'fallback' ? locator.ref : null;
    if (!captionRef) {
      const matches = state.entries.filter(item => {
        if (item.block.type !== 'caption' || !ZRBPDFFigureFallback.captionNumber(item.block)) return false;
        const local = (item.block.anchor?.pageRects || []).some(rect => ZRBPDFFigureFallback.nativeAssociations(rect, state.entries, item.block)
          .some(image => image.block.type === 'image' && image.ref.join('.') === locator.ref));
        return local || this.figureFragments(state, item.ref.join('.')).some(image => image.ref.join('.') === locator.ref);
      });
      if (matches.length === 1) captionRef = matches[0].ref.join('.');
    }
    const anchor = captionRef ? { kind: 'caption', ref: captionRef, signature: this.signature(state, captionRef) } : locator;
    const existing = Array.from(state.records.values()).find(record => JSON.stringify(record.anchor) === JSON.stringify(anchor));
    if (existing) return existing;
    const id = captionRef ? 'caption:' + captionRef : 'graphic:' + JSON.stringify(locator);
    const relatedRefs = captionRef ? new Set(this.figureFragments(state, captionRef).map(item => item.ref.join('.'))) : new Set();
    const replacements = this.candidates(state).filter(item => (item.kind === locator.kind && JSON.stringify(item) === JSON.stringify(locator))
      || (item.kind === 'native' && relatedRefs.has(item.ref)) || (item.kind === 'fallback' && item.ref === captionRef));
    const block = this.entry(state, locator.ref)?.block;
    const regions = (block?.anchor?.pageRects || []).filter(rect => ZRBPDFFigureFallback.validRect(rect))
      .map(r => ({ pageIndex: r[0], rect: r.slice(1) }));
    return { id, structure: state.structureSignature, anchor, replacements, scopeCandidates: replacements.slice(), regions: locator.kind === 'native' ? regions : [] };
  },
  // Every object passed into the renderer belongs to its content environment.
  // A separate facade caps this operation without changing Reader settings.
  limitedRenderer(state, pixels) {
    const win = state.base?._iframeWindow;
    const original = state.base?._pdfRenderer;
    if (!win || typeof original?.renderRegionCrops !== 'function') throw new Error('当前阅读器不支持原 PDF 区域渲染');
    const object = () => ZRBPDFFigureFallback.toView({}, win);
    const app = object();
    app.pdfDocument = win.PDFViewerApplication.pdfDocument;
    app.pdfViewer = ZRBPDFFigureFallback.toView({ maxCanvasPixels: pixels }, win);
    const frame = object(); frame.document = win.document; frame.PDFViewerApplication = app;
    const view = object(); view._iframeWindow = frame;
    const facade = win.Object.create(original); facade._pdfView = view;
    return facade;
  },
  async pageInfo(state, pageIndex) {
    const pdf = state.base?._iframeWindow?.PDFViewerApplication?.pdfDocument;
    if (!pdf) throw new Error('原 PDF 尚未就绪');
    const wrappedPage = await pdf.getPage(pageIndex + 1);
    // Awaiting a content Promise can reintroduce an Xray around PDFPageProxy.
    // Read its data in the owning realm; never pass privileged render options.
    const utils = typeof Cu !== 'undefined' ? Cu : typeof Components !== 'undefined' ? Components.utils : null;
    const page = utils?.waiveXrays ? utils.waiveXrays(wrappedPage) : wrappedPage;
    return { bounds: Array.from(page.view), rotation: ((page.rotate || 0) % 360 + 360) % 360 };
  },
  async decode(image, src) { return ZRBPDFFigureFallback.loadImage(image, src); },
  async renderExact(state, region, pixels = this.TOTAL_PIXELS) {
    this.validateRegions(state, [region]);
    const info = await this.pageInfo(state, region.pageIndex);
    const r = region.rect;
    if (r[0] < info.bounds[0] || r[1] < info.bounds[1] || r[2] > info.bounds[2] || r[3] > info.bounds[3]) throw new Error('PDF 页面边界已改变');
    const cache = ZRBPDFFigureFallback.getCache();
    const key = await cache.key({ algorithm: 'manual-exact-1', source: state.fingerprint, pageIndex: region.pageIndex,
      rect: r, rotation: info.rotation, pixels });
    const producer = async () => {
      const renderer = this.limitedRenderer(state, pixels);
      const images = await renderer.renderRegionCrops(region.pageIndex, ZRBPDFFigureFallback.toView([r], state.base._iframeWindow));
      if (!this.live(state) || !images?.[0]) throw new Error('渲染取消或阅读视图已关闭');
      const src = images[0];
      const size = cache.dimensions(cache.pngBytes(src));
      return { src, ...size, rect: r.slice(), direction: 'above',
        displayWidth: (info.rotation % 180 ? r[3] - r[1] : r[2] - r[0]) * 96 / 72 };
    };
    return cache.getOrCreate(key, producer, { persist: () => ZRBPDFFigureFallback.cacheEnabled(), alive: () => this.live(state) });
  },
  async previewPage(state, pageIndex) {
    const info = await this.pageInfo(state, pageIndex);
    const renderer = this.limitedRenderer(state, 1100000);
    const images = await renderer.renderRegionCrops(pageIndex, ZRBPDFFigureFallback.toView([info.bounds], state.base._iframeWindow));
    if (!this.live(state) || !images?.[0]) throw new Error('页面预览已取消');
    return { src: images[0], ...info };
  },
  async prepareImages(state, regions, alive = () => this.live(state)) {
    const results = [];
    const pixels = Math.floor(this.TOTAL_PIXELS / regions.length);
    let bytes = 0;
    let pendingImage;
    try { for (const region of regions) {
      if (!alive()) throw new Error('操作已取消或阅读视图已关闭');
      const result = await this.renderExact(state, region, pixels);
      if (!result || !alive()) throw new Error('操作已取消或阅读视图已关闭');
      const image = state.doc.createElement('img'); pendingImage = image;
      try { await this.decode(image, result.src); } catch (error) { image.removeAttribute('src'); throw error; }
      if (!alive()) { image.removeAttribute('src'); throw new Error('操作已取消或阅读视图已关闭'); }
      bytes += result.src.length * 2 + result.width * result.height * 4;
      if (bytes > this.RESIDENT_BYTES) throw new Error('选区图像超过资源预算，请减少区域或分次修正');
      results.push({ ...result, image });
      pendingImage = null;
    } } catch (error) {
      pendingImage?.removeAttribute('src');
      for (const item of results) item.image.removeAttribute('src');
      throw error;
    }
    return { results, bytes };
  },
  normalizedRect(rect, bounds, rotation) {
    const [x, y, right, top] = bounds, w = right - x, h = top - y;
    const point = (px, py) => {
      switch (rotation) {
        case 90: return [(py - y) / h, (px - x) / w];
        case 180: return [(right - px) / w, (py - y) / h];
        case 270: return [(top - py) / h, (right - px) / w];
        default: return [(px - x) / w, (top - py) / h];
      }
    };
    const a = point(rect[0], rect[1]), b = point(rect[2], rect[3]);
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  },
  subtract(rect, cut) {
    const x1 = Math.max(rect[0], cut[0]), y1 = Math.max(rect[1], cut[1]);
    const x2 = Math.min(rect[2], cut[2]), y2 = Math.min(rect[3], cut[3]);
    if (x2 <= x1 || y2 <= y1) return [rect];
    return [[rect[0], rect[1], x1, rect[3]], [x2, rect[1], rect[2], rect[3]],
      [x1, rect[1], x2, y1], [x1, y2, x2, rect[3]]].filter(r => r[2] - r[0] > .01 && r[3] - r[1] > .01);
  },
  async replacementPlan(state, locator, element, regions, anchor) {
    if (locator.kind === 'fallback' || locator.kind === 'label') return { locator, element };
    const boxes = this.entry(state, locator.ref)?.block.anchor?.pageRects?.filter(r => ZRBPDFFigureFallback.validRect(r)) || [];
    // Unmapped standalone images can only be replaced by an explicit choice.
    // They are individual image nodes, never a parent paragraph/page container.
    if (!boxes.length) return { locator, element };
    // A discrete raster/vector image is safe to recrop smaller. A PDF crop can
    // also contain another figure or surrounding prose, which must survive.
    if (!element.matches('figure.sdt-source-crop')) return { locator, element };
    const remaining = boxes.map(box => {
      let parts = [box.slice(1)];
      for (const region of regions.filter(r => r.pageIndex === box[0])) parts = parts.flatMap(rect => this.subtract(rect, region.rect));
      return parts;
    });
    if (remaining.every(parts => !parts.length)) return { locator, element };
    const foreign = state.entries.some(({ block, ref }) => {
      if (ref.join('.') === anchor?.ref || ref.join('.') === locator.ref) return false;
      if (!['caption', 'math', 'table'].includes(block.type) && !ZRBPDFFigureFallback.isProse(block)) return false;
      return (block.anchor?.pageRects || []).some(r => ZRBPDFFigureFallback.validRect(r)
        && boxes.some(box => box[0] === r[0] && Math.min(box[3], r[3]) > Math.max(box[1], r[1]) && Math.min(box[4], r[4]) > Math.max(box[2], r[2]))
        && !regions.some(region => region.pageIndex === r[0] && region.rect[0] <= r[1] && region.rect[1] <= r[2] && region.rect[2] >= r[3] && region.rect[3] >= r[4]));
    });
    if (!foreign) return { locator, element };
    if (boxes.length !== 1 || !element.matches('figure.sdt-source-crop')) throw new Error('选区未完整包含该原生图片，请扩大选区或取消勾选该碎片');
    const box = boxes[0], bounds = box.slice(1);
    const intersections = regions.filter(r => r.pageIndex === box[0]).map(({ rect }) => [Math.max(bounds[0], rect[0]), Math.max(bounds[1], rect[1]), Math.min(bounds[2], rect[2]), Math.min(bounds[3], rect[3])])
      .filter(r => r[2] > r[0] && r[3] > r[1]);
    if (!intersections.length) throw new Error('该原生图片不在裁剪区域内，请取消勾选或扩大选区');
    const info = await this.pageInfo(state, box[0]);
    const holes = intersections.map(rect => this.normalizedRect(rect, bounds, info.rotation));
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" preserveAspectRatio="none"><rect width="1" height="1" fill="white"/>'
      + holes.map(r => `<rect x="${r[0]}" y="${r[1]}" width="${r[2] - r[0]}" height="${r[3] - r[1]}" fill="black"/>`).join('') + '</svg>';
    return { locator, element, mask: 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")' };
  },
  async apply(state, draft, { restoring = false, alive: extraAlive = () => true } = {}) {
    if (!state.fingerprint || !state.structureSignature) throw new Error(state.error || '图片修正尚未就绪');
    const regions = this.validateRegions(state, draft.regions);
    const anchor = this.resolve(state, draft.anchor);
    if (!anchor || draft.structure !== state.structureSignature) throw new Error('原图来源已改变，请重新选择');
    const token = {};
    state.operations.set(draft.id, token);
    const alive = () => this.live(state) && state.operations.get(draft.id) === token && extraAlive() && anchor.isConnected;
    const replacements = [];
    for (const locator of draft.replacements || []) {
      const element = this.resolve(state, locator, regions);
      if (!element && restoring && locator.kind === 'fallback') continue;
      if (!element || !['native', 'fallback', 'label'].includes(locator.kind)) throw new Error('替换范围已改变，请重新确认图片碎片');
      const owner = element.dataset.zrbManualHidden || element.dataset.zrbManualMasked;
      if (owner && owner !== draft.id) throw new Error('该图片已用于其他修正，请先恢复原显示');
      replacements.push(await this.replacementPlan(state, locator, element, regions, draft.anchor));
    }
    for (const record of state.records.values()) {
      if (record.id !== draft.id && JSON.stringify(record.anchor) === JSON.stringify(draft.anchor)) throw new Error('此图注已有修正，请使用该图的重新裁剪入口');
    }
    const record = { id: draft.id, structure: state.structureSignature, anchor: draft.anchor,
      replacements: replacements.map(item => item.locator), regions };
    const previousRecord = state.records.get(record.id);
    let prepared;
    let figure;
    try {
      prepared = await this.prepareImages(state, regions, alive);
      if (!alive()) throw new Error('操作已取消或阅读视图已关闭');
      const source = await ZRBPDFFigureFallback.sourceFingerprint(state);
      if (!source.stable || source.hash !== state.fingerprint) throw new Error('PDF 内容已改变，请重新打开文献');
      if (!restoring) await this.getStore().put(state.documentID, state.fingerprint, record, alive);
      if (!alive()) throw new Error('操作已取消或阅读视图已关闭');
      figure = this.makeFigure(state, record, prepared);
      try { anchor.before(figure); }
      catch (error) {
        // Keep the old correction mounted until the new DOM node is accepted.
        // Also roll back the already-written decision so reopen cannot show a
        // crop that never replaced the current one.
        if (!restoring) {
          try {
            if (previousRecord) await this.getStore().put(state.documentID, state.fingerprint, previousRecord, alive);
            else await this.getStore().remove(state.documentID, state.fingerprint, record.id, alive);
          } catch (rollbackError) { error.message += '; 修正记录回滚失败：' + (rollbackError.message || rollbackError); }
        }
        throw error;
      }
      this.unmount(state, record.id);
      for (const item of replacements) {
        const { element, mask } = item;
        if (!mask) { element.dataset.zrbManualHidden = record.id; continue; }
        item.previousStyles = ['mask-image', 'mask-mode', 'mask-size', 'mask-repeat'].map(property => [property, element.style.getPropertyValue(property), element.style.getPropertyPriority(property)]);
        for (const [property, value] of [['mask-image', mask], ['mask-mode', 'luminance'], ['mask-size', '100% 100%'], ['mask-repeat', 'no-repeat']]) element.style.setProperty(property, value, 'important');
        element.dataset.zrbManualMasked = record.id;
      }
      state.records.set(record.id, record);
      state.active.set(record.id, { figure, record, replacements, bytes: prepared.bytes, used: Date.now() });
      this.suppressFallbacks(state);
      this.enforceMemory();
      return record;
    } catch (error) {
      if (prepared) for (const item of prepared.results) item.image.removeAttribute('src');
      throw error;
    } finally {
      if (state.operations.get(draft.id) === token) state.operations.delete(draft.id);
    }
  },
  makeFigure(state, record, prepared) {
    const figure = state.doc.createElement('figure');
    figure.className = 'zrb-manual-figure'; figure.dataset.manualId = record.id;
    figure.tabIndex = 0; figure.setAttribute('aria-label', '已修正图片；右键可重新裁剪或恢复原显示');
    for (const [i, item] of prepared.results.entries()) {
      const box = state.doc.createElement('div');
      box.style.cssText = `max-width:100%;width:${item.displayWidth}px;aspect-ratio:${item.width}/${item.height};margin:8px auto;position:relative`;
      item.image.alt = `修正图片区域 ${i + 1} · PDF 第 ${record.regions[i].pageIndex + 1} 页`;
      item.image.style.cssText = 'width:100%;height:100%;position:absolute;inset:0;object-fit:contain';
      box.append(item.image); figure.append(box);
    }
    return figure;
  },
  suppressFallbacks(state) {
    for (const active of state.active.values()) {
      for (const locator of active.record.replacements.filter(item => item.kind === 'label')) {
        const element = this.resolve(state, locator, active.record.regions);
        const card = element?.nextElementSibling;
        if (!card?.classList.contains('zotero-bilingual-card') || active.replacements.some(item => item.element === card)) continue;
        const source = ZRBPDFFigureFallback.text(this.entry(state, locator.ref).block).replace(/\s+/g, ' ').trim();
        if ((card.dataset.origText || '').replace(/\s+/g, ' ').trim() !== source) continue;
        card.dataset.zrbManualHidden = active.record.id;
        active.replacements.push({ locator: { kind: 'label-card' }, element: card });
      }
      if (active.record.anchor.kind !== 'caption') continue;
      active.replacements = active.replacements.filter(item => item.locator.kind !== 'fallback' || item.element.isConnected);
      for (const element of state.doc.querySelectorAll('.zrb-pdf-figure-fallback')) {
        if (element.dataset.sourceRef !== active.record.anchor.ref || active.replacements.some(item => item.element === element)) continue;
        const locator = this.locate(state, element);
        if (!locator) continue;
        element.dataset.zrbManualHidden = active.record.id;
        active.replacements.push({ locator, element });
      }
    }
  },
  unmount(state, id) {
    const active = state.active.get(id);
    if (!active) return;
    for (const { element, previousStyles } of active.replacements) {
      if (element.dataset.zrbManualHidden === id) delete element.dataset.zrbManualHidden;
      if (element.dataset.zrbManualMasked === id) {
        delete element.dataset.zrbManualMasked;
        for (const [property, value, priority] of previousStyles || []) {
          if (value) element.style.setProperty(property, value, priority); else element.style.removeProperty(property);
        }
      }
    }
    active.figure.querySelectorAll('img').forEach(image => image.removeAttribute('src'));
    active.figure.remove(); state.active.delete(id);
  },
  async restoreOriginal(state, id) {
    await this.getStore().remove(state.documentID, state.fingerprint, id, () => this.live(state));
    state.operations.delete(id);
    this.unmount(state, id); state.records.delete(id);
  },
  async loadSaved(state) {
    const records = await this.getStore().list(state.documentID, state.fingerprint);
    for (const record of records) {
      if (!this.live(state)) return;
      if (record.structure !== state.structureSignature || !this.resolve(state, record.anchor)) continue;
      try { await this.apply(state, record, { restoring: true }); }
      catch (error) { this.report(state, error); }
    }
  },
  residentBytes() {
    let bytes = 0;
    for (const state of this.states.values()) for (const active of state.active.values()) bytes += active.bytes;
    return bytes;
  },
  enforceMemory() {
    const groups = [];
    for (const state of this.states.values()) for (const active of state.active.values()) {
      const box = active.figure.getBoundingClientRect();
      const height = state.doc.defaultView?.innerHeight || 900;
      const visible = box.width > 0 && box.bottom > 0 && box.top < height;
      if (active.bytes) groups.push({ state, active, visible });
    }
    let total = this.residentBytes();
    for (const { active } of groups.filter(g => !g.visible).sort((a, b) => a.active.used - b.active.used)) {
      if (total <= this.RESIDENT_BYTES) break;
      active.figure.querySelectorAll('img').forEach(image => image.removeAttribute('src'));
      total -= active.bytes; active.bytes = 0;
    }
    const cache = ZRBPDFFigureFallback.getCache();
    cache?.trimMemory(Math.max(0, ZRBPDFFigureFallback.MEMORY_BUDGET - total - (ZRBPDFFigureFallback.displayBytesEstimate || 0)));
  },
  scheduleVisible(state) {
    if (state.visibilityTimer || !this.live(state)) return;
    state.visibilityTimer = setTimeout(() => {
      state.visibilityTimer = null;
      this.enforceMemory();
      for (const active of state.active.values()) {
        const rect = active.figure.getBoundingClientRect();
        if (active.bytes || active.loading || rect.width <= 0 || rect.bottom < -500 || rect.top > (state.doc.defaultView?.innerHeight || 900) + 500) continue;
        active.loading = true;
        this.apply(state, active.record, { restoring: true }).catch(error => this.report(state, error)).finally(() => { active.loading = false; });
      }
    }, 120);
  },
  actionFeedback(state, message, isError = false) {
    const doc = state.doc;
    let node = state.actionFeedback;
    if (!node?.isConnected) {
      node = doc.createElement('div'); node.dataset.zrbActionFeedback = 'true';
      node.setAttribute('role', isError ? 'alert' : 'status');
      node.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483005;max-width:min(90vw,720px);padding:9px 14px;border-radius:6px;background:Canvas;color:CanvasText;box-shadow:0 2px 12px #0005;font:14px sans-serif';
      doc.body.append(node); state.actionFeedback = node;
    }
    node.setAttribute('role', isError ? 'alert' : 'status');
    node.textContent = message;
    if (state.actionFeedbackTimer) clearTimeout(state.actionFeedbackTimer);
    state.actionFeedbackTimer = setTimeout(() => { node.remove(); state.actionFeedback = null; state.actionFeedbackTimer = null; }, isError ? 9000 : 1800);
  },
  graphicRect(element, target) {
    const media = target?.closest?.('img,svg,canvas');
    const rectOf = node => {
      const r = node?.getBoundingClientRect?.();
      return r && r.width > 0 && r.height > 0 ? r : null;
    };
    if (media && (media === element || element.contains(media))) {
      const rect = rectOf(media); if (rect) return rect;
    }
    const children = element.matches?.('img,svg,canvas') ? [element] : Array.from(element.querySelectorAll?.('img,svg,canvas') || []);
    const rects = children.map(rectOf).filter(Boolean);
    if (rects.length === 1) return rects[0];
    if (rects.length > 1) return {
      left: Math.min(...rects.map(r => r.left)), right: Math.max(...rects.map(r => r.right)),
      top: Math.min(...rects.map(r => r.top)), bottom: Math.max(...rects.map(r => r.bottom)),
    };
    return rectOf(element) || element.getBoundingClientRect();
  },
  cancelControlHide(state) {
    if (state.controlHideTimer) clearTimeout(state.controlHideTimer);
    state.controlHideTimer = null;
  },
  scheduleControlHide(state) {
    this.cancelControlHide(state);
    state.controlHideTimer = setTimeout(() => {
      state.controlHideTimer = null;
      if (!state.control?.matches(':hover') && !state.hovered?.matches(':hover')) state.control.hidden = true;
    }, 0);
  },
  openForElement(element) {
    const state = element?.ownerDocument && this.states.get(element.ownerDocument);
    if (!state?.openEditor) return Promise.resolve(false);
    return state.openEditor(element);
  },
  installControls(state) {
    const doc = state.doc;
    const style = doc.createElement('style');
    style.textContent = '[data-zrb-manual-hidden]{display:none!important}.zrb-manual-figure{margin:16px 0;break-inside:avoid}.zrb-figure-edit-control{position:fixed;z-index:2147483000;font:12px sans-serif;padding:4px 8px;border:1px solid #8888;border-radius:5px;background:Canvas;color:CanvasText;cursor:pointer}.zrb-manual-menu{position:fixed;z-index:2147483001;background:Canvas;color:CanvasText;border:1px solid #8888;border-radius:6px;padding:4px;box-shadow:0 3px 12px #0003}.zrb-manual-menu button{display:block;border:0;background:transparent;color:inherit;padding:8px 12px;cursor:pointer}.zrb-manual-menu button:hover{background:#8882}.zrb-manual-scope-highlight{outline:3px solid #f59e0b!important;outline-offset:2px!important}';
    doc.head.append(style); state.style = style;
    const control = doc.createElement('button'); control.type = 'button'; control.className = 'zrb-figure-edit-control';
    control.textContent = '裁剪'; control.title = '裁剪／修正图片'; control.hidden = true;
    doc.body.append(control); state.control = control;
    control.addEventListener('pointerenter', () => this.cancelControlHide(state));
    control.addEventListener('pointerleave', () => this.scheduleControlHide(state));
    const graphic = target => {
      if (!target?.closest || target.closest('.zrb-manual-editor,.zrb-manual-menu,.zrb-figure-edit-control,.zotero-bilingual-card')) return null;
      const manual = target.closest('.zrb-manual-figure'); if (manual) return manual;
      const fallback = target.closest('.zrb-pdf-figure-fallback'); if (fallback) return fallback;
      return this.nativeElements(state).find(el => el === target || el.contains(target)) || null;
    };
    const placeControl = element => {
      if (!element?.isConnected) { control.hidden = true; return; }
      const r = this.graphicRect(element, state.hoveredTarget || element);
      const view = doc.defaultView, width = view?.innerWidth || 900, height = view?.innerHeight || 700;
      if (!r || r.right <= 0 || r.bottom <= 0 || r.left >= width || r.top >= height) { control.hidden = true; return; }
      const controlWidth = Math.max(56, control.getBoundingClientRect().width || 56);
      const left = Math.min(Math.max(4, r.right - controlWidth), width - controlWidth - 4);
      const top = Math.min(Math.max(4, r.top + 4), height - 30);
      control.style.left = left + 'px'; control.style.top = top + 'px'; control.hidden = false;
    };
    state.placeControl = placeControl;
    const show = event => {
      if (event.target.closest?.('.zrb-figure-edit-control')) { this.cancelControlHide(state); return; }
      if (event.target.closest?.('.zrb-figure-edit-inline')) return;
      const element = graphic(event.target);
      if (!element) {
        this.cancelControlHide(state);
        control.hidden = true;
        return;
      }
      const rect = this.graphicRect(element, event.target);
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
        this.cancelControlHide(state);
        control.hidden = true;
        return;
      }
      this.cancelControlHide(state);
      state.hovered = element; state.hoveredTarget = event.target; placeControl(element);
    };
    const edit = async element => {
      state.menu?.remove(); state.menu = null;
      this.actionFeedback(state, '正在打开图片裁剪窗口…');
      try {
        await state.ready;
        if (!this.live(state)) return;
        if (!state.fingerprint) throw new Error(state.error || '无法读取 PDF 指纹');
        ZRBManualFigureEditor.open(state, this.targetFor(state, element));
        state.actionFeedback?.remove(); state.actionFeedback = null;
        return true;
      } catch (error) {
        this.report(state, error); control.title = state.error;
        this.actionFeedback(state, '无法打开裁剪窗口：' + state.error, true);
        return false;
      }
    };
    state.openEditor = edit;
    control.addEventListener('click', () => { if (state.hovered) edit(state.hovered, control); });
    const enlarge = element => {
      const overlay = doc.createElement('div'); overlay.className = 'zrb-image-lightbox';
      overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-label', '图片放大预览');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483002;box-sizing:border-box;background:#000d;display:grid;place-items:center;padding:48px 20px 20px;cursor:default;overscroll-behavior:contain';
      const toolbar = doc.createElement('div'); toolbar.style.cssText = 'position:absolute;right:16px;top:12px;display:flex;gap:8px;align-items:center;color:white;font:14px sans-serif';
      const zoomLabel = doc.createElement('span'); zoomLabel.setAttribute('aria-live', 'polite');
      const content = doc.createElement('div'); content.className = 'zrb-image-lightbox-content';
      content.style.cssText = 'width:94vw;height:90vh;overflow:auto;overscroll-behavior:contain;display:block;cursor:grab;touch-action:none;user-select:none';
      const stack = doc.createElement('div'); stack.style.cssText = 'box-sizing:border-box;width:max-content;min-width:100%;height:max-content;min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;margin:auto';
      let media = [];
      if (element.matches?.('img,svg,canvas')) media = [element];
      else media = Array.from(element.querySelectorAll('img,svg,canvas'));
      const scaled = [];
      for (const source of media) {
        let node;
        if (source.matches('canvas')) { node = doc.createElement('img'); try { node.src = source.toDataURL('image/png'); } catch (e) { continue; } }
        else node = source.cloneNode(true);
        const rect = source.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        // The Reader can scale/transform its page. Measure its visible bounds,
        // then render that size in this independent viewport without carrying
        // the page's transform into the cloned media.
        const size = { width: rect.width, height: rect.height };
        node.style?.setProperty('max-width', 'none', 'important'); node.style?.setProperty('max-height', 'none', 'important');
        node.style?.setProperty('width', size.width + 'px', 'important'); node.style?.setProperty('height', size.height + 'px', 'important');
        node.style?.setProperty('object-fit', 'contain', 'important');
        node.style?.setProperty('display', 'block', 'important'); node.style?.setProperty('position', 'static', 'important');
        node.style?.setProperty('float', 'none', 'important'); node.style?.setProperty('margin', '0 auto', 'important');
        node.style?.setProperty('transform', 'none', 'important');
        node.draggable = false;
        stack.append(node); scaled.push({ node, size });
      }
      if (!stack.childNodes.length) return;
      content.append(stack);
      let zoom = 1, fit = 1;
      const baseZoom = 1;
      const updateZoom = value => {
        const centerX = content.clientWidth ? (content.scrollLeft + content.clientWidth / 2) / content.scrollWidth : .5;
        const centerY = content.clientHeight ? (content.scrollTop + content.clientHeight / 2) / content.scrollHeight : .5;
        zoom = Math.min(3, Math.max(.5, Math.round(value * 100) / 100));
        zoomLabel.textContent = Math.round(zoom * 100) + '%'; overlay.dataset.zoom = String(zoom);
        for (const item of scaled) { item.node.style.setProperty('width', item.size.width * fit * zoom + 'px', 'important'); item.node.style.setProperty('height', item.size.height * fit * zoom + 'px', 'important'); }
        content.scrollLeft = Math.max(0, centerX * content.scrollWidth - content.clientWidth / 2);
        content.scrollTop = Math.max(0, centerY * content.scrollHeight - content.clientHeight / 2);
      };
      const button = (label, text, action) => {
        const b = doc.createElement('button'); b.type = 'button'; b.setAttribute('aria-label', label); b.textContent = text;
        b.style.cssText = 'min-width:36px;padding:6px 10px;border:1px solid #fff9;border-radius:4px;background:#222;color:white;cursor:pointer';
        b.addEventListener('click', event => { event.stopPropagation(); action(); }); toolbar.append(b); return b;
      };
      button('缩小图片', '−', () => updateZoom(zoom - .25));
      button('放大图片', '+', () => updateZoom(zoom + .25));
      button('适合窗口', '适合', () => updateZoom(1)); toolbar.append(zoomLabel);
      button('关闭图片预览', '关闭', () => close());
      overlay.append(toolbar, content); doc.body.append(overlay);
      const maxWidth = Math.max(...scaled.map(item => item.size.width));
      const totalHeight = scaled.reduce((sum, item) => sum + item.size.height, 0) + Math.max(0, scaled.length - 1) * 12;
      fit = Math.min(1, content.clientWidth / maxWidth, content.clientHeight / totalHeight);
      updateZoom(baseZoom);
      const close = () => { overlay.remove(); doc.removeEventListener('keydown', onKey, true); };
      const onKey = event => {
        if (event.key === 'Escape') close();
        else if (event.key === '+' || event.key === '=') updateZoom(zoom + .25);
        else if (event.key === '-') updateZoom(zoom - .25);
      };
      content.addEventListener('wheel', event => { event.preventDefault(); updateZoom(zoom + (event.deltaY < 0 ? .1 : -.1)); }, { passive: false });
      let pan = null;
      content.addEventListener('pointerdown', event => {
        if (event.button !== 0 || (content.scrollWidth <= content.clientWidth && content.scrollHeight <= content.clientHeight)) return;
        event.preventDefault(); event.stopPropagation();
        pan = { x: event.clientX, y: event.clientY, left: content.scrollLeft, top: content.scrollTop };
        content.style.cursor = 'grabbing'; content.setPointerCapture?.(event.pointerId);
      });
      content.addEventListener('pointermove', event => {
        if (!pan) return;
        event.preventDefault();
        content.scrollLeft = pan.left + pan.x - event.clientX;
        content.scrollTop = pan.top + pan.y - event.clientY;
      });
      const endPan = event => {
        if (!pan) return;
        pan = null; content.style.cursor = 'grab';
        if (content.hasPointerCapture?.(event.pointerId)) content.releasePointerCapture(event.pointerId);
      };
      content.addEventListener('pointerup', endPan);
      content.addEventListener('pointercancel', endPan);
      content.addEventListener('click', event => event.stopPropagation());
      overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
      doc.addEventListener('keydown', onKey, true);
    };
    const doubleClick = event => {
      const element = graphic(event.target); if (!element) return;
      event.preventDefault(); event.stopPropagation(); enlarge(element);
    };
    const menu = event => {
      const element = graphic(event.target); if (!element) return;
      event.preventDefault(); event.stopPropagation(); state.menu?.remove();
      const box = doc.createElement('div'); box.className = 'zrb-manual-menu'; box.setAttribute('role', 'menu');
      box.style.left = Math.max(0, Math.min(event.clientX, (doc.defaultView?.innerWidth || 900) - 180)) + 'px';
      box.style.top = Math.max(0, Math.min(event.clientY, (doc.defaultView?.innerHeight || 700) - 100)) + 'px';
      const add = (text, action) => { const button = doc.createElement('button'); button.type = 'button'; button.textContent = text; button.addEventListener('click', action); box.append(button); };
      add(element.matches('.zrb-manual-figure') ? '重新裁剪' : '裁剪／修正图片', () => edit(element));
      if (element.matches('.zrb-manual-figure')) add('恢复原显示', async () => {
        try { await this.restoreOriginal(state, element.dataset.manualId); box.remove(); } catch (error) { this.report(state, error); box.title = state.error; }
      });
      doc.body.append(box); state.menu = box; box.querySelector('button').focus();
    };
    const scopeHover = event => {
      const label = event.target.closest?.('.zrb-manual-scope label');
      if (!label) return;
      let locator; try { locator = JSON.parse(label.dataset.zrbLocator); } catch (e) { return; }
      const element = this.resolve(state, locator);
      if (element) { element.classList.add('zrb-manual-scope-highlight'); state.scopeHighlight = element; }
    };
    const clearScopeHover = event => {
      if (event.target.closest?.('.zrb-manual-scope label') && state.scopeHighlight) {
        state.scopeHighlight.classList.remove('zrb-manual-scope-highlight'); state.scopeHighlight = null;
      }
    };
    const dismiss = event => { if (!state.menu?.contains(event.target)) { state.menu?.remove(); state.menu = null; } };
    const key = event => { if (event.key === 'Escape') { state.menu?.remove(); state.menu = null; state.editor?.close(); } };
    const scroll = () => {
      this.cancelControlHide(state);
      if (state.hovered?.matches(':hover') || control.matches(':hover')) placeControl(state.hovered);
      else control.hidden = true;
      this.scheduleVisible(state);
    };
    const resize = () => {
      if (state.hovered && (!control.hidden || state.hovered.matches(':hover') || control.matches(':hover'))) placeControl(state.hovered);
      else control.hidden = true;
    };
    state.listeners = [['pointerover', show], ['focusin', show], ['dblclick', doubleClick], ['contextmenu', menu], ['pointerdown', dismiss], ['pointerover', scopeHover], ['pointerout', clearScopeHover], ['keydown', key], ['scroll', scroll]];
    for (const [name, listener] of state.listeners) doc.addEventListener(name, listener, true);
    doc.defaultView?.addEventListener('resize', resize);
    state.onResize = resize;
    state.onPageHide = () => this.dispose(state);
    doc.defaultView?.addEventListener('pagehide', state.onPageHide, { once: true });
  },
  sync(readers) {
    const liveDocs = new Set();
    for (const reader of readers) {
      this.ensure(reader);
      const internal = reader?._internalReader || reader;
      for (const view of [internal?._primarySDTView, internal?._secondarySDTView]) {
        try { if (view?._iframeDocument) liveDocs.add(view._iframeDocument); } catch (e) {}
      }
    }
    for (const state of this.states.values()) if (!liveDocs.has(state.doc) || !this.live(state)) this.dispose(state);
  },
  dispose(state) {
    if (state.disposed) return;
    state.disposed = true; state.operations.clear();
    try {
      state.scopeHighlight?.classList.remove('zrb-manual-scope-highlight'); state.doc.querySelector('.zrb-image-lightbox')?.remove();
      state.editor?.close(); state.menu?.remove(); state.control?.remove(); state.style?.remove();
      if (state.visibilityTimer) clearTimeout(state.visibilityTimer);
      this.cancelControlHide(state); if (state.actionFeedbackTimer) clearTimeout(state.actionFeedbackTimer); state.actionFeedback?.remove();
      for (const [name, listener] of state.listeners || []) state.doc.removeEventListener(name, listener, true);
      state.doc.defaultView?.removeEventListener('resize', state.onResize);
      state.doc.defaultView?.removeEventListener('pagehide', state.onPageHide);
      for (const id of state.active.keys()) this.unmount(state, id);
    } catch (e) {}
    state.records.clear(); this.states.delete(state.doc);
  },
  shutdown() { for (const state of this.states.values()) this.dispose(state); },
};
