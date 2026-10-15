const assert = require('node:assert/strict');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { firefox } = require('playwright');

const root = path.resolve(__dirname, '../..');
let browser;
before(async () => { browser = await firefox.launch({ headless: true, timeout: 30000 }); });
after(async () => { await browser?.close(); });

async function fixture(t, cancelPointerDown = true) {
  const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => page.close());
  await page.setContent('<input id="host-focus" aria-label="Host window"><iframe id="reader" style="width:900px;height:540px;border:0"></iframe>');
  const frame = await page.locator('#reader').elementHandle().then(handle => handle.contentFrame());
  await frame.setContent(`<!doctype html><html><head><style>
    body { margin: 0; }
    .toolbar { display: flex; justify-content: space-between; align-items:center; height:41px; background:#f9f9f9; -moz-window-dragging:drag; }
    .toolbar .end { display:flex; align-items:center; gap:9px; }
    .toolbar .toolbar-button { -moz-window-dragging:no-drag; }
    #paper { width:100%; height:440px; border:0; }
  </style></head><body><div class="toolbar"><button id="reading-mode" class="toolbar-button active">阅读模式</button><div class="end"><button class="toolbar-button find">搜索</button></div></div><iframe id="paper"></iframe></body></html>`);
  const paper = await frame.locator('#paper').elementHandle().then(handle => handle.contentFrame());
  await paper.setContent('<!doctype html><html><body><p id="source">English source<img id="figure" alt="figure" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2240%22 height=%2220%22%3E%3Crect width=%2240%22 height=%2220%22 fill=%22blue%22/%3E%3C/svg%3E"></p><div class="zotero-bilingual-card"><div class="zrb-card-content">中文译文</div></div></body></html>');
  await page.addScriptTag({ path: path.join(root, 'content/scripts/reading-bilingual.js') });
  await page.evaluate(cancelPointerDown => {
    window.loggedErrors = [];
    window.Zotero = { debug() {}, logError(error) { loggedErrors.push(String(error)); }, Prefs: { get() {} } };
    const doc = document.querySelector('#reader').contentDocument;
    const contentDoc = doc.querySelector('#paper').contentDocument;
    window.testReader = { _iframeWindow: doc.defaultView };
    ReadingBilingual.getRealContentDoc = () => contentDoc;
    const style = contentDoc.createElement('style');
    style.textContent = ReadingBilingual.getGeneratedCSS();
    contentDoc.head.appendChild(style);

    // Zotero Reader FocusManager._handlePointerDown prevents the default
    // pointer action for toolbar buttons, suppressing compatibility mousedown.
    // https://github.com/zotero/reader/blob/4bfd82ee848e36e80aaff2a2c732615c89ad1e72/src/common/focus-manager.js
    doc.defaultView.addEventListener('pointerdown', event => {
      if (cancelPointerDown && !event.target.closest('input, textarea, select, [contenteditable="true"]')) event.preventDefault();
    });
    window.clickEvents = [];
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
      doc.addEventListener(type, event => {
        if (event.target.closest('#zrb-display-mode')) clickEvents.push({ type, detail: event.detail });
      }, true);
    }
    ReadingBilingual.injectToolbarButton(testReader, doc);
  }, cancelPointerDown);
  return { page, frame, paper, errors, button: frame.locator('#zrb-display-mode'), menu: frame.locator('#zrb-display-mode-menu') };
}

test('a real Firefox single click opens the choices when Zotero cancels pointerdown', async t => {
  const { page, frame, button, menu, errors } = await fixture(t);
  await page.locator('#host-focus').click();
  await button.click();
  const events = await page.evaluate(() => clickEvents);
  assert.ok(events.some(event => event.type === 'click' && event.detail === 1), JSON.stringify(events));
  assert.ok(!events.some(event => event.type === 'mousedown'), 'the fixture must reproduce cancelled compatibility mouse events');
  assert.equal(await menu.isVisible(), true, `Single click did not open the menu. Events: ${JSON.stringify(events)}`);
  assert.equal(await button.getAttribute('aria-expanded'), 'true');
  assert.equal(await frame.locator('#reading-mode').getAttribute('class'), 'toolbar-button active');
  assert.deepEqual(errors, []);
});


test('a mouse click toggles once when compatibility mousedown is allowed too', async t => {
  const { page, button, menu } = await fixture(t, false);
  await button.click();
  assert.equal(await menu.isVisible(), true);
  await button.click();
  assert.equal(await menu.isVisible(), false);
  const events = await page.evaluate(() => clickEvents);
  assert.equal(events.filter(event => event.type === 'mousedown').length, 2);
  assert.equal(events.filter(event => event.type === 'click').length, 2);
});

test('real clicks on text and arrow open once, switch all states and preserve figures', async t => {
  const { page, frame, paper, button, menu, errors } = await fixture(t);
  for (const [value, label] of [['translation', '仅译文'], ['original', '原文'], ['bilingual', '对照']]) {
    await page.locator('#host-focus').click();
    await button.locator(value === 'original' ? '[aria-hidden="true"]' : '.zrb-display-mode-label').click();
    assert.equal(await menu.isVisible(), true);
    await menu.locator(`[data-mode="${value}"]`).click();
    assert.equal(await button.evaluate(element => element.value), value);
    assert.equal(await button.locator('.zrb-display-mode-label').textContent(), label);
    assert.equal(await menu.isVisible(), false);
    assert.equal(await paper.locator('html').getAttribute('data-zrb-display-mode'), value);
    assert.equal(await paper.locator('.zotero-bilingual-card').isVisible(), value !== 'original');
    assert.equal(await paper.locator('#figure').isVisible(), true);
    assert.equal(await paper.locator('.zrb-original-text').isVisible(), value !== 'translation');
  }
  for (let i = 0; i < 5; i++) {
    await button.click();
    assert.equal(await menu.isVisible(), true);
    await button.click();
    assert.equal(await menu.isVisible(), false);
  }
  assert.equal(await frame.locator('#reading-mode').getAttribute('class'), 'toolbar-button active');
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => loggedErrors), []);
});

test('real pointer presses outside the menu and in the paper dismiss it', async t => {
  const { frame, paper, button, menu } = await fixture(t);
  await button.click();
  await frame.locator('.find').click();
  assert.equal(await menu.isVisible(), false);
  await button.click();
  await paper.locator('#source').click();
  assert.equal(await menu.isVisible(), false);
});

test('Firefox keyboard navigation selects a state and Escape closes the list', async t => {
  const { page, button, menu, paper } = await fixture(t);
  await button.click();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.equal(await button.evaluate(element => element.value), 'translation');
  assert.equal(await paper.locator('.zrb-original-text').isVisible(), false);
  await button.focus();
  await page.keyboard.press('Space');
  assert.equal(await menu.isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await menu.isVisible(), false);
  assert.equal(await button.getAttribute('aria-expanded'), 'false');
});
