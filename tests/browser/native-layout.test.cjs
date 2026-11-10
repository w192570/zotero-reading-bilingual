const assert=require('node:assert/strict');
const path=require('node:path');
const {test}=require('node:test');
const {firefox}=require('playwright');
async function fixture(page,fail=false) {
  await page.setContent('<!doctype html><iframe style="width:800px;height:650px"></iframe>');
  await page.addScriptTag({path:path.resolve(__dirname,'../../content/scripts/pdf-figure-fallback.js')});
  await page.evaluate(fail=>{
    const doc=document.querySelector('iframe').contentDocument;
    doc.open();doc.write('<!doctype html><html><head><style>figcaption{display:none}.sdt-source-crop{width:600px;height:350px;background:#def}</style></head><body><article id="sdt-content"><figcaption data-ref-path="0">Fig. 11 Test</figcaption><figcaption data-ref-path="1">Table 5 Test</figcaption><figure class="sdt-source-crop" data-ref-path="2">Original photo and table</figure></article></body></html>');doc.close();
    const block=(type,r,text)=>({type,anchor:{pageRects:[[0,...r]]},content:[{text}]});
    const structure={metadata:{processor:{type:'pdf'}},catalog:{pages:[{viewRect:[0,0,600,800]}]},content:[
      block('caption',[51,367,150,385],'Fig. 11 Test'),block('caption',[51,190,295,198],'Table 5 Test'),block('table',[51,76,544,386],'Parameters Description Value'),
    ]};
    window.before=JSON.stringify(structure);window.mode='manual';window.errors=[];
    window.Zotero={Prefs:{get:()=>mode},logError:e=>errors.push(String(e))};
    const canvas=document.createElement('canvas');canvas.width=600;canvas.height=300;canvas.getContext('2d').fillRect(0,0,600,300);
    window.sample=canvas.toDataURL();window.releases=[];
    ZRBPDFFigureFallback.renderRegions=()=>fail?Promise.reject(new Error('native render unavailable')):new Promise(resolve=>releases.push(()=>resolve([sample])));
    window.reader={_internalReader:{_sdt:{structure},_primarySDTView:{_iframeDocument:doc},_primaryView:{}}};
    ZRBPDFFigureFallback.ensure(reader);
  },fail);
}
test('translation-only native replacements commit together after both decode, and disabling restores originals',async()=>{
  const browser=await firefox.launch({headless:true});
  try {
    const page=await browser.newPage();await fixture(page);
    const doc=page.frameLocator('iframe');
    await page.waitForFunction(()=>releases.length===1);
    assert.equal(await doc.locator('[data-ref-path="2"]').isVisible(),true);
    await page.evaluate(()=>releases.shift()());
    await page.waitForFunction(()=>releases.length===1);
    assert.equal(await doc.locator('[data-ref-path="2"]').isVisible(),true,'one completed crop must not hide the original composite');
    assert.equal(await doc.locator('.zrb-pdf-figure-fallback:visible').count(),0);
    await page.evaluate(()=>releases.shift()());
    await doc.locator('[data-ref-path="2"]').waitFor({state:'hidden'});
    assert.equal(await doc.locator('.zrb-pdf-figure-fallback:visible').count(),2);
    assert.equal(await page.evaluate(()=>JSON.stringify(reader._internalReader._sdt.structure)===before),true);
    await page.evaluate(()=>{mode='off';ZRBPDFFigureFallback.ensure(reader);});
    assert.equal(await doc.locator('[data-ref-path="2"]').isVisible(),true);
    assert.equal(await doc.locator('.zrb-pdf-figure-fallback').count(),0);
    assert.deepEqual(await page.evaluate(()=>errors),[]);
  }finally{await browser.close();}
});
test('failed native normalization keeps the complete original visible and does not duplicate it',async()=>{
  const browser=await firefox.launch({headless:true});
  try {
    const page=await browser.newPage();await fixture(page,true);
    await page.waitForFunction(()=>errors.length===2);
    const doc=page.frameLocator('iframe');
    assert.equal(await doc.locator('[data-ref-path="2"]').isVisible(),true);
    assert.equal(await doc.locator('.zrb-pdf-figure-fallback:visible').count(),0);
    await page.evaluate(()=>ZRBPDFFigureFallback.shutdown());
  }finally{await browser.close();}
});
