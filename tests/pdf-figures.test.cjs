const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');

function setup(blocks, render, initialMode) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="sdt-content"></div></body></html>');
  const doc = dom.window.document;
  blocks.forEach((block, i) => {
    const el = doc.createElement(block.type === 'caption' ? 'figcaption' : 'figure');
    el.dataset.refPath = String(i);
    el.textContent = block.content?.map(node => node.text).join('') || '';
    doc.querySelector('#sdt-content').append(el);
  });
  let mode = arguments.length >= 3 ? initialMode : 'auto';
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 100, bottom: 200, width: 200, height: 100 });
  const scope = { console, TextEncoder, TextDecoder, atob, btoa, crypto: require('node:crypto').webcrypto,
    Zotero: { logError() {}, Prefs: { get() { return mode; } } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../content/scripts/figure-cache.js'), 'utf8'), scope);
  scope.ZRBFigureCache.digest = async bytes => require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../content/scripts/pdf-figure-fallback.js'), 'utf8'), scope);
  const structure = { metadata: { processor: { type: 'pdf' } },
    catalog: { pages: Array.from({ length: 12 }, () => ({ viewRect: [0, 0, 600, 800] })) }, content: blocks };
  const view = { _iframeDocument: doc };
  const renderer = { renderRegionCrops: render || (async () => { throw new Error('missing page'); }) };
  const reader = { _internalReader: { _sdt: { structure }, _primarySDTView: view,
    _primaryView: { _pdfRenderer: renderer, _iframeWindow: {} } } };
  return { api: scope.ZRBPDFFigureFallback, reader, doc, structure, scope,
    setMode(value) { mode = value; scope.ZRBPDFFigureFallback.ensure(reader); } };
}

const caption = (text = 'Figure 3 Analyzed topologies', page = 3) => ({
  type: 'caption', anchor: { pageRects: [[page, 317, 305, 508, 314]] }, content: [{ text }],
});

test('missing SDT image gets a figure fallback without changing the structure or caches', () => {
  const { api, reader, doc, structure } = setup([caption()]);
  const before = JSON.stringify(structure);
  api.ensure(reader);
  assert.equal(doc.querySelectorAll('.zrb-pdf-figure-fallback').length, 1);
  assert.equal(doc.querySelector('.zrb-figure-edit-inline')?.textContent, '裁剪／修正');
  assert.match(doc.querySelector('.zrb-pdf-figure-fallback').textContent, /PDF 第 4 页/);
  assert.equal(doc.querySelector('figcaption').previousElementSibling.className, 'zrb-pdf-figure-fallback');
  api.ensure(reader);
  assert.equal(doc.querySelectorAll('.zrb-pdf-figure-fallback').length, 1);
  assert.equal(JSON.stringify(structure), before);
  api.shutdown();
  assert.equal(doc.querySelectorAll('.zrb-pdf-figure-fallback').length, 0);
});

test('existing image crops, table captions and invalid anchors do not get a fallback', () => {
  const blocks = [
    { type: 'image', anchor: { pageRects: [[3, 330, 60, 544, 295]] }, content: [] },
    caption(), caption('Table 1 Results'),
    { ...caption('Fig. 4'), anchor: { pageRects: [[-1, 0, 0, 50, 50]] } },
  ];
  const { api, reader, doc } = setup(blocks);
  api.ensure(reader);
  assert.equal(doc.querySelectorAll('.zrb-pdf-figure-fallback').length, 0);
  api.shutdown();
});

test('cross-page SDT image fragments bounded by one numbered caption are treated as one existing figure', () => {
  const blocks = [
    caption('Figure 17: preceding figure', 2),
    { type: 'image', flowClass: 'auxiliary', anchor: { pageRects: [[2, 80, 80, 520, 410]] }, content: [] },
    { type: 'caption', anchor: { pageRects: [[2, 150, 420, 430, 435]] }, content: [{ text: 'Rib 1 Rib 2' }] },
    { type: 'image', flowClass: 'auxiliary', anchor: { pageRects: [[3, 80, 390, 520, 740]] }, content: [] },
    caption('Figure 18: Ribs dimensions', 3),
    { type: 'image', flowClass: 'auxiliary', anchor: { pageRects: [[3, 80, 90, 520, 350]] }, content: [] },
    caption('Figure 19: next figure', 3),
  ];
  const { api, reader, doc } = setup(blocks);
  api.ensure(reader);
  assert.equal(api.figureSequenceImages({ block: blocks[4] }, api.blocks(blocks)).length, 2);
  assert.equal(doc.querySelectorAll('.zrb-pdf-figure-fallback[data-source-ref="4"]').length, 0,
    'the shared cross-page figure caption does not cause a duplicate plugin crop');
  api.shutdown();
});

test('adjacent bilingual captions produce one preview while different figure numbers stay separate', () => {
  const first=caption('图 5 迭代结果',3),second=caption('Fig. 5 Iteration history',3);
  first.anchor.pageRects=[[3,229,545,366,555]];
  second.anchor.pageRects=[[3,175,531,420,541]];
  const {api,reader,doc}=setup([first,second,caption('Fig. 6 Separate image',3)],null,'manual');
  api.ensure(reader);
  assert.equal(doc.querySelectorAll('.zrb-pdf-figure-fallback').length,2);
  assert.equal(doc.querySelector('figcaption').previousElementSibling.dataset.sourceRef,'0');
  assert.equal(doc.querySelectorAll('[data-source-ref="1"]').length,0);
  api.shutdown();
});

test('each missing figure on the same page gets its own crop, including nested blocks', () => {
  const { api, reader, doc, structure } = setup([caption('Fig. 1', 1), caption('Fig. 2', 1)]);
  structure.content.push({ type: 'blockquote', content: [caption('Figure 4', 4)] });
  const el = doc.createElement('figcaption');
  el.dataset.refPath = '2.0'; el.textContent = 'Figure 4';
  doc.querySelector('#sdt-content').append(el);
  api.ensure(reader);
  assert.equal(doc.querySelectorAll('.zrb-pdf-figure-fallback').length, 3);
  api.shutdown();
});

test('render failures are visible and retryable, and closing a view removes its fallback', async () => {
  const { api, reader, doc } = setup([caption()]);
  api.ensure(reader);
  const button = doc.querySelector('.zrb-pdf-figure-fallback button');
  await new Promise(resolve => setImmediate(resolve));
  assert.match(doc.querySelector('.zrb-pdf-figure-fallback').textContent, /载入失败/);
  assert.match(doc.querySelector('[role="status"]').textContent, /渲染图形区域.*missing page/);
  assert.equal(button.disabled, false);
  button.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(doc.querySelector('.zrb-pdf-figure-fallback').textContent, /载入失败/);
  api.sync([]);
  assert.equal(doc.querySelectorAll('.zrb-pdf-figure-fallback').length, 0);
});

test('EPUB views are excluded and secondary PDF reading views are supported', () => {
  const { api, reader, doc, structure } = setup([caption()]);
  structure.metadata.processor.type = 'epub';
  api.ensure(reader);
  assert.equal(doc.querySelectorAll('.zrb-pdf-figure-fallback').length, 0);
  structure.metadata.processor.type = 'pdf';
  const internal = reader._internalReader;
  internal._secondarySDTView = internal._primarySDTView;
  internal._secondaryView = internal._primaryView;
  delete internal._primarySDTView;
  api.ensure(reader);
  assert.equal(doc.querySelectorAll('.zrb-pdf-figure-fallback').length, 1);
  api.shutdown();
});

test('excluded graphics do not suppress recovery, and unrelated columns are not matched', () => {
  const { api, reader, doc } = setup([
    { type: 'image', flowClass: 'excluded', anchor: { pageRects: [[3, 330, 60, 544, 295]] }, content: [] },
    { type: 'image', anchor: { pageRects: [[3, 51, 60, 292, 295]] }, content: [] },
    caption(),
  ]);
  api.ensure(reader);
  assert.equal(doc.querySelectorAll('.zrb-pdf-figure-fallback').length, 1);
  api.shutdown();
});

test('offscreen pages load lazily and failures can be retried', async () => {
  let calls = 0, observer;
  const { api, reader, doc } = setup([caption()], async () => { calls++; throw new Error('offline'); });
  doc.defaultView.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; observer = this; }
    observe(el) { this.el = el; }
    unobserve() {}
    disconnect() {}
  };
  api.ensure(reader);
  assert.equal(calls, 0);
  observer.callback([{ target: observer.el, isIntersecting: true }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  doc.querySelector('.zrb-pdf-figure-fallback button:not(.zrb-figure-edit-inline)').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  api.shutdown();
});

test('observer callbacks do not access privileged functions stored on content DOM nodes', async () => {
  let observer, calls = 0;
  const { api, reader, doc } = setup([caption()], async () => { calls++; throw new Error('offline'); });
  doc.defaultView.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; observer = this; }
    observe(el) { this.el = el; }
    unobserve() {}
    disconnect() {}
  };
  api.ensure(reader);
  Object.defineProperty(observer.el, '_zrbLoadPage', { get() { throw new Error('Security wrapper denied access'); } });
  assert.doesNotThrow(() => observer.callback([{ target: observer.el, isIntersecting: true }]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  api.shutdown();
});

test('closing a view ignores late native render results and does not restore removed previews', async () => {
  let finish;
  const { api, reader, doc } = setup([caption()], () => new Promise(resolve => { finish = resolve; }));
  api.ensure(reader);
  await new Promise(resolve => setImmediate(resolve));
  api.shutdown();
  finish(['data:image/png;base64,AA==']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(doc.querySelectorAll('.zrb-pdf-figure-fallback').length, 0);
  assert.equal(api.states.size, 0);
});

test('missing or invalid figure preferences default to manual loading', async () => {
  for (const value of [undefined, 'invalid', 'manual']) {
    let calls = 0;
    const { api, reader, doc } = setup([caption()], async () => { calls++; throw new Error('offline'); }, value);
    assert.equal(api.getMode(), 'manual');
    api.ensure(reader);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 0);
    const loadButton = doc.querySelector('.zrb-pdf-figure-fallback button:not(.zrb-figure-edit-inline)');
    assert.match(loadButton.textContent, /载入图形/);
    loadButton.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    api.shutdown();
  }
});

test('off mode creates no previews or structure snapshot; toggling applies to the open document', async () => {
  const { api, reader, doc, structure, setMode } = setup([caption()], null, 'off');
  structure.toJSON = () => { throw new Error('off mode must not copy SDT'); };
  api.ensure(reader);
  assert.equal(doc.querySelectorAll('.zrb-pdf-figure-fallback').length, 0);
  assert.equal(api.states.size, 0);
  delete structure.toJSON;
  setMode('manual');
  assert.equal(doc.querySelectorAll('.zrb-pdf-figure-fallback').length, 1);
  setMode('off');
  assert.equal(doc.querySelectorAll('.zrb-pdf-figure-fallback').length, 0);
  assert.equal(api.states.size, 0);
});

test('auto mode loads nearby figures even when observer target wrappers have different identities', async () => {
  let calls = 0, observer;
  const { api, reader, doc } = setup([caption()], async () => { calls++; throw new Error('offline'); });
  doc.defaultView.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 5000, bottom: 5100, width: 200, height: 100 });
  doc.defaultView.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; observer = this; }
    observe(el) { this.el = el; }
    unobserve() {}
    disconnect() {}
  };
  api.ensure(reader);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
  doc.defaultView.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 200, bottom: 300, width: 200, height: 100 });
  observer.callback([{ target: { dataset: { ...observer.el.dataset } }, isIntersecting: true }]);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls, 1);
  api.shutdown();
});

