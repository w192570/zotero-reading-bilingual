const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function api() {
  const scope = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../content/scripts/pdf-figure-fallback.js'), 'utf8'), scope);
  return scope.ZRBPDFFigureFallback;
}
const block = (type, rect, text = '') => ({ type, anchor: { pageRects: [[0, ...rect]] }, content: [{ text }] });
const prose = 'This paragraph describes the structural response under the prescribed loading conditions. '.repeat(3);
const structure = content => ({ catalog: { pages: [{ viewRect: [0, 0, 600, 800] }] }, content });

test('a caption above a raster figure selects its own column and stops at neighboring prose', () => {
  const subject = api();
  const doc = structure([
    block('paragraph', [317, 332, 558, 570], prose),
    block('caption', [317, 305, 508, 314], 'Figure 3 Topologies'),
    block('paragraph', [51, 100, 292, 500], prose),
  ]);
  const candidates = subject.getCropCandidates(doc, [1], 0);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].direction, 'below');
  assert.ok(candidates[0].rect[0] > 300);
  assert.ok(candidates[0].rect[3] < 305);
  assert.ok(candidates[0].rect[2] < 570);
});

test('vector plot labels misclassified as a paragraph do not block the graphic region', () => {
  const subject = api();
  const doc = structure([
    block('heading', [103, 141, 499, 724], 'JournalPre-proof'),
    block('paragraph', [49, 308, 282, 474], prose),
    block('paragraph', [51, 161, 283, 294], '5k 10k 50k 100k 200k 300k 400k 500k 1M 2M Point Numbers 0 5 10 15 20 25 30 35 40 45 50 GPU Memory Usage Maximum Points on a Single A100 GPU VanillaAttention Galerkin GNOT Transolver LRQ-Solver'),
    block('caption', [63, 139, 268, 148], 'Fig. 1: Comparison of model capability'),
  ]);
  const candidates = subject.getCropCandidates(doc, [3], 0);
  const above = candidates.find(x => x.direction === 'above');
  assert.ok(above);
  assert.ok(above.rect[1] < 161 && above.rect[3] > 294);
  assert.ok(above.rect[3] < 308);
});

test('real paragraphs and tables delimit crops; a tiny gap never becomes a full-page fallback', () => {
  const subject = api();
  const doc = structure([
    block('paragraph', [50, 330, 280, 700], prose),
    block('caption', [50, 300, 280, 310], 'Figure 2'),
    block('table', [50, 50, 280, 285]),
  ]);
  assert.equal(subject.getCropCandidates(doc, [1], 0).length, 0);
});

test('native crop rendering avoids the wrapped page object that has no getViewport', async () => {
  const subject = api();
  let calls = 0;
  const result = await subject.renderRegions({
    disposed: false,
    base: { _pdfRenderer: { async renderRegionCrops(page, rects) { calls++; assert.equal(page, 3); return rects.map(() => 'data:image/png;base64,AA=='); } } },
    pdf: { async getPage() { return {}; } },
  }, 3, [[330, 50, 545, 295]]);
  assert.equal(calls, 1);
  assert.equal(result[0], 'data:image/png;base64,AA==');
});

test('pixel crop coordinates map back into PDF space for all quarter-turn rotations', () => {
  const subject = api();
  for (const rotation of [0, 90, 180, 270]) {
    const result = subject.mapTrimToPDF([10, 20, 110, 220], [0.1, 0.1, 0.9, 0.9], rotation);
    assert.deepEqual(Array.from(result), [20, 40, 100, 200]);
  }
});

test('two existing image/caption pairs establish placement and prevent reusing the previous figure', () => {
  const subject = api();
  const doc = structure([
    block('caption', [317, 400, 558, 410], 'Figure 1'), block('image', [330, 270, 540, 390]),
    block('caption', [51, 400, 292, 410], 'Figure 2'), block('image', [60, 270, 280, 390]),
  ]);
  assert.equal(subject.captionDirection(doc), 'below');
  doc.content[3].anchor.pageRects[0] = [0, 60, 420, 280, 550];
  assert.equal(subject.captionDirection(doc), null, 'mixed placement must not impose a document-wide guess');
});

test('excluded running headers still bound a figure crop without diagonal watermarks splitting it', () => {
  const subject = api();
  const header = { ...block('paragraph', [245, 804, 363, 817], 'Journal Pre-proof'), flowClass: 'excluded' };
  const doc = structure([header, block('caption', [50, 560, 530, 577], 'Fig. 3 Overview')]);
  doc.catalog.pages[0].viewRect = [0, 0, 595, 842];
  doc.catalog.pages.push({viewRect:[0,0,595,842]});
  doc.content.push({...header,anchor:{pageRects:[[1,245,804,363,817]]}});
  const above = subject.getCropCandidates(doc, [1], 0).find(x => x.direction === 'above');
  assert.equal(above.rect[3], 801);
});

