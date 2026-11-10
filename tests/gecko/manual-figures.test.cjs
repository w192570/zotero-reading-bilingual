const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { gecko } = require('../helpers/gecko.cjs');

// Local original PDFs and the matching installed Reader are deliberately not
// checked in. This is a real Gecko/native-renderer test, not desktop acceptance.
test('manual regions preserve exact native PDF pixels, cross-page order and durable decisions', {
  timeout: 240000,
  skip: !process.env.ZRB_MANUAL_PDF_CASES && 'Set ZRB_MANUAL_PDF_CASES to a private installed Reader/PDF manifest',
}, async t => {
  const config = JSON.parse(fs.readFileSync(process.env.ZRB_MANUAL_PDF_CASES, 'utf8'));
  const item = config.cases[0];
  const bundle = fs.readFileSync(config.readerBundle, 'utf8');
  const extractFunction = name => {
    const start = bundle.indexOf(`\nfunction ${name}(`) + 1;
    assert.ok(start > 0, name);
    return bundle.slice(start, bundle.indexOf('\nfunction ', start + 1));
  };
  const start = bundle.indexOf(';// ./src/pdf/pdf-renderer.js');
  const end = bundle.indexOf('/* harmony default export */ const pdf_renderer', start);
  assert.ok(start >= 0 && end > start);
  const nativeSource = ['fitRectIntoRect', 'getPositionBoundingRect', 'p2v'].map(extractFunction).join('\n')
    + '\n' + bundle.slice(start, end) + '\nwindow.NativePDFRenderer=PDFRenderer;\n'
    + require('../helpers/native-sdt.cjs')(config.readerBundle);
  const source = ['figure-cache.js', 'pdf-figure-fallback.js', 'manual-figure-store.js', 'manual-figures.js', 'manual-figure-editor.js']
    .map(file => fs.readFileSync(path.resolve(__dirname, '../../content/scripts', file), 'utf8')).join('\n');
  const structure = JSON.parse(fs.readFileSync(item.sdt, 'utf8'));
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const originals = [item.pdf, item.sdt, ...(item.preserve || [])];
  const before = originals.map(hash);
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    let file;
    if (pathname.startsWith('/pdfjs/')) {
      const candidate = path.resolve(config.pdfjs, decodeURIComponent(pathname.slice(7)));
      if (candidate.startsWith(path.resolve(config.pdfjs) + path.sep)) file = candidate;
    } else if (pathname === '/source.pdf') file = item.pdf;
    else if (pathname === '/rotation.pdf') file = config.rotationPDF;
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (!file || !fs.existsSync(file)) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', file.endsWith('.mjs') ? 'text/javascript' : file.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await gecko(t);
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  const root = path.join(config.output, 'manual-gecko-' + Date.now());
  const result = await browser.run(`
    const [source,nativeSource,baseURL,structure,item,root] = arguments;
    const done=arguments[arguments.length-1],Cu=Components.utils;
    Cu.importGlobalProperties(['IOUtils','PathUtils','TextEncoder','TextDecoder','atob','btoa']);
    const host=Services.appShell.createWindowlessBrowser(false);let doc=host.document;
    const win=Cu.waiveXrays(doc.defaultView),errors=[];
    doc.defaultView.addEventListener('error',e=>errors.push(e.message));
    doc.documentElement.innerHTML='<head></head><body></body>';
    function script(text){const s=doc.createElement('script');s.textContent=text;doc.body.append(s);}
    script(nativeSource);
    script('window.zrbState="starting";window.requestAnimationFrame=f=>setTimeout(()=>f(performance.now()),0);(async()=>{'+
      'const baseURL='+JSON.stringify(baseURL)+';const structure='+JSON.stringify(structure)+';'+
      'const pdfjs=await import(baseURL+"/pdfjs/build/pdf.mjs");window.zrbPDFJS=pdfjs;'+
      'pdfjs.GlobalWorkerOptions.workerSrc=baseURL+"/pdfjs/build/pdf.worker.mjs";'+
      'window.openTestPDF=url=>pdfjs.getDocument({url,cMapUrl:baseURL+"/pdfjs/web/cmaps/",cMapPacked:true,standardFontDataUrl:baseURL+"/pdfjs/web/standard_fonts/",wasmUrl:baseURL+"/pdfjs/web/wasm/"}).promise;'+
      'const pdfDocument=await openTestPDF(baseURL+"/source.pdf");'+
      'window.PDFViewerApplication={pdfDocument,pdfViewer:{maxCanvasPixels:12000000}};'+
      'window.renderSDTDocument=()=>{document.querySelector("#sdt-content")?.remove();document.body.append(NativeSDT.render(structure,document,{renderSourceCrops:true}));};renderSDTDocument();'+
      'const style=document.createElement("style");style.textContent=NativeSDT.css;document.head.append(style);'+
      'const base={_iframeWindow:window};base._pdfRenderer=new NativePDFRenderer({pdfView:base});'+
      'const hydration=new NativeSDT.Hydration(document),provider=new NativeSDT.Provider(base._pdfRenderer);hydration._prepareSourceCrops(provider.createSDTBlockCropProvider(structure));await hydration._loadSourceCrop(document.getElementById("sdt-148"));'+
      'window.reader={_internalReader:{_sdt:{structure},_primarySDTView:{_iframeDocument:document},_primaryView:base}};'+
      'window.zrbState="ready";})().catch(e=>{window.zrbState="error";window.zrbError=String(e)+" "+e.stack})');
    (async()=>{
      for(let i=0;i<5000&&!['ready','error'].includes(win.zrbState);i++)await new Promise(r=>setTimeout(r,10));
      if(win.zrbState!=='ready')throw new Error('setup '+win.zrbState+' '+win.zrbError+' '+JSON.stringify(errors));
      const check=(value,message)=>{if(!value)throw new Error(message);};
      function plugin(){
        const scope=Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(),{wantXrays:false});
        Object.assign(scope,{Cu,IOUtils,PathUtils,TextEncoder,TextDecoder,atob,btoa,setTimeout,clearTimeout});
        scope.Zotero={DataDirectory:{dir:root,getSubdirectory:()=>PathUtils.join(root,'cache')},Prefs:{get:()=>true},debug(){}};
        scope.reader=win.reader;Cu.evalInSandbox(source,scope);return scope;
      }
      let p=plugin(),api=p.ZRBManualFigures;
      api.ensure(win.reader);let state=Array.from(api.states.values())[0];
      check(state,'ensure failed: '+api.states.size+' '+JSON.stringify(errors));await state.ready;
      doc=state.doc;
      check(!state.error,'initialize '+state.error);
      const find=ref=>Array.from(doc.querySelectorAll('[data-ref-path]')).find(el=>el.dataset.refPath===ref);
      const native=api.nativeElements(state).find(el=>el.closest('[data-ref-path]')?.dataset.refPath===item.nativeRef);
      check(native,'actual native SDT graphic missing');
      const nativeTarget=api.targetFor(state,native);
      check(nativeTarget.regions.length>0,'native image lacks source region');
      const crossPageFragments=api.figureFragments(state,item.captionRef);
      const crossPageSet=new Set(crossPageFragments.flatMap(entry=>(entry.block.anchor?.pageRects||[]).map(rect=>rect[0])));
      check(crossPageFragments.length>=2&&crossPageSet.has(16)&&crossPageSet.has(17),
        'actual Figure 18 SDT fragments were not associated across PDF pages: '+JSON.stringify({refs:crossPageFragments.map(entry=>entry.ref.join('.')),pages:Array.from(crossPageSet)}));
      // A failure panel uses the same target API as native graphics. It is only
      // a UI fixture; all page geometry and image data below use the real PDF.
      const fallback=doc.createElement('figure');fallback.className='zrb-pdf-figure-fallback';
      fallback.dataset.sourceRef=item.captionRef;fallback.dataset.pageIndex='17';fallback.dataset.state='error';
      fallback.innerHTML='<button>retry</button><span>failed</span>';find(item.captionRef).before(fallback);
      const draft=api.targetFor(state,fallback);
      check(draft.anchor.kind==='caption'&&draft.anchor.ref===item.captionRef,'failure target association');
      draft.regions=JSON.parse(JSON.stringify(item.regions));
      draft.replacements=api.candidates(state).filter(x=>x.kind==='fallback'||['144','145','148','151','152','153','154','155','156'].includes(x.ref));
      const editor=p.ZRBManualFigureEditor.open(state,draft);
      for(let i=0;i<3000&&!editor.page;i++)await new Promise(r=>setTimeout(r,10));
      check(editor.page?.src?.startsWith('data:image/png;base64,'),'editor original PDF preview failed '+editor.root.querySelector('[role=status]').textContent);
      check(editor.root.querySelector('svg image')?.getAttribute('href')===editor.page.src,'editor did not show original page preview');
      check(editor.pageIndex===16&&editor.root.querySelector('[data-field=page]').value==='17','editor source page wrong');
      const editorPreview={pageIndex:editor.pageIndex,bounds:Array.from(editor.page.bounds),rotation:editor.page.rotation};
      editor.close();
      check(!state.editor&&!doc.querySelector('.zrb-manual-editor,.zrb-manual-figure'),'editor cancellation changed source display');
      check((await api.getStore().list(state.documentID,state.fingerprint)).length===0,'editor cancellation saved a correction');
      const protectedRefs=['147','149','158',item.captionRef];
      const protectedBefore=protectedRefs.map(ref=>find(ref).innerHTML);
      const oversized=find('148'),oversizedImage=oversized.querySelector('img');
      check(oversized.matches('figure.sdt-source-crop')&&oversizedImage.naturalWidth>0,'real source crop 148 not hydrated');
      const oversizedSource=oversizedImage.src;
      const originalLimit=win.PDFViewerApplication.pdfViewer.maxCanvasPixels;
      const pngs=[],exact=[];
      // Native renderer comparison proves manual boundaries are not rescanned or
      // trimmed: same page, same pixels, same source renderer => identical PNG.
      for(const region of draft.regions){
        const actual=await api.renderExact(state,region,900000);
        const renderer=api.limitedRenderer(state,900000);
        const expected=await renderer.renderRegionCrops(region.pageIndex,Cu.cloneInto([region.rect],win));
        check(actual.src===expected[0],'manual region changed native crop pixels');
        check(actual.width*actual.height<=950000,'renderer ignored pixel budget');
        check(JSON.stringify(actual.rect)===JSON.stringify(region.rect),'manual coordinates changed');
        exact.push({pageIndex:region.pageIndex,rect:actual.rect,width:actual.width,height:actual.height});
        pngs.push(actual.src);
      }
      check(win.PDFViewerApplication.pdfViewer.maxCanvasPixels===originalLimit,'Reader render settings mutated');
      await api.apply(state,draft);
      const first=state.active.get(draft.id);
      check(first.figure.querySelectorAll('img').length===2,'cross-page result merged/lost');
      check(first.figure.nextElementSibling===find(item.captionRef),'combined graphic not directly above caption');
      check(Array.from(first.figure.querySelectorAll('img')).every((img,i)=>img.alt.includes(String(draft.regions[i].pageIndex+1))),'page order changed');
      check(fallback.dataset.zrbManualHidden===draft.id,'failed fallback remains visible');
      check(!oversized.dataset.zrbManualHidden&&oversized.dataset.zrbManualMasked===draft.id,'oversized source crop hid Figure 17');
      const oversizedMask=oversized.style.getPropertyValue('mask-image');
      check(oversizedMask.includes('data:image/svg+xml')&&win.getComputedStyle(oversized).display!=='none','oversized crop missing partial mask');
      const maskDoc=new win.DOMParser().parseFromString(decodeURIComponent(oversizedMask.split('data:image/svg+xml,')[1].split('"')[0]),'image/svg+xml');
      const maskHoles=Array.from(maskDoc.querySelectorAll('rect[fill="black"]')).map(r=>({x:Number(r.getAttribute('x')),y:Number(r.getAttribute('y')),width:Number(r.getAttribute('width')),height:Number(r.getAttribute('height'))}));
      check(maskHoles.length===1&&maskHoles[0].y>.7&&maskHoles[0].y+maskHoles[0].height>.99,'mask clips upper Figure 17 or fails to remove lower selected pixels');
      check(protectedRefs.every((ref,i)=>find(ref).innerHTML===protectedBefore[i]&&!find(ref).dataset.zrbManualHidden),'source labels/caption modified or hidden');
      const saved=await api.getStore().list(state.documentID,state.fingerprint);
      check(saved.length===1,'correction record not persisted');
      const decision=await api.getStore().read(state.documentID,state.fingerprint);
      check((await IOUtils.stat(decision.file)).size>0,'no real IOUtils durable file');
      const stableMarkup=first.figure.outerHTML;
      try{await api.apply(state,{...draft,regions:[{pageIndex:99,rect:[0,0,100,100]}]});throw new Error('bad region accepted');}
      catch(e){check(!String(e).includes('bad region accepted'),'invalid region accepted');}
      check(state.active.get(draft.id).figure.outerHTML===stableMarkup,'failed edit replaced original');
      const reversed={...draft,regions:draft.regions.slice().reverse()};await api.apply(state,reversed);
      check(doc.querySelectorAll('.zrb-manual-figure').length===1,'repeat edit duplicated graphic');
      check(state.active.get(draft.id).record.regions[0].pageIndex===17,'reorder not retained');
      await api.apply(state,draft);
      const cacheStatsBefore=await p.ZRBPDFFigureFallback.getCache().stats();
      check(cacheStatsBefore.available&&cacheStatsBefore.diskEntries>0,'real PNG disk cache unavailable '+JSON.stringify(cacheStatsBefore));
      api.shutdown();p=plugin();api=p.ZRBManualFigures;
      api.ensure(win.reader);state=Array.from(api.states.values())[0];await state.ready;
      check(!state.error&&state.active.size===1,'warm reload failed '+state.error);
      const warmStats=await p.ZRBPDFFigureFallback.getCache().stats();
      check(warmStats.renders===0&&warmStats.diskHits===2,'warm reload did not reuse two PNGs '+JSON.stringify(warmStats));
      await p.ZRBPDFFigureFallback.getCache().clear();
      check((await api.getStore().list(state.documentID,state.fingerprint)).length===1,'image cache clear deleted user decision');
      api.shutdown();check(api.states.size===0&&api.residentBytes()===0,'view close retained state/images');
      check(!doc.querySelector('.zrb-manual-figure')&&!fallback.dataset.zrbManualHidden,'view close left replacement');
      fallback.remove(); // Automatic recovery is disabled/not injected on reopen.
      p=plugin();api=p.ZRBManualFigures;api.ensure(win.reader);state=Array.from(api.states.values())[0];await state.ready;
      check(!state.error,'reload '+state.error);
      check(state.active.size===1&&doc.querySelectorAll('.zrb-manual-figure img').length===2,'reload/cache clear failed to regenerate');
      const cacheStatsAfter=await p.ZRBPDFFigureFallback.getCache().stats();
      check(cacheStatsAfter.renders===2,'restore did not regenerate exactly two crops');
      const lateFallback=fallback.cloneNode(true);find(item.captionRef).before(lateFallback);api.ensure(win.reader);
      check(lateFallback.dataset.zrbManualHidden===draft.id,'late automatic fallback duplicates restored manual figure');
      await api.restoreOriginal(state,draft.id);
      check(!doc.querySelector('.zrb-manual-figure')&&!fallback.dataset.zrbManualHidden,'restore original failed');
      check(!lateFallback.dataset.zrbManualHidden,'restore original left late fallback hidden');
      check(!oversized.dataset.zrbManualMasked&&!oversized.style.getPropertyValue('mask-image')&&oversizedImage.src===oversizedSource,'restore original left a partial mask/source change');
      check((await api.getStore().list(state.documentID,state.fingerprint)).length===0,'restore decision remains');
      // Rotation is tested on an explicitly derived diagnostic copy. Never edit
      // the original user PDF to create this condition.
      const originalPDF=win.PDFViewerApplication.pdfDocument;
      const rotatedPDF=Cu.waiveXrays(await win.openTestPDF(baseURL+'/rotation.pdf'));
      win.PDFViewerApplication.pdfDocument=rotatedPDF;
      const rotated=await api.renderExact(state,draft.regions[0],800000);
      check((await api.pageInfo(state,16)).rotation===90,'diagnostic rotation missing');
      check(rotated.height>rotated.width,'90-degree crop dimensions not rotated');
      pngs.push(rotated.src);
      win.PDFViewerApplication.pdfDocument=originalPDF;await rotatedPDF.destroy();
      api.shutdown();p.ZRBPDFFigureFallback.shutdown();
      check(!doc.querySelector('.zrb-figure-edit-control,.zrb-manual-menu,.zrb-manual-figure'),'close left controls/images');
      await originalPDF.destroy();
      return {contentPrincipal:!host.document.nodePrincipal.isSystemPrincipal,exact,pngs,nativeTarget:JSON.parse(JSON.stringify(nativeTarget)),crossPageFragments:crossPageFragments.map(entry=>({ref:entry.ref.join('.'),pages:(entry.block.anchor?.pageRects||[]).map(rect=>rect[0])})),cacheStatsBefore,warmStats,cacheStatsAfter,recordFile:decision.file,protectedRefs,oversizedSource,oversizedMask,maskHoles,editorPreview,errors};
    })().then(done,e=>done({failure:String(e),stack:String(e.stack)})).finally(()=>host.close());
  `, [source, nativeSource, baseURL, structure, item, root], true);
  fs.mkdirSync(config.output, { recursive: true });
  fs.writeFileSync(path.join(config.output, 'manual-gecko-result.json'), JSON.stringify({ ...result, pngs: undefined, oversizedSource: undefined, version: browser.version }, null, 2));
  assert.ok(!result.failure, JSON.stringify(result));
  assert.equal(result.contentPrincipal, true);
  for (const [i, src] of result.pngs.entries()) fs.writeFileSync(path.join(config.output, `manual-exact-${i}.png`), Buffer.from(src.split(',')[1], 'base64'));
  // The original installed crop incorrectly includes Figure 17 above Figure 18.
  // Check actual Gecko CSS-mask pixels, using that real hydrated PDF crop.
  const visualBrowser = await require('playwright').firefox.launch({ headless: true });
  try {
    const page = await visualBrowser.newPage({ viewport: { width: 900, height: 1400 } });
    await page.setContent('<body style="margin:0;background:white"><figure style="margin:0;width:600px"><img style="display:block;width:100%"></figure></body>');
    await page.locator('img').evaluate(async (image, src) => { image.src = src; await image.decode(); }, result.oversizedSource);
    const originalCrop = await page.locator('figure').screenshot();
    await page.locator('figure').evaluate((figure, mask) => {
      Object.assign(figure.style, { maskImage: mask, maskMode: 'luminance', maskSize: '100% 100%', maskRepeat: 'no-repeat' });
    }, result.oversizedMask);
    const preservedCrop = await page.locator('figure').screenshot();
    fs.writeFileSync(path.join(config.output, 'native-148-before.png'), originalCrop);
    fs.writeFileSync(path.join(config.output, 'native-148-partial-mask.png'), preservedCrop);
    const pixels = await page.evaluate(async ([first, second]) => {
      const arrays = [];
      for (const bytes of [first, second]) {
        const image = new Image(); image.src = 'data:image/png;base64,' + bytes; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
        arrays.push({ width: canvas.width, height: canvas.height, data: context.getImageData(0, 0, canvas.width, canvas.height).data });
      }
      const [a, b] = arrays; let upperDifferences = 0, upperInk = 0, lowerBeforeInk = 0, lowerAfterInk = 0;
      const ink = (data, i) => data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245;
      for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
        const i = (y * a.width + x) * 4;
        if (y < a.height * .6) {
          if ([0, 1, 2, 3].some(offset => a.data[i + offset] !== b.data[i + offset])) upperDifferences++;
          if (ink(a.data, i)) upperInk++;
        }
        if (y > a.height * .8) { if (ink(a.data, i)) lowerBeforeInk++; if (ink(b.data, i)) lowerAfterInk++; }
      }
      return { upperDifferences, upperInk, lowerBeforeInk, lowerAfterInk };
    }, [originalCrop.toString('base64'), preservedCrop.toString('base64')]);
    assert.equal(pixels.upperDifferences, 0, 'Figure 17 pixels were altered');
    assert.ok(pixels.upperInk > 1000 && pixels.lowerBeforeInk > 100, JSON.stringify(pixels));
    assert.equal(pixels.lowerAfterInk, 0, 'selected lower source pixels remain visible');
    fs.writeFileSync(path.join(config.output, 'native-148-mask-pixel-check.json'), JSON.stringify(pixels, null, 2));
  } finally { await visualBrowser.close(); }
  assert.deepEqual(originals.map(hash), before, 'original PDF/SDT/translation files changed');
  t.diagnostic(JSON.stringify({ version: browser.version, exact: result.exact, recordFile: result.recordFile, nativeRef: item.nativeRef, protectedRefs: result.protectedRefs }));
});
