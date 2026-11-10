const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { test, before, after } = require('node:test');
const { firefox } = require('playwright');

let browser;
before(async () => { browser = await firefox.launch({ headless: true }); });
after(async () => { await browser?.close(); });

async function fixture(t, fontSize = '20px') {
  const page = await browser.newPage({viewport:{width:1100,height:1100}});
  t.after(() => page.close());
  const errors=[];
  page.on('pageerror', e=>errors.push(e.message));
  await page.setContent(`<!doctype html><html><head><style>
    body{background:#dfe8c7;color:#111;font:20px Arial;margin:32px;}
    #sdt-content{max-width:900px;margin:auto;}
    #sdt-content p{text-align:justify;}
    h1,h2,h3,h4,h5,h6{font-weight:bold;}
    table{width:100%;border-collapse:collapse;}td{border:1px solid #777;padding:8px;}
  </style></head><body><article id="sdt-content">
    <h1 id="title">Analysis of additively manufactured wing ribs</h1>
    <h2 id="section">2. Problem description</h2><h3 id="subsection">2.1 Case study</h3>
    <h4 id="deep">2.1.1 Model</h4><h5 id="fifth">2.1.1.1 Geometry</h5><h6 id="sixth">2.1.1.1.1 Parameters</h6>
    <p id="body">Figure 1 shows the wing rib specimen. This is a normal paragraph, not a caption.</p>
    <figcaption id="figure">Figure 1 Wing rib specimen with printed ribs</figcaption>
    <figcaption id="long">Figure 2 Results under multiple load cases and the relationship between the displacement and structural mass.</figcaption>
    <table><caption id="table-caption">Table I Mechanical properties of PLA and ABS</caption><tbody><tr><td id="cell">PLA</td><td>3500 MPa</td></tr></tbody></table>
    <figcaption id="nested"><p id="nested-source">Figure 4 Nested caption</p></figcaption>
  </article></body></html>`);
  for (const file of ['translation-renderer.js','reading-bilingual.js']) {
    await page.addScriptTag({path:path.resolve(__dirname,'../../content/scripts',file)});
  }
  await page.evaluate(fontSize => {
    window.Zotero={debug(){},logError(){},Prefs:{get(){}}};
    ReadingBilingual.getFontSize=()=>fontSize;
    ReadingBilingual.getFontFamily=()=>'sans';
    ReadingBilingual.getFrameTheme=()=>'indigo';
    ReadingBilingual.getBorderStyle=()=>'straight';
    const texts={title:'增材制造翼肋结构分析',section:'2. 问题描述',subsection:'2.1 案例研究',deep:'2.1.1 模型',
      fifth:'2.1.1.1 几何形状',sixth:'2.1.1.1.1 参数',body:'图 1 展示了机翼壁板试样。这是普通正文，不能仅因句首出现图号就变成图注。',
      figure:'图 1 带有打印翼肋的机翼壁板试样',long:'图 2 不同载荷下的计算结果、位移与结构质量之间的变化关系。'.repeat(4),
      'table-caption':'表 I PLA 与 ABS 的力学性能','nested-source':'图 4 嵌套结构中的图注'};
    for(const [id,text] of Object.entries(texts)) {
      const el=document.getElementById(id);
      const card=ReadingBilingual.createCardElement({},document,el.textContent,text);
      card.dataset.testId=id;
      el.after(card);
    }
    // Simulate a previously rendered Markdown translation using the actual
    // renderer's DOM shape; no network or rendering-library download is needed.
    document.querySelector('[data-test-id="long"] .zrb-card-content').innerHTML='<div class="zrb-rich-text"><p>'+texts.long+'</p></div>';
    const style=document.createElement('style');style.id='zotero-bilingual-style';
    style.textContent=ReadingBilingual.getGeneratedCSS();document.head.append(style);
  },fontSize);
  return {page,errors};
}

