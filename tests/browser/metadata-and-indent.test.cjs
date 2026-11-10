const assert = require('node:assert/strict');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { firefox } = require('playwright');

let browser;
before(async () => { browser = await firefox.launch({ headless: true }); });
after(async () => { await browser?.close(); });

async function fixture(t) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  t.after(() => page.close());
  await page.setContent(`<!doctype html><html><head><style>
    body{font:20px Georgia,serif}#sdt-content{max-width:800px;margin:auto}
    #sdt-content p{margin:1em 0} .sdt-note{font-size:.9em}
  </style></head><body><article id="sdt-content">
    <p id="author" data-ref-path="0">Qing Li <sup><a class="sdt-ref" href="#sdt-3">1</a></sup></p>
    <p id="email" data-ref-path="1">* Qing Li qing.li@example.edu.au</p>
    <p id="affiliation" data-ref-path="2">1 School of Aerospace, Mechanical and Mechatronic Engineering, University of Sydney</p>
    <aside id="editor" class="sdt-note" data-ref-path="3" data-back-refs="0">Communicated by Liwei Wang.</aside>
    <h2 id="intro" data-ref-path="4">1. Introduction</h2>
    <p id="body" data-ref-path="5">The method is described in the main text.</p>
    <aside id="footnote" class="sdt-note" data-ref-path="7" data-back-refs="5"><span><sup>2</sup> This is a long explanatory note with a preserved <a href="https://example.org/" id="note-link">link</a>.</span><ul id="note-list"><li>First note item</li><li>Second note item</li></ul></aside>
    <ul id="ordinary-list"><li>List content is not a body paragraph.</li></ul>
    <figcaption id="caption">Figure 1 A centered figure caption</figcaption>
    <figure id="figure"><svg viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg></figure>
    <div id="formula" class="sdt-math">x + y = z</div>
    <table id="table"><tbody><tr><td>Cell content</td></tr></tbody></table>
    <pre id="code">const x = 1;</pre>
    <aside id="untyped">An aside without an SDT note type stays unchanged.</aside>
  </article></body></html>`);
  for (const file of ['translation-renderer.js', 'reading-bilingual.js']) {
    await page.addScriptTag({ path: path.resolve(__dirname, '../../content/scripts', file) });
  }
  await page.evaluate(() => {
    window.Zotero = { debug() {}, logError() {}, Prefs: { get() {} } };
    ReadingBilingual.getFontSize = () => '20px';
    ReadingBilingual.getFontFamily = () => 'serif';
    ReadingBilingual.getFrameTheme = () => 'indigo';
    ReadingBilingual.getBorderStyle = () => 'straight';
    const authorCard = ReadingBilingual.createCardElement({}, document, 'author source', '李清，已有译文');
    authorCard.id = 'author-card';
    ReadingBilingual.prepareTranslationCard(document.getElementById('author'), authorCard);
    document.getElementById('author').after(authorCard);
    const noteCard = ReadingBilingual.createCardElement({}, document, 'footnote source', '脚注已有译文');
    noteCard.id = 'footnote-card';
    document.getElementById('footnote').after(noteCard);
    for (const [id, sourceId, text] of [['body-card', 'body', '这是正文译文。'], ['list-card', 'ordinary-list', '列表译文。'], ['caption-card', 'caption', '图注译文。']]) {
      const source = document.getElementById(sourceId);
      source.after(ReadingBilingual.createCardElement({}, document, source.textContent, text));
      source.nextElementSibling.id = id;
      ReadingBilingual.prepareTranslationCard(source, source.nextElementSibling);
    }
    const style = document.createElement('style');
    style.id = 'zotero-bilingual-style';
    style.textContent = ReadingBilingual.getGeneratedCSS();
    document.head.append(style);
  });
  return page;
}

