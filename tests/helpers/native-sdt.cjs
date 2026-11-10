const assert = require('node:assert/strict');
const fs = require('node:fs');
// Extract the installed Reader's renderer and crop hydration, not a simplified
// replacement DOM. No Zotero source is copied into the shipped extension.
module.exports = function nativeSDT(file) {
  const bundle = fs.readFileSync(file, 'utf8');
  const between = (start, end) => {
    const a=bundle.indexOf(start),b=bundle.indexOf(end,a+start.length);
    assert.ok(a>=0&&b>a, `Reader section missing: ${start}`);return bundle.slice(a,b);
  };
  const fn = name => {
    const start=bundle.indexOf('\nfunction '+name+'(')+1;assert.ok(start>0,name);
    const rest=bundle.slice(start+1);const end=rest.search(/\n(?:function |class |;\/\/)/);
    assert.ok(end>=0,name);return bundle.slice(start,start+1+end);
  };
  const constants=['HEADER_LAST_IS_SOFT_HYPHEN','CSS_UNITS','PDF_READING_MODE_CROP_DISPLAY_SCALE']
    .map(name=>{const match=bundle.match(new RegExp('^const '+name+' = .+;$','m'));assert.ok(match,name);return match[0];}).join('\n');
  return constants+'\n'+['refKey','parseTextMap','isTextNodeArray','getBlockNodeByRef','fitRectIntoRect','waitForImage'].map(fn).join('\n')
    +'\n'+between('function getNodeByRef(', 'function getLogicalBlockText(')
    +'\n'+between(';// ./src/dom/sdt/lib/renderer.ts',';// ./src/dom/sdt/stylesheets/sdt.scss')
    +'\n'+between(';// ./src/dom/sdt/stylesheets/sdt.scss',';// ./src/dom/sdt/sdt-view.ts')
    +'\nclass NativeCropProvider { constructor(renderer){this._pdfRenderer=renderer;}\n'
    +between('  createSDTBlockCropProvider(sdtData) {','  // Top-level SDT block index for the first non-excluded block')+'}\n'
    +'class NativeHydration { constructor(doc){this._iframeDocument=doc;this._sourceCrops=new WeakMap();this._destroyed=false;}\n'
    +between('  _prepareSourceCrops(getBlockCrops) {','  _observeSourceCrops() {')
    +between('  async _loadSourceCrop(figure) {','  destroy() {')+'}\n'
    +'window.NativeSDT={render:renderSDT,Provider:NativeCropProvider,Hydration:NativeHydration,css:sdt};';
};
