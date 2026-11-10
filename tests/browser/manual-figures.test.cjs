const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { firefox } = require('playwright');

let browser, server, url;
before(async () => {
  server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><head></head><body></body></html>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  browser = await firefox.launch({ headless: true });
});
after(async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)); });

async function fixture(t) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 950 } });
  t.after(() => page.close());
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.setContent('<style>body{font:20px Georgia;background:#dfe8c7}figure{margin:20px}#sdt-content{max-width:900px;margin:auto}.sdt-image{width:400px;height:160px;background:#acf}.sdt-image img{width:100%;height:100%}</style><article id="sdt-content"><p id="body">Body text <a id="link" href="#formula">unchanged link</a></p><figure class="sdt-image" id="native" data-ref-path="0"><img alt="native figure" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22400%22 height=%22160%22%3E%3Crect width=%22400%22 height=%22160%22 fill=%22skyblue%22/%3E%3C/svg%3E"></figure><figure class="sdt-image" id="orphan" data-ref-path="1"><svg width="300" height="130"><rect width="300" height="130" fill="#acf"/></svg></figure><figure class="zrb-pdf-figure-fallback" id="failed" data-source-ref="2" data-page-index="0" data-state="error"><img alt="plugin crop" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22100%22%3E%3Crect width=%22200%22 height=%22100%22 fill=%22pink%22/%3E%3C/svg%3E"></figure><figcaption data-ref-path="2">Figure 18: Ribs dimensions</figcaption><div class="zotero-bilingual-card" id="caption-translation">图 18 翼肋尺寸</div><p id="formula" class="sdt-math">x + y = z</p><table id="table"><tr><td>Table remains</td></tr></table></article>');
  await page.locator('#failed').evaluate(el => { const button=document.createElement('button');button.type='button';button.className='zrb-figure-edit-inline';button.textContent='裁剪／修正';el.append(button); });
  for (const file of ['figure-cache.js', 'pdf-figure-fallback.js', 'manual-figure-store.js', 'manual-figures.js', 'manual-figure-editor.js', 'reading-bilingual.js']) {
    await page.addScriptTag({ path: path.resolve(__dirname, '../../content/scripts', file) });
  }
  await page.locator('#failed .zrb-figure-edit-inline').evaluate(button => button.addEventListener('click', event => {
    event.preventDefault(); event.stopPropagation(); ZRBManualFigures.openForElement(button.closest('.zrb-pdf-figure-fallback'));
  }));
  await page.evaluate(async () => {
    const storage = new Map();
    window.Zotero = { debug() {}, logError() {}, Prefs: { get() {} } };
    ZRBManualFigures.store = ZRBManualFigureStore.create({ io: {
      join: key => key,
      async read(key) { if (!storage.has(key)) throw Object.assign(new Error('absent'), { name: 'NotFoundError' }); return storage.get(key); },
      async write(key, value) { storage.set(key, value); },
    } });
    window.PDFViewerApplication = { pdfDocument: { async getPage(number) { return { view: [0, 0, 600, 800], rotate: number === 2 ? 90 : 0 }; } } };
    window.renderCalls = [];
    const base = { _iframeWindow: window, _pdfRenderer: {
      async renderRegionCrops(pageIndex, rects) {
        if (window.renderFailure) throw new Error('测试渲染失败');
        renderCalls.push({ pageIndex, rects: JSON.parse(JSON.stringify(rects)) });
        return rects.map(rect => {
          let w = rect[2] - rect[0], h = rect[3] - rect[1]; if (pageIndex === 1) [w, h] = [h, w];
          const scale = Math.min(2, Math.sqrt(this._pdfView?._iframeWindow.PDFViewerApplication.pdfViewer.maxCanvasPixels / (w * h)) || 1);
          const canvas = document.createElement('canvas'); canvas.width = Math.ceil(w * scale); canvas.height = Math.ceil(h * scale);
          const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = pageIndex === 0 ? '#e0f2fe' : '#e0e7ff'; ctx.fillRect(5, 5, canvas.width - 10, canvas.height - 10);
          ctx.fillStyle = '#111'; ctx.font = '24px sans-serif'; ctx.fillText('Original PDF page ' + (pageIndex + 1), 20, 40);
          return canvas.toDataURL('image/png');
        });
      },
    } };
    window.structure = { metadata: { processor: { type: 'pdf' }, source: { hash: 'test-pdf' } }, catalog: { pages: [0, 1, 2].map(() => ({ viewRect: [0, 0, 600, 800] })) }, content: [
      { type: 'image', anchor: { pageRects: [[0, 30, 300, 300, 500]] } },
      { type: 'image', anchor: { pageRects: [[1, 30, 300, 300, 500]] } },
      { type: 'caption', anchor: { pageRects: [[0, 30, 270, 300, 290]] }, content: [{ text: 'Figure 18: Ribs dimensions' }] },
    ] };
    window.reader = { itemID: 7, _internalReader: { _sdt: { structure }, _primaryView: base, _primarySDTView: { _iframeDocument: document } } };
    window.originalMarkup = document.querySelector('#sdt-content').innerHTML;
    ZRBManualFigures.ensure(reader);
    await ZRBManualFigures.states.get(document).ready;
  });
  return { page, errors };
}

