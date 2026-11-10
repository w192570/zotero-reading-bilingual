// Opt-in local-PDF test: no paper, SDT cache or user path belongs in the repo.
// ZRB_PDF_CASES points to { pdfjs, output, cases:[{name,pdf,sdt,page,region?}] }.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { firefox } = require('playwright');

test('actual problem PDFs recover raster and vector figures from unchanged SDT caches', { timeout: 120000 }, async t => {
  assert.ok(process.env.ZRB_PDF_CASES, 'Set ZRB_PDF_CASES to the local PDF-case manifest');
  const config = JSON.parse(fs.readFileSync(process.env.ZRB_PDF_CASES, 'utf8'));
  // Exercise the exact crop renderer shipped with the user's Zotero, including
  // its own PDF.js realm, rather than a substitute page.render implementation.
  assert.ok(config.readerBundle, 'readerBundle must point to Zotero Reader JS');
  const bundle = fs.readFileSync(config.readerBundle, 'utf8');
  const extractFunction = name => {
    const start = bundle.indexOf(`\nfunction ${name}(`) + 1;
    assert.ok(start > 0, `Native function ${name} not found`);
    const end = bundle.indexOf('\nfunction ', start + 1);
    return bundle.slice(start, end);
  };
  const start = bundle.indexOf(';// ./src/pdf/pdf-renderer.js');
  const end = bundle.indexOf('/* harmony default export */ const pdf_renderer', start);
  assert.ok(start >= 0 && end > start, 'Native PDFRenderer module not found');
  const nativeRenderer = ['fitRectIntoRect', 'getPositionBoundingRect', 'p2v'].map(extractFunction).join('\n')
    + '\n' + bundle.slice(start, end) + '\nwindow.NativePDFRenderer = PDFRenderer;';
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const originals = config.cases.map(c => [c.pdf, c.sdt, ...(c.preserve || [])].map(hash));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let file;
    if (url.pathname.startsWith('/pdfjs/')) {
      const rel = decodeURIComponent(url.pathname.slice(7));
      const resolved = path.resolve(config.pdfjs, rel);
      if (resolved.startsWith(path.resolve(config.pdfjs) + path.sep)) file = resolved;
    } else if (/^\/case\/\d+\.pdf$/.test(url.pathname)) {
      file = config.cases[Number(url.pathname.match(/\d+/)[0])]?.pdf;
    }
    if (file && fs.existsSync(file)) {
      res.setHeader('Content-Type', file.endsWith('.mjs') ? 'text/javascript' : file.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');
      res.end(fs.readFileSync(file));
    } else if (url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><html><body><iframe id="reading" style="width:850px;height:900px;border:0"></iframe></body></html>');
    } else { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await firefox.launch({ headless: true });
  t.after(() => browser.close());
  const results = [];
  for (const [index, item] of config.cases.entries()) {
    const page = await browser.newPage({ viewport: { width: 960, height: 1000 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const paper = await page.locator('#reading').elementHandle().then(el => el.contentFrame());
    await paper.setContent('<!doctype html><html><head><style>body{margin:15px;font:16px sans-serif} #sdt-content{max-width:800px;margin:auto} figcaption{margin:12px 0} figure{margin:0}</style></head><body><article id="sdt-content"></article></body></html>');
    await page.addScriptTag({ path: path.resolve(__dirname, '../../content/scripts/figure-cache.js') });
    await page.addScriptTag({ path: path.resolve(__dirname, '../../content/scripts/pdf-figure-fallback.js') });
    await page.addScriptTag({ path: path.resolve(__dirname, '../../content/scripts/translation-renderer.js') });
    await page.addScriptTag({ path: path.resolve(__dirname, '../../content/scripts/reading-bilingual.js') });
    await page.addScriptTag({ content: nativeRenderer });
    await page.addScriptTag({ content: require('../helpers/native-sdt.cjs')(config.readerBundle) });
    const structure = JSON.parse(fs.readFileSync(item.sdt, 'utf8'));
    await page.evaluate(async ({ index, structure, profile }) => {
      window.Zotero = { debug() {}, logError(e) { console.warn(String(e)); }, Prefs: { get(key) { if (key.endsWith('.figureMode')) return 'auto'; } } };
      const pdfjs = await import('/pdfjs/build/pdf.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/build/pdf.worker.mjs';
      const pdfDocument = await pdfjs.getDocument({ url: `/case/${index}.pdf`, cMapUrl: '/pdfjs/web/cmaps/', cMapPacked: true,
        standardFontDataUrl: '/pdfjs/web/standard_fonts/', wasmUrl: '/pdfjs/web/wasm/' }).promise;
      window.PDFViewerApplication = { pdfDocument, pdfViewer: { maxCanvasPixels: 12000000 } };
      const doc = document.querySelector('#reading').contentDocument;
      doc.querySelector('#sdt-content').replaceWith(NativeSDT.render(structure,doc,{renderSourceCrops:true}));
      const nativeStyle=doc.createElement('style');nativeStyle.textContent=NativeSDT.css;doc.head.append(nativeStyle);
      for (const el of doc.querySelectorAll('figcaption')) el.after(ReadingBilingual.createCardElement({},doc,el.textContent,'测试译文'));
      const style = doc.createElement('style'); style.textContent = ReadingBilingual.getGeneratedCSS();doc.head.append(style);
      const nativeBase = { _iframeWindow: window };
      // Reproduce the important desktop boundary: plugin code cannot use
      // getViewport on the wrapped page, but Reader's native renderer can.
      const wrappedWindow = { JSON: window.JSON, PDFViewerApplication: { pdfDocument: { async getPage() { return {}; } } } };
      window.reader = { _internalReader: { _sdt: { structure }, _primarySDTView: { _iframeDocument: doc },
        _primaryView: { _iframeWindow: wrappedWindow, _pdfRenderer: new NativePDFRenderer({ pdfView: nativeBase }) } } };
      // Register every native block with the official crop provider and load
      // through the official hydration methods. These are real source pixels,
      // including the composite table crop seen in the regression screenshot.
      window.nativeHydration = new NativeSDT.Hydration(doc);
      const nativeProvider = new NativeSDT.Provider(reader._internalReader._primaryView._pdfRenderer);
      nativeHydration._prepareSourceCrops(nativeProvider.createSDTBlockCropProvider(structure));
      window.loadNative = async ref => {
        const el=doc.querySelector(`figure.sdt-source-crop[data-ref-path="${ref}"]`);
        if(el?.dataset.sourceCropState==='ready') await nativeHydration._loadSourceCrop(el);
        return el?.dataset.sourceCropState;
      };
      ReadingBilingual.setupSelectionContextMenu = () => {};
      ReadingBilingual.getAutoTranslate = () => false;
      if(profile) {
        window.figureProfile={stages:{},frameGaps:[]};
        let last=performance.now();
        figureProfile.timer=setInterval(()=>{const now=performance.now();figureProfile.frameGaps.push(now-last);last=now;},16);
        for(const name of ['renderRegions','trimImage','getFigure']) {
          const original=ZRBPDFFigureFallback[name];
          ZRBPDFFigureFallback[name]=async function(...args){const start=performance.now();try{return await original.apply(this,args);}finally{(figureProfile.stages[name]??=[]).push(performance.now()-start);}};
        }
      }
      // Exercise the production hook, including when automatic translation is off.
      ReadingBilingual.setupReadingModeObserver(reader, document);
    }, { index, structure, profile:!!process.env.ZRB_SCROLL_PROFILE });
    const figure = paper.locator(`.zrb-pdf-figure-fallback[data-source-ref="${item.sourceRef}"]`);
    assert.equal(await figure.count(), 1, `${item.name}: missing figure needs its own crop`);
    await paper.locator(`[data-ref-path="${item.sourceRef}"]`).first().scrollIntoViewIfNeeded();
    await figure.locator('img').waitFor({ state: 'visible', timeout: 60000 });
    await page.waitForFunction(ref => {
      const image = document.querySelector('#reading').contentDocument.querySelector(`.zrb-pdf-figure-fallback[data-source-ref="${ref}"] img`);
      return image?.complete && image.naturalWidth > 100;
    }, item.sourceRef);
    for (const mode of ['original', 'bilingual', 'translation']) {
      await page.evaluate(mode => ReadingBilingual.setReaderDisplayMode(reader, mode), mode);
      assert.equal(await figure.locator('img').isVisible(), true, `${item.name}: ${mode}`);
      assert.equal(await figure.locator('.zrb-original-text').count(), 0);
    }
    const cropRect = JSON.parse(await figure.getAttribute('data-crop-rect'));
    if (item.expectedRect) {
      const tolerance = item.geometryTolerance ?? 5;
      for (const i of [0, 1]) assert.ok(cropRect[i] <= item.expectedRect[i] + tolerance, `crop clips figure: ${cropRect}`);
      for (const i of [2, 3]) assert.ok(cropRect[i] >= item.expectedRect[i] - tolerance, `crop clips figure: ${cropRect}`);
    }
    const view = structure.catalog.pages[item.page - 1].viewRect;
    assert.ok((cropRect[2] - cropRect[0]) * (cropRect[3] - cropRect[1]) < (view[2] - view[0]) * (view[3] - view[1]) * 0.35,
      'the result must be a figure region, never an entire source page');
    const pixels = await figure.locator('img').evaluate(img => {
      const canvas = document.createElement('canvas');canvas.width = img.naturalWidth;canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let nonwhite = 0;for (let i = 0; i < data.length; i += 4) if (data[i + 3] && Math.min(data[i], data[i + 1], data[i + 2]) < 210) nonwhite++;
      return { width: canvas.width, height: canvas.height, nonwhite };
    });
    assert.ok(pixels.nonwhite > 1000, `graphic region must contain actual PDF pixels: ${JSON.stringify(pixels)}`);
    fs.mkdirSync(config.output, { recursive: true });
    // Fit the whole figure in its iframe before capturing: Firefox otherwise
    // screenshots clipped iframe pixels as black outside the visible surface.
    const captureHeight = Math.ceil(await figure.evaluate(el => el.getBoundingClientRect().height)) + 50;
    await page.setViewportSize({ width: 960, height: captureHeight + 50 });
    await page.locator('#reading').evaluate((el, height) => { el.style.height = height + 'px'; }, captureHeight);
    await figure.scrollIntoViewIfNeeded();
    await figure.screenshot({ path: path.join(config.output, `${item.name}-figure.png`) });
    const count = await paper.locator('.zrb-pdf-figure-fallback').count();
    if (item.expectedCount != null) assert.equal(count, item.expectedCount, `${item.name}: one preview per missing figure`);
    const allCrops = [];
    await page.evaluate(()=>ReadingBilingual.setReaderDisplayMode(reader,'bilingual'));
    for (const preview of await paper.locator('.zrb-pdf-figure-fallback').all()) {
      const ref=await preview.getAttribute('data-source-ref');
      await paper.locator(`[data-ref-path="${ref}"]`).first().scrollIntoViewIfNeeded();
      await page.waitForFunction(ref => ['loaded', 'error'].includes(document.querySelector('#reading').contentDocument
        .querySelector(`.zrb-pdf-figure-fallback[data-source-ref="${ref}"]`)?.dataset.state), await preview.getAttribute('data-source-ref'), { timeout: 60000 });
      allCrops.push(await preview.evaluate(el => ({ ref: el.dataset.sourceRef, page: Number(el.dataset.pageIndex) + 1,
        state: el.dataset.state, rect: el.dataset.cropRect, error: el.querySelector('[role="status"]').textContent })));
      if (allCrops.at(-1).state === 'loaded') {
        const src = await preview.locator('img').getAttribute('src');
        fs.writeFileSync(path.join(config.output, `${item.name}-ref-${allCrops.at(-1).ref}.png`), Buffer.from(src.split(',')[1], 'base64'));
      }
    }
    assert.ok(allCrops.every(crop => crop.state === 'loaded'), JSON.stringify(allCrops.filter(crop => crop.state !== 'loaded')));
    for (const check of item.nativeChecks || []) {
      if(check.native) {
        assert.equal(await page.evaluate(ref=>loadNative(ref),check.native),'loaded','official native image hydration must work');
        const replacement=paper.locator(`.zrb-pdf-figure-fallback[data-source-ref="${check.caption}"]`);
        if(await replacement.count()) {
          assert.equal(await replacement.getAttribute('data-native-replacement'),'true');
          assert.equal(await paper.locator(`[data-ref-path="${check.native}"]`).isVisible(),false,'replacement cannot coexist visibly with native pixels');
        }
      }
      if(check.composite) {
        assert.equal(await page.evaluate(ref=>loadNative(ref),check.composite),'loaded');
        assert.equal(await paper.locator(`[data-ref-path="${check.composite}"]`).isVisible(),false,'composite crop must not remain visible beside separated photo and table');
        const order=await paper.evaluate(({caption,table})=>{
          const cap=document.querySelector(`[data-ref-path="${caption}"]`),tc=document.querySelector(`[data-ref-path="${table}"]`);
          return {photo:cap.previousElementSibling?.dataset.sourceRef,card:cap.nextElementSibling?.classList.contains('zotero-bilingual-card'),
            table:tc.nextElementSibling?.nextElementSibling?.dataset.sourceRef};
        },check);
        assert.deepEqual(order,{photo:check.caption,card:true,table:check.table});
      }
    }
    for (const group of item.layoutGroups || []) {
      assert.equal(await page.evaluate(ref=>loadNative(ref),group.native),'loaded');
      assert.equal(await paper.locator(`[data-ref-path="${group.native}"]`).isVisible(),false);
      for(const ref of group.figures) assert.equal(await paper.locator(`[data-ref-path="${ref}"]`).evaluate(el=>el.previousElementSibling?.dataset.sourceRef),ref);
      for(const ref of group.tables) assert.equal(await paper.locator(`[data-ref-path="${ref}"]`).evaluate(el=>el.nextElementSibling?.nextElementSibling?.dataset.sourceRef),ref);
    }
    // Native and supplemental pixels are inspected together in a complete
    // reading layout. Save the exact problematic photo/caption/table sequence.
    if(item.nativeChecks?.length) {
      const start=paper.locator(`.zrb-pdf-figure-fallback[data-source-ref="${item.nativeChecks[0].caption}"]`);
      const last=paper.locator(`.zrb-pdf-figure-fallback[data-source-ref="${item.nativeChecks.at(-1).table}"]`);
      const span=await last.evaluate(el=>el.getBoundingClientRect().bottom)-await start.evaluate(el=>el.getBoundingClientRect().top);
      const height=Math.min(6000,Math.ceil(span)+100);
      await page.setViewportSize({width:960,height:height+50});
      await page.locator('#reading').evaluate((el,height)=>{el.style.height=height+'px';},height);
      await start.evaluate(el=>el.scrollIntoView({block:'start'}));
      const refs=[...new Set(item.nativeChecks.flatMap(c=>[c.caption,c.table]).filter(Boolean))];
      await page.waitForFunction(refs=>refs.every(ref=>{
        const f=document.querySelector('#reading').contentDocument.querySelector(`.zrb-pdf-figure-fallback[data-source-ref="${ref}"]`);
        const img=f?.querySelector('img');return f?.dataset.state==='loaded'&&img?.naturalWidth>0&&!img.hidden;
      }),refs,{timeout:60000});
      await page.locator('#reading').screenshot({path:path.join(config.output,`${item.name}-native-layout.png`)});
    }
    for (const target of item.targets || []) {
      const actual = JSON.parse(allCrops.find(crop => crop.ref === target.sourceRef)?.rect || 'null');
      assert.ok(actual, `missing target ${target.sourceRef}`);
      const tol = target.geometryTolerance ?? 5;
      for (const i of [0, 1]) assert.ok(actual[i] <= target.expectedRect[i] + tol, `${target.sourceRef}: clipped ${actual}`);
      for (const i of [2, 3]) assert.ok(actual[i] >= target.expectedRect[i] - tol, `${target.sourceRef}: clipped ${actual}`);
      if (target.bounds) for (const i of [0, 1, 2, 3]) {
        assert.ok(i < 2 ? actual[i] >= target.bounds[i] : actual[i] <= target.bounds[i], `${target.sourceRef}: neighboring content ${actual}`);
      }
    }
    if (item.name === '5HEMQ2BB') {
      assert.equal(await paper.locator('.zrb-pdf-figure-fallback[data-page-index="3"]').count(), 2,
        'Figure 2 and Figure 3 require separate graphic crops from the same page');
      const first = allCrops.find(crop => crop.ref === '157');
      const second = allCrops.find(crop => crop.ref === '158');
      assert.notEqual(first.rect, second.rect, 'Figure 9 must not reuse the preceding Figure 8 graphic');
    }
    // Closing/reopening Reading Mode reuses the unchanged cache and rebuilds
    // its previews; no cache deletion or regeneration is needed for this route.
    await page.evaluate(() => { ZRBPDFFigureFallback.shutdown(); ZRBPDFFigureFallback.ensure(reader); });
    assert.equal(await paper.locator('.zrb-pdf-figure-fallback').count(), count);
    assert.deepEqual([item.pdf, item.sdt, ...(item.preserve || [])].map(hash), originals[index]);
    assert.deepEqual(errors, []);
    const profile=await page.evaluate(()=>{if(!window.figureProfile)return null;clearInterval(figureProfile.timer);return {stages:figureProfile.stages,maxGap:Math.max(...figureProfile.frameGaps),gapsOver50:figureProfile.frameGaps.filter(ms=>ms>50).length};});
    results.push({ name: item.name, profile, sourcePage: item.page, sourceRef: item.sourceRef, cropRect, fallbacks: count,
      renderedFigures: allCrops.filter(crop => crop.state === 'loaded').length, ...pixels, allCrops, modes: 3, cacheUnchanged: true, errors });
    await page.evaluate(() => ZRBPDFFigureFallback.shutdown());
    await page.close();
  }
  fs.writeFileSync(path.join(config.output, 'integration-results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results.map(({ name, fallbacks, renderedFigures, width, height, cropRect, cacheUnchanged, errors }) =>
    ({ name, fallbacks, renderedFigures, width, height, cropRect, cacheUnchanged, errors }))));
});
