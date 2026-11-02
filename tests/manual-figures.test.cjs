const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');

function fixture() {
  const files = new Map();
  const io = {
    async read(key) { if (!files.has(key)) throw Object.assign(new Error('absent'), { name: 'NotFoundError' }); return files.get(key); },
    async write(key, bytes) { files.set(key, bytes); },
    join: key => key,
  };
  const scope = { TextEncoder, TextDecoder, Uint8Array, atob, btoa, setTimeout, clearTimeout, crypto: crypto.webcrypto };
  for (const file of ['figure-cache.js', 'pdf-figure-fallback.js', 'manual-figure-store.js', 'manual-figures.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../content/scripts', file), 'utf8'), scope);
  }
  const digest = async bytes => crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
  const store = scope.ZRBManualFigureStore.create({ io, digest });
  scope.ZRBManualFigures.store = store;
  return { scope, store, files, io };
}

const record = () => ({ id: 'caption:4', structure: 'layout-v1',
  anchor: { kind: 'caption', ref: '4', signature: 'caption-signature' },
  replacements: [{ kind: 'native', ref: '3', signature: 'native-signature' }],
  regions: [{ pageIndex: 0, rect: [20, 30, 100, 90] }, { pageIndex: 1, rect: [25, 40, 120, 180] }] });

test('manual correction records survive fresh stores, remain separate from PNG cache and isolate PDF changes', async () => {
  const { scope, store, io } = fixture();
  await store.put('library:item', 'pdf-a', record());
  const fresh = scope.ZRBManualFigureStore.create({ io, digest: store.digest });
  assert.equal((await fresh.list('library:item', 'pdf-a')).length, 1);
  assert.equal((await fresh.list('library:item', 'pdf-b')).length, 0);
  const value = (await fresh.list('library:item', 'pdf-a'))[0];
  assert.deepEqual(JSON.parse(JSON.stringify(value.regions)), record().regions);
  await fresh.remove('library:item', 'pdf-a', value.id);
  assert.equal((await fresh.list('library:item', 'pdf-a')).length, 0);
});

test('concurrent edits to different figures retain both records and repeated edits replace one record', async () => {
  const { store } = fixture();
  await Promise.all([store.put('item', 'pdf', record()), store.put('item', 'pdf', { ...record(), id: 'caption:8' })]);
  await store.put('item', 'pdf', { ...record(), regions: [{ pageIndex: 1, rect: [1, 2, 3, 4] }] });
  const records = await store.list('item', 'pdf');
  assert.equal(records.length, 2);
  assert.equal(records.find(r => r.id === 'caption:4').regions.length, 1);
});

function stateFixture(scope) {
  const dom = new JSDOM('<article id="sdt-content"><p id="body">Body <a href="#">link</a></p><figure class="sdt-image" data-ref-path="3"><img></figure><figure class="sdt-image" data-ref-path="5"><img></figure><figure class="zrb-pdf-figure-fallback" data-source-ref="4" data-page-index="0" data-state="error">Failed</figure><figcaption data-ref-path="4">Figure 18</figcaption><div class="zotero-bilingual-card">图18 译文</div><figure class="sdt-math" data-ref-path="6">Formula</figure><table data-ref-path="7"><tr><td>Table</td></tr></table></article>');
  const doc = dom.window.document;
  const structure = { metadata: { processor: { type: 'pdf' }, source: { hash: 'pdf' } }, catalog: { pages: [{ viewBox: [0, 0, 600, 800] }, { viewBox: [0, 0, 600, 800], rotation: 90 }] }, content: [] };
  structure.content[3] = { type: 'image', anchor: { pageRects: [[0, 20, 30, 100, 90]] } };
  structure.content[4] = { type: 'caption', content: [{ text: 'Figure 18' }], anchor: { pageRects: [[0, 20, 10, 100, 25]] } };
  structure.content[5] = { type: 'image', anchor: { pageRects: [[1, 25, 40, 120, 180]] } };
  structure.content[6] = { type: 'math' };
  structure.content[7] = { type: 'table' };
  const reader = { itemID: 1, _internalReader: { _sdt: { structure }, _primarySDTView: { _iframeDocument: doc }, _primaryView: {} } };
  const manager = scope.ZRBManualFigures;
  manager.renderExact = async (_state, region) => ({ src: 'data:image/png;base64,eA==', width: 80, height: 60, displayWidth: 80, rect: region.rect, direction: 'above' });
  manager.decode = async () => {};
  manager.ensure(reader);
  return { manager, state: manager.states.get(doc), doc, dom };
}

