const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {test}=require('node:test');
const {gecko}=require('../helpers/gecko.cjs');

test('privileged retry controls update content-principal cards and preserve successful translations',{timeout:30000},async t=>{
  const browser=await gecko(t);
  const source=['translation-renderer.js','reading-bilingual.js'].map(name=>fs.readFileSync(path.resolve(__dirname,'../../content/scripts',name),'utf8')).join('\n');
  const result=await browser.run(`
    const done=arguments[arguments.length-1];
    const Cu=Components.utils;
    const browser=Services.appShell.createWindowlessBrowser(false);
    const doc=browser.document;
    doc.documentElement.innerHTML='<head></head><body><article id="sdt-content"><p id="good">Good source</p><h2 id="first">First source</h2><p id="second">Second source</p></article></body>';
    const plugin=Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(),{wantXrays:false});
    Object.assign(plugin,{setTimeout,clearTimeout,document:doc,Zotero:{debug(){},logError(){},Prefs:{get(){}}}});
    Cu.evalInSandbox(arguments[0],plugin);
    Cu.evalInSandbox('this.reader={};this.calls=[];this.cache={"Good source":"成功译文"};'+
      'ReadingBilingual.getProvider=()=>"custom";ReadingBilingual.getConcurrency=()=>2;'+
      'ReadingBilingual.loadCache=async()=>({...cache});ReadingBilingual.saveCache=async(_,entries)=>{Object.assign(cache,entries);};'+
      'ReadingBilingual.callOpenAIBatch=async texts=>{calls.push(texts);return texts.map(text=>"恢复译文 "+text);};'+
      'for(const id of ["good","first","second"]){const el=document.getElementById(id);const card=ReadingBilingual.createCardElement(reader,document,el.textContent,id==="good"?"成功译文":"[翻译失败: NetworkError]");el.after(card);}'+
      'ReadingBilingual.prepareTranslationRetries(reader,document);',plugin);
    const original=doc.getElementById('good').nextElementSibling.outerHTML;
    doc.querySelector('#zrb-translation-retry-summary button').click();
    (async()=>{
      for(let i=0;i<500&&doc.querySelector('#zrb-translation-retry-summary');i++)await new Promise(resolve=>setTimeout(resolve,10));
      return {contentPrincipal:!doc.nodePrincipal.isSystemPrincipal,
        calls:JSON.parse(JSON.stringify(plugin.calls)),cache:JSON.parse(JSON.stringify(plugin.cache)),
        goodUnchanged:original===doc.getElementById('good').nextElementSibling.outerHTML,
        failures:doc.querySelectorAll('[data-zrb-translation-state="failed"]').length,
        controls:doc.querySelectorAll('.zrb-retry-translation').length,
        summary:!!doc.querySelector('#zrb-translation-retry-summary')};
    })().then(done,e=>done({error:String(e)})).finally(()=>browser.close());
  `,[source],true);
  assert.ok(!result.error,JSON.stringify(result));
  assert.equal(result.contentPrincipal,true);
  assert.deepEqual(result.calls,[['First source','Second source']]);
  assert.equal(result.goodUnchanged,true);
  assert.equal(result.cache['Good source'],'成功译文');
  assert.equal(result.cache['First source'],'恢复译文 First source');
  assert.equal(result.failures,0);assert.equal(result.controls,0);assert.equal(result.summary,false);
});
