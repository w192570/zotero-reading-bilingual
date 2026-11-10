const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const {test,before,after}=require('node:test');
const {firefox}=require('playwright');
let browser;
before(async()=>{browser=await firefox.launch({headless:true});});
after(async()=>{await browser?.close();});

async function fixture(t) {
  let mode='offline';const requests=[];
  const server=http.createServer(async(req,res)=>{
    if(req.url==='/v1/chat/completions') {
      let body='';for await(const data of req)body+=data;
      const payload=JSON.parse(body);
      const source=payload.messages.find(m=>m.role==='user').content;
      const texts=Array.from(source.matchAll(/【P\d+】\n([\s\S]*?)(?=\n\n【P\d+】|$)/g),m=>m[1]);
      requests.push(texts);
      if(mode==='offline'){req.socket.destroy();return;}
      res.setHeader('Content-Type','application/json');
      const content=texts.map((text,i)=>mode==='partial'&&i===1?'':`【P${i+1}】恢复的译文：${text}`).filter(Boolean).join('\n\n');
      res.end(JSON.stringify({choices:[{message:{content}}]}));return;
    }
    const name=req.url.slice(1);
    if(['translation-renderer.js','reading-bilingual.js'].includes(name)) {
      res.setHeader('Content-Type','text/javascript; charset=utf-8');
      res.end(fs.readFileSync(path.resolve(__dirname,'../../content/scripts',name)));return;
    }
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end('<!doctype html><html><head></head><body style="background:#dfe8c7;font:20px Arial;margin:32px"><article id="sdt-content"><p id="good">Successful source already translated and cached.</p><h2 id="first">2.2 Fabrication of the wing rib prototype</h2><p id="second">The model was printed using FDM and PLA material.</p><figcaption id="third">Figure 2 Wing rib under the prescribed load</figcaption></article></body></html>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let page;
  t.after(async()=>{await page?.close();await new Promise(resolve=>server.close(resolve));});
  page=await browser.newPage({viewport:{width:1100,height:850}});
  page.setDefaultTimeout(7000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  for(const name of ['translation-renderer.js','reading-bilingual.js'])await page.addScriptTag({url:'/'+name});
  await page.evaluate(()=>{
    window.Zotero={debug(){},logError(){},Prefs:{get(){}}};
    window.reader={};window.cache={'Successful source already translated and cached.':'原有成功译文'};
    const originalFetch=window.fetch;window.fetchAttempts=0;
    window.fetch=(...args)=>{window.fetchAttempts++;return originalFetch(...args);};
    const api=ReadingBilingual;
    api.getProvider=()=> 'custom';api.getApiKey=()=> 'local-test-token';api.getModel=()=> 'test-model';
    api.getBaseUrl=()=>location.origin+'/v1';api.getConcurrency=()=>2;
    api.loadCache=async()=>({...cache});api.saveCache=async(_reader,entries)=>{Object.assign(cache,entries);};
    for(const id of ['good','first','second','third']) {
      const source=document.getElementById(id);
      const card=api.createCardElement(reader,document,source.textContent,id==='good'?'原有成功译文':'[翻译失败: NetworkError when attempting to fetch resource.]');
      card.dataset.testId=id;source.after(card);
    }
    api.prepareTranslationRetries(reader,document);
    const style=document.createElement('style');style.textContent=api.getGeneratedCSS();document.head.append(style);
  });
  return {page,requests,errors,setMode(value){mode=value;}};
}

test('real network disconnect leaves a single paragraph retryable; bulk recovery sends only failed source text',{timeout:30000},async t=>{
  const {page,requests,errors,setMode}=await fixture(t);
  const good=await page.locator('[data-test-id="good"]').evaluate(el=>el.outerHTML);
  const first=page.locator('[data-test-id="first"]');
  await first.locator('.zrb-retry-translation').click();
  await page.waitForFunction(()=>document.querySelector('[data-test-id="first"]').dataset.zrbTranslationState==='failed');
  assert.equal(await page.evaluate(()=>fetchAttempts),2,'one user click uses the existing bounded two-attempt request policy');
  // Firefox may internally resend a connection dropped before any response.
  // Count JS fetch calls separately from requests observed by the test server.
  const failedRequests=requests.length;
  assert.ok((await first.locator('.zrb-card-content').textContent()).includes('NetworkError'));
  assert.equal(await first.locator('.zrb-retry-translation').isEnabled(),true);
  assert.equal(await page.evaluate(()=>Object.keys(cache).length),1,'network errors never enter the translation cache');
  if(process.env.ZRB_RETRY_OUTPUT) {
    fs.mkdirSync(process.env.ZRB_RETRY_OUTPUT,{recursive:true});
    await page.screenshot({path:path.join(process.env.ZRB_RETRY_OUTPUT,'failed.png'),fullPage:true});
  }
  setMode('online');
  await page.locator('#zrb-translation-retry-summary button').click();
  await page.waitForFunction(()=>!document.querySelector('#zrb-translation-retry-summary'));
  assert.equal(requests.length,failedRequests+1);
  assert.equal(requests.at(-1).length,3);
  assert.ok(requests.every(batch=>!batch.some(text=>text.includes('Successful source'))));
  assert.equal(await page.locator('[data-test-id="good"]').evaluate(el=>el.outerHTML),good);
  assert.equal(await page.locator('.zrb-retry-translation').count(),0);
  assert.equal(await page.evaluate(()=>Object.keys(cache).length),4);
  assert.deepEqual(errors,[]);
});

test('a numbered partial response preserves completed rows and manual correction avoids another model request',{timeout:20000},async t=>{
  const {page,requests,setMode,errors}=await fixture(t);setMode('partial');
  await page.locator('#zrb-translation-retry-summary button').click();
  await page.waitForFunction(()=>document.querySelector('[data-test-id="third"]').dataset.zrbTranslationState==='complete');
  assert.equal(requests.length,1);
  assert.equal(await page.locator('.zrb-retry-translation').count(),1);
  const second=page.locator('[data-test-id="second"]');
  assert.equal(await second.getAttribute('data-zrb-translation-state'),'failed');
  await second.locator('.zrb-card-content').dblclick();
  await second.locator('textarea').fill('手动补好的译文');
  await second.locator('textarea').press('Control+Enter');
  await page.waitForFunction(()=>!document.querySelector('#zrb-translation-retry-summary'));
  assert.equal(requests.length,1,'manual repair does not call the model');
  assert.equal(await page.evaluate(()=>cache['The model was printed using FDM and PLA material.']),'手动补好的译文');
  assert.equal(await page.locator('.zrb-retry-translation').count(),0);
  assert.deepEqual(errors,[]);
});

test('a translated paragraph can be explicitly retranslated without reading its cached result',{timeout:20000},async t=>{
  const {page,requests,setMode,errors}=await fixture(t);setMode('online');
  await page.evaluate(()=>{
    const source=document.querySelector('#good');
    const card=ReadingBilingual.createCardElement(reader,document,source.textContent,'旧译文');
    card.dataset.testId='retranslate';source.after(card);
    card.dataset.zrbTranslationState='complete';
    ReadingBilingual.attachCardActionHandlers(card,reader,document,source.textContent);
  });
  const card=page.locator('[data-test-id="retranslate"]');
  await card.locator('.zrb-btn-retranslate').click();
  await page.waitForFunction(()=>document.querySelector('[data-test-id="retranslate"] .zrb-card-content').textContent.includes('恢复的译文'));
  assert.equal(requests.length,1);
  assert.deepEqual(requests[0],['Successful source already translated and cached.'],'the action sends only this paragraph and bypasses its cached translation');
  assert.equal(await page.evaluate(()=>cache['Successful source already translated and cached.']),'恢复的译文：Successful source already translated and cached.');
  assert.deepEqual(errors,[]);
});
