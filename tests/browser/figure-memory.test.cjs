const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { firefox } = require('playwright');

test('long documents in two views release distant images, keep layout and restore on return', {timeout:60000}, async t => {
  const browser = await firefox.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1000,height:900}});
    await page.exposeFunction('testDigest', bytes => require('node:crypto').createHash('sha256').update(Buffer.from(bytes)).digest('hex'));
    for(const file of ['figure-cache.js','pdf-figure-fallback.js'])
      await page.addScriptTag({path:path.resolve(__dirname,'../../content/scripts',file)});
    const result=await page.evaluate(async () => {
      const api=ZRBPDFFigureFallback;
      window.Zotero={Prefs:{get:()=> 'manual'},logError(){}};
      api.cache=ZRBFigureCache.create({digest:bytes=>testDigest([...bytes])});
      const canvas=document.createElement('canvas');canvas.width=1500;canvas.height=1000;
      canvas.getContext('2d').fillRect(0,0,1500,1000);
      const src=canvas.toDataURL();canvas.width=canvas.height=0;
      api.renderFigure=async()=>({src,width:1500,height:1000,rect:[0,0,300,200],direction:'above',displayWidth:650});
      const readers=[],docs=[];
      const wait=async test=>{for(let n=0;n<500;n++){if(test())return;await new Promise(r=>setTimeout(r,10));}throw new Error('Timed out image');};
      for(let view=0;view<2;view++) {
        const frame=document.createElement('iframe');frame.style.cssText='width:850px;height:400px';document.body.append(frame);
        const doc=frame.contentDocument;docs.push(doc);doc.body.innerHTML='<article id="sdt-content"></article>';
        const content=Array.from({length:14},(_,i)=>({type:'caption',anchor:{pageRects:[[0,50,300,400,320]]},content:[{text:'Figure '+(i+1)}]}));
        for(let i=0;i<content.length;i++)doc.querySelector('article').insertAdjacentHTML('beforeend','<figcaption data-ref-path="'+i+'">Figure '+(i+1)+'</figcaption>');
        const reader={_internalReader:{_sdt:{structure:{metadata:{processor:{type:'pdf'},source:{hash:'doc'+view}},catalog:{pages:[{viewRect:[0,0,600,800]}]},content}},_primarySDTView:{_iframeDocument:doc},_primaryView:{}}};
        readers.push(reader);api.ensure(reader);
        for(const figure of doc.querySelectorAll('.zrb-pdf-figure-fallback')) {
          figure.scrollIntoView({block:'center'});figure.querySelector('button:not(.zrb-figure-edit-inline)').click();
          await wait(()=>figure.dataset.state==='loaded');
        }
      }
      api.enforceMemory();
      const figures=docs.flatMap(doc=>[...doc.querySelectorAll('.zrb-pdf-figure-fallback')]);
      const unloaded=figures.filter(f=>f.dataset.state==='unloaded');
      const retained=figures.filter(f=>f.querySelector('img').hasAttribute('src')).length;
      const estimate=api.displayBytesEstimate+(await api.getCache().stats()).memoryBytes;
      const first=figures[0], box=first.querySelector('img').parentElement;
      const before=box.getBoundingClientRect().height;
      first.scrollIntoView({block:'center'});docs[0].dispatchEvent(new Event('scroll'));
      await wait(()=>first.dataset.state==='loaded');
      const after=box.getBoundingClientRect().height;
      api.sync([readers[1]]);const afterClose=api.states.size;
      api.shutdown();
      return {total:figures.length,unloaded:unloaded.length,retained,estimate,before,after,afterClose,closedMemory:(await api.getCache().stats()).memoryBytes};
    });
    assert.equal(result.total,28);
    assert.ok(result.unloaded>20,JSON.stringify(result));
    assert.ok(result.retained<8,JSON.stringify(result));
    assert.ok(result.estimate<=32*1024*1024,JSON.stringify(result));
    assert.ok(result.before>400);
    assert.ok(Math.abs(result.before-result.after)<0.1);
    assert.equal(result.afterClose,1);
    assert.equal(result.closedMemory,0);
    t.diagnostic(JSON.stringify(result));
  } finally {await browser.close();}
});
