const assert=require('node:assert/strict');
const path=require('node:path');
const {test}=require('node:test');
const {gecko}=require('../helpers/gecko.cjs');

test('bundled math libraries render short Chinese inline variables across the Gecko privilege boundary',{timeout:30000},async t=>{
  const browser=await gecko(t);
  const root=path.resolve(__dirname,'../..');
  const result=await browser.run(`
    const done=arguments[arguments.length-1];
    (async()=>{
    const Cu=Components.utils;
    Cu.importGlobalProperties(['atob']);
    const file=Components.classes['@mozilla.org/file/local;1'].createInstance(Components.interfaces.nsIFile);
    file.initWithPath(arguments[0]);
    const fileURI=Services.io.newFileURI(file).spec;
    const root=file.isDirectory()?fileURI.replace(/\\/$/,'')+'/':'jar:'+fileURI+'!/';
    const startup=Components.classes['@mozilla.org/addons/addon-manager-startup;1'].getService(Components.interfaces.amIAddonManagerStartup);
    const chrome=startup.registerChrome(Services.io.newURI(root+'manifest.json'),[
      ['content','readingbilingual-render',root+'content/vendor/','contentaccessible=yes']
    ]);
    const browser=Services.appShell.createWindowlessBrowser(false);
    try {
    const doc=browser.document;
    doc.documentElement.innerHTML='<head></head><body><div id="content"></div></body>';
    const plugin=Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(),{wantXrays:false});
    const logs=[];
    plugin.Services=Services;
    plugin.atob=atob;
    plugin.Zotero={debug(message){logs.push(String(message));}};
    plugin.target=doc.querySelector('#content');
    Services.scriptloader.loadSubScript(root+'content/scripts/translation-renderer.js',plugin);
    plugin.ZRBTranslationRenderer.init(root);
    Cu.evalInSandbox('ZRBTranslationRenderer.renderInto(target,"其中 $r$ 为预设的滤波半径，$X_g$ 和 $X_e$ 分别表示单元 $g$ 与 $e$ 的中心位置。");',plugin);
    const link=doc.getElementById('zrb-katex-style');
    if(link&&!link.sheet) await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('KaTeX stylesheet timed out')),5000);
      link.addEventListener('load',()=>{clearTimeout(timeout);resolve();},{once:true});
      link.addEventListener('error',()=>{clearTimeout(timeout);reject(new Error('KaTeX stylesheet failed'));},{once:true});
    });
    const fonts=await doc.fonts.load('16px KaTeX_Main','rX');
    const result={count:doc.querySelectorAll('.katex').length,html:doc.querySelector('#content').innerHTML,
      stylesheetLoaded:!!link?.sheet,fonts:fonts.length,logs};
    done(result);
    } finally {browser.close();chrome.destruct();}
    })().catch(e=>done({failure:String(e),stack:String(e.stack)}));
  `,[process.env.ZRB_RENDERER_XPI||root],true);
  assert.ok(!result.failure,JSON.stringify(result));
  assert.equal(result.count,5,JSON.stringify(result));
  assert.equal(result.stylesheetLoaded,true);
  assert.ok(result.fonts>0,'KaTeX font assets must load from registered content-accessible chrome');
  assert.deepEqual(result.logs,[]);
});