test('Chinese prose indentation follows paragraph meaning and leaves source and non-prose layout alone', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(() => {
    const css = id => getComputedStyle(document.getElementById(id).querySelector('.zrb-card-content'));
    const p = document.createElement('p');
    p.dataset.refPath = '9';
    p.textContent = 'English source paragraph';
    document.getElementById('sdt-content').append(p);
    const englishCard = ReadingBilingual.createCardElement({}, document, p.textContent, 'English only');
    p.after(englishCard);
    ReadingBilingual.prepareTranslationCard(p, englishCard);
    const spacedSource = document.createElement('p');
    spacedSource.textContent = 'Source with existing leading space';
    document.getElementById('sdt-content').append(spacedSource);
    const spaced = ReadingBilingual.createCardElement({}, document, spacedSource.textContent, '　译文已有全角空格');
    spaced.id = 'spaced-card';
    spacedSource.after(spaced);
    ReadingBilingual.prepareTranslationCard(spacedSource, spaced);
    const structured = ReadingBilingual.createCardElement({}, document, 'Source paragraph', '- 列表条目\n\n$$x+y=z$$');
    structured.id = 'structured-card';
    p.after(structured);
    ReadingBilingual.prepareTranslationCard(p, structured);
    structured.querySelector('.zrb-card-content').innerHTML = '<div class="zrb-rich-text"><ul><li>列表条目</li></ul><p>公式 <span class="katex">x+y=z</span></p></div>';
    ReadingBilingual.updateChineseFirstLineIndent(structured);
    return {
      proseIndent: css('body-card').textIndent,
      listIndent: css('list-card').textIndent,
      captionIndent: css('caption-card').textIndent,
      englishIndent: getComputedStyle(englishCard.querySelector('.zrb-card-content')).textIndent,
      sourceIndent: getComputedStyle(document.getElementById('body')).textIndent,
      spacedIndent: getComputedStyle(spaced.querySelector('.zrb-card-content')).textIndent,
      structuredIndent: getComputedStyle(structured.querySelector('.zrb-card-content li')).textIndent,
    };
  });
  assert.equal(result.proseIndent, '40px');
  assert.equal(result.listIndent, '0px');
  assert.equal(result.captionIndent, '0px');
  assert.equal(result.englishIndent, '0px');
  assert.equal(result.sourceIndent, '0px');
  assert.equal(result.spacedIndent, '0px', 'leading ideographic spaces are not doubled by CSS indentation');
  assert.equal(result.structuredIndent, '0px', 'Markdown list output stays flush');

  await page.evaluate(() => ReadingBilingual.applyReaderDisplayMode(document, 'translation'));
  assert.equal(await page.locator('#body-card').isVisible(), true);
  await page.evaluate(() => ReadingBilingual.applyReaderDisplayMode(document, 'bilingual'));
  assert.equal(await page.locator('#body-card').isVisible(), true);
  await page.locator('#body-card .zrb-card-content').dblclick();
  await page.locator('#body-card textarea').fill('修订后的正文译文');
  await page.locator('#body-card .zrb-save-edit-btn').click();
  assert.equal(await page.locator('#body-card .zrb-card-content').textContent(), '修订后的正文译文');
  assert.equal(await page.locator('#body-card .zrb-card-content').evaluate(el => getComputedStyle(el).textIndent), '40px');
});