test('cross-page correction replaces only confirmed graphics, stays above caption and can restore every original', async () => {
  const { scope } = fixture();
  const { manager, state, doc } = stateFixture(scope);
  await state.ready;
  const fragmentA = manager.entry(state, '3'), fragmentB = manager.entry(state, '5'), sharedCaption = manager.entry(state, '4');
  state.entries = [fragmentA, fragmentB, sharedCaption, ...state.entries.filter(item => ![fragmentA, fragmentB, sharedCaption].includes(item))];
  const target = manager.targetFor(state, doc.querySelector('[data-ref-path="3"]'));
  assert.equal(target.anchor.kind, 'caption', 'an extracted fragment on the preceding page resolves to the shared figure caption');
  assert.ok(target.scopeCandidates.some(item => item.ref === '5'), 'cross-page fragments are available in one replacement scope');
  const draft = { ...target, regions: record().regions,
    replacements: manager.candidates(state).filter(c => c.ref === '3' || c.ref === '5' || c.kind === 'fallback') };
  const preserved = ['#body', '[data-ref-path="6"]', 'table', 'figcaption', '.zotero-bilingual-card'].map(s => doc.querySelector(s).outerHTML);
  await manager.apply(state, draft);
  assert.equal(doc.querySelectorAll('.zrb-manual-figure img').length, 2);
  assert.equal(doc.querySelector('.zrb-manual-figure').nextElementSibling.tagName, 'FIGCAPTION');
  assert.equal(doc.querySelectorAll('[data-zrb-manual-hidden]').length, 3);
  assert.deepEqual(['#body', '[data-ref-path="6"]', 'table', 'figcaption', '.zotero-bilingual-card'].map(s => doc.querySelector(s).outerHTML), preserved);
  await manager.apply(state, { ...draft, regions: [record().regions[1]], replacements: draft.replacements.filter(item => item.ref !== '3') });
  assert.equal(doc.querySelectorAll('.zrb-manual-figure').length, 1);
  assert.equal(doc.querySelectorAll('.zrb-manual-figure img').length, 1);
  await manager.restoreOriginal(state, draft.id);
  assert.equal(doc.querySelectorAll('.zrb-manual-figure,[data-zrb-manual-hidden]').length, 0);
  manager.shutdown();
});

test('a DOM insertion failure while recropping keeps the prior picture and durable regions', async () => {
  const { scope, store } = fixture();
  const { manager, state, doc } = stateFixture(scope); await state.ready;
  const target = manager.targetFor(state, doc.querySelector('[data-ref-path="3"]'));
  const first = { ...target, regions: [record().regions[0]] };
  await manager.apply(state, first);
  const previousFigure = doc.querySelector('.zrb-manual-figure');
  const originalRecord = JSON.stringify((await store.list(state.documentID, state.fingerprint))[0]);
  const anchor = manager.resolve(state, first.anchor), before = anchor.before;
  anchor.before = () => { throw new Error('insertion failed'); };
  await assert.rejects(manager.apply(state, { ...first, regions: [record().regions[1]] }), /insertion failed/);
  anchor.before = before;
  assert.equal(doc.querySelector('.zrb-manual-figure'), previousFigure);
  assert.equal(JSON.stringify((await store.list(state.documentID, state.fingerprint))[0]), originalRecord);
  assert.equal(doc.querySelector('[data-ref-path="3"]').dataset.zrbManualHidden, first.id);
  manager.shutdown();
});

