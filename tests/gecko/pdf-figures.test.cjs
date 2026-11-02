const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { gecko } = require('../helpers/gecko.cjs');

test('actual PDF crops load from a privileged plugin using a content-principal native Reader renderer',
  { timeout: 240000, skip: !process.env.ZRB_PDF_CASES }, async t => {
    const config = JSON.parse(fs.readFileSync(process.env.ZRB_PDF_CASES, 'utf8'));
    const bundle = fs.readFileSync(config.readerBundle, 'utf8');
    const extractFunction = name => {
      const start = bundle.indexOf(`\nfunction ${name}(`) + 1;
      assert.ok(start > 0);
      return bundle.slice(start, bundle.indexOf('\nfunction ', start + 1));
    };
    const start = bundle.indexOf(';// ./src/pdf/pdf-renderer.js');
    const end = bundle.indexOf('/* harmony default export */ const pdf_renderer', start);
    assert.ok(start >= 0 && end > start);
    const nativeRenderer = ['fitRectIntoRect', 'getPositionBoundingRect', 'p2v'].map(extractFunction).join('\n')
      + '\n' + bundle.slice(start, end) + '\nwindow.NativePDFRenderer = PDFRenderer;'
      + '\n' + require('../helpers/native-sdt.cjs')(config.readerBundle);
    const source = require('../helpers/figure-source.cjs')();
    const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const server = http.createServer((req, res) => {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      let file;
      if (pathname.startsWith('/pdfjs/')) {
        const resolved = path.resolve(config.pdfjs, decodeURIComponent(pathname.slice(7)));
        if (resolved.startsWith(path.resolve(config.pdfjs) + path.sep)) file = resolved;
      } else if (/^\/case\/\d+\.pdf$/.test(pathname)) {
        file = config.cases[Number(pathname.match(/\d+/)[0])]?.pdf;
      }
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (!file || !fs.existsSync(file)) { res.statusCode = 404; res.end(); return; }
      res.setHeader('Content-Type', file.endsWith('.mjs') ? 'text/javascript' : file.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');
      res.end(fs.readFileSync(file));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const baseURL = `http://127.0.0.1:${server.address().port}`;
    const browser = await gecko(t);
    const results = [];
    for (const [index, item] of config.cases.entries()) {
      const preserved = [item.pdf, item.sdt, ...(item.preserve || [])];
      const before = preserved.map(hash);
      const structure = JSON.parse(fs.readFileSync(item.sdt, 'utf8'));
      const result = await browser.run(`
        const [source, nativeSource, baseURL, structure, index, cacheRoot] = arguments;
        const done = arguments[arguments.length-1];
        const Cu = Components.utils;
        Cu.importGlobalProperties(['IOUtils','PathUtils','TextEncoder','TextDecoder','atob','btoa']);
        const browser = Services.appShell.createWindowlessBrowser(false);
        const doc = browser.document;
        const win = Cu.waiveXrays(doc.defaultView);
        const scriptErrors = [];
        doc.defaultView.addEventListener('error', e => scriptErrors.push(e.message));
        doc.documentElement.innerHTML='<head></head><body><article id="sdt-content"></article></body>';
        function script(source) { const s=doc.createElement('script');s.textContent=source;doc.body.append(s); }
        script(nativeSource);
        // A windowless document has no refresh ticks; let PDF.js continue its
        // canvas work using timers while leaving its rendering code intact.
        script('window.zrbState="starting";window.requestAnimationFrame=callback=>setTimeout(()=>callback(performance.now()),0); (async()=>{' +
          'const baseURL='+JSON.stringify(baseURL)+';const structure='+JSON.stringify(structure)+';' +
          'const pdfjs=await import(baseURL+"/pdfjs/build/pdf.mjs");' +
          'pdfjs.GlobalWorkerOptions.workerSrc=baseURL+"/pdfjs/build/pdf.worker.mjs";' +
          'const pdfDocument=await pdfjs.getDocument({url:baseURL+"/case/'+index+'.pdf",' +
          'cMapUrl:baseURL+"/pdfjs/web/cmaps/",cMapPacked:true,standardFontDataUrl:baseURL+"/pdfjs/web/standard_fonts/",wasmUrl:baseURL+"/pdfjs/web/wasm/"}).promise;' +
          'window.PDFViewerApplication={pdfDocument,pdfViewer:{maxCanvasPixels:12000000}};' +
          'document.querySelector("article").replaceWith(NativeSDT.render(structure,document,{renderSourceCrops:true}));' +
          'const style=document.createElement("style");style.textContent=NativeSDT.css;document.head.append(style);' +
          'const base={_iframeWindow:window};base._pdfRenderer=new NativePDFRenderer({pdfView:base});' +
          'window.nativeHydration=new NativeSDT.Hydration(document);const provider=new NativeSDT.Provider(base._pdfRenderer);' +
          'nativeHydration._prepareSourceCrops(provider.createSDTBlockCropProvider(structure));' +
          'window.reader={_internalReader:{_sdt:{structure},_primarySDTView:{_iframeDocument:document},_primaryView:base}};' +
          'window.zrbState="ready";})().catch(e=>{window.zrbState="error";window.zrbError=String(e)+"; "+e.stack})');
        (async()=>{
          for(let i=0;i<3000&&!['ready','error'].includes(win.zrbState);i++)await new Promise(resolve=>setTimeout(resolve,10));
          if(win.zrbState!=='ready')throw new Error('PDF setup: '+win.zrbState+' '+win.zrbError+' '+JSON.stringify(scriptErrors));
          function createPlugin() {
            const plugin=Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(),{wantXrays:false});
            Object.assign(plugin,{TextEncoder,TextDecoder,atob,btoa,IOUtils,PathUtils,setTimeout,clearTimeout});
            plugin.Zotero={DataDirectory:{getSubdirectory:()=>cacheRoot}};
            plugin.Cu=Cu; plugin.reader=win.reader;
            Cu.evalInSandbox(source,plugin); return plugin;
          }
          let plugin=createPlugin();
          await Cu.evalInSandbox('ZRBPDFFigureFallback.getCache().clear()',plugin);
          Cu.evalInSandbox('ZRBPDFFigureFallback.ensure(reader)',plugin);
          const figures=Array.from(doc.querySelectorAll('.zrb-pdf-figure-fallback'));
          const crops=[];
          const coldStart=Date.now();
          for(const figure of figures){
            await IOUtils.writeUTF8(cacheRoot+'-progress.json',JSON.stringify({stage:'cold',ref:figure.dataset.sourceRef,time:Date.now()}));
            figure.querySelector('button').click();
            for(let i=0;i<3000&&figure.dataset.state==='loading';i++)await new Promise(resolve=>setTimeout(resolve,10));
            if(figure.dataset.state==='loading')throw new Error('Timed out figure '+figure.dataset.sourceRef);
            const image=figure.querySelector('img');
            crops.push({ref:figure.dataset.sourceRef,state:figure.dataset.state,rect:figure.dataset.cropRect,
              error:figure.querySelector('[role="status"]').textContent,width:image.naturalWidth,src:image.getAttribute('src')});
          }
          const coldMs=Date.now()-coldStart;
          const coldStats=await Cu.evalInSandbox('ZRBPDFFigureFallback.getCache().stats()',plugin);
          Cu.evalInSandbox('ZRBPDFFigureFallback.shutdown()',plugin);
          plugin=createPlugin();
          Cu.evalInSandbox('ZRBPDFFigureFallback.ensure(reader)',plugin);
          const warmStart=Date.now(), warm=[];
          for(const figure of doc.querySelectorAll('.zrb-pdf-figure-fallback')){
            await IOUtils.writeUTF8(cacheRoot+'-progress.json',JSON.stringify({stage:'warm',ref:figure.dataset.sourceRef,time:Date.now()}));
            figure.querySelector('button').click();
            for(let i=0;i<3000&&figure.dataset.state==='loading';i++)await new Promise(resolve=>setTimeout(resolve,10));
            warm.push({state:figure.dataset.state,width:figure.querySelector('img').naturalWidth});
          }
          const warmMs=Date.now()-warmStart;
          const warmStats=await Cu.evalInSandbox('ZRBPDFFigureFallback.getCache().stats()',plugin);
          Cu.evalInSandbox('ZRBPDFFigureFallback.shutdown()',plugin);
          const closedStats=await Cu.evalInSandbox('ZRBPDFFigureFallback.getCache().stats()',plugin);
          return {contentPrincipal:!doc.nodePrincipal.isSystemPrincipal,crops,coldMs,warmMs,coldStats,warmStats,closedStats,warm};
        })().then(done,e=>done({failure:String(e),stack:String(e.stack)})).finally(()=>browser.close());
      `, [source, nativeRenderer, baseURL, structure, index, path.join(config.output, 'gecko-cache-' + item.name)], true);
      assert.ok(!result.failure, JSON.stringify(result));
      assert.equal(result.contentPrincipal, true);
      assert.equal(result.crops.length, item.expectedCount ?? (item.name === '5HEMQ2BB' ? 14 : 10));
      assert.equal(result.coldStats.available, true);
      assert.equal(result.coldStats.renders, result.crops.length);
      assert.equal(result.warmStats.renders, 0);
      assert.equal(result.warmStats.diskHits, result.crops.length);
      assert.equal(result.closedStats.memoryBytes, 0);
      assert.ok(result.warm.every(crop => crop.state === 'loaded' && crop.width > 100));
      for (const crop of result.crops) {
        assert.equal(crop.state, 'loaded', JSON.stringify({ ...crop, src: undefined }));
        assert.equal(crop.error, '');
        assert.ok(crop.width > 100);
        fs.writeFileSync(path.join(config.output, `gecko-${item.name}-ref-${crop.ref}.png`), Buffer.from(crop.src.split(',')[1], 'base64'));
        delete crop.src;
      }
      const target = JSON.parse(result.crops.find(crop => crop.ref === item.sourceRef).rect);
      for (const i of [0,1]) assert.ok(target[i] <= item.expectedRect[i] + 5);
      for (const i of [2,3]) assert.ok(target[i] >= item.expectedRect[i] - 5);
      for (const expected of item.targets || []) {
        const actual = JSON.parse(result.crops.find(crop => crop.ref === expected.sourceRef).rect);
        for (const i of [0,1]) assert.ok(actual[i] <= expected.expectedRect[i] + 5, `${expected.sourceRef}: clipped ${actual}`);
        for (const i of [2,3]) assert.ok(actual[i] >= expected.expectedRect[i] - 5, `${expected.sourceRef}: clipped ${actual}`);
        if (expected.bounds) for (const i of [0,1,2,3]) {
          assert.ok(i < 2 ? actual[i] >= expected.bounds[i] : actual[i] <= expected.bounds[i], `${expected.sourceRef}: neighboring content ${actual}`);
        }
      }
      assert.deepEqual(preserved.map(hash), before);
      results.push({ name: item.name, version: browser.version, ...result, cacheUnchanged: true });
    }
    fs.writeFileSync(path.join(config.output, 'gecko-results.json'), JSON.stringify(results, null, 2));
    t.diagnostic(JSON.stringify(results.map(result => ({ name: result.name, crops: result.crops.length, contentPrincipal: result.contentPrincipal, cacheUnchanged: result.cacheUnchanged }))));
  });