async function open(page, selector) {
  await page.locator(selector).click({ button: 'right' });
  await page.getByRole('button', { name: '裁剪／修正图片', exact: true }).click();
  await page.waitForFunction(() => !!ZRBManualFigures.states.get(document).editor?.page);
}
async function draw(page, a = [.02, .2], b = [.82, .68]) {
  const box = await page.locator('.zrb-crop-stage').boundingBox();
  await page.mouse.move(box.x + box.width * a[0], box.y + box.height * a[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * b[0], box.y + box.height * b[1], { steps: 8 });
  await page.mouse.up();
}

test('native orphan vector figures expose the same editor, support rotated zoomed input and cancel without mutation', async t => {
  const { page, errors } = await fixture(t);
  await page.dblclick('#native img');
  assert.equal(await page.getByRole('dialog', { name: '图片放大预览' }).count(), 1);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.zrb-image-lightbox').count(), 0);
  await page.dblclick('#orphan svg');
  assert.equal(await page.locator('.zrb-image-lightbox svg').count(), 1);
  await page.keyboard.press('Escape');
  await page.dblclick('#failed img');
  assert.equal(await page.locator('.zrb-image-lightbox img').count(), 1);
  await page.keyboard.press('Escape');
  await open(page, '#orphan');
  assert.equal(await page.getByLabel('图片插入位置').inputValue(), '0');
  await page.getByLabel('预览缩放').selectOption('1.25');
  await page.getByRole('button', { name: '旋转预览' }).click();
  await page.getByRole('button', { name: '新建选区' }).click();
  await draw(page, [.15, .12], [.65, .55]);
  const beforeArea = await page.evaluate(() => { const r = ZRBManualFigures.states.get(document).editor.selection; return (r[2] - r[0]) * (r[3] - r[1]); });
  const handle = page.locator('.zrb-crop-selection [data-corner=se]');
  await handle.scrollIntoViewIfNeeded();
  const corner = await handle.boundingBox();
  await page.mouse.move(corner.x + 6, corner.y + 6); await page.mouse.down();
  await page.mouse.move(corner.x - 20, corner.y - 15, { steps: 5 }); await page.mouse.up();
  const afterArea = await page.evaluate(() => { const r = ZRBManualFigures.states.get(document).editor.selection; return (r[2] - r[0]) * (r[3] - r[1]); });
  assert.ok(afterArea < beforeArea, 'a real pointer resize changes the PDF-coordinate rectangle');
  await page.getByRole('button', { name: '添加当前选区' }).click();
  if (process.env.ZRB_MANUAL_UI_OUTPUT) await page.screenshot({ path: path.join(process.env.ZRB_MANUAL_UI_OUTPUT, 'manual-editor.png') });
  const region = await page.evaluate(() => ZRBManualFigures.states.get(document).editor.draft.regions[0]);
  assert.equal(region.pageIndex, 1);
  assert.ok(region.rect[0] < region.rect[2] && region.rect[1] < region.rect[3]);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.locator('.zrb-manual-editor,.zrb-manual-figure,[data-zrb-manual-hidden]').count(), 0);
  assert.equal(await page.locator('#orphan').isVisible(), true);
  assert.deepEqual(errors, []);
});

