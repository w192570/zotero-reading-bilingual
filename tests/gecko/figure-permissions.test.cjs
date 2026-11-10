const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { gecko } = require('../helpers/gecko.cjs');

test('system-principal figure planning accepts real content-principal SDT arrays', { timeout: 30000 }, async t => {
  const browser = await gecko(t);
  const source = require('../helpers/figure-source.cjs')();
  const result = await browser.run(`
    const Cu = Components.utils;
    const browser = Services.appShell.createWindowlessBrowser(false);
    const doc = browser.document;
    doc.documentElement.innerHTML = '<head></head><body><article id="sdt-content"><figcaption data-ref-path="1">Figure 2</figcaption></article></body>';
    const structure = { metadata: { processor: { type: 'pdf' } }, catalog: { pages: [{ viewRect: [0,0,600,800] }] }, content: [
      { type: 'heading', anchor: { pageRects: [[0,50,700,150,710]] }, content: [{ text: 'Heading' }] },
      { type: 'caption', anchor: { pageRects: [[0,50,300,280,310]] }, content: [{ text: 'Figure 2' }] }
    ] };
    const foreign = Cu.waiveXrays(Cu.cloneInto(structure, doc.defaultView));
    const plugin = Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(), { wantXrays: false });
    Object.assign(plugin, { TextEncoder, TextDecoder, atob, btoa });
    plugin.Cu = Cu;
    plugin.reader = { _internalReader: { _sdt: { structure: foreign },
      _primarySDTView: { _iframeDocument: doc }, _primaryView: { _iframeWindow: doc.defaultView } } };
    Cu.evalInSandbox(arguments[0], plugin);
    let control, failure = null, candidates;
    // This is the exact old bug pattern, not an injected exception or Proxy.
    try { Cu.evalInSandbox('reader._internalReader._sdt.structure.content[0].anchor.pageRects.map(r => r.slice(1)).some(r => r[3]-r[1] <= 40)', plugin); }
    catch(e) { control = String(e.message); }
    const before = JSON.stringify(foreign);
    try {
      Cu.evalInSandbox('ZRBPDFFigureFallback.ensure(reader); this.state = ZRBPDFFigureFallback.states.get(reader._internalReader._primarySDTView._iframeDocument); this.candidates = ZRBPDFFigureFallback.getCropCandidates(state.structure,[1],0);', plugin);
      candidates = JSON.parse(JSON.stringify(plugin.candidates));
    } catch(e) { failure = String(e.message); }
    const result = { control, failure, candidates, contentPrincipal: !doc.nodePrincipal.isSystemPrincipal,
      unchanged: before === JSON.stringify(foreign), previews: doc.querySelectorAll('.zrb-pdf-figure-fallback').length };
    Cu.evalInSandbox('ZRBPDFFigureFallback.shutdown()', plugin);
    browser.close();
    return result;
  `, [source]);
  assert.equal(result.contentPrincipal, true);
  assert.match(result.control, /Permission denied to pass object to privileged code/);
  assert.equal(result.failure, null, JSON.stringify(result));
  assert.equal(result.previews, 1);
  assert.equal(result.unchanged, true);
  assert.deepEqual(result.candidates, [
    { direction: 'above', rect: [47,313,283,697] },
    { direction: 'below', rect: [47,28,283,297] },
  ]);
  t.diagnostic('Firefox ' + browser.version + ': real system/content principal boundary');
});

