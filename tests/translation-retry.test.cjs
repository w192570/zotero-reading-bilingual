const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {test}=require('node:test');
const {JSDOM}=require('jsdom');

function setup(initial={}) {
  const dom=new JSDOM('<!doctype html><html><head></head><body><article id="sdt-content"></article></body></html>');
  const doc=dom.window.document,scope={atob,console,setTimeout:(fn)=>setTimeout(fn,0),clearTimeout,
    Zotero:{debug(){},logError(){},Prefs:{get(){}}}};
  for(const name of ['translation-renderer.js','reading-bilingual.js']) {
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../content/scripts',name),'utf8'),scope);
  }
  const api=scope.ReadingBilingual,reader={},cache={...initial},calls=[],writes=[];
  api.getProvider=()=> 'custom';api.getApiKey=()=> 'test-key';api.getBaseUrl=()=> 'https://unit.invalid/v1';
  api.getModel=()=> 'test-model';api.getConcurrency=()=>2;
  api.loadCache=async()=>({...cache});
  api.saveCache=async(_reader,entries)=>{writes.push({...entries});Object.assign(cache,entries);};
  api.callOpenAIBatch=async texts=>{calls.push(Array.from(texts));return Array.from(texts, t=>'译文 '+t);};
  const add=(text,result='[翻译失败: NetworkError when attempting to fetch resource.]')=>{
    const source=doc.createElement('p');source.textContent=text;doc.querySelector('article').append(source);
    const card=api.createCardElement(reader,doc,text,result);source.after(card);return card;
  };
  return {doc,api,reader,cache,calls,writes,add,scope};
}

test('failed legacy cards expose a direct retry and successful cards do not',()=>{
  const {add}=setup();
  assert.ok(add('Failed source').querySelector('.zrb-retry-translation'));
  assert.equal(add('Good source','已完成的译文').querySelector('.zrb-retry-translation'),null);
});

test('retrying one paragraph preserves successful cards/cache and coalesces duplicate clicks',async()=>{
  const {api,reader,doc,cache,calls,add}=setup({'Good source':'已有译文'});
  const good=add('Good source','已有译文'),failed=add('Failed source');
  const original=good.outerHTML;
  await Promise.all([api.retryTranslationCards(reader,doc,[failed]),api.retryTranslationCards(reader,doc,[failed])]);
  assert.deepEqual(calls,[['Failed source']]);
  assert.equal(good.outerHTML,original);
  assert.equal(cache['Good source'],'已有译文');
  assert.equal(cache['Failed source'],'译文 Failed source');
  assert.equal(failed.dataset.zrbTranslationState,'complete');
  assert.equal(failed.querySelector('.zrb-retry-translation'),null);
});

test('bulk retry batches only missing failed paragraphs, reuses cache and deduplicates identical source',async()=>{
  const {api,reader,doc,cache,calls,add}=setup({'Recovered source':'此前已成功保存'});
  const good=add('Good source','不应重翻');
  add('Recovered source');
  for(let i=0;i<7;i++)add('Missing '+i);
  add('Missing 0');
  await api.retryFailedTranslations(reader,doc);
  assert.equal(good.querySelector('.zrb-card-content').textContent,'不应重翻');
  assert.equal(calls.length,2);
  assert.ok(calls.every(texts=>texts.length<=5));
  assert.deepEqual(calls.flat().sort(),Array.from({length:7},(_,i)=>'Missing '+i));
  assert.equal(cache['Recovered source'],'此前已成功保存');
  assert.equal(doc.querySelectorAll('[data-zrb-translation-state="failed"]').length,0);
});

test('a repeated network failure remains retryable without caching an error or looping automatically',async()=>{
  const {api,reader,doc,cache,add}=setup();let attempts=0;
  api.callOpenAIBatch=async()=>{attempts++;throw new TypeError('NetworkError when attempting to fetch resource.');};
  const card=add('Source');
  await api.retryTranslationCards(reader,doc,[card]);
  assert.equal(attempts,1);
  assert.equal(card.dataset.zrbTranslationState,'failed');
  assert.equal(card.querySelector('.zrb-retry-translation').disabled,false);
  assert.equal(cache.Source,undefined);
});

test('a partial response saves successful paragraphs and the next retry sends only the missing result',async()=>{
  const {api,reader,doc,cache,add,calls}=setup();
  const first=add('First source'),second=add('Second source');
  api.callOpenAIBatch=async texts=>{calls.push(Array.from(texts));return calls.length===1?['第一段译文','']:['第二段译文'];};
  await api.retryFailedTranslations(reader,doc);
  assert.equal(first.dataset.zrbTranslationState,'complete');
  assert.equal(second.dataset.zrbTranslationState,'failed');
  assert.equal(cache['First source'],'第一段译文');
  assert.equal(cache['Second source'],undefined);
  await api.retryFailedTranslations(reader,doc);
  assert.deepEqual(calls,[['First source','Second source'],['Second source']]);
});