test('native orphan images remain operable and failed rendering or a closed view cannot replace the old display', async () => {
  const { scope } = fixture();
  const { manager, state, doc } = stateFixture(scope);
  await state.ready;
  const orphan = doc.querySelector('[data-ref-path="5"]');
  const target = manager.targetFor(state, orphan);
  assert.equal(target.anchor.kind, 'native');
  const draft = { ...target, regions: [record().regions[1]], replacements: [manager.locate(state, orphan)] };
  manager.renderExact = async () => { throw new Error('PDF renderer failed'); };
  await assert.rejects(manager.apply(state, draft), /PDF renderer failed/);
  assert.equal(doc.querySelectorAll('[data-zrb-manual-hidden],.zrb-manual-figure').length, 0);
  let release;
  manager.renderExact = () => new Promise(resolve => { release = resolve; });
  const pending = manager.apply(state, draft);
  await new Promise(setImmediate);
  manager.dispose(state);
  release({ src: 'data:image/png;base64,eA==', width: 80, height: 60, displayWidth: 80 });
  await assert.rejects(pending, /关闭|取消|closed/);
  assert.equal(doc.querySelectorAll('[data-zrb-manual-hidden],.zrb-manual-figure').length, 0);
});

test('manual geometry rejects invalid, out-of-page, empty and unsafe replacement regions', async () => {
  const { scope } = fixture();
  const { manager, state, doc } = stateFixture(scope);
  await state.ready;
  for (const region of [{ pageIndex: 8, rect: [1, 2, 3, 4] }, { pageIndex: 0, rect: [0, 0, 0, 2] }, { pageIndex: 0, rect: [0, 0, 900, 800] }, { pageIndex: 0, rect: [NaN, 2, 3, 4] }]) {
    assert.throws(() => manager.validateRegions(state, [region]));
  }
  assert.equal(manager.locate(state, doc.querySelector('table')), null);
  assert.equal(manager.locate(state, doc.querySelector('.sdt-math')), null);
  manager.shutdown();
});

test('PDF/preview coordinates round-trip at every rotation including nonzero page origins', () => {
  const { scope } = fixture();
  const rect = [35, 61, 455, 709], bounds = [10, 20, 610, 820];
  for (const angle of [0, 90, 180, 270]) {
    const unit = scope.ZRBManualFigures.normalizedRect(rect, bounds, angle);
    const restored = scope.ZRBPDFFigureFallback.mapTrimToPDF(bounds, unit, angle);
    restored.forEach((value, i) => assert.ok(Math.abs(value - rect[i]) < .00001));
  }
});

test('partial native PDF composites keep their unselected surrounding figure pixels and restore prior styles', async () => {
  const { scope } = fixture();
  const { manager, state, doc } = stateFixture(scope);
  await state.ready;
  const original = doc.querySelector('[data-ref-path="3"]'); original.className = 'sdt-source-crop';
  original.style.setProperty('mask-size', '80% 90%');
  state.entries.push({ ref: [9], block: { type: 'caption', content: [{ text: 'Figure 17' }], anchor: { pageRects: [[0, 20, 70, 100, 80]] } } });
  manager.pageInfo = async () => ({ bounds: [0, 0, 600, 800], rotation: 0 });
  const target = manager.targetFor(state, original);
  const draft = { ...target, anchor: { kind: 'caption', ref: '4', signature: manager.signature(state, '4') },
    regions: [{ pageIndex: 0, rect: [20, 30, 100, 60] }], replacements: [manager.locate(state, original)] };
  await manager.apply(state, draft);
  assert.equal(original.hasAttribute('data-zrb-manual-hidden'), false);
  assert.equal(original.dataset.zrbManualMasked, draft.id);
  assert.match(decodeURIComponent(original.style.maskImage), /y="0.5".*height="0.5"/);
  await manager.restoreOriginal(state, draft.id);
  assert.equal(original.style.maskImage, '');
  assert.equal(original.style.maskSize, '80% 90%');
  assert.equal(original.hasAttribute('data-zrb-manual-masked'), false);
  manager.shutdown();
});

