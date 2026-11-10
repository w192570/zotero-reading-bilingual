const assert = require('node:assert/strict');
const path = require('node:path');
const {test} = require('node:test');
const {firefox} = require('playwright');
const script=process.env.ZRB_SCROLL_SOURCE||path.resolve(__dirname,'../../content/scripts/pdf-figure-fallback.js');

test('automatic prefetch reaches a figure well before it enters the viewport, but remains bounded',async()=>{
  const browser=await firefox.launch({headless:true});
  try {
    const page=await browser.newPage();await page.setContent('<!doctype html><html><body></body></html>');await page.addScriptTag({path:script});
    const result=await page.evaluate(()=>{
      const api=ZRBPDFFigureFallback;const loaded=[];
      const preview=(name,top)=>({figure:{dataset:{state:'idle'},getBoundingClientRect:()=>({top,bottom:top+100,width:200,height:100})},load:()=>loaded.push(name)});
      const state={doc:document,mode:'auto',previews:new Map([['far',preview('far',5000)],['near',preview('near',1500)],['visible',preview('visible',100)]])};
      api.loadVisible(state);return {loaded,margin:api.prefetchMargin(state)};
    });
    assert.deepEqual(result.loaded,['visible','near']);assert.ok(result.margin>=1200&&result.margin<=3200);
  }finally{await browser.close();}
});

test('large figure trimming allows scroll/input tasks to run before completion', async t => {
  const browser=await firefox.launch({headless:true});
  try {
    const page=await browser.newPage();
    await page.addScriptTag({path:script});
    const result=await page.evaluate(async()=>{
      const api=ZRBPDFFigureFallback;
      const canvas=document.createElement('canvas');canvas.width=3000;canvas.height=3000;
      const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,3000,3000);
      ctx.fillStyle='blue';ctx.fillRect(100,100,2800,2800);
      const src=canvas.toDataURL();canvas.width=canvas.height=0;
      const original=api.loadImage.bind(api);
      let ticks=0,timer,start;
      api.loadImage=async(...args)=>{
        await original(...args);start=performance.now();timer=setInterval(()=>ticks++,0);
      };
      const state={doc:document,structure:{catalog:{pages:[{rotation:0}]}}};
      const crop=await api.trimImage(state,src,{direction:'above',rect:[0,0,600,600]},0);
      const elapsed=performance.now()-start;clearInterval(timer);
      return {ticks,elapsed,width:crop.width,height:crop.height};
    });
    t.diagnostic(JSON.stringify(result));
    assert.ok(result.ticks>0,'The complete pixel scan and PNG encoding monopolized the UI thread: '+JSON.stringify(result));
    assert.equal(result.width,2820);assert.equal(result.height,2820);
  } finally {await browser.close();}
});

test('continuous wheel input defers automatic source rendering until scrolling settles', async t=>{
  const browser=await firefox.launch({headless:true});
  try {
    const page=await browser.newPage({viewport:{width:900,height:600}});
    await page.setContent('<iframe style="width:800px;height:400px"></iframe>');
    await page.addScriptTag({path:script});
    await page.evaluate(()=>{
      window.Zotero={Prefs:{get:()=> 'auto'},logError(){}};
      const doc=document.querySelector('iframe').contentDocument;
      doc.open();doc.write('<!doctype html><html><body></body></html>');doc.close();
      doc.body.innerHTML='<div id="sdt-content"><div style="height:1800px"></div><figcaption data-ref-path="0">Figure 1</figcaption><div style="height:3000px"></div></div>';
      const structure={metadata:{processor:{type:'pdf'}},catalog:{pages:[{viewRect:[0,0,600,800]}]},content:[{type:'caption',anchor:{pageRects:[[0,50,300,400,320]]},content:[{text:'Figure 1'}]}]};
      window.renderStarts=[];window.lastWheel=0;
      doc.addEventListener('wheel',()=>{lastWheel=performance.now();},{passive:true});
      ZRBPDFFigureFallback.renderFigure=async()=>{renderStarts.push({sinceInput:performance.now()-lastWheel});throw new Error('stop after observing render start');};
      window.reader={_internalReader:{_sdt:{structure},_primarySDTView:{_iframeDocument:doc},_primaryView:{}}};
      ZRBPDFFigureFallback.ensure(reader);
    });
    assert.equal(await page.evaluate(()=>renderStarts.length),0,'The fixture must begin outside the prefetch margin');
    await page.locator('iframe').hover();
    for(let i=0;i<8;i++){await page.mouse.wheel(0,70);await page.waitForTimeout(30);}
    await page.waitForFunction(()=>renderStarts.length===1);
    const starts=await page.evaluate(()=>renderStarts);
    // Measure against delivered input rather than wall time between automation
    // calls: other concurrent browser tests may delay the next wheel event.
    t.diagnostic(JSON.stringify({renderStarts:starts}));
    assert.ok(starts.every(x=>x.sinceInput>=70),'Source PDF rendering started within the active wheel interval: '+JSON.stringify(starts));
    await page.evaluate(()=>ZRBPDFFigureFallback.shutdown());
  } finally {await browser.close();}
});