test('an oversized formula box cannot swallow a figure when its text coordinates locate the formula above it', () => {
  const subject=api();
  const math=block('math',[36.28,68.693,452.984,284.46],'F = FeedForward(F)');
  math.content[0].anchor={textMap:'[[0,0,36.3,269.6,288,284.5]]'};
  const doc=structure([math,block('caption',[72.38,49.1,521.75,57.07],'Fig. 3 Architecture')]);
  const before=JSON.stringify(doc);
  const above=subject.getCropCandidates(doc,[1],0).find(x=>x.direction==='above');
  assert.ok(above,'The formula block includes both the real formula and the figure: use its text bounds');
  assert.ok(above.rect[1]<68.7 && above.rect[3]>242.8);
  assert.ok(above.rect[3]<269.6,'The real formula must remain outside the figure crop');
  assert.equal(JSON.stringify(doc),before);
});

test('missing or malformed formula text coordinates retain the conservative original boundary', () => {
  const subject=api();
  for(const textMap of [undefined,'invalid','[[0,1,36,269,288,284]]']) {
    const math=block('math',[36,68,453,284],'F = FeedForward(F)');
    math.content[0].anchor={textMap};
    assert.equal(subject.getCropCandidates(structure([math,block('caption',[72,49,522,57],'Fig. 3')]),[1],0).length,0);
  }
});

test('panel labels next to a figure caption belong inside the crop while table captions still bound it', () => {
  const subject=api();
  const doc=structure([block('caption',[74,470,525,478],'(a) Input (b) Prediction'),
    block('caption',[50,438,545,457],'Figure 8: Comparison'),block('paragraph',[50,350,545,410],prose)]);
  const above=subject.getCropCandidates(doc,[1],0).find(x=>x.direction==='above');
  assert.ok(above && above.rect[3]>720);
  doc.content[0].content[0].text='Table 1: Independent results';
  assert.equal(subject.getCropCandidates(doc,[1],0).length,0);
});

test('a native figure slightly beyond the fixed gap is accepted only for its nearest caption', () => {
  const subject=api(),caption=block('caption',[51,244,289,272],'Fig. 15 Result');
  const doc=structure([block('image',[51,309,288,730]),caption]);
  assert.equal(subject.hasGraphic(caption.anchor.pageRects[0],subject.blocks(doc.content),caption),true);
  doc.content.push(block('caption',[51,740,289,752],'Fig. 14 Previous result'));
  assert.equal(subject.hasGraphic(caption.anchor.pageRects[0],subject.blocks(doc.content),caption),false);
});

test('adjacent bilingual captions share a native image without matching another figure number', () => {
  const subject=api(),chinese=block('caption',[229,545,366,555],'图 5 迭代结果');
  const english=block('caption',[175,531,420,541],'Fig. 5 Iteration history');
  const doc=structure([block('image',[156,580,439,730]),chinese,english]);
  assert.equal(subject.hasGraphic(english.anchor.pageRects[0],subject.blocks(doc.content),english),true);
  english.content[0].text='Fig. 6 Different result';
  assert.equal(subject.hasGraphic(english.anchor.pageRects[0],subject.blocks(doc.content),english),false);
});

test('bilingual captions for one missing image plan the same region without blocking each other', () => {
  const subject=api();
  const doc=structure([block('caption',[229,545,366,555],'图 5 迭代结果'),
    block('caption',[175,531,420,541],'Fig. 5 Iteration history')]);
  const first=subject.getCropCandidates(doc,[0],0),second=subject.getCropCandidates(doc,[1],0);
  assert.deepEqual(first,second);
  assert.ok(second.some(c=>c.direction==='above'&&c.rect[1]>555&&c.rect[3]>700));
});

test('Chinese prose with an ASCII sentence period establishes a full-width crop scope', () => {
  const subject=api(),paragraph=block('paragraph',[60,337,536,384],
    '对机翼结构进行优化设计并计算不同工况条件下的位移与应力响应，计算结果表明该方法能够兼顾结构质量和变形约束，所得机翼结构如图7.');
  const doc=structure([paragraph,block('caption',[175,531,420,541],'Fig. 5 History')]);
  assert.equal(subject.isProse(paragraph),true);
  const above=subject.getCropCandidates(doc,[1],0).find(c=>c.direction==='above');
  assert.ok(above.rect[0]<156 && above.rect[2]>439);
});

test('excluded figure column headings near the top stay inside the graphic crop', () => {
  const subject=api();
  const labels={...block('paragraph',[110,711,502,717],'Computational Domain 41x41 Boundary Encoding Ground Truth Prediction'),flowClass:'excluded'};
  const doc=structure([labels,block('caption',[110,582,502,624],'Figure 3 Prediction')]);
  const above=subject.getCropCandidates(doc,[1],0).find(c=>c.direction==='above');
  assert.ok(above.rect[3]>717,'An excluded block is not proof that its content is a running header');
});
