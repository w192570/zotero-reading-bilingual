const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {test} = require('node:test');
function api() { const scope={}; vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../content/scripts/pdf-figure-fallback.js'),'utf8'),scope); return scope.ZRBPDFFigureFallback; }
const block=(type,rect,text)=>({type,anchor:{pageRects:[[0,...rect]]},content:[{text}]});
test('mixed full-width and side captions keep the entire adjacent diagram',()=>{
  const subject=api();
  const s={catalog:{pages:[{viewRect:[0,0,595,791]}]},content:[
    block('paragraph',[51,472,289,733],'This paragraph describes the structural response under the prescribed loading conditions. '.repeat(3)),
    block('paragraph',[306,497,544,733],'This paragraph describes the structural response under the prescribed loading conditions. '.repeat(3)),
    block('caption',[51,297,286,307],'Fig. 10 Geometric and boundary conditions'),
    block('caption',[51,203,160,273],'Fig. 11 Optimization results of the wing rib structure'),
  ]};
  const wide=subject.getCropCandidates(s,[2],0).find(c=>c.direction==='above'&&c.rect[2]>540);
  assert.ok(wide,'cross-column diagram must extend beyond the left prose column');
  assert.ok(wide.rect[3]<472 && wide.rect[1]>307);
  const side=subject.getCropCandidates(s,[3],0).find(c=>c.direction==='right');
  assert.ok(side,'a tall left caption needs a right-hand candidate');
  assert.ok(side.rect[0]>160 && side.rect[2]>540 && side.rect[3]>=280 && side.rect[1]<60);
});
test('stacked side captions divide at the next caption top, not its bottom',()=>{
  const subject=api();const s={catalog:{pages:[{viewRect:[0,0,595,791]}]},content:[
    block('caption',[51,653,161,732],'Fig. 13 The optimization results of the wing rib structure'),
    block('caption',[51,330,158,420],'Fig. 14 The optimization results of the wing rib structure'),
  ]};
  const a=subject.getCropCandidates(s,[0],0).find(c=>c.direction==='right');
  const b=subject.getCropCandidates(s,[1],0).find(c=>c.direction==='right');
  assert.ok(a&&b);assert.ok(a.rect[1]>=420&&a.rect[1]<445);assert.ok(b.rect[3]<445&&b.rect[3]>=420);
});
test('a destroyed reading document cannot poison another view memory sweep',()=>{
  const subject=api();const doc={get documentElement(){throw new Error("can't access dead object");}};
  const state={doc,regions:new Map(),previews:new Map()};subject.states.set(doc,state);
  assert.doesNotThrow(()=>subject.enforceMemory());assert.equal(subject.states.size,0);
});
test('a side candidate is rejected when the neighboring column contains prose',()=>{
  const subject=api();const s={catalog:{pages:[{viewRect:[0,0,600,800]}]},content:[
    block('caption',[50,300,160,380],'Fig. 1 Long caption'),
    block('paragraph',[305,200,550,700],'This paragraph describes the structural response under the prescribed loading conditions. '.repeat(3)),
  ]};
  assert.ok(!subject.getCropCandidates(s,[0],0).some(c=>c.direction==='right'));
});
test('right-edge multiline captions can recover a left-hand figure',()=>{
  const subject=api();const s={catalog:{pages:[{viewRect:[0,0,600,800]}]},content:[
    block('caption',[440,300,550,380],'Fig. 1 Long caption'),
  ]};
  const left=subject.getCropCandidates(s,[0],0).find(c=>c.direction==='left');
  assert.ok(left && left.rect[0]<60 && left.rect[2]<440);
});