test('automatic visibility checks work without observer delivery and stop in manual mode', async () => {
  let calls = 0;
  const { api, reader, doc, setMode } = setup([caption()], async () => { calls++; throw new Error('offline'); }, 'manual');
  api.ensure(reader);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
  setMode('auto');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  // An automatic failure is not retried on every scroll or periodic sweep.
  doc.dispatchEvent(new doc.defaultView.Event('scroll'));
  api.ensure(reader);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  setMode('manual');
  doc.dispatchEvent(new doc.defaultView.Event('scroll'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  api.shutdown();
});

test('switching manual and automatic modes retains already rendered figures', async () => {
  const { api, reader, doc, setMode } = setup([caption()], null, 'manual');
  let calls = 0;
  api.renderFigure = async () => { calls++; return { src: 'data:image/png;base64,AA==', rect: [0,0,100,100], direction: 'above', displayWidth: 200 }; };
  api.loadImage = async () => {};
  api.ensure(reader);
  doc.querySelector('.zrb-pdf-figure-fallback button:not(.zrb-figure-edit-inline)').click();
  await new Promise(resolve => setImmediate(resolve));
  const image = doc.querySelector('img');
  setMode('auto');
  setMode('manual');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(doc.querySelector('img'), image);
  assert.equal(image.hidden, false);
  assert.equal(calls, 1);
  api.shutdown();
});

test('switching to manual cancels automatic jobs that have not started', async () => {
  const { api, reader, doc, setMode } = setup([caption('Figure 1'), caption('Figure 2')]);
  let finish, calls = 0;
  const result = { src: 'data:image/png;base64,AA==', rect: [0,0,100,100], direction: 'above', displayWidth: 200 };
  api.renderFigure = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  api.loadImage = async () => {};
  api.ensure(reader);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  setMode('manual');
  finish(result);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  const figures = doc.querySelectorAll('.zrb-pdf-figure-fallback');
  assert.equal(figures[0].dataset.state, 'loaded');
  assert.equal(figures[1].dataset.state, 'idle');
  api.shutdown();
});

test('manual images unload offscreen without losing layout and restore without another render', async () => {
  const { api, reader, doc } = setup([caption()], null, 'manual');
  let renders = 0;
  api.renderFigure = async () => { renders++; return { src: 'data:image/png;base64,AA==', width: 1000, height: 500,
    rect: [0,0,100,50], direction: 'above', displayWidth: 400 }; };
  api.loadImage = async () => {};
  api.ensure(reader); doc.querySelector('.zrb-pdf-figure-fallback button:not(.zrb-figure-edit-inline)').click();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  const figure = doc.querySelector('figure'); const image = figure.querySelector('img');
  const ratio = image.parentElement.style.aspectRatio;
  figure.getBoundingClientRect = () => ({ top: 5000, bottom: 5200, width: 400, height: 200 });
  doc.dispatchEvent(new doc.defaultView.Event('scroll'));
  for(let i=0;i<100&&figure.dataset.state!=='unloaded';i++) await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(figure.dataset.state, 'unloaded');
  assert.equal(image.hasAttribute('src'), false);
  assert.equal(image.parentElement.hidden, false);
  assert.equal(image.parentElement.style.aspectRatio, ratio);
  figure.getBoundingClientRect = () => ({ top: 100, bottom: 300, width: 400, height: 200 });
  doc.dispatchEvent(new doc.defaultView.Event('scroll'));
  for(let i=0;i<100&&figure.dataset.state!=='loaded';i++) await new Promise(resolve=>setTimeout(resolve,10));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(figure.dataset.state, 'loaded');
  assert.equal(renders, 1);
  api.shutdown();
  assert.equal(api.getCache().memoryBytes, 0);
});

test('a changed attachment cannot reuse a crop tied to the old SDT fingerprint', async () => {
  const {api,reader,doc,structure,scope}=setup([caption()],null,'manual');
  let currentHash='a'.repeat(32),stamp=1,renders=0;
  structure.metadata.source={hash:currentHash};reader.itemID=123;
  scope.IOUtils={stat:async()=>({size:100,lastModified:stamp})};
  scope.Zotero.Items={get:()=>({getFilePathAsync:async()=> 'fixture.pdf'})};
  scope.Zotero.Utilities={Internal:{md5Async:async()=>currentHash}};
  api.renderFigure=async()=>{renders++;return{src:'data:image/png;base64,AA==',width:100,height:50,rect:[0,0,100,50],direction:'above',displayWidth:200};};
  api.loadImage=async()=>{};
  api.ensure(reader);doc.querySelector('.zrb-pdf-figure-fallback button:not(.zrb-figure-edit-inline)').click();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(doc.querySelector('.zrb-pdf-figure-fallback').dataset.state,'loaded');
  api.shutdown();currentHash='b'.repeat(32);stamp++;
  api.ensure(reader);doc.querySelector('.zrb-pdf-figure-fallback button:not(.zrb-figure-edit-inline)').click();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(doc.querySelector('.zrb-pdf-figure-fallback').dataset.state,'error');
  assert.match(doc.querySelector('[role="status"]').textContent,/PDF 内容已改变/);
  assert.equal(renders,1);api.shutdown();
});