test('author metadata stays in place while linked footnotes collapse and preserve existing content', async t => {
  const page = await fixture(t);
  const before = await page.evaluate(() => {
    const root = document.getElementById('sdt-content');
    const legacy = document.createElement('details');
    legacy.id = 'zrb-author-info';
    legacy.dataset.zrbNoteKind = 'author';
    const summary = document.createElement('summary');
    summary.textContent = '作者信息';
    const body = document.createElement('div');
    body.className = 'zrb-collapsible-note-body';
    legacy.append(summary, body);
    const author = document.getElementById('author');
    const authorCard = document.getElementById('author-card');
    root.insertBefore(legacy, author);
    body.append(author, authorCard);
    ReadingBilingual.prepareStructuredNotes(document);
    ReadingBilingual.prepareStructuredNotes(document);
    return {
      groups: Array.from(document.querySelectorAll('details.zrb-collapsible-note')).map(d => ({
        kind: d.dataset.zrbNoteKind,
        label: d.querySelector('summary').textContent,
        open: d.open,
        ids: Array.from(d.querySelectorAll('[id]')).map(el => el.id),
        text: d.textContent,
      })),
      untyped: document.getElementById('untyped').parentElement === document.getElementById('sdt-content'),
      order: Array.from(document.getElementById('sdt-content').children).map(el => el.id),
      backrefs: document.getElementById('footnote').dataset.backRefs,
      authorParents: ['author', 'email', 'affiliation', 'editor'].map(id => document.getElementById(id).parentElement.id),
      authorSourceFlags: ['author', 'email', 'affiliation', 'editor'].map(id => document.getElementById(id).classList.contains('zrb-author-info-source')),
    };
  });
  assert.equal(before.groups.length, 1, JSON.stringify(before.groups));
  assert.deepEqual(before.groups.map(g => g.kind), ['footnote']);
  assert.deepEqual(before.groups.map(g => g.label), ['脚注 2']);
  assert.equal(before.groups[0].open, false);
  assert.ok(before.groups[0].text.includes('First note item'));
  assert.ok(before.groups[0].ids.includes('note-link'));
  assert.ok(before.groups[0].ids.includes('footnote-card'));
  assert.equal(before.backrefs, '5');
  assert.equal(before.untyped, true);
  assert.deepEqual(before.authorParents, ['sdt-content', 'sdt-content', 'sdt-content', 'sdt-content']);
  assert.deepEqual(before.authorSourceFlags, [true, true, true, true]);
  assert.ok(before.order.indexOf('author') < before.order.indexOf('intro'));
  assert.equal(before.order.includes('zrb-author-info'), false);
  assert.ok(before.order.indexOf('footnote') < before.order.indexOf('ordinary-list'));

  for (const mode of ['original', 'bilingual', 'translation']) {
    await page.evaluate(mode => ReadingBilingual.applyReaderDisplayMode(document, mode), mode);
    assert.equal(await page.locator('details[data-zrb-note-kind="author"]').count(), 0, `${mode}: author disclosure is removed`);
    assert.equal(await page.locator('[data-zrb-note-kind="footnote"] > summary').isVisible(), true, `${mode}: footnote summary stays visible`);
  }
  await page.evaluate(() => ReadingBilingual.applyReaderDisplayMode(document, 'bilingual'));

  await page.locator('[data-zrb-note-kind="footnote"] > summary').click();
  assert.equal(await page.locator('[data-zrb-note-kind="footnote"]').evaluate(el => el.open), true);
  await page.evaluate(() => ReadingBilingual.applyReaderDisplayMode(document, 'translation'));
  assert.equal(await page.locator('[data-zrb-note-kind="footnote"]').evaluate(el => el.open), true);
  for (const id of ['ordinary-list', 'caption', 'figure', 'formula', 'table', 'code', 'untyped']) {
    assert.equal(await page.locator(`#${id}`).count(), 1, id);
  }
  assert.deepEqual(await page.locator('#note-link').getAttribute('href'), 'https://example.org/');
  assert.equal(await page.locator('#footnote-card .zrb-card-content').textContent(), '脚注已有译文');
  assert.equal(await page.locator('#author-card .zrb-card-content').textContent(), '李清，已有译文');
  assert.equal(await page.locator('#author-card .zrb-card-content').evaluate(el => getComputedStyle(el).textIndent), '0px');

  const cachedAdded = await page.evaluate(() => ReadingBilingual.injectCachedMetadataTranslations(document, {
    '* Qing Li qing.li@example.edu.au': '通讯作者：李清，邮箱 qing.li@example.edu.au',
    '1 School of Aerospace, Mechanical and Mechatronic Engineering, University of Sydney': '悉尼大学航空、机械与机电工程学院',
  }, {}));
  assert.equal(cachedAdded, 2, 'metadata translations are restored from cache without requesting a model');
  assert.equal(await page.locator('.zrb-metadata-translation-card').count(), 2);
  assert.equal(await page.locator('#email + .zrb-metadata-translation-card .zrb-card-content').textContent(), '通讯作者：李清，邮箱 qing.li@example.edu.au');
  assert.equal(await page.locator('#affiliation + .zrb-metadata-translation-card .zrb-card-content').textContent(), '悉尼大学航空、机械与机电工程学院');
  await page.locator('#footnote-card .zrb-btn-edit').click();
  await page.locator('#footnote-card textarea').fill('编辑后的脚注译文');
  await page.locator('#footnote-card .zrb-save-edit-btn').click();
  assert.equal(await page.locator('#footnote-card .zrb-card-content').textContent(), '编辑后的脚注译文');
});