test('a same-document SDT rebuild restores decisions and a changed PDF fingerprint never reuses old coordinates', async () => {
  const { scope } = fixture();
  const { manager, state, doc } = stateFixture(scope);
  await state.ready;
  const target = manager.targetFor(state, doc.querySelector('[data-ref-path="3"]'));
  const markup = doc.querySelector('#sdt-content').outerHTML;
  await manager.apply(state, { ...target, regions: [record().regions[0]] });
  const reader = state.reader;
  doc.querySelector('#sdt-content').outerHTML = markup;
  manager.ensure(reader);
  const reopened = manager.states.get(doc); await reopened.ready;
  assert.notEqual(reopened, state);
  assert.equal(doc.querySelectorAll('.zrb-manual-figure').length, 1);
  reader._internalReader._sdt.structure.metadata.source.hash = 'changed-pdf';
  manager.ensure(reader); await manager.states.get(doc).ready;
  assert.equal(doc.querySelectorAll('.zrb-manual-figure,[data-zrb-manual-hidden]').length, 0);
  manager.shutdown();
});

test('a later render failure releases images already decoded in the abandoned transaction', async () => {
  const { scope } = fixture();
  const { manager, state, doc } = stateFixture(scope); await state.ready;
  const created = [], create = doc.createElement.bind(doc);
  doc.createElement = tag => { const element = create(tag); if (tag === 'img') created.push(element); return element; };
  let calls = 0;
  manager.decode = async (img, src) => { img.src = src; };
  manager.renderExact = async () => { if (++calls > 1) throw new Error('second page failed'); return { src: 'data:image/png;base64,eA==', width: 80, height: 60, displayWidth: 80 }; };
  await assert.rejects(manager.prepareImages(state, record().regions), /second page failed/);
  assert.equal(created.length, 1);
  assert.equal(created[0].hasAttribute('src'), false);
  manager.shutdown();
});

test('cancelling during a disk write rolls back before a newer plugin instance saves', async () => {
  const { scope, store, io } = fixture();
  let alive = true, release, entered;
  const inWrite = new Promise(resolve => { entered = resolve; });
  const write = io.write;
  let paused = false;
  io.write = async (key, value) => {
    if (!paused) { paused = true; entered(); await new Promise(resolve => { release = resolve; }); }
    await write(key, value);
  };
  const old = store.put('item', 'pdf', record(), () => alive);
  // Attach the rejection handler before unblocking the native write.
  const rejected = assert.rejects(old, /取消/);
  await inWrite;
  const next = scope.ZRBManualFigureStore.create({ io, digest: store.digest, serial: store.serial });
  const saved = next.put('item', 'pdf', { ...record(), id: 'newer' });
  alive = false; release();
  await rejected; await saved;
  assert.deepEqual(JSON.parse(JSON.stringify(await next.list('item', 'pdf'))).map(r => r.id), ['newer']);
});

test('a standalone native image without a caption can be cropped smaller and restored at its original location', async () => {
  const { scope } = fixture();
  const { manager, state, doc } = stateFixture(scope); await state.ready;
  const original = doc.querySelector('[data-ref-path="5"]');
  const draft = { ...manager.targetFor(state, original), regions: [{ pageIndex: 1, rect: [60, 80, 100, 120] }] };
  await manager.apply(state, draft);
  assert.equal(doc.querySelector('.zrb-manual-figure').nextElementSibling, original);
  assert.equal(original.dataset.zrbManualHidden, draft.id);
  await manager.restoreOriginal(state, draft.id);
  assert.equal(original.hasAttribute('data-zrb-manual-hidden'), false);
  manager.shutdown();
});

