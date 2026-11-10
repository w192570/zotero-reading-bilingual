const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { firefox } = require('playwright');

test('preferences persist all three figure modes and update an open Reader immediately', async () => {
  const root = path.resolve(__dirname, '../..');
  const defaults = {};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'prefs.js'), 'utf8'), { pref(key, value) { defaults[key] = value; } });
  // The pane is normally hosted by Zotero's XUL document. Keep its real HTML
  // controls and script, with equivalent flex containers for browser QA.
  const markup = fs.readFileSync(path.join(root, 'content/preferences.xhtml'), 'utf8')
    .replace(/html:/g, '').replace(/xmlns(?::\w+)?="[^"]*"/g, '')
    .replace(/<(textarea|label|button|checkbox)(\b[^>]*?)\/>/g, '<$1$2></$1>');
  const browser = await firefox.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 850 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.exposeFunction('testDigest', bytes => require('node:crypto').createHash('sha256').update(Buffer.from(bytes)).digest('hex'));
    await page.setContent('<!doctype html><html><head><style>body{font:14px "Segoe UI",sans-serif;margin:16px;color:#222;background:#fafafa}vbox{display:flex;flex-direction:column}hbox{display:flex;align-items:center}groupbox{display:block;margin-bottom:16px}label[value]::before{content:attr(value)}button[label]::before{content:attr(label)}select{min-width:0}#reading-bilingual-prefpane{max-width:740px}</style></head><body>' + markup + '<iframe id="reading" style="width:800px;height:400px"></iframe></body></html>');
    for (const file of ['figure-cache.js', 'pdf-figure-fallback.js', 'reading-bilingual.js']) {
      await page.addScriptTag({ path: path.join(root, 'content/scripts', file) });
    }
    await page.evaluate(async defaults => {
      window.preferences = { ...defaults };
      window.Zotero = { debug() {}, logError() {}, Prefs: { get(key) { return preferences[key]; }, set(key, value) { preferences[key] = value; } }, Reader: { _readers: {} } };
      Zotero.ReadingBilingual = ReadingBilingual;
      const files = new Map();
      ZRBPDFFigureFallback.cache = ZRBFigureCache.create({ digest: bytes => testDigest([...bytes]), io: {
        join: name => name, list: async () => [...files.keys()],
        read: async name => { if (!files.has(name)) throw Object.assign(new Error('missing'), { name: 'NotFoundError' }); return files.get(name); },
        write: async (name, bytes) => files.set(name, bytes), remove: async name => files.delete(name),
      }});
      const cache = ZRBPDFFigureFallback.cache;
      await cache.getOrCreate(await cache.key({ sample: 1 }), async () => ({
        src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6n0AAAAASUVORK5CYII=',
        width: 1, height: 1, rect: [0,0,10,10], direction: 'above', displayWidth: 10,
      }));
      ReadingBilingual.updateAllReaderStyles = () => {};
      const doc = document.querySelector('#reading').contentDocument;
      doc.body.innerHTML = '<article id="sdt-content"><figcaption data-ref-path="0">Figure 2</figcaption></article>';
      const structure = { metadata: { processor: { type: 'pdf' } }, catalog: { pages: [{ viewRect: [0,0,600,800] }] },
        content: [{ type: 'caption', anchor: { pageRects: [[0,50,300,280,310]] }, content: [{ text: 'Figure 2' }] }] };
      window.reader = { _internalReader: { _sdt: { structure }, _primarySDTView: { _iframeDocument: doc }, _primaryView: {} } };
      Zotero.Reader._readers = [reader];
      window.renderCalls = 0;
      ZRBPDFFigureFallback.renderFigure = async () => { renderCalls++; throw new Error('test render'); };
      ZRBPDFFigureFallback.ensure(reader);
    }, defaults);
    await page.addScriptTag({ path: path.join(root, 'content/scripts/preferences.js') });
    const select = page.getByLabel('缺图补充：', { exact: true });
    await page.waitForFunction(() => document.getElementById('reading-bilingual-pref-provider')._initialized);
    assert.equal(await select.inputValue(), 'manual');
    const disk = page.getByLabel('缓存补图到本地', { exact: true });
    assert.equal(await disk.isChecked(), true);
    assert.equal(await page.evaluate(async () => (await ReadingBilingual.getPDFFigureCacheStats()).diskEntries), 1);
    await disk.uncheck();
    assert.equal(await page.evaluate(() => preferences['extensions.zotero.reading-bilingual.figureCache']), false);
    await disk.check();
    await page.getByRole('button', { name: '清理补图缓存', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('reading-bilingual-figure-cache-status').textContent.includes('已清理'));
    assert.equal(await page.evaluate(async () => (await ReadingBilingual.getPDFFigureCacheStats()).diskEntries), 0);
    assert.equal(await page.evaluate(() => renderCalls), 0);
    await select.selectOption('off');
    assert.equal(await page.evaluate(() => preferences['extensions.zotero.reading-bilingual.figureMode']), 'off');
    assert.equal(await page.frameLocator('#reading').locator('.zrb-pdf-figure-fallback').count(), 0);
    await select.selectOption('manual');
    assert.equal(await page.frameLocator('#reading').locator('.zrb-pdf-figure-fallback').count(), 1);
    assert.equal(await page.evaluate(() => renderCalls), 0);
    await select.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => renderCalls === 1);
    assert.equal(await select.inputValue(), 'auto');
    assert.equal(await page.evaluate(() => ReadingBilingual.getPDFFigureMode()), 'auto');
    await select.selectOption('manual');
    await page.frameLocator('#reading').locator('.zrb-pdf-figure-fallback button:not(.zrb-figure-edit-inline)').click();
    await page.waitForFunction(() => renderCalls === 2);
    // Recreating the control script reads the saved mode rather than resetting it.
    await page.evaluate(() => { document.getElementById('reading-bilingual-pref-provider')._initialized = false; });
    await page.addScriptTag({ path: path.join(root, 'content/scripts/preferences.js') });
    await page.waitForFunction(() => document.getElementById('reading-bilingual-pref-provider')._initialized);
    assert.equal(await select.inputValue(), 'manual');
    assert.deepEqual(errors, []);
    if (process.env.ZRB_UI_OUTPUT) {
      fs.mkdirSync(process.env.ZRB_UI_OUTPUT, { recursive: true });
      await page.locator('#reading-bilingual-figure-settings').screenshot({ path: path.join(process.env.ZRB_UI_OUTPUT, 'figure-settings.png') });
    }
  } finally { await browser.close(); }
});
