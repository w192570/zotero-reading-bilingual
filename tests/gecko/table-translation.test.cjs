const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { gecko } = require('../helpers/gecko.cjs');

test('privileged table rendering loads local libraries into a content document without changing cached text', { timeout: 30000 }, async t => {
  const browser = await gecko(t);
  const root = path.resolve(__dirname, '../..');
  const result = await browser.run(`
    const done = arguments[arguments.length - 1], Cu = Components.utils;
    Cu.importGlobalProperties(['atob']);
    const file = Components.classes['@mozilla.org/file/local;1'].createInstance(Components.interfaces.nsIFile);
    file.initWithPath(arguments[0]);
    let root = Services.io.newFileURI(file).spec;
    if (!root.endsWith('/')) root += '/';
    const host = Services.appShell.createWindowlessBrowser(false), doc = host.document;
    doc.documentElement.innerHTML = '<head></head><body><article id="sdt-content"><table id="source"><tr><td>Native source</td></tr></table><p id="after">Neighbor stays</p></article></body>';
    const plugin = Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(), { wantXrays: false });
    Object.assign(plugin, { Services, atob, setTimeout, clearTimeout, doc, zh: arguments[1], Zotero: { debug() {}, Prefs: { get() {} } } });
    for (const name of ['translation-renderer.js', 'reading-bilingual.js']) Services.scriptloader.loadSubScript(root + 'content/scripts/' + name, plugin);
    plugin.ZRBTranslationRenderer.init(root);
    Cu.evalInSandbox('this.text="Parameter Value Rate 0.001 Batch 32";' +
      'ReadingBilingual.loadCache=async()=>({[text]:zh});' +
      'ReadingBilingual.saveCache=async()=>{throw new Error("Unexpected cache write")};' +
      'ReadingBilingual.callModelText=async()=>{throw new Error("Unexpected model call")};', plugin);
    Cu.evalInSandbox('(async()=>{const source=doc.getElementById("source");await ReadingBilingual.translateTableBlock({element:source,text}, {},doc);' +
      'const card=source.nextElementSibling,content=card.querySelector(".zrb-card-content");' +
      'const style=doc.createElement("style");style.textContent=ReadingBilingual.getGeneratedCSS();doc.head.append(style);' +
      'const matrix=Array.from(content.querySelectorAll("tr"),row=>Array.from(row.children,cell=>cell.textContent));' +
      'card.querySelector(".zrb-btn-edit").click();const edited=card.querySelector("textarea").value;card.querySelector(".zrb-cancel-edit-btn").click();' +
      'return {contentPrincipal:!doc.nodePrincipal.isSystemPrincipal,matrix,edited,raw:ZRBTranslationRenderer.getSource(content),neighbor:doc.getElementById("after").textContent,' +
      'scrollable:doc.defaultView.getComputedStyle(content.querySelector(".zrb-table-scroll")).overflowX};})()', plugin)
      .then(done, error => done({ failure: String(error), stack: String(error.stack) })).finally(() => host.close());
  `, [root, '参数 | 值\n学习率 | 0.001\n批大小 | 32'], true);
  assert.ok(!result.failure, JSON.stringify(result));
  assert.equal(result.contentPrincipal, true);
  assert.deepEqual(result.matrix, [['参数', '值'], ['学习率', '0.001'], ['批大小', '32']]);
  assert.equal(result.raw, '参数 | 值\n学习率 | 0.001\n批大小 | 32');
  assert.equal(result.edited, result.raw);
  assert.equal(result.neighbor, 'Neighbor stays');
  assert.equal(result.scrollable, 'auto');
});