test('list items linked by unreliable SDT back-references stay outside author and footnote folds', async t => {
  const page = await fixture(t);
  await page.evaluate(() => {
    const root = document.getElementById('sdt-content');
    root.innerHTML = `
      <p id="author-line" data-ref-path="0">Qing Li <sup><a class="sdt-ref" href="#editor-note">1</a></sup></p>
      <aside id="editor-note" class="sdt-note" data-ref-path="1" data-back-refs="0 2 3">Communicated by Liwei Wang.</aside>
      <p id="bullet-one" data-ref-path="2">• The law of the mean line,</p>
      <p id="bullet-two" data-ref-path="3">• The distribution of thickness perpendicular to the mean line.</p>
      <aside id="bullet-note" class="sdt-note" data-ref-path="4" data-back-refs="1">• The law of the mean line,</aside>
      <h2 id="intro" data-ref-path="5">1. Introduction</h2>
      <p id="body" data-ref-path="6">The method is described in the main text.</p>
      <aside id="footnote" class="sdt-note" data-ref-path="7" data-back-refs="6"><sup>1</sup> A genuine explanatory footnote.</aside>`;
    ReadingBilingual.prepareStructuredNotes(document);
  });

  const result = await page.evaluate(() => ({
    authors: Array.from(document.querySelectorAll('details[data-zrb-note-kind="author"]')).map(el => el.textContent),
    footnotes: Array.from(document.querySelectorAll('details[data-zrb-note-kind="footnote"]')).map(el => ({
      label: el.querySelector('summary').textContent,
      text: el.querySelector('.zrb-collapsible-note-body').textContent,
    })),
    bulletParents: ['bullet-one', 'bullet-two', 'bullet-note'].map(id => document.getElementById(id).parentElement.id),
    bulletAuthorSources: ['bullet-one', 'bullet-two'].map(id => document.getElementById(id).dataset.zrbAuthorInfoSource || null),
  }));

  assert.equal(result.authors.length, 0);
  assert.deepEqual(result.footnotes, [{ label: '脚注 1', text: '1 A genuine explanatory footnote.' }]);
  assert.deepEqual(result.bulletParents, ['sdt-content', 'sdt-content', 'sdt-content']);
  assert.deepEqual(result.bulletAuthorSources, [null, null]);
});

test('Reader display mode selection persists and is restored in a newly opened document', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const values = new Map();
    Zotero.Prefs = {
      // Zotero prepends its branch unless the caller passes global=true.
      get(key, global) { return values.get(global ? key : 'extensions.zotero.' + key); },
      set(key, value, global) { values.set(global ? key : 'extensions.zotero.' + key, value); },
    };
    const currentReader = { _internalReader: { _primarySDTView: { _iframeDocument: document } }, _iframeWindow: { document } };
    await ReadingBilingual.setReaderDisplayMode(currentReader, 'translation');

    const reopenedDoc = document.implementation.createHTMLDocument('reopened');
    reopenedDoc.body.innerHTML = '<article id="sdt-content"><p data-ref-path="0">A source paragraph for the reopened Reader.</p></article>';
    const reopenedReader = { _internalReader: { _primarySDTView: { _iframeDocument: reopenedDoc } }, _iframeWindow: { document } };
    ReadingBilingual.getApiKey = () => '';
    ReadingBilingual.loadCache = async () => ({});
    window.Services = { prompt: { alert() {} } };
    await ReadingBilingual.translateReader(reopenedReader, reopenedDoc, false, false);
    return {
      saved: values.get(ReadingBilingual.PREF_READER_DISPLAY_MODE),
      restored: reopenedDoc.documentElement.dataset.zrbDisplayMode,
      translationOnly: reopenedDoc.documentElement.classList.contains('zrb-translation-only'),
    };
  });
  assert.deepEqual(result, { saved: 'translation', restored: 'translation', translationOnly: true });
});