test('new cache writes reject failure placeholders instead of overwriting a successful translation',async()=>{
  const {api,reader,scope}=setup();let payload;
  api.getCacheFilePath=async()=> 'unit-cache.json';
  api.loadCache=async()=>({Good:'已经完成'});
  scope.IOUtils={writeUTF8:async(_file,text)=>{payload=JSON.parse(text);}};
  await api._saveCacheNow(reader,{Good:'[翻译失败: network]',Bad:'[译文解析空，请重试]',New:'新的译文'});
  assert.equal(payload.translations.Good,'已经完成');
  assert.equal(payload.translations.Bad,undefined);
  assert.equal(payload.translations.New,'新的译文');
});

test('table retries keep their dedicated request instead of treating table content as a paragraph',async()=>{
  const {api,reader,doc,add,calls,cache}=setup();
  const card=add('Table source','[表格翻译失败: NetworkError]');let tableCalls=0;
  api._cardRetryRequests.set(card,async()=>{tableCalls++;return '参数 | 值\n--- | ---\n刚度 | 100';});
  // Plain fallback avoids loading Markdown libraries in this isolated fixture.
  api.setTranslationContent=(element,text)=>{element.textContent=text;element._zrbRawText=text;};
  await api.retryFailedTranslations(reader,doc);
  assert.equal(tableCalls,1);assert.equal(calls.length,0);
  assert.ok(cache['Table source'].includes('刚度'));
});

test('deleting a view while retrying cannot reinsert a card, but an already paid result is cached',async()=>{
  const {api,reader,doc,add,cache}=setup();let finish;
  api.callOpenAIBatch=()=>new Promise(resolve=>{finish=resolve;});
  const card=add('Closed source');const task=api.retryTranslationCards(reader,doc,[card]);
  for(let i=0;i<10&&!finish;i++)await new Promise(setImmediate);
  doc.querySelector('article').remove();finish(['已完成结果']);await task;
  assert.equal(doc.querySelector('.zotero-bilingual-card'),null);
  assert.equal(cache['Closed source'],'已完成结果');
});

test('numbered partial batch replies never assign the third translation to a missing second paragraph',()=>{
  const {api}=setup();
  assert.deepEqual(Array.from(api.parseBatchedTranslations('【P1】第一段\n\n【P3】第三段',3)),['第一段','','第三段']);
});

test('the full translation flow ignores cached errors and reports partial failure instead of 100 percent success',async()=>{
  const good='This successful paragraph already has a translation in the local cache.';
  const one='This missing paragraph must be requested and translated only once.';
  const two='This second missing paragraph will receive an empty result from the server.';
  const {api,reader,doc,scope,calls,cache,writes}=setup({[good]:'原有成功译文',[two]:'[译文解析空，请重试]'});
  Object.defineProperty(doc.defaultView.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
  for(const text of [good,one,two]){const p=doc.createElement('p');p.textContent=text;doc.querySelector('article').append(p);}
  const statuses=[],percentages=[];
  scope.Zotero.ProgressWindow=class{constructor(){this.ItemProgress=class{setText(text){statuses.push(text);}setProgress(value){percentages.push(value);}};}changeHeadline(){}show(){}startCloseTimer(){}};
  api.syncToolbarDisplayMode=()=>{};api.setupSelectionContextMenu=()=>{};
  api.translateSidebarOutline=async()=>{};api.getTranslateTables=()=>false;
  api.callOpenAIBatch=async texts=>{calls.push(Array.from(texts));return ['新译文',''];};
  await api.translateReader(reader,doc,true);
  assert.deepEqual(calls,[[one,two]]);
  assert.equal(cache[good],'原有成功译文');
  assert.equal(cache[one],'新译文');
  assert.equal(doc.querySelectorAll('.zrb-retry-translation').length,1);
  assert.ok(statuses.at(-1).includes('1 段失败'),statuses.at(-1));
  assert.equal(percentages.at(-1),67);
  assert.ok(writes.every(entries=>!Object.values(entries).some(value=>value.startsWith('[译文解析空'))));
});

test('a view closed before retry preparation finishes sends no request',async()=>{
  const {api,reader,doc,add,calls}=setup();let finishCache;
  api.loadCache=()=>new Promise(resolve=>{finishCache=resolve;});
  const card=add('Never send');const task=api.retryTranslationCards(reader,doc,[card]);
  for(let i=0;i<10&&!finishCache;i++)await new Promise(setImmediate);
  doc.querySelector('article').remove();finishCache({});await task;
  assert.equal(calls.length,0);
});

test('a cache-write exception must not turn an already translated paragraph into a retry target',async()=>{
  const {api,reader,doc,scope,calls}=setup();
  Object.defineProperty(doc.defaultView.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
  const p=doc.createElement('p');p.textContent='A complete original paragraph with a successful model response.';doc.querySelector('article').append(p);
  scope.Zotero.ProgressWindow=class{constructor(){this.ItemProgress=class{setText(){}setProgress(){}};}changeHeadline(){}show(){}startCloseTimer(){}};
  api.syncToolbarDisplayMode=()=>{};api.setupSelectionContextMenu=()=>{};api.translateSidebarOutline=async()=>{};api.getTranslateTables=()=>false;
  api.saveCache=async()=>{throw new Error('disk write failed');};
  await api.translateReader(reader,doc,true);
  assert.equal(doc.querySelector('.zotero-bilingual-card').dataset.zrbTranslationState,'complete');
  await api.retryFailedTranslations(reader,doc);
  assert.equal(calls.length,1);
});