test('hover crop control remains reachable from a graphic whose visual content is narrower than its host', async t => {
  const { page } = await fixture(t);
  await page.locator('#native').evaluate(el => { el.style.width = '560px'; el.querySelector('img').style.width = '400px'; });
  await page.locator('#native img').hover();
  const button = page.locator('.zrb-figure-edit-control');
  const box = await button.boundingBox();
  assert.ok(box, 'hovering a native graphic reveals the crop control');
  const imageBox = await page.locator('#native img').boundingBox();
  assert.ok(box.x + box.width > imageBox.x && box.x < imageBox.x + imageBox.width,
    'crop control is anchored to the visible image rather than the wider SDT host');
  assert.ok(box.y + box.height > imageBox.y && box.y < imageBox.y + imageBox.height);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
  assert.equal(await button.isVisible(), true, 'moving to the control must not hide it while crossing the host gap');
  await button.click();
  await page.waitForFunction(() => !!ZRBManualFigures.states.get(document).editor?.page);
});

test('hover crop control disappears as soon as the pointer leaves the image and control', async t => {
  const { page } = await fixture(t);
  const image = page.locator('#native img');
  const button = page.locator('.zrb-figure-edit-control');
  await image.hover();
  assert.equal(await button.isVisible(), true);
  const box = await image.boundingBox();
  await page.mouse.move(box.x - 12, box.y + box.height / 2);
  assert.equal(await button.isVisible(), false, 'the crop control should not linger after leaving the graphic');
});

test('enlarged images have explicit zoom and close controls while clicking the image keeps it open', async t => {
  const { page } = await fixture(t);
  await page.dblclick('#native img');
  const lightbox = page.getByRole('dialog', { name: '图片放大预览' });
  await page.getByRole('button', { name: '放大图片' }).click();
  assert.equal(await lightbox.getAttribute('data-zoom'), '1.25');
  await page.locator('.zrb-image-lightbox img').click();
  assert.equal(await lightbox.count(), 1, 'clicking the image should not dismiss the preview');
  await page.getByRole('button', { name: '关闭图片预览' }).click();
  assert.equal(await lightbox.count(), 0);
});

