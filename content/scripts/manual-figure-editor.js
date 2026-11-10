/* eslint-disable no-undef */

var ZRBManualFigureEditor = {
  normalizedRect(rect, bounds, rotation) {
    return ZRBManualFigures.normalizedRect(rect, bounds, rotation);
  },
  open(state, target) {
    state.editor?.close();
    const doc = state.doc, manager = ZRBManualFigures;
    const draft = JSON.parse(JSON.stringify(target));
    const initialRegion = draft.regions[0];
    // A native crop is a starting selection, not an implicitly confirmed part.
    if (!state.records.has(draft.id)) draft.regions = [];
    const ui = { state, draft, closed: false, selected: -1, selection: null, rotation: 0, zoom: 1, pageTicket: 0, revision: 0, previewRevision: -1 };
    state.editor = ui;
    const previousFocus = doc.activeElement;
    const root = doc.createElement('div'); root.className = 'zrb-manual-editor';
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', '裁剪／修正图片');
    root.innerHTML = `<style>
      .zrb-manual-editor{position:fixed;inset:10px;z-index:2147483100;display:flex;flex-direction:column;overscroll-behavior:contain;background:Canvas;color:CanvasText;border:1px solid #8888;border-radius:10px;box-shadow:0 10px 50px #0005;font:14px/1.5 system-ui,sans-serif;text-align:left}
      .zrb-manual-editor *{box-sizing:border-box;text-indent:0!important;letter-spacing:normal}
      .zrb-manual-editor button,.zrb-manual-editor select,.zrb-manual-editor input{font:inherit;max-width:100%;color:inherit}
      .zrb-manual-editor button{padding:5px 10px;cursor:pointer;border:1px solid #8887;border-radius:5px;background:Canvas;color:CanvasText}
      .zrb-manual-editor button:disabled{opacity:.5;cursor:default}.zrb-manual-editor button:focus-visible{outline:2px solid #6366f1}
      .zrb-manual-editor header,.zrb-manual-editor footer{padding:10px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      .zrb-manual-editor header{border-bottom:1px solid #8884}.zrb-manual-editor header strong{flex:1}
      .zrb-manual-editor footer{border-top:1px solid #8884;justify-content:flex-end}
      .zrb-manual-workspace{display:flex;min-height:0;flex:1;overscroll-behavior:contain}.zrb-manual-source{flex:1;min-width:200px;overflow:auto;overscroll-behavior:contain;background:#8882;padding:12px}
      .zrb-manual-main-preview{display:none;flex:1;min-width:0;overflow:auto;overscroll-behavior:contain;background:#8882;padding:18px;align-content:start;justify-items:center;gap:14px}
      .zrb-manual-main-preview img{display:block;max-width:100%;max-height:calc(100vh - 220px);height:auto;object-fit:contain;background:white;box-shadow:0 2px 8px #0002}
      .zrb-manual-editor[data-preview=true] .zrb-manual-source,.zrb-manual-editor[data-preview=true] .zrb-manual-sidebar{display:none}
      .zrb-manual-editor[data-preview=true] .zrb-manual-main-preview{display:grid}
      .zrb-manual-sidebar{width:290px;max-width:42%;overflow:auto;overscroll-behavior:contain;padding:12px;border-left:1px solid #8884}
      .zrb-manual-sidebar h3{font:bold 14px system-ui;margin:14px 0 8px}.zrb-manual-sidebar h3:first-child{margin-top:0}
      .zrb-crop-stage{position:relative;user-select:none;touch-action:none;margin:auto;background:white;box-shadow:0 2px 6px #0002;cursor:crosshair}
      .zrb-crop-stage>svg{display:block;width:100%;height:100%;pointer-events:none}
      .zrb-crop-selection{position:absolute;border:2px solid #4f46e5;background:#6366f120;cursor:move}
      .zrb-crop-selection span{position:absolute;width:12px;height:12px;background:white;border:2px solid #4f46e5}
      .zrb-crop-selection [data-corner=nw]{left:-7px;top:-7px;cursor:nwse-resize}.zrb-crop-selection [data-corner=ne]{right:-7px;top:-7px;cursor:nesw-resize}
      .zrb-crop-selection [data-corner=sw]{left:-7px;bottom:-7px;cursor:nesw-resize}.zrb-crop-selection [data-corner=se]{right:-7px;bottom:-7px;cursor:nwse-resize}
      .zrb-manual-help{font-size:12px;opacity:.8;padding:6px 14px;margin:0}.zrb-manual-status{flex:1;font-size:12px;overflow-wrap:anywhere}
      .zrb-manual-region{padding:7px;border:1px solid #8884;border-radius:5px;margin:6px 0;display:flex;gap:4px;flex-wrap:wrap;align-items:center}
      .zrb-manual-region[aria-current=true]{border-color:#6366f1}.zrb-manual-region>button:first-child{flex:1;text-align:left}
      .zrb-manual-region button{font-size:12px;padding:3px 6px}.zrb-manual-coordinates{display:grid;grid-template-columns:1fr 1fr;gap:6px}
      .zrb-manual-coordinates label{font-size:12px}.zrb-manual-coordinates input{display:block;width:100%;padding:3px}
      .zrb-manual-scope label{display:grid;grid-template-columns:18px 1fr 72px;gap:6px;font-size:12px;align-items:center;margin:6px 0;padding:5px;border:1px solid #8884;border-radius:5px;overflow-wrap:anywhere;cursor:pointer}
      .zrb-manual-scope label:has(input:checked){border-color:#4f46e5;background:#6366f114}
      .zrb-manual-scope img{max-width:72px;max-height:48px;object-fit:contain}
      .zrb-manual-preview img{display:block;max-width:100%;height:auto;margin:6px auto;border:1px solid #8883}
      .zrb-manual-editor .zrb-manual-primary{background:#4f46e5;color:white;border-color:#4f46e5}
      @media(max-width:650px){.zrb-manual-editor{inset:2px}.zrb-manual-sidebar{width:220px}.zrb-manual-editor header{gap:4px;padding:6px}.zrb-manual-editor button{padding:4px 6px}}
    </style>
    <header><strong>裁剪／修正图片</strong><button type="button" data-action="previous" aria-label="上一页">‹</button><label>原 PDF 第 <input data-field="page" aria-label="PDF 页码" type="number" min="1" style="width:60px"> / <span data-field="total"></span> 页</label><button type="button" data-action="next" aria-label="下一页">›</button><select data-field="zoom" aria-label="预览缩放"><option value="1">适合宽度</option><option value="1.25">125%</option><option value="1.5">150%</option><option value="2">200%</option></select><button type="button" data-action="rotate">旋转预览</button><button type="button" data-action="close" aria-label="关闭裁剪窗口">×</button></header>
    <p class="zrb-manual-help">在原页拖动框选；拖动选框可移动，拖动四角可调整。切换页码可继续添加其他页的区域。</p>
    <div class="zrb-manual-workspace"><div class="zrb-manual-source"><div class="zrb-crop-stage"><svg xmlns="http://www.w3.org/2000/svg"></svg><div class="zrb-crop-selection" hidden><span data-corner="nw"></span><span data-corner="ne"></span><span data-corner="sw"></span><span data-corner="se"></span></div></div></div><div class="zrb-manual-main-preview" role="region" aria-label="裁剪结果预览"></div>
    <aside class="zrb-manual-sidebar"><h3>选区</h3><div class="zrb-manual-coordinates"></div><p><button type="button" data-action="new">新建选区</button> <button type="button" data-action="add">添加当前选区</button></p><div class="zrb-manual-regions"></div><h3>插入位置</h3><select data-field="anchor" aria-label="图片插入位置" style="width:100%"></select><h3>确认替换范围</h3><p style="font-size:12px;margin:0">勾选要替换的原图碎片。未勾选的内容保留。</p><div class="zrb-manual-scope"></div><h3>结果预览</h3><div class="zrb-manual-preview">添加选区后点击“预览结果”。</div></aside></div>
    <footer><span class="zrb-manual-status" role="status" aria-live="polite"></span><button type="button" data-action="restore">恢复原显示</button><button type="button" data-action="cancel">取消</button><button type="button" data-action="preview">预览结果</button><button type="button" data-action="apply" class="zrb-manual-primary" disabled>应用修正</button></footer>`;
    doc.body.append(root); ui.root = root;
    const find = name => root.querySelector(`[data-field="${name}"]`);
    const action = name => root.querySelector(`[data-action="${name}"]`);
    const status = root.querySelector('[role=status]');
    const scopeKey = locator => JSON.stringify(locator);
    const stage = root.querySelector('.zrb-crop-stage'), selection = root.querySelector('.zrb-crop-selection');
    const svg = stage.querySelector('svg');
    const preview = root.querySelector('.zrb-manual-preview');
    const setStatus = message => { status.textContent = message; };
    const alive = () => !ui.closed && manager.live(state);
    const clearPreview = () => {
      preview.querySelectorAll('img').forEach(img => img.removeAttribute('src')); preview.replaceChildren();
      const main = root.querySelector('.zrb-manual-main-preview');
      main?.querySelectorAll('img').forEach(img => img.removeAttribute('src')); main?.replaceChildren();
    };
    const invalidate = () => {
      ui.revision++; action('apply').disabled = true; clearPreview();
      preview.textContent = '选区已改变，请重新预览。';
    };
    ui.close = () => {
      if (ui.closed) return;
      ui.closed = true; ui.pageTicket++;
      state.operations.delete(draft.id);
      clearPreview(); svg.replaceChildren(); root.remove();
      if (state.editor === ui) state.editor = null;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
    const coordinateInputs = [];
    for (const [i, label] of ['左', '下', '右', '上'].entries()) {
      const wrap = doc.createElement('label'); wrap.textContent = label;
      const input = doc.createElement('input'); input.type = 'number'; input.step = '0.1'; input.setAttribute('aria-label', '选区' + label + '边界');
      wrap.append(input); root.querySelector('.zrb-manual-coordinates').append(wrap); coordinateInputs.push(input);
      input.addEventListener('change', () => {
        const rect = coordinateInputs.map(input => Number(input.value));
        try { manager.validateRegions(state, [{ pageIndex: ui.pageIndex, rect }]); setSelection(rect); renderScope(); }
        catch (error) { setStatus(error.message); }
      });
    }
    const drawSelection = () => {
      selection.hidden = !ui.selection || !ui.page;
      coordinateInputs.forEach((input, i) => { input.value = ui.selection ? Number(ui.selection[i].toFixed(3)) : ''; });
      action('add').disabled = !ui.selection || ui.selected >= 0 || draft.regions.length >= manager.MAX_REGIONS;
      if (selection.hidden) return;
      const unit = this.normalizedRect(ui.selection, ui.page.bounds, (ui.page.rotation + ui.rotation) % 360);
      selection.style.left = unit[0] * 100 + '%'; selection.style.top = unit[1] * 100 + '%';
      selection.style.width = (unit[2] - unit[0]) * 100 + '%'; selection.style.height = (unit[3] - unit[1]) * 100 + '%';
    };
    const setSelection = rect => {
      if (ui.page) rect = rect.map((value, i) => Math.max(ui.page.bounds[i % 2], Math.min(ui.page.bounds[i % 2 + 2], value)));
      ui.selection = rect;
      if (ui.selected >= 0) draft.regions[ui.selected] = { pageIndex: ui.pageIndex, rect: rect.slice() };
      invalidate(); drawSelection(); renderRegions();
    };
    const layoutPage = () => {
      if (!ui.page) return;
      const bounds = ui.page.bounds;
      let w = bounds[2] - bounds[0], h = bounds[3] - bounds[1];
      if (ui.page.rotation % 180) [w, h] = [h, w];
      const turned = ui.rotation % 180;
      const vw = turned ? h : w, vh = turned ? w : h;
      stage.style.width = ui.zoom * 100 + '%'; stage.style.aspectRatio = `${vw}/${vh}`;
      svg.setAttribute('viewBox', `0 0 ${vw} ${vh}`); svg.replaceChildren();
      const image = doc.createElementNS('http://www.w3.org/2000/svg', 'image');
      image.setAttribute('href', ui.page.src); image.setAttribute('width', w); image.setAttribute('height', h);
      const transforms = { 90: `translate(${h} 0) rotate(90)`, 180: `translate(${w} ${h}) rotate(180)`, 270: `translate(0 ${w}) rotate(270)` };
      if (transforms[ui.rotation]) image.setAttribute('transform', transforms[ui.rotation]);
      svg.append(image); drawSelection();
    };
    const loadPage = async (pageIndex, selected = -1, initialSelection = null) => {
      if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= state.structure.catalog.pages.length) return;
      const ticket = ++ui.pageTicket;
      ui.pageIndex = pageIndex; ui.selected = selected;
      ui.selection = selected >= 0 ? draft.regions[selected].rect.slice() : initialSelection;
      ui.page = null; svg.replaceChildren(); selection.hidden = true;
      find('page').value = pageIndex + 1; setStatus('正在载入原 PDF 页面…');
      action('previous').disabled = pageIndex === 0; action('next').disabled = pageIndex === state.structure.catalog.pages.length - 1;
      try {
        const page = await manager.previewPage(state, pageIndex);
        if (!alive() || ticket !== ui.pageTicket) return;
        ui.page = page; layoutPage(); renderRegions(); renderScope(); setStatus('');
      } catch (error) { if (alive() && ticket === ui.pageTicket) setStatus(error.message); }
    };
    const renderRegions = () => {
      const list = root.querySelector('.zrb-manual-regions'); list.replaceChildren();
      draft.regions.forEach((region, i) => {
        const row = doc.createElement('div'); row.className = 'zrb-manual-region'; row.setAttribute('aria-current', String(ui.selected === i));
        const button = (text, label, fn) => { const b = doc.createElement('button'); b.type = 'button'; b.textContent = text; b.setAttribute('aria-label', label); b.addEventListener('click', fn); row.append(b); return b; };
        button(`${i + 1} · 第 ${region.pageIndex + 1} 页`, '调整选区 ' + (i + 1), () => loadPage(region.pageIndex, i));
        const move = direction => {
          const other = i + direction;
          if (other < 0 || other >= draft.regions.length) return;
          [draft.regions[i], draft.regions[other]] = [draft.regions[other], draft.regions[i]];
          if (ui.selected === i) ui.selected = other; else if (ui.selected === other) ui.selected = i;
          invalidate(); renderRegions();
        };
        button('↑', '上移选区 ' + (i + 1), () => move(-1)).disabled = i === 0;
        button('↓', '下移选区 ' + (i + 1), () => move(1)).disabled = i === draft.regions.length - 1;
        button('×', '移除选区 ' + (i + 1), () => {
          draft.regions.splice(i, 1); ui.selected = -1; ui.selection = null;
          const pages = new Set(draft.regions.map(region => region.pageIndex));
          draft.replacements = draft.replacements.filter(locator => {
            if (locator.kind !== 'native') return true;
            const rects = manager.entry(state, locator.ref)?.block.anchor?.pageRects || [];
            return !rects.length || rects.some(rect => pages.has(rect[0]));
          });
          invalidate(); renderRegions(); drawSelection(); renderScope();
        });
        list.append(row);
      });
    };
    const labelFor = locator => {
      const item = manager.entry(state, locator.ref)?.block;
      const page = locator.pageIndex ?? item?.anchor?.pageRects?.[0]?.[0];
      const label = locator.kind === 'fallback' ? '插件识别图' : locator.kind === 'label'
        ? '图内短标记（需确认）' : 'PDF 原生图形';
      return `${label} · 第 ${Number.isInteger(page) ? page + 1 : '?'} 页`;
    };
    const renderScope = () => {
      const list = root.querySelector('.zrb-manual-scope'); list.replaceChildren();
      draft.replacements = draft.replacements.filter(locator => locator.kind !== 'label' || manager.resolve(state, locator, draft.regions));
      const pages = new Set([ui.pageIndex, ...draft.regions.map(region => region.pageIndex)]);
      for (const locator of manager.candidates(state, draft.regions)) {
        const selected = draft.replacements.some(item => JSON.stringify(item) === JSON.stringify(locator));
        const rects = manager.entry(state, locator.ref)?.block.anchor?.pageRects || [];
        if (!selected && locator.pageIndex !== ui.pageIndex && !rects.some(rect => pages.has(rect[0]))) continue;
        const element = manager.resolve(state, locator, draft.regions);
        const label = doc.createElement('label'), input = doc.createElement('input'); input.type = 'checkbox';
        label.dataset.zrbLocator = JSON.stringify(locator);
        input.checked = selected; input.setAttribute('aria-label', '替换 ' + labelFor(locator));
        const owner = element?.dataset.zrbManualHidden || element?.dataset.zrbManualMasked;
        input.disabled = !!owner && owner !== draft.id;
        input.addEventListener('change', () => {
          draft.replacements = draft.replacements.filter(item => JSON.stringify(item) !== JSON.stringify(locator));
          draft.scopeExcluded ||= [];
          draft.scopeExcluded = draft.scopeExcluded.filter(key => key !== scopeKey(locator));
          if (input.checked) draft.replacements.push(locator); else draft.scopeExcluded.push(scopeKey(locator));
          invalidate();
        });
        label.append(input, doc.createTextNode(labelFor(locator)));
        const src = element?.matches('img') ? element.getAttribute('src') : element?.querySelector('img')?.getAttribute('src');
        if (src?.startsWith('data:image/')) { const image = doc.createElement('img'); image.src = src; image.alt = ''; label.append(image); }
        else {
          const svgPreview = element?.matches('svg') ? element : element?.querySelector('svg');
          if (svgPreview) { const svg = svgPreview.cloneNode(true); svg.setAttribute('aria-hidden', 'true'); label.append(svg); }
          else { const placeholder = doc.createElement('span'); placeholder.textContent = element ? '原 PDF 图形' : '待载入'; label.append(placeholder); }
        }
        list.append(label);
      }
      if (!list.childNodes.length) list.textContent = '此页没有可安全替换的原生图片碎片。正文、公式和表格保持原状。';
    };
    const anchors = [draft.anchor];
    const selectAnchor = find('anchor');
    const currentOption = doc.createElement('option'); currentOption.value = '0';
    currentOption.textContent = draft.anchor.kind === 'caption' ? '对应图注上方' : '保留原图所在位置'; selectAnchor.append(currentOption);
    for (const { block, ref } of state.entries) {
      if (block.type !== 'caption' || !ZRBPDFFigureFallback.captionNumber(block) || ref.join('.') === draft.anchor.ref) continue;
      const locator = { kind: 'caption', ref: ref.join('.'), signature: manager.signature(state, ref.join('.')) };
      const option = doc.createElement('option'); option.value = String(anchors.length);
      option.textContent = '图注上方：' + ZRBPDFFigureFallback.text(block).slice(0, 65);
      anchors.push(locator); selectAnchor.append(option);
    }
    selectAnchor.addEventListener('change', () => { draft.anchor = anchors[Number(selectAnchor.value)]; invalidate(); });
    let gesture = null;
    const point = event => {
      const rect = stage.getBoundingClientRect();
      return [Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))];
    };
    stage.addEventListener('pointerdown', event => {
      if (!ui.page || event.button !== 0 || ui.busy) return;
      event.preventDefault(); event.stopPropagation();
      const start = point(event);
      const corner = event.target.dataset?.corner;
      const unit = ui.selection ? this.normalizedRect(ui.selection, ui.page.bounds, (ui.page.rotation + ui.rotation) % 360) : [...start, ...start];
      const type = corner || (event.target.closest('.zrb-crop-selection') ? 'move' : 'draw');
      if (type === 'draw') { ui.selected = -1; ui.selection = null; }
      gesture = { start, unit, type };
      stage.setPointerCapture?.(event.pointerId);
    });
    stage.addEventListener('pointermove', event => {
      if (!gesture || !ui.page) return;
      event.preventDefault();
      const p = point(event), g = gesture; let unit;
      if (g.type === 'draw') unit = [Math.min(g.start[0], p[0]), Math.min(g.start[1], p[1]), Math.max(g.start[0], p[0]), Math.max(g.start[1], p[1])];
      else if (g.type === 'move') {
        const dx = Math.max(-g.unit[0], Math.min(1 - g.unit[2], p[0] - g.start[0]));
        const dy = Math.max(-g.unit[1], Math.min(1 - g.unit[3], p[1] - g.start[1]));
        unit = [g.unit[0] + dx, g.unit[1] + dy, g.unit[2] + dx, g.unit[3] + dy];
      } else {
        unit = g.unit.slice(); unit[g.type.includes('w') ? 0 : 2] = p[0]; unit[g.type.includes('n') ? 1 : 3] = p[1];
        unit = [Math.min(unit[0], unit[2]), Math.min(unit[1], unit[3]), Math.max(unit[0], unit[2]), Math.max(unit[1], unit[3])];
      }
      if (unit[2] - unit[0] < .001 || unit[3] - unit[1] < .001) return;
      setSelection(ZRBPDFFigureFallback.mapTrimToPDF(ui.page.bounds, unit, (ui.page.rotation + ui.rotation) % 360));
    });
    const finishGesture = event => { gesture = null; if (stage.hasPointerCapture?.(event.pointerId)) stage.releasePointerCapture(event.pointerId); renderScope(); };
    stage.addEventListener('pointerup', finishGesture); stage.addEventListener('pointercancel', finishGesture);
    const sourcePane = root.querySelector('.zrb-manual-source');
    root.addEventListener('wheel', event => {
      event.stopPropagation();
      if (event.ctrlKey) {
        event.preventDefault();
        if (!sourcePane.contains(event.target)) return;
        ui.zoom = Math.max(.5, Math.min(3, ui.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1)));
        const zoom = find('zoom'), value = String(Number(ui.zoom.toFixed(3)));
        let option = Array.from(zoom.options).find(item => item.value === value);
        if (!option) { option = doc.createElement('option'); option.value = value; option.textContent = Math.round(ui.zoom * 100) + '%'; zoom.append(option); }
        zoom.value = value; layoutPage(); return;
      }
      const pane = event.target?.closest?.('.zrb-manual-source,.zrb-manual-main-preview,.zrb-manual-sidebar');
      const canScroll = (position, size, total, delta) => !delta || (total > size
        && (delta < 0 ? position > 0 : position + size < total));
      if (!pane || !canScroll(pane.scrollTop, pane.clientHeight, pane.scrollHeight, event.deltaY)
        || !canScroll(pane.scrollLeft, pane.clientWidth, pane.scrollWidth, event.deltaX)) event.preventDefault();
    }, { capture: true, passive: false });
    root.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); ui.close(); }
      if (event.key !== 'Tab') return;
      const controls = Array.from(root.querySelectorAll('button,input,select')).filter(el => !el.disabled && !el.hidden);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    for (const name of ['close', 'cancel']) action(name).addEventListener('click', ui.close);
    action('previous').addEventListener('click', () => loadPage(ui.pageIndex - 1));
    action('next').addEventListener('click', () => loadPage(ui.pageIndex + 1));
    find('page').max = state.structure.catalog.pages.length; find('total').textContent = state.structure.catalog.pages.length;
    find('page').addEventListener('change', () => loadPage(Number(find('page').value) - 1));
    find('zoom').addEventListener('change', () => { ui.zoom = Number(find('zoom').value); layoutPage(); });
    action('rotate').addEventListener('click', () => { ui.rotation = (ui.rotation + 90) % 360; layoutPage(); });
    action('new').addEventListener('click', () => { ui.selected = -1; ui.selection = null; drawSelection(); renderRegions(); });
    action('add').addEventListener('click', () => {
      if (!ui.selection || ui.selected >= 0 || draft.regions.length >= manager.MAX_REGIONS) return;
      try {
        const region = { pageIndex: ui.pageIndex, rect: ui.selection.slice() }; manager.validateRegions(state, [region]);
        draft.regions.push(region); ui.selected = draft.regions.length - 1;
        const intersects = rect => {
          if (!ZRBPDFFigureFallback.validRect(rect) || rect[0] !== region.pageIndex) return false;
          const area = Math.max(0, Math.min(rect[3], region.rect[2]) - Math.max(rect[1], region.rect[0]))
            * Math.max(0, Math.min(rect[4], region.rect[3]) - Math.max(rect[2], region.rect[1]));
          const total = Math.max(1, (rect[3] - rect[1]) * (rect[4] - rect[2]));
          return area / total >= .65;
        };
        for (const locator of manager.candidates(state, draft.regions)) {
          const allowed = (draft.scopeCandidates || draft.replacements).some(item => item.kind === locator.kind
            && item.ref === locator.ref && item.pageIndex === locator.pageIndex && item.nodeIndex === locator.nodeIndex);
          if (!allowed || locator.kind !== 'native' || draft.replacements.some(item => item.kind === locator.kind
              && item.ref === locator.ref && item.nodeIndex === locator.nodeIndex) || draft.scopeExcluded?.includes(scopeKey(locator))) continue;
          const block = manager.entry(state, locator.ref)?.block;
          if ((block?.anchor?.pageRects || []).some(intersects))
            draft.replacements.push(locator);
        }
        invalidate(); drawSelection(); renderRegions(); renderScope();
      } catch (error) { setStatus(error.message); }
    });
    const busy = value => {
      ui.busy = value; root.setAttribute('aria-busy', String(value));
      for (const control of root.querySelectorAll('button,select,input')) {
        if (control.matches('[data-action=cancel],[data-action=close]')) continue;
        control.disabled = value;
      }
      if (!value) {
        action('apply').disabled = ui.previewRevision !== ui.revision;
        action('restore').disabled = !state.records.has(draft.id); drawSelection(); renderRegions(); renderScope();
      }
    };
    action('preview').addEventListener('click', async () => {
      if (root.dataset.preview === 'true') {
        root.dataset.preview = 'false'; action('preview').textContent = '预览结果'; return;
      }
      try {
        const regions = manager.validateRegions(state, draft.regions);
        ui.previewRevision = -1;
        busy(true); setStatus('正在从原 PDF 渲染选区…'); clearPreview();
        const prepared = await manager.prepareImages(state, regions, alive);
        if (!alive()) return;
        const mainPreview = root.querySelector('.zrb-manual-main-preview'); mainPreview.replaceChildren();
        for (const item of prepared.results) {
          const image = item.image.cloneNode(); image.src = item.image.src; image.alt = '修正结果预览';
          image.style.width = Math.min(1100, item.displayWidth) + 'px'; mainPreview.append(image);
        }
        root.dataset.preview = 'true'; action('preview').textContent = '返回编辑';
        ui.previewRevision = ui.revision; setStatus('请核对选区顺序和替换范围，再应用修正。');
      } catch (error) { if (alive()) setStatus(error.message); }
      finally { if (alive()) busy(false); }
    });
    action('apply').addEventListener('click', async () => {
      if (ui.previewRevision !== ui.revision) return;
      try {
        busy(true); clearPreview(); setStatus('正在保存图片修正…');
        await manager.apply(state, draft, { alive }); if (alive()) ui.close();
      } catch (error) { if (alive()) setStatus(error.message); }
      finally { if (alive()) busy(false); }
    });
    action('restore').disabled = !state.records.has(draft.id);
    action('restore').addEventListener('click', async () => {
      try { busy(true); await manager.restoreOriginal(state, draft.id); if (alive()) ui.close(); }
      catch (error) { if (alive()) { setStatus(error.message); busy(false); } }
    });
    renderRegions(); renderScope(); action('close').focus();
    const initial = draft.regions[0]?.pageIndex ?? initialRegion?.pageIndex ?? manager.entry(state, draft.anchor.ref)?.block.anchor?.pageRects?.[0]?.[0] ?? 0;
    loadPage(initial, draft.regions.length ? 0 : -1, !draft.regions.length ? initialRegion?.rect.slice() : null);
    return ui;
  },
};
