const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { gecko } = require('../helpers/gecko.cjs');

// Use Zotero's installed preference implementation, backed by real Gecko prefs
// in the helper's isolated profile. Never load or edit the user's profile.
test('saved Reader modes survive new plugin instances with the installed Zotero Prefs API', {
  timeout: 30000,
  skip: !process.env.ZRB_ZOTERO_APP_OMNI && 'Set ZRB_ZOTERO_APP_OMNI to the installed Zotero app/omni.ja',
}, async t => {
  const browser = await gecko(t);
  const source = fs.readFileSync(path.resolve(__dirname, '../../content/scripts/reading-bilingual.js'), 'utf8');
  const result = await browser.run(`
    const Cu = Components.utils;
    const archive = Components.classes['@mozilla.org/file/local;1'].createInstance(Components.interfaces.nsIFile);
    archive.initWithPath(arguments[1]);
    const prefsURI = 'jar:' + Services.io.newFileURI(archive).spec + '!/chrome/content/zotero/xpcom/prefs.js';
    const host = Services.appShell.createWindowlessBrowser(false);
    const outerDoc = host.document;
    outerDoc.documentElement.innerHTML = '<head></head><body><div class="toolbar"><div class="end"><button class="toolbar-button find">Find</button></div></div></body>';
    const newPlugin = () => {
      const scope = Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(), { wantXrays: false });
      Object.assign(scope, {
        Services, setTimeout, clearTimeout,
        ZOTERO_CONFIG: { PREF_BRANCH: 'extensions.zotero.' },
        Zotero: { debug() {}, logError(error) { throw error; }, Debug: { enabled: false } },
      });
      Services.scriptloader.loadSubScript(prefsURI, scope);
      Cu.evalInSandbox(arguments[0], scope);
      return scope;
    };
    try {
      const first = newPlugin();
      const key = first.ReadingBilingual.PREF_READER_DISPLAY_MODE;
      const prefs = Services.prefs;
      prefs.getDefaultBranch('').setStringPref(key, 'bilingual');
      const makeDoc = () => {
        const doc = outerDoc.implementation.createHTMLDocument('Reader');
        doc.body.innerHTML = '<article id="sdt-content"><p id="source">English source</p><div class="zotero-bilingual-card"><div class="zrb-card-content">已有中文译文</div></div></article>';
        return doc;
      };
      const outcomes = [];
      for (const mode of ['translation', 'bilingual', 'original']) {
        const selectedDoc = makeDoc();
        const reader = { _iframeWindow: outerDoc.defaultView };
        first.ReadingBilingual.getRealContentDoc = () => selectedDoc;
        // Existing translations must avoid the network/translation entry point.
        first.ReadingBilingual.translateActiveReader = () => { throw new Error('Unexpected model call'); };
        first.ReadingBilingual.injectToolbarButton(reader, outerDoc);
        const select = outerDoc.getElementById('zrb-display-mode');
        select.value = mode;
        select.dispatchEvent(new outerDoc.defaultView.Event('change', { bubbles: true }));
        const reopened = newPlugin();
        const reopenedDoc = makeDoc();
        reopened.ReadingBilingual.getRealContentDoc = () => reopenedDoc;
        reopened.ReadingBilingual.getAutoTranslate = () => false;
        reopened.Zotero.Reader = { _readers: [reader] };
        reopened.ReadingBilingual.scanExistingReaders();
        outcomes.push({
          selected: mode,
          saved: prefs.getStringPref(key),
          restored: reopenedDoc.documentElement.dataset.zrbDisplayMode,
          toolbar: outerDoc.getElementById('zrb-display-mode').value,
          originalHidden: reopenedDoc.documentElement.classList.contains('zrb-translation-only'),
          translationHidden: reopenedDoc.querySelector('.zotero-bilingual-card').classList.contains('zotero-bilingual-hidden'),
        });
        reopened.ReadingBilingual._observers.forEach(observer => observer.disconnect());
      }
      return JSON.parse(JSON.stringify(outcomes));
    } finally { host.close(); }
  `, [source, path.resolve(process.env.ZRB_ZOTERO_APP_OMNI)]);
  assert.deepEqual(result, ['translation', 'bilingual', 'original'].map(mode => ({
    selected: mode, saved: mode, restored: mode, toolbar: mode,
    originalHidden: mode === 'translation', translationHidden: mode === 'original',
  })));
});