test('lightbox centers narrow images and formula/chart renderings can be recropped', async t => {
  const { page } = await fixture(t);
  await page.locator('#sdt-content').evaluate(root => {
    const wrapper = document.createElement('div'); wrapper.id = 'odd-image'; wrapper.dataset.refPath = '5';
    wrapper.innerHTML = '<a href="#original"><span><img alt="unusual tall figure" width="70" height="260" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2270%22 height=%22260%22%3E%3Crect width=%2270%22 height=%22260%22 fill=%22%23888%22/%3E%3C/svg%3E"></span></a>';
    root.append(wrapper);
  });
  await page.locator('#formula').evaluate(el => {
    el.dataset.refPath = '3';
    el.innerHTML = '<svg id="formula-svg" width="80" height="40"><text x="2" y="25">x+y=z</text></svg>';
  });
  await page.locator('#orphan').evaluate(el => { el.dataset.refPath = '4'; el.innerHTML = '<canvas id="chart-canvas" width="60" height="240"></canvas>'; });
  await page.evaluate(() => {
    const state = ZRBManualFigures.states.get(document);
    state.entries.push(
      { ref: [3], block: { type: 'math', anchor: { pageRects: [[0, 20, 20, 180, 90]] } } },
      { ref: [4], block: { type: 'chart', anchor: { pageRects: [[0, 20, 20, 180, 400]] } } },
      { ref: [5], block: { type: 'image', anchor: { pageRects: [[0, 20, 20, 120, 280]] } } },
    );
  });
  await page.dblclick('#chart-canvas');
  const image = page.locator('.zrb-image-lightbox img');
  const box = await image.boundingBox();
  const overlay = await page.locator('.zrb-image-lightbox').boundingBox();
  assert.ok(Math.abs((box.x + box.width / 2) - (overlay.x + overlay.width / 2)) < 3,
    'a narrow image is centered in the available preview area');
  await page.keyboard.press('Escape');
  await page.locator('#formula-svg').evaluate(el => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })));
  await page.getByRole('button', { name: '裁剪／修正图片', exact: true }).click();
  await page.waitForFunction(() => !!ZRBManualFigures.states.get(document).editor?.page);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.locator('#odd-image img').evaluate(el => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })));
  await page.getByRole('button', { name: '裁剪／修正图片', exact: true }).click();
  await page.waitForFunction(() => !!ZRBManualFigures.states.get(document).editor?.page);
  await page.getByRole('button', { name: '取消', exact: true }).click();
});

test('lightbox recenters after document zoom and dragging pans an enlarged image on both axes', async t => {
  const { page } = await fixture(t);
  await page.locator('#native img').evaluate(img => {
    img.style.setProperty('width', '600px', 'important');
    img.style.setProperty('height', '450px', 'important');
    img.style.transform = 'scale(2)';
  });
  await page.dblclick('#native img');
  const lightbox = page.locator('.zrb-image-lightbox');
  const viewport = page.locator('.zrb-image-lightbox-content');
  const image = lightbox.locator('img');
  const center = async () => {
    const imageBox = await image.boundingBox(), viewportBox = await viewport.boundingBox();
    return {
      x: Math.abs(imageBox.x + imageBox.width / 2 - (viewportBox.x + viewportBox.width / 2)),
      y: Math.abs(imageBox.y + imageBox.height / 2 - (viewportBox.y + viewportBox.height / 2)),
    };
  };
  const initialCenter = await center();
  assert.ok(initialCenter.x < 3 && initialCenter.y < 3, 'initial fit is centered independently of the source page zoom');

  await page.getByRole('button', { name: '放大图片' }).click();
  const box = await image.boundingBox();
  const before = await viewport.evaluate(el => ({ x: el.scrollLeft, y: el.scrollTop }));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2 - 100, { steps: 4 });
  await page.mouse.up();
  const after = await viewport.evaluate(el => ({ x: el.scrollLeft, y: el.scrollTop }));
  assert.ok(after.x > before.x && after.y > before.y, 'dragging the zoomed image pans horizontally and vertically');
  await page.keyboard.press('Escape');
});

test('crop editor contains scroll chaining at the edge of its PDF pane', async t => {
  const { page } = await fixture(t);
  await page.locator('body').evaluate(body => {
    const tail = document.createElement('div'); tail.style.height = '3000px'; body.append(tail);
  });
  await page.evaluate(() => scrollTo(0, 0));
  await open(page, '#orphan');
  const source = page.locator('.zrb-manual-source');
  await page.locator('[data-field=zoom]').selectOption('2');
  await source.evaluate(el => { el.scrollTop = el.scrollHeight; el.scrollLeft = el.scrollWidth; });
  const box = await source.boundingBox();
  const before = await page.evaluate(() => scrollY);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 18);
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(60);
  const result = await page.evaluate(() => {
    const pane = document.querySelector('.zrb-manual-source');
    return { scrollY, paneTop: pane.scrollTop, paneHeight: pane.clientHeight, paneScrollHeight: pane.scrollHeight,
      overscroll: getComputedStyle(pane).overscrollBehaviorY };
  });
  assert.equal(result.scrollY, before, 'wheel input at the PDF pane boundary must not scroll the underlying paper: ' + JSON.stringify(result));
  assert.equal(await source.evaluate(el => getComputedStyle(el).overscrollBehaviorY), 'contain');
  await page.getByRole('button', { name: '取消', exact: true }).click();
});

