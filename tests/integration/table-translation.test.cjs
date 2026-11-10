// Private manifest: {pdf, sdt, sdtOriginal, translationFile, source,
// translation, ref, readerBundle, pdfjs, output}. No papers/caches are checked in.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { firefox } = require('playwright');

test('actual cached PDF table keeps all cells aligned in native Reader layout, narrow views and display modes', {
  timeout: 90000,
  skip: !process.env.ZRB_TABLE_CASE && 'Set ZRB_TABLE_CASE to a private PDF/table-cache manifest',
}, async t => {
  const config = JSON.parse(fs.readFileSync(process.env.ZRB_TABLE_CASE, 'utf8'));
  const bundle = fs.readFileSync(config.readerBundle, 'utf8');
  const extract = name => {
    const start = bundle.indexOf(`\nfunction ${name}(`) + 1;
    assert.ok(start > 0, name);
    return bundle.slice(start, bundle.indexOf('\nfunction ', start + 1));
  };
  const start = bundle.indexOf(';// ./src/pdf/pdf-renderer.js');
  const end = bundle.indexOf('/* harmony default export */ const pdf_renderer', start);
  assert.ok(start >= 0 && end > start, 'installed PDF renderer module');
  const native = ['fitRectIntoRect', 'getPositionBoundingRect', 'p2v'].map(extract).join('\n')
    + '\n' + bundle.slice(start, end) + '\nwindow.NativePDFRenderer=PDFRenderer;\n'
    + require('../helpers/native-sdt.cjs')(config.readerBundle);
  const originals = [config.pdf, config.sdtOriginal, config.translationFile];
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const before = originals.map(hash);
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><html><body style="margin:0"><iframe id="reading" style="width:100%;height:100vh;border:0;display:block"></iframe></body></html>');
      return;
    }
    let file;
    if (pathname === '/source.pdf') file = config.pdf;
    else if (pathname.startsWith('/pdfjs/')) {
      const candidate = path.resolve(config.pdfjs, decodeURIComponent(pathname.slice(7)));
      if (candidate.startsWith(path.resolve(config.pdfjs) + path.sep)) file = candidate;
    }
    if (!file || !fs.existsSync(file)) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', file.endsWith('.mjs') ? 'text/javascript' : file.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await firefox.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1100, height: 1100 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.addScriptTag({ content: native });
  for (const file of ['vendor/markdown-it.min.js', 'vendor/katex/katex.min.js', 'scripts/translation-renderer.js', 'scripts/reading-bilingual.js']) {
    await page.addScriptTag({ path: path.resolve(__dirname, '../../content', file) });
  }
  const structure = JSON.parse(fs.readFileSync(config.sdt, 'utf8'));
  const result = await page.evaluate(async ({ config, structure }) => {
    window.Zotero = { debug() {}, logError(e) { throw e; }, Prefs: { get() {} } };
    const pdfjs = await import('/pdfjs/build/pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/build/pdf.worker.mjs';
    const pdfDocument = await pdfjs.getDocument({ url: '/source.pdf', cMapUrl: '/pdfjs/web/cmaps/', cMapPacked: true,
      standardFontDataUrl: '/pdfjs/web/standard_fonts/', wasmUrl: '/pdfjs/web/wasm/' }).promise;
    window.PDFViewerApplication = { pdfDocument, pdfViewer: { maxCanvasPixels: 12000000 } };
    const doc = document.getElementById('reading').contentDocument;
    doc.open(); doc.write('<!doctype html><html><head></head><body></body></html>'); doc.close();
    doc.body.append(NativeSDT.render(structure, doc, { renderSourceCrops: true }));
    const style = doc.createElement('style');
    style.textContent = NativeSDT.css + '\n:root{--background-color:#dfe8c7;--text-color:#111}body{font:20px Arial;padding:16px}#sdt-content{max-width:1000px;margin:auto}';
    doc.head.append(style);
    const source = doc.querySelector(`[data-ref-path="${config.ref.join('.')}"]`);
    if (!source) throw new Error('Actual SDT table not found');
    const sourceText = (source.getAttribute('aria-label') || source.innerText || source.textContent).replace(/\s+/g, ' ').trim();
    if (sourceText !== config.source) throw new Error('Actual table does not match its translation cache key');
    const base = { _iframeWindow: window };
    const renderer = new NativePDFRenderer({ pdfView: base });
    const hydration = new NativeSDT.Hydration(doc), provider = new NativeSDT.Provider(renderer);
    hydration._prepareSourceCrops(provider.createSDTBlockCropProvider(structure));
    await hydration._loadSourceCrop(source);
    const image = source.querySelector('img');
    if (!image?.naturalWidth) throw new Error('Native PDF table crop failed');
    const api = ReadingBilingual;
    ZRBTranslationRenderer._loadLibrary = (_filename, name) => window[name];
    api.loadCache = async () => ({ [config.source]: config.translation });
    api.saveCache = async () => { throw new Error('Unexpected translation cache write'); };
    api.callModelText = async () => { throw new Error('Unexpected model request'); };
    const generated = doc.createElement('style'); generated.textContent = api.getGeneratedCSS(); doc.head.append(generated);
    const reader = { _internalReader: { _sdt: { structure } } };
    const graphic = doc.querySelector('[data-ref-path="3"]');
    if (structure.content[3].type !== 'image' || !graphic) throw new Error('Actual architecture image is missing');
    const wrong = doc.createElement('div'); wrong.className = 'zotero-bilingual-card zotero-bilingual-table-card';
    wrong.textContent = 'Wrong historical architecture table'; graphic.after(wrong);
    api.removeMisclassifiedTableCards(reader, doc);
    if (wrong.isConnected || !graphic.isConnected || api.isTableTranslationSource(reader, graphic)) throw new Error('Architecture figure still treated as a table');
    await api.translateTableBlock({ element: graphic, text: 'Architecture labels' }, reader, doc);
    await api.translateTableBlock({ element: source, text: sourceText }, reader, doc);
    const card = source.nextElementSibling;
    card.id = 'translated-table'; source.id = 'original-table';
    const content = card.querySelector('.zrb-card-content');
    const matrix = Array.from(content.querySelectorAll('tr'), row => Array.from(row.children, cell => cell.textContent));
    return { matrix, raw: ZRBTranslationRenderer.getSource(content), originalImage: image.src,
      neighbors: [source.previousElementSibling?.textContent, card.nextElementSibling?.textContent] };
  }, { config, structure });
  const expected = config.translation.trim().split(/\r?\n/).map(row => row.split('|').map(cell => cell.trim()));
  assert.deepEqual(result.matrix, expected, 'every original translated cell stays in its original row and column');
  assert.equal(result.raw, config.translation);
  const frame = await page.locator('#reading').elementHandle().then(el => el.contentFrame());
  const card = frame.locator('#translated-table'), region = card.locator('.zrb-table-scroll');
  fs.mkdirSync(config.output, { recursive: true });
  fs.writeFileSync(path.join(config.output, 'original-table.png'), Buffer.from(result.originalImage.split(',')[1], 'base64'));
  await card.screenshot({ path: path.join(config.output, 'translated-table.png') });
  for (const width of [320, 768, 1100, 1440]) {
    await page.setViewportSize({ width, height: 1100 });
    const layout = await region.evaluate(element => {
      const header = element.querySelector('thead tr'), row = element.querySelector('tbody tr');
      return { documentWidth: element.ownerDocument.documentElement.clientWidth,
        documentScrollWidth: element.ownerDocument.scrollingElement.scrollWidth,
        aligned: Array.from(header.children).every((cell, index) => Math.abs(cell.getBoundingClientRect().x - row.children[index].getBoundingClientRect().x) < 1) };
    });
    assert.ok(layout.documentScrollWidth <= layout.documentWidth + 1, JSON.stringify({ width, layout }));
    assert.equal(layout.aligned, true);
  }
  await page.setViewportSize({ width: 768, height: 1100 });
  const pinned = await region.evaluate(element => {
    const first = element.querySelector('tbody th'), before = first.getBoundingClientRect().x;
    element.scrollLeft = element.scrollWidth;
    return { before, after: first.getBoundingClientRect().x, scrollLeft: element.scrollLeft };
  });
  assert.ok(pinned.scrollLeft > 0);
  assert.ok(Math.abs(pinned.after - pinned.before) < 1, 'row labels stay visible during horizontal scroll');
  await region.focus();
  assert.equal(await region.evaluate(el => el.ownerDocument.activeElement === el), true);
  for (const mode of ['original', 'bilingual', 'translation']) {
    await page.evaluate(mode => ReadingBilingual.applyReaderDisplayMode(document.getElementById('reading').contentDocument, mode), mode);
    assert.equal(await card.isVisible(), mode !== 'original');
    assert.equal(await frame.locator('#original-table img').isVisible(), true, 'native table pixels are preserved');
  }
  await card.locator('.zrb-card-content').dblclick({ position: { x: 8, y: 8 } });
  assert.equal(await card.locator('textarea').inputValue(), config.translation);
  await card.locator('textarea').press('Escape');
  assert.equal(await region.count(), 1);
  const neighbors = await frame.locator('#original-table').evaluate(source => [source.previousElementSibling?.textContent, source.nextElementSibling.nextElementSibling?.textContent]);
  assert.deepEqual(neighbors, result.neighbors);
  assert.deepEqual(originals.map(hash), before, 'original PDF, SDT and translation cache remain byte-identical');
  assert.deepEqual(errors, []);
  t.diagnostic(JSON.stringify({ rows: result.matrix.length, columns: result.matrix[0].length, originalFilesUnchanged: true, modes: 3, widths: 4 }));
});
