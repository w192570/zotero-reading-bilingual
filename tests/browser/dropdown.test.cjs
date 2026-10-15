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
  await paper.setContent('<!doctype html><html><body><figure class="sdt-image" data-ref-path="0.1"><img id="figure" alt="figure" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2240%22 height=%2220%22%3E%3Crect width=%2240%22 height=%2220%22 fill=%22blue%22/%3E%3C/svg%3E"></figure><p id="source">English source</p><div class="zotero-bilingual-card"><div class="zrb-card-content">中文译文</div></div></body></html>');
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
      doc.defaultView.addEventListener(type, event => {
        if (event.target.closest('#zrb-display-mode')) clickEvents.push({ type, detail: event.detail, defaultPrevented: event.defaultPrevented });
      });
    }
    ReadingBilingual.injectToolbarButton(testReader, doc);
  }, cancelPointerDown);
  return { page, frame, paper, errors, select: frame.locator('#zrb-display-mode') };
}

test('one real Firefox click opens the native dropdown despite Zotero toolbar drag styling', async t => {
  const { page, frame, select, errors } = await fixture(t);
  await page.locator('#host-focus').click();
  await select.click();
  const events = await page.evaluate(() => clickEvents);
  assert.ok(events.some(event => event.type === 'click' && event.detail === 1), JSON.stringify(events));
  assert.ok(events.some(event => event.type === 'pointerdown' && !event.defaultPrevented), `Zotero should leave native select input enabled: ${JSON.stringify(events)}`);
  assert.ok(events.some(event => event.type === 'mousedown'), `Native select should retain compatibility mouse events: ${JSON.stringify(events)}`);
  // Firefox keeps its native option popup outside the iframe DOM. Target the
  // select directly for keyboard input, as Zotero's toolbar does.
  await select.press('ArrowDown');
  await select.press('Enter');
  assert.equal(await select.inputValue(), 'translation', 'one click followed by a native option choice selects the next state');
  assert.equal(await select.locator('option:checked').textContent(), '仅译文');
  assert.equal(await frame.locator('#reading-mode').getAttribute('class'), 'toolbar-button active');
  assert.deepEqual(errors, []);
});

test('native dropdown selection switches all states and preserves present graphics', async t => {
  const { page, frame, paper, select, errors } = await fixture(t);
  for (const [value, label] of [['translation', '仅译文'], ['original', '原文'], ['bilingual', '对照']]) {
    await select.selectOption(value);
    assert.equal(await select.inputValue(), value);
    assert.equal(await select.locator('option:checked').textContent(), label);
    assert.equal(await paper.locator('html').getAttribute('data-zrb-display-mode'), value);
    assert.equal(await paper.locator('.zotero-bilingual-card').isVisible(), value !== 'original');
    assert.equal(await paper.locator('#figure').isVisible(), true);
    assert.equal(await paper.locator('.zrb-original-text').isVisible(), value !== 'translation');
  }
  assert.equal(await frame.locator('#zrb-display-mode-menu').count(), 0, 'no clipped HTML popup is used');
  assert.equal(await frame.locator('#reading-mode').getAttribute('class'), 'toolbar-button active');
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => loggedErrors), []);
});

test('Firefox keyboard navigation can select a state without activating Reader shortcuts', async t => {
  const { page, select, paper } = await fixture(t);
  await select.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.equal(await select.inputValue(), 'translation');
  assert.equal(await paper.locator('.zrb-original-text').isVisible(), false);
});

test('translation-only removes inline fi glyph fragments and restores prose with figures and formulas intact', async t => {
  const { page, paper, select, errors } = await fixture(t);
  await page.evaluate(() => {
    const doc = ReadingBilingual.getRealContentDoc(testReader);
    doc.body.innerHTML = `
      <p id="ligatures" data-zrb-translation-only-prepared="true"><span class="zrb-original-text">scienti</span><code id="glyph">fi</code><span class="zrb-original-text">c findings </span><span aria-hidden="true">fi</span><code><em>ffi</em></code></p>
      <div class="zotero-bilingual-card" id="translation">科学结果，变量 <code>fi</code> 保留在译文中</div>
      <p id="mixed">Original formula <math id="equation"><mi>fi</mi><mo>+</mo><mn>1</mn></math><code id="mixed-glyph">fi</code></p>
      <div class="zotero-bilingual-card">公式与图像</div>
      <figure class="sdt-image" data-ref-path="1.1"><img id="figure" width="40" height="20" alt="figure" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2240%22 height=%2220%22%3E%3Crect width=%2240%22 height=%2220%22 fill=%22blue%22/%3E%3C/svg%3E"></figure>
      <pre id="program"><code>const fi = 1;</code></pre>`;
    window.ligatureOriginal = doc.getElementById('ligatures').textContent;
  });
  await select.selectOption('translation');
  assert.equal((await paper.locator('#ligatures').innerText()).trim(), '', 'no loose fi fragments should remain above the translation');
  assert.equal(await paper.locator('#mixed-glyph').isVisible(), false);
  assert.equal(await paper.locator('#figure').isVisible(), true);
  assert.equal(await paper.locator('#equation').isVisible(), true);
  assert.equal(await paper.locator('#program').innerText(), 'const fi = 1;');
  assert.equal(await paper.locator('#translation code').isVisible(), true, 'literal fi inside the translation is valid content');
  await select.selectOption('bilingual');
  assert.equal(await paper.locator('#ligatures').textContent(), await page.evaluate(() => ligatureOriginal));
  assert.equal(await paper.locator('#glyph').isVisible(), true);
  assert.deepEqual(errors, []);
});