test('crop control follows the image corner after viewport zoom/layout changes', async t => {
  const { page } = await fixture(t);
  const image = page.locator('#native img');
  await image.hover();
  const button = page.locator('.zrb-figure-edit-control');
  const distance = async () => {
    const imageBox = await image.boundingBox(), controlBox = await button.boundingBox();
    return { x: Math.abs((controlBox.x + controlBox.width) - imageBox.x - imageBox.width), y: Math.abs(controlBox.y - imageBox.y) };
  };
  await page.evaluate(() => { document.querySelector('#native img').style.transform = 'scale(1.25)'; });
  await page.setViewportSize({ width: 1000, height: 850 });
  await page.waitForTimeout(80);
  const result = await distance();
  assert.ok(result.x < 18 && result.y < 18, 'control remains pinned to the image top-right after visual scaling');
});

test('crop action reports why it cannot open instead of silently doing nothing', async t => {
  const { page } = await fixture(t);
  await page.evaluate(() => { ZRBManualFigures.states.get(document).fingerprint = null; });
  await page.locator('#failed .zrb-figure-edit-inline').click();
  await page.waitForFunction(() => !!document.querySelector('[data-zrb-action-feedback]'));
  assert.match(await page.locator('[data-zrb-action-feedback]').textContent(), /无法读取 PDF 指纹/);
});

