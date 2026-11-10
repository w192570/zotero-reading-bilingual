const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {test}=require('node:test');
const {JSDOM}=require('jsdom');
function setup(content) {
  const dom=new JSDOM('<!doctype html><html><body><article id="sdt-content"></article></body></html>');
  const doc=dom.window.document;
  for(const [i,b] of content.entries()){
    const el=doc.createElement(b.type==='caption'?'figcaption':'figure');
    el.dataset.refPath=i;el.textContent=(b.content||[]).map(n=>n.text||'').join('');
    if(b.type!=='caption')el.className='sdt-source-crop';
    doc.querySelector('article').append(el);
  }
  const scope={setTimeout,clearTimeout,Zotero:{Prefs:{get:()=> 'manual'},logError(){}}};
  vm.runInNewContext(fs.readFileSync(process.env.ZRB_FIGURE_SOURCE||path.join(__dirname,'../content/scripts/pdf-figure-fallback.js'),'utf8'),scope);
  const structure={metadata:{processor:{type:'pdf'}},catalog:{pages:[{viewRect:[0,0,600,800]}]},content};
  const reader={_internalReader:{_sdt:{structure},_primarySDTView:{_iframeDocument:doc},_primaryView:{}}};
  return {api:scope.ZRBPDFFigureFallback,doc,reader,structure};
}
const b=(type,rect,text)=>({type,anchor:{pageRects:[[0,...rect]]},content:[{text}]});
test('an existing right-hand native figure is associated with its left caption without a duplicate',()=>{
  const {api,reader,doc}=setup([b('image',[312,578,544,733],''),b('caption',[51,715,150,732],'Fig. 10 Experimental set-up')]);
  api.ensure(reader);
  assert.equal(doc.querySelectorAll('.zrb-pdf-figure-fallback:not([data-native-replacement])').length,0);
  assert.equal(doc.querySelector('.zrb-pdf-figure-fallback').hidden,true,'original remains the only visible image until replacement decodes');
});
test('native image moves with its caption after intervening prose and restores on disable',()=>{
  const {api,reader,doc}=setup([b('image',[312,578,544,733],''),b('paragraph',[51,500,544,557],'Body text.'),b('caption',[51,715,150,732],'Fig. 10 Experimental set-up')]);
  api.ensure(reader);
  const caption=doc.querySelector('[data-ref-path="2"]'),image=doc.querySelector('[data-ref-path="0"]');
  assert.equal(caption.previousElementSibling.dataset.nativeReplacement,'true');
  api.shutdown();assert.equal(doc.querySelector('article').firstElementChild,image);
});
test('a native composite containing photo, captions and table is split without altering source SDT',()=>{
  const {api,reader,doc,structure}=setup([
    b('caption',[51,367,150,385],'Fig. 11 Experimental set-up'),
    b('caption',[51,190,295,198],'Table 5 Parameters'),
    b('table',[51,76,544,386],'Parameters Description Value'),
  ]);
  const before=JSON.stringify(structure);api.ensure(reader);
  const previews=[...doc.querySelectorAll('.zrb-pdf-figure-fallback')];
  assert.equal(previews.length,2,'photo and table need separate bounded render targets');
  assert.equal(previews[0].nextElementSibling.dataset.refPath,'0');
  assert.equal(previews[1].previousElementSibling.dataset.refPath,'1');
  const state=api.states.get(doc);
  const photo=state.cropOverrides.get('0:0')[0].rect,table=state.cropOverrides.get('1:0')[0].rect;
  assert.ok(photo[0]>150&&photo[1]>198&&photo[3]<=386);
  assert.ok(table[3]<190&&table[1]>=76);
  assert.equal(JSON.stringify(structure),before);
  api.shutdown();assert.equal(doc.querySelector('[data-ref-path="2"]').hidden,false);
});
test('another column figure with its own closer caption does not suppress a missing figure',()=>{
  const {api,reader,doc}=setup([b('image',[315,400,550,600],''),b('caption',[315,380,550,390],'Fig. 2 Existing'),b('caption',[50,500,150,520],'Fig. 1 Missing')]);
  api.ensure(reader);assert.equal(doc.querySelectorAll('.zrb-pdf-figure-fallback[data-source-ref="2"]').length,1);
});
test('two separated native panels are replaced together with their axes and labels',()=>{
  const {api,reader,doc}=setup([
    b('image',[193,644,357,721],''),b('image',[364,645,533,715],''),
    b('caption',[51,693,157,732],'Fig. 6 Two panels'),
    b('paragraph',[51,300,545,608],'This paragraph describes the structural response under the prescribed loading conditions. '.repeat(3)),
  ]);
  api.ensure(reader);const state=api.states.get(doc),candidate=state.cropOverrides.get('2:0')[0];
  assert.ok(candidate.rect[0]<190&&candidate.rect[2]>533&&candidate.rect[3]>732);
  assert.equal(state.nativeGroups[0].originals.length,2);
  api.shutdown();assert.equal(doc.querySelectorAll('figure[hidden]').length,0);
});
test('a formula crop containing a figure retains separate formula pixels',()=>{
  const math=b('math',[51,75,545,375],'Equation 18');
  math.content[0].anchor={textMap:'[[0,0,51,330,545,375]]'};
  const {api,reader,doc}=setup([math,b('caption',[51,244,152,274],'Fig. 1 Flowchart')]);
  api.ensure(reader);const state=api.states.get(doc);
  assert.equal(state.nativeGroups.length,1);assert.equal(state.nativeGroups[0].previews.length,2);
  assert.ok(state.cropOverrides.get('0:0')[0].rect[1]>=328);
  assert.ok(state.cropOverrides.get('1:0')[0].rect[3]<330);
  api.shutdown();
});
test('an ambiguous native composite with multiple figure captions is preserved intact',()=>{
  const {api,reader,doc}=setup([b('image',[50,100,550,750],''),
    b('caption',[51,500,150,530],'Fig. 1 One'),b('caption',[51,300,150,330],'Fig. 2 Two')]);
  api.ensure(reader);assert.equal(api.states.get(doc).nativeGroups.length,0);
  assert.equal(doc.querySelector('[data-ref-path="0"]').hidden,false);
  assert.equal(doc.querySelectorAll('.zrb-pdf-figure-fallback').length,0);
  api.shutdown();
});
test('a misclassified native table containing three side figures and a table is split as a complete group',()=>{
  const {api,reader,doc}=setup([
    b('caption',[51,703,145,732],'Fig. 19 Simulation'),b('caption',[51,594,153,632],'Table 8 Comparison'),
    b('caption',[51,514,156,532],'Fig. 20 Bending'),b('caption',[51,339,151,357],'Fig. 21 Torsion'),
    b('table',[170,204,545,733],'Bending load application point and results'),
  ]);
  api.ensure(reader);const state=api.states.get(doc);
  assert.equal(state.nativeGroups.length,1);assert.equal(state.nativeGroups[0].previews.length,4);
  const a=state.cropOverrides.get('0:0')[0].rect,t=state.cropOverrides.get('1:0')[0].rect;
  const c=state.cropOverrides.get('2:0')[0].rect,d=state.cropOverrides.get('3:0')[0].rect;
  assert.ok(a[1]>=632&&a[3]>=732&&t[1]>=532&&t[3]>=632);
  assert.ok(c[1]>=357&&c[3]>=532&&d[1]>=204&&d[3]>=357);
  assert.equal(doc.querySelectorAll('.zrb-pdf-figure-fallback:not([data-native-replacement])').length,0);
  api.shutdown();
});
test('a side plot fragment below the caption top is recovered across the full diagram width',()=>{
  const {api,reader,doc}=setup([b('image',[200,84,422,259],''),b('caption',[51,244,160,274],'Fig. 5 Curves')]);
  api.ensure(reader);const state=api.states.get(doc),region=state.cropOverrides.get('1:0')?.[0].rect;
  assert.ok(region&&region[0]<200&&region[2]>535&&region[1]>=50);
  api.shutdown();
});
test('short continuation prose remains a crop boundary',()=>{
  const {api}=setup([]);
  assert.equal(api.isProse(b('paragraph',[306,484,544,508],'higher compliance, reflecting the expected trade-off between stiffness and safety.')),true);
});