test('missing and later fallback frames cannot block restoring a manual correction or duplicate its picture', async () => {
  const { scope } = fixture();
  const { manager, state, doc } = stateFixture(scope); await state.ready;
  const draft = manager.targetFor(state, doc.querySelector('.zrb-pdf-figure-fallback'));
  draft.regions = [record().regions[0]];
  await manager.apply(state, draft);
  manager.shutdown();
  doc.querySelector('.zrb-pdf-figure-fallback').remove();
  manager.ensure(state.reader);
  const next = manager.states.get(doc); await next.ready;
  assert.equal(doc.querySelectorAll('.zrb-manual-figure').length, 1);
  const late = doc.createElement('figure'); late.className = 'zrb-pdf-figure-fallback'; late.dataset.sourceRef = '4'; late.dataset.pageIndex = '0';
  doc.querySelector('figcaption').before(late);
  manager.ensure(state.reader);
  assert.equal(late.dataset.zrbManualHidden, draft.id);
  await manager.restoreOriginal(next, draft.id);
  assert.equal(late.hasAttribute('data-zrb-manual-hidden'), false);
  manager.shutdown();
});

test('destroyed Reader views cannot retain or recreate manual image resources on the sweep', async () => {
  const { scope } = fixture();
  const { manager, state, doc } = stateFixture(scope); await state.ready;
  const draft = manager.targetFor(state, doc.querySelector('[data-ref-path="3"]'));
  await manager.apply(state, { ...draft, regions: [record().regions[0]] });
  state.reader._internalReader._primarySDTView._destroyed = true;
  manager.sync([state.reader]);
  assert.equal(manager.states.size, 0);
  assert.equal(manager.residentBytes(), 0);
  assert.equal(doc.querySelectorAll('.zrb-manual-figure,.zrb-figure-edit-control,[data-zrb-manual-hidden]').length, 0);
  manager.sync([state.reader]);
  assert.equal(manager.states.size, 0);
});

test('only explicitly confirmed, fully enclosed auxiliary label groups may hide with their matched translations', async () => {
  const { scope } = fixture();
  const { manager, state, doc } = stateFixture(scope); await state.ready;
  for (const [ref, flowClass, linked] of [['8', 'auxiliary', false], ['9', 'main', false], ['10', 'auxiliary', true]]) {
    state.entries.push({ ref: [Number(ref)], block: { type: 'paragraph', flowClass, content: [{ text: 'Rib 1 Rib 2' }], anchor: { pageRects: [[0, 25, 35, 80, 50]] } } });
    const p = doc.createElement('p'); p.dataset.refPath = ref; p.innerHTML = linked ? '<a href="#">Rib 1 Rib 2</a>' : 'Rib 1 Rib 2';
    doc.querySelector('figcaption').before(p);
    if (ref === '8') {
      const card = doc.createElement('div'); card.className = 'zotero-bilingual-card'; card.dataset.origText = p.textContent;
      card.id = 'label-translation'; card.textContent = '翼肋1、翼肋2'; p.after(card);
    }
  }
  const regions = [record().regions[0]], labels = manager.candidates(state, regions).filter(c => c.kind === 'label');
  assert.deepEqual(Array.from(labels, c => c.ref), ['8']);
  assert.equal(manager.candidates(state).some(c => c.kind === 'label'), false, 'no label may be implicitly selected');
  const target = manager.targetFor(state, doc.querySelector('[data-ref-path="3"]'));
  await manager.apply(state, { ...target, regions, replacements: [...target.replacements, labels[0]] });
  assert.equal(doc.querySelector('[data-ref-path="8"]').dataset.zrbManualHidden, target.id);
  assert.equal(doc.querySelector('#label-translation').dataset.zrbManualHidden, target.id);
  assert.equal(doc.querySelector('[data-ref-path="9"]').hasAttribute('data-zrb-manual-hidden'), false);
  assert.equal(doc.querySelector('[data-ref-path="10"] a').textContent, 'Rib 1 Rib 2');
  assert.equal(doc.querySelector('figcaption').hasAttribute('data-zrb-manual-hidden'), false);
  await manager.restoreOriginal(state, target.id);
  assert.equal(doc.querySelectorAll('[data-zrb-manual-hidden]').length, 0);
  assert.equal(doc.querySelector('#label-translation').textContent, '翼肋1、翼肋2');
  manager.shutdown();
});