test('failure boxes support cross-page selections, order changes, scope confirmation, all display modes and original restore', async t => {
  const { page, errors } = await fixture(t);
  await page.locator('#failed .zrb-figure-edit-inline').click();
  await page.waitForFunction(() => !!ZRBManualFigures.states.get(document).editor?.page);
  assert.equal(await page.locator('.zrb-manual-editor').count(), 1, 'plugin-generated figure frames expose a direct recrop action');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await open(page, '#failed');
  await draw(page);
  await page.getByRole('button', { name: '添加当前选区' }).click();
  await page.getByLabel('PDF 页码').fill('2'); await page.getByLabel('PDF 页码').press('Tab');
  await page.waitForFunction(() => ZRBManualFigures.states.get(document).editor?.pageIndex === 1 && !!ZRBManualFigures.states.get(document).editor?.page);
  await draw(page, [.32, .02], [.7, .58]);
  await page.getByRole('button', { name: '添加当前选区' }).click();
  assert.equal(await page.getByLabel('替换 PDF 原生图形 · 第 1 页', { exact: true }).isChecked(), true,
    'the editor automatically selects an original fragment contained by the crop without asking for an ordinal');
  await page.getByLabel('替换 PDF 原生图形 · 第 1 页', { exact: true }).check();
  await page.getByLabel('替换 PDF 原生图形 · 第 2 页', { exact: true }).check();
  await page.getByRole('button', { name: '上移选区 2', exact: true }).click();
  await page.getByRole('button', { name: '预览结果', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-action=apply]').disabled);
  assert.equal(await page.locator('.zrb-manual-main-preview img').count(), 2);
  assert.equal(await page.locator('.zrb-manual-source').isVisible(), false);
  if (process.env.ZRB_MANUAL_UI_OUTPUT) await page.screenshot({ path: path.join(process.env.ZRB_MANUAL_UI_OUTPUT, 'manual-editor-preview.png') });
  await page.getByRole('button', { name: '返回编辑', exact: true }).click();
  assert.equal(await page.locator('.zrb-manual-source').isVisible(), true);
  await page.getByRole('button', { name: '预览结果', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-action=apply]').disabled);
  await page.getByRole('button', { name: '应用修正', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.zrb-manual-editor'));
  await page.dblclick('.zrb-manual-figure img');
  assert.equal(await page.locator('.zrb-image-lightbox img').count(), 2);
  await page.keyboard.press('Escape');
  const result = await page.evaluate(() => {
    const state = ZRBManualFigures.states.get(document), record = [...state.records.values()][0];
    const figure = document.querySelector('.zrb-manual-figure');
    return { pages: record.regions.map(r => r.pageIndex), next: figure.nextElementSibling.tagName, hidden: document.querySelectorAll('[data-zrb-manual-hidden]').length };
  });
  assert.deepEqual(result, { pages: [1, 0], next: 'FIGCAPTION', hidden: 3 });
  for (const mode of ['original', 'bilingual', 'translation']) {
    await page.evaluate(mode => ReadingBilingual.applyReaderDisplayMode(document, mode), mode);
    assert.equal(await page.locator('.zrb-manual-figure').isVisible(), true);
    assert.equal(await page.locator('.zrb-manual-figure img').count(), 2);
    for (const selector of ['#body', '#link', '#formula', '#table']) assert.equal(await page.locator(selector).isVisible(), true);
  }
  await page.locator('.zrb-manual-figure').click({ button: 'right' });
  await page.getByRole('button', { name: '重新裁剪', exact: true }).click();
  await page.waitForFunction(() => !!ZRBManualFigures.states.get(document).editor?.page);
  await page.getByRole('button', { name: '移除选区 2', exact: true }).click();
  await page.getByRole('button', { name: '预览结果', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-action=apply]').disabled);
  await page.getByRole('button', { name: '应用修正', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.zrb-manual-editor'));
  assert.equal(await page.locator('.zrb-manual-figure').count(), 1);
  assert.equal(await page.locator('.zrb-manual-figure img').count(), 1);
  await page.locator('.zrb-manual-figure').click({ button: 'right' });
  await page.getByRole('button', { name: '恢复原显示', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.zrb-manual-figure'));
  assert.equal(await page.locator('[data-zrb-manual-hidden]').count(), 0);
  assert.deepEqual(errors, []);
});

test('Ctrl+wheel over the PDF pane changes only its local zoom and does not bubble to the Reader', async t => {
  const { page } = await fixture(t);
  await open(page, '#orphan');
  const before = await page.locator('.zrb-crop-stage').evaluate(el => el.getBoundingClientRect().width);
  const result = await page.locator('.zrb-manual-source').evaluate(el => {
    let bubbled = false; document.addEventListener('wheel', () => { bubbled = true; }, { once: true });
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100 });
    el.dispatchEvent(event); return { prevented: event.defaultPrevented, bubbled };
  });
  const after = await page.locator('.zrb-crop-stage').evaluate(el => el.getBoundingClientRect().width);
  assert.equal(result.prevented, true);
  assert.equal(result.bubbled, false);
  assert.ok(after > before, 'Ctrl+wheel enlarges the source pane preview only');
});

test('failed preview and failed apply preserve an existing correction and its records', async t => {
  const { page } = await fixture(t);
  await open(page, '#native');
  await page.getByRole('button', { name: '添加当前选区' }).click();
  await page.getByRole('button', { name: '预览结果', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-action=apply]').disabled);
  await page.evaluate(() => { window.renderFailure = true; ZRBPDFFigureFallback.getCache().clearMemory(); });
  await page.getByRole('button', { name: '应用修正', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[role=status]').textContent.includes('测试渲染失败'));
  assert.equal(await page.locator('#native').isVisible(), true);
  assert.equal(await page.locator('.zrb-manual-figure').count(), 0);
  assert.equal(await page.evaluate(() => ZRBManualFigures.states.get(document).records.size), 0);
});