test('cached heading translations retain hierarchy and figure/table captions are smaller and centered',async t=>{
  const {page,errors}=await fixture(t);
  const sizes=await page.evaluate(()=>Object.fromEntries(['title','section','subsection','deep','fifth','sixth','body','figure','long','table-caption','nested-source'].map(id=>{
    const el=document.querySelector(`[data-test-id="${id}"] .zrb-card-content`),s=getComputedStyle(el);
    return [id,{size:parseFloat(s.fontSize),weight:Number(s.fontWeight),align:s.textAlign}];
  })));
  for(const id of ['title','section','subsection','deep','fifth','sixth']) {
    assert.ok(sizes[id].size>sizes.body.size,JSON.stringify(sizes));
    assert.ok(sizes[id].weight>=700,id);
  }
  assert.ok(sizes.title.size>sizes.section.size&&sizes.section.size>sizes.subsection.size);
  for(const id of ['figure','long','table-caption','nested-source']) {
    assert.ok(Math.abs(sizes[id].size/sizes.body.size-0.85)<0.01,JSON.stringify(sizes));
    assert.equal(sizes[id].align,'center',id);
  }
  assert.equal(await page.locator('[data-test-id="long"] p').evaluate(el=>getComputedStyle(el).textAlign),'center');
  assert.equal(await page.locator('#cell').evaluate(el=>parseFloat(getComputedStyle(el).fontSize)),20,'table body keeps its size');
  assert.equal(sizes.body.weight,400,'body mention of a figure remains prose');
  assert.ok(await page.locator('[data-test-id="long"] .zrb-card-content').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
  for(const mode of ['bilingual','translation','original']) {
    await page.evaluate(mode=>ReadingBilingual.applyReaderDisplayMode(document,mode),mode);
    assert.equal(await page.locator('[data-test-id="section"]').isVisible(),mode!=='original');
    assert.equal(await page.locator('[data-test-id="figure"]').isVisible(),mode!=='original');
  }
  await page.evaluate(()=>ReadingBilingual.applyReaderDisplayMode(document,'translation'));
  if(process.env.ZRB_TYPOGRAPHY_OUTPUT) {
    fs.mkdirSync(process.env.ZRB_TYPOGRAPHY_OUTPUT,{recursive:true});
    await page.screenshot({path:path.join(process.env.ZRB_TYPOGRAPHY_OUTPUT,'translation.png'),fullPage:true});
    await page.evaluate(()=>ReadingBilingual.applyReaderDisplayMode(document,'bilingual'));
    await page.screenshot({path:path.join(process.env.ZRB_TYPOGRAPHY_OUTPUT,'bilingual.png'),fullPage:true});
  }
  assert.deepEqual(errors,[]);
});

test('relative typography follows user font settings and caption editing remains usable',async t=>{
  const {page}=await fixture(t,'24px');
  const result=await page.evaluate(()=>{
    const style=id=>getComputedStyle(document.querySelector(`[data-test-id="${id}"] .zrb-card-content`));
    return {body:parseFloat(style('body').fontSize),caption:parseFloat(style('figure').fontSize),heading:parseFloat(style('section').fontSize)};
  });
  assert.equal(result.body,24);
  assert.ok(Math.abs(result.caption-20.4)<0.01);
  assert.ok(result.heading>24);
  const card=page.locator('[data-test-id="figure"]');
  await card.locator('.zrb-card-content').dblclick();
  await card.locator('textarea').fill('图 1 修订后的图注');
  await card.locator('textarea').press('Escape');
  assert.equal(await card.locator('textarea').count(),0);
  assert.equal(await card.locator('.zrb-card-content').evaluate(el=>getComputedStyle(el).textAlign),'center');
});

test('chapter numbers survive cached full translation and selected-text translation without changing cached text',async t=>{
  const {page,errors}=await fixture(t);
  const result=await page.evaluate(async()=>{
    const api=ReadingBilingual;
    const root=document.getElementById('sdt-content');
    root.innerHTML='<h2 id="full-heading">2. Preliminaries</h2><h3 id="selected-heading">3. Experiments</h3><p id="ordinary">2. This is ordinary body text.</p>';
    const cache={'2. Preliminaries':'预备知识'};
    const writes=[];
    const oldCard=api.createCardElement({},document,'2. Preliminaries','预备知识');
    document.getElementById('full-heading').after(oldCard);
    api.getApiKey=()=> 'test-key';
    api.getRealContentDoc=()=>document;
    api.syncToolbarDisplayMode=()=>{};
    api.setupSelectionContextMenu=()=>{};
    api.prepareStructuredNotes=()=>{};
    api.injectCachedMetadataTranslations=()=>0;
    api.loadCache=async()=>({...cache});
    api.getProvider=()=> 'custom';
    api.callModelText=async()=> '实验';
    api.saveCache=async(_reader,entries)=>writes.push({...entries});
    window.Zotero.ProgressWindow=function(){
      this.changeHeadline=()=>{};
      this.ItemProgress=function(){this.setProgress=()=>{};this.setText=()=>{};};
      this.show=()=>{};
      this.startCloseTimer=()=>{};
    };
    await api.translateReader({},document,true,false);
    const full=document.querySelector('#full-heading + .zotero-bilingual-card .zrb-card-content').textContent;

    const freshSource=document.createElement('h2');freshSource.textContent='4. Results';root.append(freshSource);
    const freshCard=api.createCardElement({},document,freshSource.textContent,'正在翻译…',true,freshSource);
    freshSource.after(freshCard);
    api.applyTranslationResults({},document,[{element:freshSource,card:freshCard,text:freshSource.textContent}],['结果']);
    const fresh=freshCard.querySelector('.zrb-card-content').textContent;

    const range=document.createRange();
    range.selectNodeContents(document.getElementById('selected-heading'));
    const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
    await api.translateSelectedText({},document,selection.toString().trim(),selection);
    const selected=document.querySelector('#selected-heading + .zotero-bilingual-card .zrb-card-content').textContent;
    const ordinary=api.preserveHeadingNumber(document.getElementById('ordinary'), '2. This is ordinary body text.', '普通正文');
    const duplicate=api.preserveSectionNumber('2.1.', '2.1. 已带编号');
    const compactHeading=document.createElement('h2');compactHeading.textContent='5. Results';
    const compact=api.preserveHeadingNumber(compactHeading,'5.Results','结果');
    const romanHeading=document.createElement('h2');romanHeading.textContent='IV. Results';
    const roman=api.sectionNumberForHeading(romanHeading,romanHeading.textContent);
    const chapterHeading=document.createElement('h1');chapterHeading.textContent='Chapter 1 Introduction';
    const chapterClean=api.preserveHeadingNumber(chapterHeading,chapterHeading.textContent,'C 第 1 章 引言');
    const descriptionHeading=document.createElement('h2');descriptionHeading.textContent='Description of the geometry';
    const descriptionClean=api.preserveHeadingNumber(descriptionHeading,descriptionHeading.textContent,'D 几何外形描述');
    const staleChapterCard=api.createCardElement({},document,chapterHeading.textContent,'C 第 1 章 引言');
    chapterHeading.after(staleChapterCard);root.append(chapterHeading,staleChapterCard);
    const staleDescriptionCard=api.createCardElement({},document,descriptionHeading.textContent,'D 几何外形描述');
    descriptionHeading.after(staleDescriptionCard);root.append(descriptionHeading,staleDescriptionCard);
    api.repairExistingHeadingNumbers(document);
    const repairedChapter=staleChapterCard.querySelector('.zrb-card-content').textContent;
    const repairedDescription=staleDescriptionCard.querySelector('.zrb-card-content').textContent;
    const caption=document.createElement('figure');caption.innerHTML='<figcaption><h2>2. Figure caption</h2></figcaption>';
    const captionNumber=api.sectionNumberForHeading(caption.querySelector('h2'));
    return {full,fresh,selected,ordinary,duplicate,compact,roman,chapterClean,descriptionClean,repairedChapter,repairedDescription,captionNumber,writes,cacheValue:cache['2. Preliminaries']};
  });
  assert.equal(result.full,'2. 预备知识');
  assert.equal(result.fresh,'4. 结果','a new full-translation response also restores the source heading number');
  assert.equal(result.selected,'3. 实验');
  assert.equal(result.ordinary,'普通正文','a numbered prose paragraph is not treated as a heading');
  assert.equal(result.duplicate,'2.1. 已带编号','existing numbering is not duplicated');
  assert.equal(result.compact,'5. 结果','a heading without a space after its source number is still recognized');
  assert.equal(result.roman,'IV.','standalone Roman numeral section labels remain recognized');
  assert.equal(result.chapterClean,'第 1 章 引言','Chapter 1 is recognized as Arabic chapter numbering, not Roman C');
  assert.equal(result.descriptionClean,'几何外形描述','a heading word initial is not mistaken for a Roman section number');
  assert.equal(result.repairedChapter,'第 1 章 引言','an existing card loses the spurious C without duplicating its translated chapter number');
  assert.equal(result.repairedDescription,'几何外形描述','an existing card loses the spurious D from an unnumbered heading');
  assert.equal(result.captionNumber,'','a heading-like caption is excluded');
  assert.equal(result.cacheValue,'预备知识','repairing an existing card never rewrites cached translation text');
  assert.deepEqual(result.writes,[{'3. Experiments':'实验'}],'the cache retains the model translation without a display-only prefix');
  assert.deepEqual(errors,[]);
});
