/* eslint-disable no-undef */

// Recover missing figures from regions between captions and prose. Source PDF
// rendering preserves both raster and vector graphics. Never display a page as
// a fallback for uncertain geometry; PDF, SDT and translation caches stay intact.
var ZRBPDFFigureFallback = {
  states: new Map(),
  cache: null,
  viewSequence: 0,
  MEMORY_BUDGET: 32 * 1024 * 1024,
  SCROLL_IDLE_MS: 80,

  prefetchMargin(state) {
    const height = state.doc.documentElement.clientHeight || state.doc.defaultView?.innerHeight || 0;
    return Math.min(3200, Math.max(1200, height * 2));
  },

  isLive(state) {
    if (state.disposed) return false;
    try {
      if (state.doc.documentElement && !state.doc.defaultView?.closed) return true;
      this.dispose(state); return false;
    }
    catch (e) { this.dispose(state); return false; }
  },

  defer(state, callback, delay) {
    return typeof setTimeout === 'function' ? setTimeout(callback, delay) : state.doc.defaultView.setTimeout(callback, delay);
  },

  async waitForScrollIdle(state) {
    while (!state.disposed) {
      const delay = this.SCROLL_IDLE_MS - (Date.now() - (state.lastInput || 0));
      if (delay <= 0) return;
      await new Promise(resolve => this.defer(state, resolve, delay));
    }
  },

  scheduleVisibility(state) {
    if (state.disposed || state.visibilityTimer != null) return;
    const delay = Math.max(0, this.SCROLL_IDLE_MS - (Date.now() - (state.lastInput || 0)));
    state.visibilityTimer = this.defer(state, () => {
      state.visibilityTimer = null;
      this.loadVisible(state);
    }, delay);
  },

  async renderWhenIdle(state, pageIndex, ref, reason, candidates) {
    if (reason !== 'manual') await this.waitForScrollIdle(state);
    if (state.disposed || (reason === 'auto' && state.mode !== 'auto')) return null;
    return this.renderFigure(state, pageIndex, ref, candidates);
  },

  getCache() {
    if (!this.cache && typeof ZRBFigureCache !== 'undefined') this.cache = ZRBFigureCache.runtime();
    return this.cache;
  },

  cacheEnabled() {
    try {
      const value = Zotero.Prefs.get('extensions.zotero.reading-bilingual.figureCache', true);
      if (typeof value === 'boolean') return value;
    } catch (e) {}
    return true;
  },

  async sourceFingerprint(state) {
    const declared = state.structure.metadata?.source?.hash;
    const reader = state.reader;
    const itemID = reader?.itemID || reader?._itemID || reader?._item?.id;
    if (itemID && typeof IOUtils !== 'undefined' && typeof Zotero !== 'undefined' && Zotero.Items) {
      try {
        const file = await Zotero.Items.get(itemID)?.getFilePathAsync();
        if (file) {
          const stat = await IOUtils.stat(file);
          const stamp = file + ':' + stat.size + ':' + stat.lastModified;
          if (state.fileStamp !== stamp) {
            state.fileHash = await Zotero.Utilities.Internal.md5Async(file);
            state.fileStamp = stamp;
          }
          if (declared && state.fileHash !== declared) throw new Error('PDF 内容已改变，请重新打开文献以更新阅读模式');
          if (state.fileHash) return { hash: state.fileHash, stable: true };
        }
      } catch (e) {
        if (String(e.message).includes('PDF 内容已改变')) throw e;
        return { hash: 'view-' + state.id, stable: false };
      }
    }
    return { hash: declared || 'view-' + state.id, stable: !!declared };
  },

  async getFigure(state, pageIndex, ref, reason = 'manual') {
    const candidates = state.cropOverrides?.get(ref.join('.') + ':' + pageIndex)
      || this.getCropCandidates(state.structure, ref, pageIndex);
    const cache = this.getCache();
    if (!cache) return this.renderWhenIdle(state, pageIndex, ref, reason, candidates);
    const source = await this.sourceFingerprint(state);
    const key = await cache.key({ algorithm: 'region-crops-3', source: source.hash,
      processor: state.structure.metadata?.processor, pageIndex, ref, candidates, direction: state.direction,
      rotation: state.structure.catalog.pages[pageIndex].rotation || 0,
      maxPixels: state.base?._iframeWindow?.PDFViewerApplication?.pdfViewer?.maxCanvasPixels || 0 });
    const result = await cache.getOrCreate(key, () => this.renderWhenIdle(state, pageIndex, ref, reason, candidates), {
      persist: () => source.stable && this.cacheEnabled(),
      alive: () => this.isLive(state) && (reason !== 'auto' || state.mode === 'auto'),
    });
    if (result) result.cacheKey = key;
    return result;
  },

  enforceMemory() {
    const loaded = [];
    for (const state of this.states.values()) {
      if (!this.isLive(state)) continue;
      const height = state.doc.documentElement.clientHeight || state.doc.defaultView?.innerHeight || 0;
      for (const preview of state.previews.values()) {
        if (preview.figure.dataset.state !== 'loaded') continue;
        const rect = this.previewRect(preview);
        const visible = height > 0 && rect.width > 0 && rect.height > 0 && rect.top < height && rect.bottom > 0;
        const retention = Math.max(2 * height, this.prefetchMargin(state) + height);
        const far = height > 0 && (rect.width === 0 || rect.height === 0 || rect.bottom < -retention || rect.top > height + retention);
        if (far) this.unload(preview);
        else loaded.push({ preview, visible });
      }
    }
    let bytes = loaded.reduce((sum, item) => sum + item.preview.bytes, 0);
    for (const item of loaded.filter(item => !item.visible).sort((a,b) => a.preview.used - b.preview.used)) {
      if (bytes <= this.MEMORY_BUDGET) break;
      this.unload(item.preview); bytes -= item.preview.bytes;
    }
    const manualBytes = typeof ZRBManualFigures !== 'undefined' ? ZRBManualFigures.residentBytes() : 0;
    this.getCache()?.trimMemory(Math.max(0, this.MEMORY_BUDGET - bytes - manualBytes));
    this.displayBytesEstimate = bytes;
  },

  unload(preview) {
    preview.image.hidden = true;
    preview.image.removeAttribute('src');
    preview.figure.dataset.state = 'unloaded';
    // The image box retains its aspect ratio, so scrolling never collapses it.
  },

  getMode() {
    try {
      const value = Zotero.Prefs.get('extensions.zotero.reading-bilingual.figureMode', true);
      if (['off', 'manual', 'auto'].includes(value)) return value;
    } catch (e) {}
    return 'manual';
  },

  previewKey(figure) {
    return figure.dataset.sourceRef + ':' + figure.dataset.pageIndex;
  },

  previewRect(preview) {
    if (!preview.nativeGroup || preview.nativeGroup.active) return preview.figure.getBoundingClientRect();
    const rect = preview.anchor.getBoundingClientRect();
    if (rect.width && rect.height) return rect;
    // Translation-only mode hides source captions. The original native crop
    // is still visible until the replacement transaction is ready.
    for (const original of preview.nativeGroup.originals) {
      const source = original.element.getBoundingClientRect();
      if (source.width && source.height) return source;
    }
    return rect;
  },

  updateMode(state, mode) {
    if (state.mode !== mode) {
      state.observer?.disconnect();
      state.observer = null;
      state.doc.removeEventListener('scroll', state.checkVisibility, true);
      state.doc.removeEventListener('wheel', state.checkVisibility, true);
      state.doc.defaultView?.removeEventListener('resize', state.checkVisibility);
      state.mode = mode;
      state.doc.addEventListener('scroll', state.checkVisibility, true);
      state.doc.addEventListener('wheel', state.checkVisibility, { capture: true, passive: true });
      state.doc.defaultView?.addEventListener('resize', state.checkVisibility);
      if (mode === 'auto') {
        const Observer = state.doc.defaultView?.IntersectionObserver;
        if (Observer) {
          try {
            state.observer = new Observer(items => {
              if (state.disposed || state.mode !== 'auto') return;
              for (const item of items) {
                if (!item.isIntersecting) continue;
                this.scheduleVisibility(state);
              }
            }, this.toView({ rootMargin: this.prefetchMargin(state) + 'px' }, state.doc.defaultView));
            for (const { figure } of state.previews.values()) {
              if (['idle', 'unloaded'].includes(figure.dataset.state)) state.observer.observe(figure);
            }
          } catch (e) { state.observer?.disconnect(); state.observer = null; }
        }
      }
    }
    this.loadVisible(state);
  },

  loadVisible(state) {
    if (!this.isLive(state)) return;
    if (Date.now() - (state.lastInput || 0) < this.SCROLL_IDLE_MS) { this.scheduleVisibility(state); return; }
    this.enforceMemory();
    const height = state.doc.documentElement.clientHeight || state.doc.defaultView?.innerHeight || 0;
    if (!height) return;
    const nearby = [];
    const margin = this.prefetchMargin(state);
    for (const preview of state.previews.values()) {
      const { figure, load, loadedBefore, nativeGroup } = preview;
      if (!['idle', 'unloaded'].includes(figure.dataset.state) || (state.mode !== 'auto' && !loadedBefore && !nativeGroup)) continue;
      const rect = this.previewRect(preview);
      if (rect.width > 0 && rect.height > 0 && rect.top <= height + margin && rect.bottom >= -margin) {
        nearby.push({ load, reason: nativeGroup ? 'native' : state.mode === 'auto' ? 'auto' : 'restore', distance: Math.max(0, rect.top - height, -rect.bottom) });
      }
    }
    nearby.sort((a, b) => a.distance - b.distance);
    for (const { load, reason } of nearby) load(reason);
  },

  blocks(content, prefix = [], includeExcluded = false) {
    const result = [];
    for (const [i, block] of (content || []).entries()) {
      if (!block || typeof block !== 'object' || !block.type || (!includeExcluded && block.flowClass === 'excluded')) continue;
      const ref = [...prefix, i];
      result.push({ block, ref });
      result.push(...this.blocks(block.content, ref, includeExcluded));
    }
    return result;
  },

  validRect(rect) {
    return Array.isArray(rect) && rect.length === 5 && rect.every(Number.isFinite)
      && Number.isInteger(rect[0]) && rect[0] >= 0 && rect[3] > rect[1] && rect[4] > rect[2];
  },

  text(block) {
    return (block.content || []).map(node => typeof node.text === 'string' ? node.text : this.text(node)).join(' ');
  },

  isProse(block) {
    if (!['paragraph', 'list', 'listitem'].includes(block.type)) return false;
    const text = this.text(block).trim();
    if (text.length < 40) return false;
    const words = text.split(/\s+/);
    const verbal = words.filter(word => /[A-Za-z]{2}/.test(word)).length;
    // Figure labels may be classified as a long paragraph. Numeric ticks and
    // short legend entries must not become boundaries through the plot itself.
    return (text.length >= 60 && verbal >= 8 && verbal / words.length > 0.65
      && /[^0-9]\.(?:\s|$)|[!?]/.test(text))
      || ((text.match(/[\u4e00-\u9fff]/g) || []).length >= 40 && /[。！？]|\.(?:\s|$)/.test(text));
  },

  cropBlockRects(block, pageIndex) {
    const rects = (block.anchor?.pageRects || []).filter(r => this.validRect(r) && r[0] === pageIndex).map(r => r.slice(1));
    if (block.type !== 'math' || !rects.length) return rects;
    const textRects = [];
    const visit = node => {
      if (typeof node.anchor?.textMap === 'string') {
        try {
          const runs = JSON.parse(node.anchor.textMap);
          if (Array.isArray(runs)) for (const run of runs) {
            // SDT text-map runs begin with flags,page,x1,y1,x2,y2.
            const rect = Array.isArray(run) ? run.slice(1, 6) : [];
            if (this.validRect(rect) && rect[0] === pageIndex) textRects.push(rect.slice(1));
          }
        } catch (e) {}
      }
      for (const child of node.content || []) if (child && typeof child === 'object') visit(child);
    };
    visit(block);
    return rects.map(rect => {
      const inside = textRects.filter(r => r[0] >= rect[0] - 2 && r[1] >= rect[1] - 2 && r[2] <= rect[2] + 2 && r[3] <= rect[3] + 2);
      if (!inside.length) return rect;
      const ink = [Math.min(...inside.map(r => r[0])), Math.min(...inside.map(r => r[1])),
        Math.max(...inside.map(r => r[2])), Math.max(...inside.map(r => r[3]))];
      const oversized = rect[3] - rect[1] > Math.max(ink[3] - ink[1] + 20, (ink[3] - ink[1]) * 2)
        || rect[2] - rect[0] > Math.max(ink[2] - ink[0] + 20, (ink[2] - ink[0]) * 2);
      if (!oversized) return rect;
      // Some SDT math boxes merge a formula with a neighboring graphic. Keep
      // the formula's own glyph bounds plus padding as a crop boundary.
      return [Math.max(rect[0], ink[0] - 2), Math.max(rect[1], ink[1] - 2),
        Math.min(rect[2], ink[2] + 2), Math.min(rect[3], ink[3] + 2)];
    });
  },

  getCropCandidates(structure, ref, pageIndex, ignoredBlocks = new Set()) {
    const entries = this.blocks(structure.content).filter(item=>!ignoredBlocks.has(item.block));
    const caption = entries.find(item => item.ref.join('.') === ref.join('.'))?.block;
    const anchorRect = caption?.anchor?.pageRects?.find(r => this.validRect(r) && r[0] === pageIndex);
    const page = structure.catalog?.pages?.[pageIndex]?.viewRect;
    if (!anchorRect || !Array.isArray(page) || page.length !== 4 || !page.every(Number.isFinite)) return [];
    const group = this.captionGroup(anchorRect, entries, caption);
    const rect = [pageIndex, Math.min(...group.map(c => c.rect[1])), Math.min(...group.map(c => c.rect[2])),
      Math.max(...group.map(c => c.rect[3])), Math.max(...group.map(c => c.rect[4]))];
    const pageWidth = page[2] - page[0];
    if (!(pageWidth > 0) || !(page[3] > page[1])) return [];
    const bounds = new Map();
    const localRects = block => {
      if (!bounds.has(block)) bounds.set(block, this.cropBlockRects(block, pageIndex));
      return bounds.get(block);
    };
    const scopes = entries.filter(item => this.isProse(item.block)).flatMap(item => localRects(item.block))
      .filter(r => r[0] - 15 <= rect[1] && r[2] + 15 >= rect[3] && r[2] - r[0] >= pageWidth * 0.2)
      .sort((a, b) => Math.abs(a[1] + a[3] - rect[2] - rect[4]) - Math.abs(b[1] + b[3] - rect[2] - rect[4]));
    const scope = scopes[0] || rect.slice(1);
    const x1 = Math.max(page[0], Math.min(scope[0], rect[1]) - 3);
    const x2 = Math.min(page[2], Math.max(scope[2], rect[3]) + 3);
    const excluded = this.blocks(structure.content, [], true).filter(item => item.block.flowClass === 'excluded'
      && ['paragraph', 'heading'].includes(item.block.type));
    const marginal = excluded.filter(item => localRects(item.block).some(r => r[3] - r[1] < 25
      && (r[1] > page[3] - (page[3] - page[1]) * 0.15 || r[3] < page[1] + (page[3] - page[1]) * 0.18))
      && this.isRunningMargin(item.block, excluded, pageIndex, structure.catalog.pages));
    const obstacleRects = entries.filter(item => {
      if (group.some(c => c.block === item.block)) return false;
      if (item.block.type === 'heading') return localRects(item.block).some(r => r[3] - r[1] <= 40);
      if (item.block.type === 'caption' && /^\s*[(（](?:[a-z]|[ivx]{1,4})[)）]/i.test(this.text(item.block))
        && localRects(item.block).some(r => Math.max(0, r[1] - rect[4], rect[2] - r[3]) <= 24
          && Math.min(r[2], rect[3]) - Math.max(r[0], rect[1]) > Math.min(r[2] - r[0], rect[3] - rect[1]) * 0.5)) return false;
      return ['caption', 'table', 'math', 'image'].includes(item.block.type) || this.isProse(item.block);
    }).concat(marginal).flatMap(item => localRects(item.block));
    const blockers = obstacleRects.filter(r => {
      const overlap = Math.min(x2, r[2]) - Math.max(x1, r[0]);
      return overlap > 0.2 * Math.min(x2 - x1, r[2] - r[0]);
    });
    const upper = Math.min(page[3] - 25, ...blockers.filter(r => r[1] >= rect[4] - 1).map(r => r[1]));
    const lower = Math.max(page[1] + 25, ...blockers.filter(r => r[3] <= rect[2] + 1).map(r => r[3]));
    const candidates = [
      { direction: 'above', rect: [x1, rect[4] + 3, x2, upper - 3] },
      { direction: 'below', rect: [x1, lower + 3, x2, rect[2] - 3] },
    ];
    // A narrow multiline caption near a page edge may sit beside its figure.
    // Bound successive side figures by caption TOPS: their caption bottoms do
    // not describe where the neighboring multi-panel graphic ends.
    const capWidth = rect[3] - rect[1], capHeight = rect[4] - rect[2];
    const side = capWidth < pageWidth * 0.28 && capHeight >= 12
      ? rect[1] < page[0] + pageWidth * 0.18 ? 'right'
        : rect[3] > page[2] - pageWidth * 0.18 ? 'left' : null : null;
    if (side) {
      const edge = Math.max(25, side === 'right' ? rect[1] - page[0] : page[2] - rect[3]);
      const sx1 = side === 'right' ? rect[3] + 3 : page[0] + edge - 3;
      const sx2 = side === 'right' ? page[2] - edge + 3 : rect[1] - 3;
      const neighbors = entries.filter(item => item.block.type === 'caption' && !group.some(c => c.block === item.block))
        .flatMap(item => localRects(item.block)).filter(r => Math.min(r[2], rect[3]) > Math.max(r[0], rect[1]));
      let top = Math.min(page[3] - 25, rect[4] + 12);
      let bottom = Math.max(page[1] + edge + 8, ...neighbors.filter(r => r[3] < rect[2]).map(r => r[3] + 3));
      const across = obstacleRects.filter(r => Math.min(sx2, r[2]) - Math.max(sx1, r[0]) > 10);
      const occupied = across.some(r => r[1] < rect[4] && r[3] > rect[2]);
      top = Math.min(top, ...across.filter(r => r[1] >= rect[4]).map(r => r[1] - 3));
      bottom = Math.max(bottom, ...across.filter(r => r[3] <= rect[2]).map(r => r[3] + 3));
      if (!occupied && sx2 - sx1 > pageWidth * 0.45) candidates.unshift({ direction: side, rect: [sx1, bottom, sx2, top] });
    }
    // Expand a short caption's column only when the adjacent column is empty
    // over this entire band. Existing prose, captions and graphics still block
    // expansion; separate column figures must never be joined by ink score.
    const proseRects = entries.filter(item => this.isProse(item.block)).flatMap(item => localRects(item.block));
    if (!side && capWidth >= pageWidth * 0.35 && proseRects.some(r => r[0] > x2 || r[2] < x1)) {
      const left = Math.max(page[0] + 25, Math.min(x1, ...proseRects.map(r => r[0] - 3)));
      const right = Math.min(page[2] - 25, Math.max(x2, ...proseRects.map(r => r[2] + 3)));
      for (const c of candidates) {
        if (c.rect[3] - c.rect[1] < 32) continue;
        const obstruction = obstacleRects.some(r => r[1] < c.rect[3] && r[3] > c.rect[1]
          && (r[0] >= x2 || r[2] <= x1));
        if (!obstruction) { c.rect[0] = left; c.rect[2] = right; }
      }
    }
    return candidates.filter(candidate => candidate.rect[2] - candidate.rect[0] >= 40 && candidate.rect[3] - candidate.rect[1] >= 32);
  },

  captionDirection(structure) {
    const entries = this.blocks(structure.content);
    const captions = entries.filter(item => item.block.type === 'caption' && /^\s*(?:fig(?:ure)?\.?\s*\d|图\s*\d)/i.test(this.text(item.block)));
    const votes = [];
    for (const { block } of entries.filter(item => item.block.type === 'image')) {
      for (const r of block.anchor?.pageRects || []) {
        if (!this.validRect(r)) continue;
        const neighbors = captions.flatMap(item => (item.block.anchor?.pageRects || []).filter(c => this.validRect(c)
          && c[0] === r[0] && Math.min(c[3], r[3]) - Math.max(c[1], r[1]) > Math.min(c[3] - c[1], r[3] - r[1]) * 0.5)
          .map(c => ({ gap: Math.max(0, c[2] - r[4], r[2] - c[4]), direction: r[4] <= c[2] + 3 ? 'below' : 'above' })));
        neighbors.sort((a, b) => a.gap - b.gap);
        if (neighbors[0]?.gap <= 36) votes.push(neighbors[0].direction);
      }
    }
    // Infer placement only from at least two already extracted image blocks.
    // This avoids choosing the previous figure for a caption printed above its
    // own figure when the previous region happens to have more dark pixels.
    return votes.length >= 2 && votes.every(vote => vote === votes[0]) ? votes[0] : null;
  },

  mapTrimToPDF(rect, trim, rotation = 0) {
    const w = rect[2] - rect[0], h = rect[3] - rect[1];
    const point = (x, y) => {
      switch (rotation) {
        case 90: return [rect[0] + y * w, rect[1] + x * h];
        case 180: return [rect[2] - x * w, rect[1] + y * h];
        case 270: return [rect[2] - y * w, rect[3] - x * h];
        default: return [rect[0] + x * w, rect[3] - y * h];
      }
    };
    const points = [point(trim[0], trim[1]), point(trim[2], trim[3])];
    return [Math.min(points[0][0], points[1][0]), Math.min(points[0][1], points[1][1]),
      Math.max(points[0][0], points[1][0]), Math.max(points[0][1], points[1][1])];
  },

  async renderRegions(state, pageIndex, rects) {
    if (state.disposed) throw new Error('Reading view closed');
    const renderer = state.base?._pdfRenderer;
    if (typeof renderer?.renderRegionCrops !== 'function') {
      throw new Error('当前阅读器不提供区域渲染接口');
    }
    // Keep page objects and render options inside Reader's own realm. Passing
    // privileged objects through PDF.js hits Gecko's security wrappers.
    const win = state.base._iframeWindow;
    return renderer.renderRegionCrops(pageIndex, this.toView(rects, win));
  },

  toView(value, win) {
    if (typeof Cu !== 'undefined' && typeof Cu.cloneInto === 'function') return Cu.cloneInto(value, win);
    return win?.JSON ? win.JSON.parse(JSON.stringify(value)) : value;
  },

  captionNumber(block) {
    return this.text(block).match(/^\s*(?:fig(?:ure)?\.?\s*|图\s*)(\d+)/i)?.[1];
  },

  figureSequenceImages(caption, entries) {
    if (!caption || caption.block?.type !== 'caption') return [];
    const index = entries.findIndex(item => item.block === caption.block);
    const number = this.captionNumber(caption.block);
    if (index < 0 || !number) return [];
    const numbered = entries.map((item, i) => ({ item, i, number: item.block.type === 'caption' ? this.captionNumber(item.block) : null }))
      .filter(value => value.number && value.number !== number);
    const previous = numbered.filter(value => value.i < index).at(-1)?.i ?? -1;
    const next = numbered.find(value => value.i > index)?.i ?? entries.length;
    const pages = (caption.block.anchor?.pageRects || []).filter(rect => this.validRect(rect)).map(rect => rect[0]);
    if (!pages.length) return [];
    const minPage = Math.max(0, Math.min(...pages) - 1), maxPage = Math.max(...pages) + 1;
    const candidates = entries.slice(previous + 1, next).filter(item => item.block.type === 'image'
      && item.block.flowClass !== 'excluded'
      && (item.block.anchor?.pageRects || []).some(rect => this.validRect(rect) && rect[0] >= minPage && rect[0] <= maxPage));
    const before = candidates.filter(item => entries.findIndex(entry => entry.block === item.block) < index);
    const after = candidates.filter(item => entries.findIndex(entry => entry.block === item.block) > index);
    // Captions can occur above or below a multi-panel group. Select the side
    // with the stronger run; a tie is structurally ambiguous and is left alone.
    return before.length > after.length ? before : after.length > before.length ? after : [];
  },

  captionGroup(rect, entries, caption) {
    const number = caption && this.captionNumber(caption);
    const group = [{ block: caption, rect }];
    if (!number) return group;
    // Chinese/English captions can be two SDT blocks for the same figure.
    // Require the same number, page and nearby overlapping caption geometry.
    const candidates = entries.filter(({block}) => block.type === 'caption' && this.captionNumber(block) === number)
      .flatMap(item => (item.block.anchor?.pageRects || []).filter(r => this.validRect(r) && r[0] === rect[0])
        .map(r => ({...item, rect:r})));
    for (let changed = true; changed;) {
      changed = false;
      for (const item of candidates) {
        if (group.some(c => c.block === item.block && c.rect === item.rect)) continue;
        if (group.some(c => Math.max(0, c.rect[2] - item.rect[4], item.rect[2] - c.rect[4]) <= 24
          && Math.min(c.rect[3], item.rect[3]) - Math.max(c.rect[1], item.rect[1])
            > Math.min(c.rect[3] - c.rect[1], item.rect[3] - item.rect[1]) * 0.5)) {
          group.push(item); changed = true;
        }
      }
    }
    return group.map(c => ({...c, ref:entries.find(item => item.block === c.block)?.ref}))
      .sort((a,b) => entries.findIndex(item => item.block === a.block) - entries.findIndex(item => item.block === b.block));
  },

  isRunningMargin(block, excluded, pageIndex, pages) {
    const text = this.text(block).trim().replace(/\s+/g, ' ');
    if (/^\d+$/.test(text)) return true;
    if (!text) return false;
    // Excluded text also includes labels inside figures. A repeated string at
    // the same relative page height is evidence for a running header/footer.
    const current = this.cropBlockRects(block, pageIndex), page = pages[pageIndex]?.viewRect;
    if (!page) return false;
    return excluded.some(({block:other}) => other !== block && this.text(other).trim().replace(/\s+/g, ' ') === text
      && (other.anchor?.pageRects || []).some(r => {
        if (!this.validRect(r)) return false;
        const otherPage = pages[r[0]]?.viewRect;
        return r[0] !== pageIndex && otherPage && current.some(c =>
          Math.abs((c[1] - page[1]) / (page[3] - page[1]) - (r[2] - otherPage[1]) / (otherPage[3] - otherPage[1])) < 0.015);
      }));
  },

  containsRect(outer, inner) {
    if (outer[0] !== inner[0]) return false;
    const area = Math.max(0, Math.min(outer[3], inner[3]) - Math.max(outer[1], inner[1]))
      * Math.max(0, Math.min(outer[4], inner[4]) - Math.max(outer[2], inner[2]));
    return area >= (inner[3] - inner[1]) * (inner[4] - inner[2]) * 0.9;
  },

  nativeAssociations(rect, blocks, caption) {
    const captions = blocks.filter(item => item.block.type === 'caption' && this.captionNumber(item.block));
    const distance = (cap, image) => {
      if (cap[0] !== image[0]) return Infinity;
      const ox = Math.min(cap[3], image[3]) - Math.max(cap[1], image[1]);
      const oy = Math.min(cap[4], image[4]) - Math.max(cap[2], image[2]);
      const horizontal = ox > Math.min(cap[3] - cap[1], image[3] - image[1]) * 0.5;
      const vertical = oy > Math.min(cap[4] - cap[2], image[4] - image[2]) * 0.25;
      if (!horizontal && !vertical) return Infinity;
      const gx = Math.max(0, image[1] - cap[3], cap[1] - image[3]);
      const gy = Math.max(0, image[2] - cap[4], cap[2] - image[4]);
      // There must be a clear geometric corridor between the two objects.
      const corridor = horizontal
        ? [Math.max(cap[1], image[1]), Math.min(cap[4], image[4]), Math.min(cap[3], image[3]), Math.max(cap[2], image[2])]
        : [Math.min(cap[3], image[3]), Math.max(cap[2], image[2]), Math.max(cap[1], image[1]), Math.min(cap[4], image[4])];
      if (blocks.some(({block}) => this.isProse(block) && this.cropBlockRects(block, rect[0]).some(r =>
        Math.min(r[2], corridor[2]) > Math.max(r[0], corridor[0]) + 2
        && Math.min(r[3], corridor[3]) > Math.max(r[1], corridor[1]) + 2))) return Infinity;
      return horizontal ? gy / Math.max(1, image[4] - image[2]) : gx / Math.max(1, image[3] - image[1]);
    };
    const matches = [];
    for (const item of blocks) {
      if (!['image', 'table', 'math'].includes(item.block.type)) continue;
      for (const image of item.block.anchor?.pageRects || []) {
        if (!this.validRect(image) || image[0] !== rect[0]) continue;
        if (this.containsRect(image, rect)) { matches.push({...item, rect:image, score:-1}); continue; }
        if (item.block.type !== 'image') continue;
        const score = distance(rect, image);
        const beside = Math.min(rect[4],image[4]) - Math.max(rect[2],image[2]) > Math.min(rect[4]-rect[2],image[4]-image[2]) * 0.25;
        if (score > (beside ? 2 : 1) || !Number.isFinite(score)) continue;
        const competitors = captions.filter(c => c.block !== caption && this.captionNumber(c.block) !== this.captionNumber(caption || {}));
        if (competitors.some(c => (c.block.anchor?.pageRects || []).some(r => this.validRect(r) && distance(r,image) + 0.02 < score))) continue;
        matches.push({...item, rect:image, score});
      }
    }
    return matches.sort((a,b)=>a.score-b.score);
  },

  nativeAssociation(rect, blocks, caption) {
    return this.nativeAssociations(rect,blocks,caption)[0] || null;
  },

  addNativeGroup(state, originals, crops) {
    const group = {originals:originals.map(element=>({element,hidden:element.hidden})),active:false,previews:[]};
    state.nativeGroups.push(group);
    for (const crop of crops) {
      state.cropOverrides.set(crop.ref.join('.')+':'+crop.page,[crop.candidate]);
      this.addPreview(state,crop.anchor,crop.page,crop.ref,{nativeGroup:group,after:crop.after});
    }
    return group;
  },

  normalizeNative(state, entries) {
    const {doc} = state;
    const captions = entries.filter(item => item.block.type === 'caption');
    const seen = new Set();
    // A column-sized crop may have been labelled as one table even though it
    // contains a sequence of side-caption figures and tables. Plan the ENTIRE
    // sequence before replacing it; never salvage only the first photograph.
    for (const native of entries.filter(e=>e.block.type==='table')) {
      const element=doc.querySelector(`[data-ref-path="${native.ref.join('.')}"]`);
      if (!element?.matches('figure.sdt-source-crop')) continue;
      for (const n of native.block.anchor?.pageRects || []) {
        if (!this.validRect(n)) continue;
        const headers=captions.flatMap(c=>(c.block.anchor?.pageRects||[]).filter(r=>this.validRect(r)&&r[0]===n[0])
          .map(r=>({...c,rect:r}))).filter(c=>
            (this.captionNumber(c.block)||/^\s*(?:table\s*\d|表\s*\d)/i.test(this.text(c.block)))
            && c.rect[4]<=n[4]+3 && c.rect[4]>n[2]+24
            && c.rect[3]<=n[1]+3 && n[1]-c.rect[3]<100);
        if (headers.length<2 || !headers.some(c=>this.captionNumber(c.block))
          || !headers.some(c=>/^\s*(?:table\s*\d|表\s*\d)/i.test(this.text(c.block)))) continue;
        headers.sort((a,b)=>b.rect[4]-a.rect[4]);
        const crops=headers.map((c,i)=>({anchor:doc.querySelector(`[data-ref-path="${c.ref.join('.')}"]`),ref:c.ref,page:n[0],
          after:!this.captionNumber(c.block),candidate:{direction:'right',rect:[n[1],
            i+1<headers.length?headers[i+1].rect[4]+3:n[2],n[3],Math.min(n[4],c.rect[4]+12)]}}));
        if(crops.some(c=>!c.anchor||c.candidate.rect[3]-c.candidate.rect[1]<32)) continue;
        this.addNativeGroup(state,[element],crops);seen.add(native.ref.join('.'));
      }
    }
    for (const item of captions.filter(item => this.captionNumber(item.block))) {
      const anchor = doc.querySelector(`[data-ref-path="${item.ref.join('.')}"]`);
      if (!anchor) continue;
      for (const rect of item.block.anchor?.pageRects || []) {
        if (!this.validRect(rect)) continue;
        if (state.cropOverrides.has(item.ref.join('.')+':'+rect[0])) continue;
        const native = this.nativeAssociation(rect, entries, item.block);
        if (!native || seen.has(native.ref.join('.'))) continue;
        const element = doc.querySelector(`[data-ref-path="${native.ref.join('.')}"]`);
        if (!element || element === anchor) continue;
        const containedFigures = captions.filter(c => this.captionNumber(c.block)
          && (c.block.anchor?.pageRects || []).some(r => this.validRect(r) && this.containsRect(native.rect,r)));
        // A page-sized composite can contain several distinct figures. Do not
        // hide it in exchange for just one of them without a complete split.
        if (['image','math'].includes(native.block.type) && containedFigures.length > 1) continue;
        const matches = this.nativeAssociations(rect,entries,item.block).filter(m=>m.block.type==='image');
        const side = native.block.type === 'image' && (native.rect[1] >= rect[3] || native.rect[3] <= rect[1]);
        if (native.block.type === 'image' && !side && !this.containsRect(native.rect,rect)
          && Math.max(0,native.rect[2]-rect[4],rect[2]-native.rect[4]) <= 48) {
          const marker = doc.createComment('reading-bilingual native position');
          element.before(marker); state.nativeMoves.push({element, marker});
          anchor.before(element); seen.add(native.ref.join('.'));
          continue;
        }
        if (native.block.type === 'image' || native.block.type === 'math') {
          const related = native.block.type === 'image' ? matches : [native];
          const ignored = new Set(related.map(m=>m.block));
          const candidates = this.getCropCandidates(state.structure,item.ref,rect[0],ignored);
          let candidate = candidates.find(c=>['left','right'].includes(c.direction))
            || candidates.find(c=>c.direction===state.direction) || candidates[0];
          if (!candidate) continue;
          const originals = related.map(m=>doc.querySelector(`[data-ref-path="${m.ref.join('.')}"]`)).filter(Boolean);
          const crops = [];
          if (native.block.type === 'math') {
            const glyphs = this.cropBlockRects(native.block,rect[0]);
            if (glyphs.length !== 1 || glyphs[0][3]-glyphs[0][1] >= native.rect[4]-native.rect[2]-20) continue;
            // Preserve the formula while separating the figure incorrectly
            // included in its source crop. Never discard formula pixels.
            candidate={...candidate,rect:[...candidate.rect]};
            candidate.rect[1]=Math.max(candidate.rect[1],native.rect[2]);
            crops.push({anchor:element,ref:native.ref,page:rect[0],candidate:{direction:'above',rect:glyphs[0]}});
          }
          crops.push({anchor,ref:item.ref,page:rect[0],candidate});
          this.addNativeGroup(state,originals,crops);
          for(const m of related) seen.add(m.ref.join('.'));
          continue;
        }
        // Some extracted table crops contain a photograph and both captions.
        // Split only an unambiguous one-figure/one-table composite. Keep the
        // original visible until BOTH replacement crops have decoded.
        if (!element.matches('figure.sdt-source-crop') || !['table','math'].includes(native.block.type)) continue;
        const embedded = captions.filter(c => (c.block.anchor?.pageRects || []).some(r => this.validRect(r) && this.containsRect(native.rect,r)));
        const figures = embedded.filter(c=>this.captionNumber(c.block));
        const tables = embedded.filter(c=>/^\s*(?:table\s*\d|表\s*\d)/i.test(this.text(c.block)));
        if (figures.length !== 1 || tables.length !== 1) continue;
        const table = tables[0], tr = table.block.anchor.pageRects.find(r=>r[0]===rect[0]);
        const tableAnchor = doc.querySelector(`[data-ref-path="${table.ref.join('.')}"]`);
        const n = native.rect;
        if (!tr || !tableAnchor || tr[4] >= rect[2] || rect[3] - n[1] > (n[3]-n[1]) * 0.4) continue;
        const photo = [rect[3]+3,tr[4]+3,n[3],n[4]];
        const body = [n[1],n[2],n[3],tr[2]-3];
        if ([photo,body].some(r=>r[2]-r[0]<40||r[3]-r[1]<32)) continue;
        this.addNativeGroup(state,[element],[
          {anchor,ref:item.ref,page:rect[0],candidate:{direction:'right',rect:photo}},
          {anchor:tableAnchor,ref:table.ref,page:rect[0],candidate:{direction:'below',rect:body},after:true},
        ]);
        seen.add(native.ref.join('.'));
      }
    }
  },

  hasGraphic(rect, blocks, caption) {
    if (this.nativeAssociation(rect, blocks, caption)) return true;
    // Some SDT versions split one numbered figure into image nodes on adjacent
    // pages. The numbered-caption-bounded source sequence is stronger evidence
    // than same-page geometry; count it as an existing figure to avoid adding a
    // duplicate crop above its shared caption.
    const sequence = caption ? this.figureSequenceImages({ block: caption }, blocks) : [];
    const sequencePages = new Set(sequence.flatMap(item => (item.block.anchor?.pageRects || []).filter(r => this.validRect(r)).map(r => r[0])));
    if (sequence.length > 1 && sequencePages.size > 1 && sequence.some(item =>
      (item.block.anchor?.pageRects || []).some(r => this.validRect(r) && Math.abs(r[0] - rect[0]) === 1))) return true;
    // Treat adjacent image/table blocks as represented even when their lazy
    // crops haven't loaded yet. This fallback addresses absent blocks only.
    const overlap = (a, b) => Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > Math.min(a[3] - a[1], b[3] - b[1]) * 0.5;
    const gap = (a, b) => Math.max(0, a[2] - b[4], b[2] - a[4]);
    const number = caption ? this.captionNumber(caption) : null;
    const captions = number ? blocks.filter(({ block }) => block.type === 'caption' && this.captionNumber(block))
      .flatMap(({ block }) => (block.anchor?.pageRects || []).filter(r => this.validRect(r) && r[0] === rect[0])
        .map(r => ({ rect: r, number: this.captionNumber(block) }))) : [];
    const group = this.captionGroup(rect, blocks, caption).map(c => c.rect);
    return blocks.some(({ block }) => ['image', 'table'].includes(block.type)
      && (block.anchor?.pageRects || []).some(other => {
        if (!this.validRect(other) || other[0] !== rect[0]) return false;
        const distance = Math.min(...group.filter(r => overlap(r, other)).map(r => gap(r, other)));
        if (distance <= 36) return true;
        // Permit a modest larger caption gap only when no other figure caption
        // is closer to this native image. Do not steal the preceding figure.
        return distance <= 48 && !!number
          && captions.filter(c => overlap(c.rect, other)).every(c => gap(c.rect, other) >= distance - 1);
      }));
  },

  ensure(reader) {
    const mode = this.getMode();
    if (mode === 'off') { this.shutdown(); return; }
    const internal = reader?._internalReader || reader;
    const sourceStructure = internal?._sdt?.structure;
    if (sourceStructure?.metadata?.processor?.type !== 'pdf') return;
    for (const primary of [true, false]) {
      const view = primary ? internal._primarySDTView : internal._secondarySDTView;
      const base = primary ? internal._primaryView : internal._secondaryView;
      let doc;
      try {
        doc = view?._iframeDocument;
        if (!doc?.querySelector('#sdt-content') || !base) continue;
      } catch (e) { continue; }
      if (this.states.has(doc)) {
        this.updateMode(this.states.get(doc), mode);
        continue;
      }
      // The SDT iframe may still be populating. Retry on the next sweep.
      if (!doc.querySelector('[data-ref-path]')) continue;
      // SDT arrays belong to Reader's content principal. Chaining their array
      // methods can put privileged intermediate objects into content arrays;
      // Gecko then rejects passing those objects back into our callbacks.
      // Snapshot once per view so all planning runs in the plugin's own realm.
      const structure = JSON.parse(JSON.stringify(sourceStructure));
      const entries = this.blocks(structure.content);
      const state = { id: ++this.viewSequence, reader, doc, base, structure, direction: this.captionDirection(structure), disposed: false, regions: new Map(),
        previews: new Map(), cropOverrides:new Map(), nativeMoves:[], nativeGroups:[], mode: null, queue: Promise.resolve(), observer: null };
      state.checkVisibility = () => { state.lastInput = Date.now(); this.scheduleVisibility(state); };
      this.states.set(doc, state);
      this.normalizeNative(state, entries);
      for (const { block, ref } of entries) {
        if (block.type !== 'caption') continue;
        if (!this.captionNumber(block)) continue;
        const anchor = doc.querySelector(`[data-ref-path="${ref.join('.')}"]`);
        if (!anchor) continue;
        for (const rect of block.anchor?.pageRects || []) {
          if (!this.validRect(rect) || this.hasGraphic(rect, entries, block)) continue;
          if (state.cropOverrides.has(ref.join('.')+':'+rect[0])) continue;
          if (this.captionGroup(rect, entries, block)[0].block !== block) continue;
          this.addPreview(state, anchor, rect[0], ref);
        }
      }
      this.updateMode(state, mode);
    }
  },

  addPreview(state, anchor, pageIndex, ref, options = {}) {
    const doc = state.doc;
    const figure = doc.createElement('figure');
    figure.className = 'zrb-pdf-figure-fallback';
    figure.dataset.pageIndex = String(pageIndex);
    figure.dataset.sourceRef = ref.join('.');
    if (options.nativeGroup) figure.dataset.nativeReplacement = 'true';
    figure.dataset.state = 'idle';
    figure.style.cssText = 'margin:16px 0;padding:8px;border:1px solid #8886;border-radius:4px;break-inside:avoid;background:Canvas;color:CanvasText';
    const label = doc.createElement('div');
    label.textContent = `${options.nativeGroup ? '原图' : '原图补充'} · PDF 第 ${pageIndex + 1} 页`;
    label.style.cssText = 'font:13px sans-serif;margin-bottom:6px';
    const edit = doc.createElement('button');
    edit.type = 'button'; edit.className = 'zrb-figure-edit-inline'; edit.textContent = '裁剪／修正';
    edit.title = '从原 PDF 重新选择该图片区域';
    edit.style.cssText = 'font:inherit;margin-inline-start:10px;padding:2px 7px;cursor:pointer';
    edit.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      if (typeof ZRBManualFigures !== 'undefined') ZRBManualFigures.openForElement(figure);
    });
    label.append(edit);
    const button = doc.createElement('button');
    button.type = 'button';
    button.textContent = '载入图形';
    const image = doc.createElement('img');
    image.alt = `PDF 第 ${pageIndex + 1} 页图形`;
    image.hidden = true;
    const imageBox = doc.createElement('div');
    imageBox.style.cssText = 'position:relative;max-width:100%;margin:8px auto 0';
    imageBox.hidden = true;
    image.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain';
    imageBox.append(image);
    const error = doc.createElement('div');
    error.style.cssText = 'font:12px sans-serif;overflow-wrap:anywhere;margin-top:6px';
    error.setAttribute('role', 'status');
    error.hidden = true;
    figure.append(label, button, error, imageBox);
    if (options.after) {
      const next = anchor.nextElementSibling;
      (next?.classList.contains('zotero-bilingual-card') ? next : anchor).after(figure);
    } else anchor.before(figure);
    if (options.nativeGroup) figure.hidden = true;
    const load = async (reason = 'manual') => {
      if (!this.isLive(state) || button.disabled || figure.dataset.state === 'loaded' || (reason === 'auto' && state.mode !== 'auto')) return;
      if (figure.hasAttribute('data-zrb-manual-hidden')) return;
      if (reason !== 'manual' && Date.now() - (state.lastInput || 0) < this.SCROLL_IDLE_MS) { this.scheduleVisibility(state); return; }
      button.disabled = true;
      figure.dataset.state = 'loading';
      button.textContent = '正在提取图形…';
      error.hidden = true;
      try {
        const key = ref.join('.') + ':' + pageIndex;
        if (!state.regions.has(key)) {
          const task = state.queue.then(() => {
            if (!this.isLive(state) || (reason === 'auto' && state.mode !== 'auto')) return null;
            if (reason === 'auto') {
              const box = figure.getBoundingClientRect();
              const height = state.doc.documentElement.clientHeight || state.doc.defaultView?.innerHeight || 0;
              const margin = this.prefetchMargin(state);
              if (box.top > height + margin || box.bottom < -margin) return null;
            }
            return this.getFigure(state, pageIndex, ref, reason);
          });
          state.queue = task.then(() => undefined, () => undefined);
          state.regions.set(key, task);
          task.catch(() => state.regions.delete(key));
        }
        const result = await state.regions.get(key);
        if (!this.isLive(state) || !figure.isConnected) return;
        if (!result) {
          state.regions.delete(key);
          figure.dataset.state = 'idle';
          button.textContent = '载入图形';
          return;
        }
        try { await this.loadImage(image, result.src); }
        catch (e) { if (result.cacheKey) await this.getCache()?.invalidate(result.cacheKey); throw e; }
        if (!this.isLive(state) || !figure.isConnected) return;
        figure.dataset.cropRect = JSON.stringify(result.rect);
        figure.dataset.cropDirection = result.direction;
        // Native Reader renders at a high resolution; display at a readable
        // size without upscaling small raster figures to the full text width.
        imageBox.style.width = Math.round(result.displayWidth) + 'px';
        const width = result.width || image.naturalWidth || result.displayWidth;
        const height = result.height || image.naturalHeight || width;
        imageBox.style.aspectRatio = width + ' / ' + height;
        imageBox.hidden = false;
        image.hidden = false;
        figure.dataset.state = 'loaded';
        button.hidden = true;
        const preview = state.previews.get(this.previewKey(figure));
        preview.loadedBefore = true;
        preview.used = Date.now();
        preview.bytes = result.src.length * 2 + width * height * 4;
        if (options.nativeGroup) {
          const group = options.nativeGroup;
          if (group.previews.every(p=>p.figure.dataset.state === 'loaded')) {
            for (const original of group.originals) original.element.hidden = true;
            group.active = true;
            for (const p of group.previews) p.figure.hidden = false;
          }
        }
        this.enforceMemory();
      } catch (e) {
        if (!this.isLive(state)) return;
        figure.dataset.state = 'error';
        button.hidden = false;
        button.textContent = '图形载入失败，点击重试';
        error.textContent = String(e.message || e).slice(0, 240);
        error.hidden = false;
        if (typeof Zotero !== 'undefined') Zotero.logError(new Error('[ReadingBilingual figure ' + ref.join('.') + '] '
          + String(e.message || e) + '\n' + String(e.stack || '')));
      } finally {
        state.regions.delete(ref.join('.') + ':' + pageIndex);
        if (this.isLive(state)) button.disabled = false;
      }
    };
    button.addEventListener('click', () => load());
    const preview = { figure, image, load, anchor, nativeGroup:options.nativeGroup, loadedBefore: false, bytes: 0, used: 0 };
    state.previews.set(this.previewKey(figure), preview);
    if (options.nativeGroup) options.nativeGroup.previews.push(preview);
  },

  loadImage(image, src) {
    return new Promise((resolve, reject) => {
      const loaded = () => { cleanup(); image.naturalWidth ? resolve() : reject(new Error('图形解码失败')); };
      const failed = () => { cleanup(); reject(new Error('图形解码失败')); };
      const cleanup = () => { image.removeEventListener('load', loaded); image.removeEventListener('error', failed); };
      image.addEventListener('load', loaded);
      image.addEventListener('error', failed);
      image.src = src;
      if (image.complete) loaded();
    });
  },

  encodePNG(canvas, doc) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => {
        if (!blob) { reject(new Error('图形编码失败')); return; }
        try {
          const reader = new doc.defaultView.FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reader.onabort = () => reject(new Error('图形编码读取失败'));
          reader.readAsDataURL(blob);
        } catch (e) { reject(e); }
      }, 'image/png');
    });
  },

  async trimImage(state, src, candidate, pageIndex) {
    if (state.disposed || !src) return null;
    const image = state.doc.createElement('img');
    await this.loadImage(image, src);
    if (state.disposed) return null;
    const canvas = state.doc.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    let cropped;
    try {
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      const width = canvas.width, height = canvas.height;
      const data = ctx.getImageData(0, 0, width, height).data;
      let x1 = width, y1 = height, x2 = 0, y2 = 0, ink = 0;
      // Scanning/encoding a whole high-resolution crop synchronously blocks
      // wheel input. Scan small bands and give the UI a turn between slices.
      // Read pixels once: repeated canvas readbacks are expensive in Firefox.
      const rows = Math.max(1, Math.floor(131072 / width));
      const defer = typeof setTimeout === 'function' ? setTimeout : state.doc.defaultView.setTimeout.bind(state.doc.defaultView);
      let sliceStart = Date.now();
      for (let top = 0; top < height; top += rows) {
        if (state.disposed) return null;
        const count = Math.min(rows, height - top);
        for (let row = 0; row < count; row++) {
          const y = top + row;
          for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            if (data[i + 3] > 100 && Math.min(data[i], data[i + 1], data[i + 2]) < 225) {
              ink++; x1 = Math.min(x1, x); x2 = Math.max(x2, x + 1); y1 = Math.min(y1, y); y2 = Math.max(y2, y + 1);
            }
          }
        }
        if (top + count < height && Date.now() - sliceStart >= 6) {
          await new Promise(resolve => defer(resolve, 0));
          await this.waitForScrollIdle(state);
          sliceStart = Date.now();
        }
      }
      const cw = candidate.rect[2] - candidate.rect[0], ch = candidate.rect[3] - candidate.rect[1];
      const rotation = state.structure.catalog.pages[pageIndex].rotation || 0;
      const turned = rotation === 90 || rotation === 270;
      const scaleX = width / (turned ? ch : cw), scaleY = height / (turned ? cw : ch);
      // Blank margins, a page number, or a tiny fragment cannot qualify as a figure.
      if (ink < width * height * 0.001 || (x2 - x1) / scaleX < 40 || (y2 - y1) / scaleY < 25) return null;
      const padding = Math.max(2, Math.ceil(Math.min(scaleX, scaleY) * 2));
      x1 = Math.max(0, x1 - padding); y1 = Math.max(0, y1 - padding);
      x2 = Math.min(width, x2 + padding); y2 = Math.min(height, y2 + padding);
      cropped = state.doc.createElement('canvas');
      cropped.width = x2 - x1; cropped.height = y2 - y1;
      cropped.getContext('2d').drawImage(canvas, x1, y1, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);
      const png = await this.encodePNG(cropped, state.doc);
      if (state.disposed) return null;
      return { src: png, width: cropped.width, height: cropped.height, direction: candidate.direction,
        rect: this.mapTrimToPDF(candidate.rect, [x1 / width, y1 / height, x2 / width, y2 / height], rotation),
        displayWidth: Math.min(800, (x2 - x1) / scaleX * 2), score: ink / (scaleX * scaleY) };
    } finally {
      canvas.width = canvas.height = 0;
      if (cropped) cropped.width = cropped.height = 0;
    }
  },

  async renderFigure(state, pageIndex, ref, preparedCandidates = null) {
    let stage = '定位图形区域';
    try {
      if (state.disposed) throw new Error('Reading view closed');
      const candidates = preparedCandidates || this.getCropCandidates(state.structure, ref, pageIndex);
      if (!candidates.length) throw new Error('未找到可靠的图形空白区域，请在原 PDF 中查看');
      stage = '渲染图形区域';
      const images = await this.renderRegions(state, pageIndex, candidates.map(candidate => candidate.rect));
      stage = '裁剪图形边缘';
      const results = [];
      for (const [i, candidate] of candidates.entries()) {
        const result = await this.trimImage(state, images?.[i], candidate, pageIndex);
        if (result) results.push(result);
      }
      results.sort((a, b) => b.score - a.score);
      if (!results.length) throw new Error('区域内没有足够的图形内容，请在原 PDF 中查看');
      return results.find(result => ['left', 'right'].includes(result.direction))
        || results.find(result => result.direction === state.direction) || results[0];
    } catch (e) { throw new Error(stage + '：' + String(e.message || e)); }
  },

  sync(readers) {
    const live = new Set();
    for (const reader of readers) {
      this.ensure(reader);
      const internal = reader?._internalReader || reader;
      for (const view of [internal?._primarySDTView, internal?._secondarySDTView]) {
        try { if (view?._iframeDocument) live.add(view._iframeDocument); } catch (e) {}
      }
    }
    for (const [doc, state] of this.states) {
      if (!live.has(doc)) this.dispose(state);
    }
  },

  dispose(state) {
    state.disposed = true;
    try { state.observer?.disconnect(); } catch (e) {}
    if (state.visibilityTimer != null) {
      try {
        if (typeof clearTimeout === 'function') clearTimeout(state.visibilityTimer);
        else state.doc.defaultView.clearTimeout(state.visibilityTimer);
      } catch (e) {}
      state.visibilityTimer = null;
    }
    try {
      for (const group of state.nativeGroups || []) for (const original of group.originals) original.element.hidden = original.hidden;
      for (const move of state.nativeMoves || []) { move.marker.before(move.element); move.marker.remove(); }
      state.doc.removeEventListener('scroll', state.checkVisibility, true);
      state.doc.removeEventListener('wheel', state.checkVisibility, true);
      state.doc.defaultView?.removeEventListener('resize', state.checkVisibility);
      state.doc.querySelectorAll('.zrb-pdf-figure-fallback').forEach(el => el.remove());
    } catch (e) {}
    state.regions.clear();
    state.previews.clear();
    this.states.delete(state.doc);
  },

  shutdown() {
    for (const state of this.states.values()) this.dispose(state);
    this.cache?.clearMemory();
  },
};