test('a reopened SDT document restores the saved mode even when its outer Reader observer already exists', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(() => {
    Zotero.Prefs = { get: () => 'translation' };
    ReadingBilingual.scheduleAutoTranslate = () => {};
    ReadingBilingual.setupSelectionContextMenu = () => {};
    ReadingBilingual.prepareTranslationRetries = () => {};
    const firstDoc = document.implementation.createHTMLDocument('first Reader view');
    firstDoc.body.innerHTML = '<article id="sdt-content"><p>First view</p></article>';
    const secondDoc = document.implementation.createHTMLDocument('reopened Reader view');
    secondDoc.body.innerHTML = '<article id="sdt-content"><p>Reopened view</p></article>';
    const ordinaryPdfDoc = document.implementation.createHTMLDocument('ordinary PDF view');
    ordinaryPdfDoc.body.innerHTML = '<div class="textLayer"><p>PDF page text</p></div>';
    let currentDoc = firstDoc;
    ReadingBilingual.getRealContentDoc = () => currentDoc;
    const reader = {};
    ReadingBilingual.setupReadingModeObserver(reader, document);
    currentDoc = secondDoc;
    ReadingBilingual.setupReadingModeObserver(reader, document);
    return {
      firstMode: firstDoc.documentElement.dataset.zrbDisplayMode,
      reopenedMode: secondDoc.documentElement.dataset.zrbDisplayMode,
      translationOnly: secondDoc.documentElement.classList.contains('zrb-translation-only'),
      ordinaryPdfUntouched: !ordinaryPdfDoc.documentElement.dataset.zrbDisplayMode && !ordinaryPdfDoc.documentElement.classList.contains('zrb-translation-only'),
    };
  });
  assert.deepEqual(result, { firstMode: 'translation', reopenedMode: 'translation', translationOnly: true, ordinaryPdfUntouched: true });
});

test('uncertain first-page metadata stays in its existing layout', async t => {
  const page = await fixture(t);
  await page.evaluate(() => {
    const root = document.getElementById('sdt-content');
    root.innerHTML = '<p id="unbounded-email" data-ref-path="0">qing.li@example.edu.au</p>' +
      '<aside id="unbounded-note" class="sdt-note" data-ref-path="1" data-back-refs="0">School of Engineering</aside>';
    ReadingBilingual.prepareStructuredNotes(document);
  });
  assert.equal(await page.locator('#zrb-author-info').count(), 0);
  assert.equal(await page.locator('#unbounded-email').evaluate(el => el.parentElement.id), 'sdt-content');
  assert.equal(await page.locator('#unbounded-note details[data-zrb-note-kind="footnote"] > summary').textContent(), '脚注 1');
});

test('SDT notes fold without a translation key or a model request', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    let alerts = 0;
    window.Services = { prompt: { alert() { alerts++; } } };
    ReadingBilingual.getApiKey = () => '';
    ReadingBilingual.loadCache = async () => ({});
    await ReadingBilingual.translateReader({}, document, false, false);
    return {
      authors: document.querySelectorAll('details[data-zrb-note-kind="author"]').length,
      footnotes: document.querySelectorAll('details[data-zrb-note-kind="footnote"]').length,
      closed: Array.from(document.querySelectorAll('details.zrb-collapsible-note')).every(el => !el.open),
      alerts,
    };
  });
  assert.equal(result.authors, 0);
  assert.equal(result.footnotes, 1);
  assert.equal(result.closed, true);
  assert.equal(result.alerts, 1);
});