test('manual-to-auto settings load and trim visible content figures across the full security boundary', { timeout: 30000 }, async t => {
  const browser = await gecko(t);
  const source = require('../helpers/figure-source.cjs')();
  const results = await browser.run(`
    const done = arguments[arguments.length - 1];
    const source = arguments[0];
    (async () => {
      const Cu = Components.utils;
      const results = [];
      for (const exposeCu of [true, false]) {
        const browser = Services.appShell.createWindowlessBrowser(false);
        const doc = browser.document;
        doc.documentElement.innerHTML = '<head></head><body><article id="sdt-content"><figcaption data-ref-path="1">Figure 2</figcaption></article></body>';
        const content = Cu.Sandbox(doc.defaultView, { sandboxPrototype: doc.defaultView, wantXrays: false });
        Cu.evalInSandbox(
          // Windowless test documents have no viewport. Supply content-realm
          // geometry to exercise automatic loading without observer delivery.
          'Element.prototype.getBoundingClientRect=function(){return {top:10,bottom:110,width:400,height:100}};' +
          'Object.defineProperty(window,"innerHeight",{value:600,configurable:true});this.renderCalls=0;' +
          'this.structure = {metadata:{processor:{type:"pdf"}},catalog:{pages:[{viewRect:[0,0,600,800]}]},content:[' +
          '{type:"heading",anchor:{pageRects:[[0,50,700,150,710]]},content:[{text:"Heading"}]},' +
          '{type:"caption",anchor:{pageRects:[[0,50,300,280,310]]},content:[{text:"Figure 2"}]}]};' +
          'this.renderer = {async renderRegionCrops(page,rects) {' +
          ' renderCalls++;' +
          ' if (Object.getPrototypeOf(rects)!==window.Array.prototype) throw new Error("Crop arguments must belong to content");' +
          ' return rects.map(rect => {const c=document.createElement("canvas");c.width=400;c.height=400;' +
          ' const ctx=c.getContext("2d");ctx.fillStyle="white";ctx.fillRect(0,0,400,400);' +
          ' ctx.fillStyle="blue";ctx.fillRect(40,40,320,320);return c.toDataURL();}); }};', content);
        const plugin = Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(), { wantXrays: false });
        Object.assign(plugin, { TextEncoder, TextDecoder, atob, btoa });
        if (exposeCu) plugin.Cu = Cu;
        let mode = 'manual';
        plugin.Zotero = { Prefs: { get() { return mode; } } };
        plugin.reader = { _internalReader: { _sdt: { structure: Cu.waiveXrays(content.structure) },
          _primarySDTView: { _iframeDocument: Cu.waiveXrays(doc) }, _primaryView: { _iframeWindow: doc.defaultView,
            _pdfRenderer: Cu.waiveXrays(content.renderer) } } };
        Cu.evalInSandbox(source + '; ZRBPDFFigureFallback.ensure(reader);', plugin);
        const figure = doc.querySelector('figure');
        await new Promise(resolve => setTimeout(resolve, 20));
        const beforeAuto = content.renderCalls;
        mode = 'auto';
        Cu.evalInSandbox('ZRBPDFFigureFallback.ensure(reader)', plugin);
        for (let i=0; i<200 && figure.dataset.state==='loading'; i++) await new Promise(resolve => setTimeout(resolve,10));
        mode = 'manual';
        Cu.evalInSandbox('ZRBPDFFigureFallback.ensure(reader)', plugin);
        results.push({ exposeCu, state: figure.dataset.state, error: figure.querySelector('[role="status"]').textContent,
          width: figure.querySelector('img').naturalWidth, rect: figure.dataset.cropRect,
          beforeAuto, afterAuto: content.renderCalls, sameFigure: doc.querySelector('figure') === figure });
        Cu.evalInSandbox('ZRBPDFFigureFallback.shutdown()', plugin);
        browser.close();
      }
      return results;
    })().then(done, e => done({ failure: String(e), stack: String(e.stack) }));
  `, [source], true);
  assert.ok(Array.isArray(results), JSON.stringify(results));
  for (const result of results) {
    assert.equal(result.state, 'loaded', JSON.stringify(result));
    assert.equal(result.beforeAuto, 0);
    assert.equal(result.afterAuto, 1);
    assert.equal(result.sameFigure, true);
    assert.equal(result.error, '');
    assert.ok(result.width > 100);
    assert.equal(JSON.parse(result.rect).length, 4);
  }
});
