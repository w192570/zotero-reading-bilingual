const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { JSDOM } = require("jsdom");

const root = path.resolve(__dirname, "..");
function setup() {
  const loads = [];
  const prefs = new Map();
  const scope = {
    atob,
    Zotero: { debug() {}, logError() {}, Prefs: {
      get(key, global) { return prefs.get(global ? key : "extensions.zotero." + key); },
      set(key, value, global) { prefs.set(global ? key : "extensions.zotero." + key, value); },
    } },
    Services: { scriptloader: { loadSubScript(filename, target) {
      loads.push(filename);
      vm.runInNewContext(fs.readFileSync(filename, "utf8"), target);
    } } },
    setTimeout() {},
    clearTimeout() {},
  };
  vm.createContext(scope);
  for (const file of ["translation-renderer.js", "reading-bilingual.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, "content/scripts", file), "utf8"), scope);
  }
  scope.ZRBTranslationRenderer.init(root + path.sep);
  const doc = new JSDOM("<!doctype html><html><head></head><body></body></html>").window.document;
  const renderer = scope.ZRBTranslationRenderer;
  const plugin = scope.ReadingBilingual;
  const render = (source) => {
    const card = plugin.createCardElement({}, doc, "original", source);
    doc.body.appendChild(card);
    return card.querySelector(".zrb-card-content");
  };
  return { doc, renderer, plugin, render, loads, prefs };
}

test("plain cached paragraphs keep line breaks without loading rendering libraries", () => {
  const { plugin, renderer, render, loads } = setup();
  const source = "第一行\n第二行\n\n第三行";
  const cleaned = plugin.cleanTypography(source);
  assert.equal(cleaned, source);
  const content = render(cleaned);
  assert.equal(content.textContent, source);
  assert.equal(renderer.getSource(content), source);
  assert.equal(loads.length, 0);
});

test("Markdown renders emphasis, hard breaks, lists, headings and tables", () => {
  const { render, renderer } = setup();
  const source = "## 标题\n\n**重点**\n下一行\n\n- 条目一\n- 条目二\n\n| 参数 | 值 |\n| --- | --- |\n| 学习率 | 0.01 |";
  const content = render(source);
  assert.equal(content.querySelector("h2").textContent, "标题");
  assert.equal(content.querySelector("strong").textContent, "重点");
  assert.ok(content.querySelector("br"));
  assert.equal(content.querySelectorAll("li").length, 2);
  assert.equal(content.querySelector("td").textContent, "学习率");
  assert.equal(renderer.getSource(content), source);
  assert.ok(render("参数 | 值\n--- | ---\n学习率 | 0.01").querySelector("table"));
});

test("cached whole-table pipe translations render aligned cells without another model call or cache write", async () => {
  const { plugin, renderer, doc } = setup();
  const text = "Elasticity Poisson Batch size 20 32 Initial learning rate 0.001 0.001";
  const zh = "参数 | 弹性力学 | 泊松\n批大小 | 20 | 32\n初始学习率 | 0.001 | 0.001";
  doc.body.innerHTML = '<article id="sdt-content"><table id="source"><tr><td>Original table</td></tr></table><p id="after">Following paragraph</p></article>';
  const element = doc.getElementById("source"), original = element.textContent;
  plugin.loadCache = async () => ({ [text]: zh });
  plugin.saveCache = async () => { throw new Error("Display must not rewrite the cache"); };
  plugin.callModelText = async () => { throw new Error("Cached table must not call a model"); };
  await plugin.translateTableBlock({ element, text }, {}, doc);
  const content = element.nextElementSibling.querySelector(".zrb-card-content");
  assert.deepEqual(Array.from(content.querySelectorAll("thead th"), cell => cell.textContent), ["参数", "弹性力学", "泊松"]);
  assert.equal(content.querySelectorAll("tbody tr").length, 2);
  assert.equal(content.querySelector("tbody th[scope='row']").textContent, "批大小");
  assert.equal(content.querySelectorAll("tbody td")[2].textContent, "0.001");
  assert.equal(renderer.getSource(content), zh);
  assert.equal(element.textContent, original);
  assert.equal(element.querySelectorAll("td").length, 1);
  await plugin.translateTableBlock({ element, text }, {}, doc);
  assert.equal(doc.querySelectorAll(".zotero-bilingual-table-card").length, 1);
  assert.equal(doc.getElementById("after").textContent, "Following paragraph");
});

test("image and unknown source crops cannot enter table translation or retain old table cards", async () => {
  const { plugin, doc } = setup();
  doc.body.innerHTML = '<figure class="sdt-source-crop" data-ref-path="0"><img><span>Architecture labels</span></figure><div class="zotero-bilingual-card zotero-bilingual-table-card">Wrong cached table</div><figcaption>Figure 1 Architecture</figcaption><figure class="sdt-source-crop" data-ref-path="1"></figure><figure class="sdt-source-crop" data-ref-path="2"></figure><figure class="sdt-source-crop"></figure>';
  const reader = { _internalReader: { _sdt: { structure: { content: [{ type: 'image' }, { type: 'table' }, { type: 'math' }] } } } };
  const crops = doc.querySelectorAll('figure');
  assert.equal(plugin.isTableTranslationSource(reader, crops[0]), false);
  assert.equal(plugin.isTableTranslationSource(reader, crops[1]), true);
  assert.equal(plugin.isTableTranslationSource(reader, crops[2]), false);
  assert.equal(plugin.isTableTranslationSource(reader, crops[3]), false);
  assert.equal(plugin.isTableTranslationSource({}, crops[1]), false);
  plugin.loadCache = async () => { throw new Error('Image must not read a table translation'); };
  plugin.callModelText = async () => { throw new Error('Image must not request a table translation'); };
  plugin.removeMisclassifiedTableCards(reader, doc);
  await plugin.translateTableBlock({ element: crops[0], text: 'Architecture labels' }, reader, doc);
  assert.equal(doc.querySelectorAll('.zotero-bilingual-table-card').length, 0);
  assert.equal(doc.querySelectorAll('img,figcaption').length, 2);
});

test("table cells preserve empty values, literal pipes, code, links and inline math", () => {
  const { doc, renderer } = setup();
  const content = doc.createElement("div");
  const source = '| 项目 | 记号 | 值 | 备注 |\n| --- | --- | --- | --- |\n| $r$ | $a|b$ | 0.001 | A\\|B |\n| 代码 | `x|y` | 80% | |\n| 链接 | [来源](https://example.com) | — | <img src="https://example.com/image"> |';
  renderer.renderInto(content, source, { table: true });
  assert.equal(content.querySelectorAll("thead th").length, 4);
  assert.equal(content.querySelectorAll("tbody tr").length, 3);
  assert.equal(content.querySelectorAll(".katex").length, 2);
  assert.equal(content.querySelectorAll("tbody tr")[0].lastElementChild.textContent, "A|B");
  assert.equal(content.querySelector("code").textContent, "x|y");
  assert.equal(content.querySelectorAll("tbody tr")[1].lastElementChild.textContent, "");
  assert.equal(content.querySelectorAll("img,script,iframe").length, 0);
  assert.equal(content.querySelector("a").getAttribute("href"), "https://example.com");
  assert.equal(renderer.getSource(content), source);
});

test("inconsistent table columns stay intact as text and ordinary prose pipes are not promoted to tables", () => {
  const { doc, renderer, render } = setup();
  for (const source of ["项目 | 值\n学习率 | 0.001 | 额外值", "项目 | 值\n--- | ---\n学习率 | 0.001 | 额外值"]) {
    const content = doc.createElement("div");
    renderer.renderInto(content, source, { table: true });
    assert.equal(content.querySelector("table"), null);
    assert.equal(content.textContent, source, "no inferred, padded or dropped cells");
  }
  assert.equal(render("状态 A | 状态 B\n条件 C | 条件 D").querySelector("table"), null);
});

test("editing and copying a cached table retain its raw text and saving rebuilds the grid", async () => {
  const { doc, plugin, renderer } = setup();
  const text = "Parameter value learning rate 0.001 batch size 32", zh = "参数 | 值\n学习率 | 0.001\n批大小 | 32";
  const element = doc.createElement("table"); doc.body.append(element);
  plugin.loadCache = async () => ({ [text]: zh });
  const writes = [];
  plugin.saveCache = async (_reader, entries) => writes.push(entries);
  let copied;
  Object.defineProperty(doc.defaultView.navigator, "clipboard", { value: { writeText: async value => { copied = value; } } });
  await plugin.translateTableBlock({ element, text }, {}, doc);
  const card = element.nextElementSibling;
  card.querySelector(".zrb-btn-copy").click();
  assert.equal(copied, zh);
  card.querySelector(".zrb-btn-edit").click();
  assert.equal(card.querySelector("textarea").value, zh);
  const changed = "参数 | 值\n学习率 | 0.0005\n批大小 | 64";
  card.querySelector("textarea").value = changed;
  card.querySelector(".zrb-save-edit-btn").click();
  await new Promise(setImmediate);
  const content = card.querySelector(".zrb-card-content");
  assert.equal(content.querySelectorAll("tbody td")[0].textContent, "0.0005");
  assert.equal(renderer.getSource(content), changed);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][text], changed);
});

test("explicit retranslation of a cached table keeps the table-specific request and renders its result", async () => {
  const { doc, plugin } = setup();
  const text = "Parameter value learning rate 0.001 batch size 32";
  const element = doc.createElement("table"); doc.body.append(element);
  plugin.loadCache = async () => ({ [text]: "参数 | 值\n学习率 | 0.001" });
  plugin.saveCache = async () => {};
  const prompts = [];
  plugin.callModelText = async prompt => { prompts.push(prompt); return "| 参数 | 值 |\n| --- | --- |\n| 学习率 | 0.0005 |"; };
  plugin.callOpenAIBatch = async () => { throw new Error("Table must retain its specialized request"); };
  await plugin.translateTableBlock({ element, text }, {}, doc);
  await plugin.retryTranslationCards({}, doc, [element.nextElementSibling], { force: true });
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].includes("表格"));
  assert.equal(element.nextElementSibling.querySelector("tbody td").textContent, "0.0005");
});

test("card styles preserve plain line breaks and allow rendered Markdown and editing", () => {
  const { doc, render, plugin } = setup();
  const style = doc.createElement("style");
  style.textContent = plugin.getGeneratedCSS();
  doc.head.appendChild(style);
  const plain = render("第一行\n第二行");
  const rich = render("**重点**\n第二行");
  assert.equal(doc.defaultView.getComputedStyle(plain).whiteSpace, "pre-wrap");
  assert.equal(doc.defaultView.getComputedStyle(rich).whiteSpace, "normal");
  rich.parentElement.querySelector(".zrb-btn-edit").click();
  assert.equal(doc.defaultView.getComputedStyle(rich).display, "none");
});

test("all four math delimiters render locally and preserve TeX through typography cleanup", () => {
  const { render, renderer, plugin, doc, loads } = setup();
  const source = "损失 $L_i = \\alpha_i^2$ 与 \\(x+y\\)。\n\n$$\n\\sum_{i=1}^{n} i\n$$\n\n\\[\\frac{a}{b}\\]";
  assert.equal(plugin.cleanTypography(source), source);
  const content = render(source);
  assert.equal(content.querySelectorAll(".katex").length, 4);
  assert.equal(content.querySelectorAll(".katex-display").length, 2);
  assert.equal(renderer.getSource(content), source);
  assert.equal(doc.querySelectorAll("#zrb-katex-style").length, 1);
  assert.equal(doc.querySelector("#zrb-katex-style").getAttribute("href"), "chrome://readingbilingual-render/content/katex/katex.min.css");
  render("缓存中的公式 $a_1+b_2$。");
  assert.equal(doc.querySelectorAll("#zrb-katex-style").length, 1);
  assert.equal(loads.length, 2);
});

test("Chinese prose renders short inline variables and subscripts without exposing dollar delimiters", () => {
  const { render, renderer } = setup();
  const source = "其中 $r$ 为预设的滤波半径，$X_g$ 和 $X_e$ 分别表示单元 $g$ 与 $e$ 的中心位置。";
  const content = render(source);
  assert.equal(content.querySelectorAll('.katex').length, 5, content.innerHTML);
  assert.equal(content.querySelectorAll('.katex-error').length, 0);
  assert.equal(content.textContent.includes('$'), false);
  assert.equal(renderer.getSource(content), source);
});

test("display formulas can contain blank lines and Markdown markup inside TeX", () => {
  const { render } = setup();
  const content = render("$$\n\\begin{aligned}\na_1 &= b_2 \\\\\n\n c_3 &= d_4\n\\end{aligned}\n$$");
  assert.equal(content.querySelectorAll(".katex-display").length, 1);
});

test("currency, escaped dollars and inline/fenced code remain literal", () => {
  const { render, plugin } = setup();
  const source = "价格 $5 and $10；转义 \\$x\\$；代码 `$x_i$`。\n\n```python\nif ok:\n    value = '$a$'\n```";
  assert.equal(plugin.cleanTypography(source), source);
  const content = render(source);
  assert.equal(content.querySelectorAll(".katex").length, 0);
  assert.ok(content.textContent.includes("$5 and $10"));
  assert.ok(content.textContent.includes("$x$"));
  assert.equal(content.querySelector("code").textContent, "$x_i$");
  assert.ok(content.querySelector("pre code").textContent.includes("    value"));
});

test("invalid formulas remain readable and HTML, image and TeX input cannot inject active content", () => {
  const { render } = setup();
  const invalid = "$\\unknowncommand{a}$";
  assert.ok(render(invalid).textContent.includes(invalid));
  const content = render('<script>alert(1)</script>\n<img src="https://example.com/leak">\n![remote](https://example.com/image)\n[bad](javascript:alert(1))\n$\\href{javascript:alert(1)}{x}$');
  assert.equal(content.querySelectorAll("script, img, iframe").length, 0);
  assert.equal(content.querySelectorAll('[href^="javascript:"]').length, 0);
});

test("editing and copying a rendered card preserve source and save re-rendered changes", async () => {
  const { doc, plugin, renderer } = setup();
  const source = "**损失** $L_i=\\alpha_i$\n第二行";
  const card = plugin.createCardElement({}, doc, "original", source);
  doc.body.appendChild(card);
  const saved = [];
  plugin.saveCache = async (_reader, entries) => saved.push(entries);
  let copied;
  Object.defineProperty(doc.defaultView.navigator, "clipboard", { value: {
    writeText: async (text) => { copied = text; },
  } });
  card.querySelector(".zrb-btn-copy").click();
  assert.equal(copied, source);
  card.querySelector(".zrb-btn-edit").click();
  const textarea = card.querySelector("textarea");
  assert.equal(textarea.value, source);
  const changed = "第一行\n第二行 $x_1^2$";
  textarea.value = changed;
  card.querySelector(".zrb-save-edit-btn").click();
  await new Promise(setImmediate);
  const content = card.querySelector(".zrb-card-content");
  assert.equal(renderer.getSource(content), changed);
  assert.equal(content.querySelectorAll(".katex").length, 1);
  assert.equal(saved[0].original, changed);
  assert.equal(card.querySelector("textarea"), null);
  card.querySelector(".zrb-btn-copy").click();
  assert.equal(copied, changed);
});

test("a pending card renders the completed result without leaking rendered text into the cache", () => {
  const { doc, plugin, renderer } = setup();
  const card = plugin.createCardElement({}, doc, "original", "正在翻译…", true);
  const content = card.querySelector(".zrb-card-content");
  const result = "结果 $x_1$\n新的一行";
  plugin.setTranslationContent(content, result);
  assert.equal(content.querySelectorAll(".katex").length, 1);
  assert.equal(renderer.getSource(content), result);
  plugin.setTranslationContent(content, "[翻译失败: 错误]", true);
  assert.equal(content.querySelectorAll(".katex").length, 0);
  assert.equal(renderer.getSource(content), "[翻译失败: 错误]");
});


test("translation-only mode hides source text while preserving figures, formulas and code blocks", () => {
  const { doc, plugin } = setup();
  doc.body.innerHTML = `
    <p id="source">English paragraph<img id="photo" src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="><svg id="chart" viewBox="0 0 10 10"><text>Chart label</text></svg><span class="sdt-math">x + 1</span><code>value = 1</code></p>
    <table id="plain-table"><tbody><tr><td>Table label</td></tr></tbody></table>
    <table id="chart-table"><tbody><tr><td>Series<svg viewBox="0 0 10 10"><text>Series A</text></svg></td></tr></tbody></table>
    <div class="zotero-bilingual-card"><span class="zrb-card-content">中文译文</span></div>
    <pre id="code-block"><code>value = 1</code></pre>
  `;
  const source = doc.getElementById("source");
  const plainTable = doc.getElementById("plain-table");
  const chartTable = doc.getElementById("chart-table");

  plugin.markSourceForTranslationOnly(source);
  plugin.markSourceForTranslationOnly(source);
  plugin.markSourceForTranslationOnly(plainTable);
  plugin.markSourceForTranslationOnly(chartTable);
  const style = doc.createElement("style");
  style.textContent = plugin.getGeneratedCSS();
  doc.head.appendChild(style);

  assert.equal(source.querySelectorAll(".zrb-original-text").length, 2, "prose and inline code are marked once");

  plugin.applyReaderDisplayMode(doc, "original");
  assert.equal(doc.documentElement.dataset.zrbDisplayMode, "original");
  assert.notEqual(doc.defaultView.getComputedStyle(source.querySelector(".zrb-original-text")).display, "none");
  assert.equal(doc.defaultView.getComputedStyle(doc.querySelector(".zrb-card-content").parentElement).display, "none");
  assert.notEqual(doc.defaultView.getComputedStyle(plainTable).display, "none");

  plugin.applyReaderDisplayMode(doc, "bilingual");
  assert.equal(doc.documentElement.dataset.zrbDisplayMode, "bilingual");
  assert.notEqual(doc.defaultView.getComputedStyle(doc.querySelector(".zrb-card-content").parentElement).display, "none");
  assert.notEqual(doc.defaultView.getComputedStyle(source.querySelector(".zrb-original-text")).display, "none");

  plugin.applyReaderDisplayMode(doc, "translation");
  assert.equal(doc.defaultView.getComputedStyle(source.querySelector(".zrb-original-text")).display, "none");
  assert.equal(doc.defaultView.getComputedStyle(plainTable).display, "none", "translated text tables can be replaced by their Chinese card");
  assert.notEqual(doc.defaultView.getComputedStyle(chartTable).display, "none", "a table containing a chart remains visible");
  assert.notEqual(doc.defaultView.getComputedStyle(source.querySelector("img")).display, "none");
  assert.notEqual(doc.defaultView.getComputedStyle(source.querySelector("svg")).display, "none");
  assert.equal(source.querySelector(".sdt-math").textContent, "x + 1");
  assert.equal(source.querySelector("code").textContent, "value = 1");
  assert.equal(doc.defaultView.getComputedStyle(source.querySelector("code .zrb-original-text")).display, "none");
  assert.notEqual(doc.defaultView.getComputedStyle(doc.getElementById("code-block")).display, "none");
  assert.equal(doc.querySelector(".zrb-card-content").textContent, "中文译文");
  assert.ok(source.textContent.includes("English paragraph"), "original text remains in the DOM for restoration and retranslation");
});


function setupToolbar(translated = true) {
  const state = setup();
  const { doc, plugin } = state;
  doc.body.innerHTML = '<div class="toolbar"><button id="native-reading-mode" class="active">阅读模式</button><div class="end"><button class="toolbar-button find">搜索</button></div></div>';
  const contentDoc = new JSDOM('<!doctype html><html><body><p>English paragraph<img id="figure"></p>' + (translated ? '<div class="zotero-bilingual-card">译文</div>' : '') + '</body></html>').window.document;
  const reader = { _iframeWindow: { document: doc } };
  plugin.getRealContentDoc = () => contentDoc;
  // Zotero cancels pointerdown for ordinary toolbar elements, but exempts
  // native form controls such as select.
  doc.defaultView.addEventListener("pointerdown", (event) => {
    if (!event.target.closest("input, textarea, select, [contenteditable='true']")) event.preventDefault();
  });
  plugin.injectToolbarButton(reader, doc);
  return { ...state, contentDoc, reader, select: doc.getElementById("zrb-display-mode") };
}

function mouseClick(doc, element) {
  const send = (type) => element.dispatchEvent(new doc.defaultView.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, detail: 1 }));
  const compatibilityMouseEvents = send("pointerdown");
  if (compatibilityMouseEvents) send("mousedown");
  send("pointerup");
  if (compatibilityMouseEvents) send("mouseup");
  send("click");
}

test("the native toolbar dropdown exposes all three states and applies each change", async () => {
  const { doc, plugin, contentDoc, reader, select } = setupToolbar();
  const nativeButton = doc.getElementById("native-reading-mode");
  assert.equal(select.tagName, "SELECT");
  assert.equal(select.getAttribute("aria-label"), "显示内容");
  assert.deepEqual(Array.from(select.options).map((option) => [option.value, option.textContent]), [
    ["original", "原文"], ["bilingual", "对照"], ["translation", "仅译文"]
  ]);
  assert.equal(select.value, "bilingual");
  assert.equal(select.nextElementSibling, doc.querySelector(".find"));
  assert.equal(doc.getElementById("zrb-button-context-menu"), null);

  // Start with focus elsewhere and confirm FocusManager leaves the native
  // select pointer action intact.
  nativeButton.focus();
  let pointerDownDefaultPrevented = null;
  select.addEventListener("pointerdown", (event) => { pointerDownDefaultPrevented = event.defaultPrevented; });
  mouseClick(doc, select);
  assert.equal(pointerDownDefaultPrevented, false);
  for (const mode of ["original", "translation", "bilingual"]) {
    select.value = mode;
    select.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
    await new Promise(setImmediate);
    assert.equal(contentDoc.documentElement.dataset.zrbDisplayMode, mode);
    assert.equal(select.value, mode);
    assert.equal(contentDoc.querySelector(".zotero-bilingual-card").classList.contains("zotero-bilingual-hidden"), mode === "original");
  }
  assert.equal(nativeButton.className, "active", "Zotero's reading-mode switch stays enabled");
  assert.equal(nativeButton.textContent, "阅读模式");
  plugin.injectToolbarButton(reader, doc);
  assert.equal(doc.querySelectorAll("#zrb-display-mode").length, 1);
  assert.equal(doc.querySelectorAll("#zrb-display-mode-menu").length, 0);
  assert.equal(doc.getElementById("zrb-display-mode"), select);
});

test("all saved display modes restore before the toolbar reads stale cached card visibility", async () => {
  const { doc, plugin, reader, select, prefs, contentDoc } = setupToolbar();
  let currentDoc = contentDoc;
  plugin.getRealContentDoc = () => currentDoc;
  plugin.translateActiveReader = () => { throw new Error("Existing translations must not call the model"); };
  for (const mode of ["translation", "bilingual", "original"]) {
    select.value = mode;
    select.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
    await new Promise(setImmediate);
    assert.equal(prefs.get(plugin.PREF_READER_DISPLAY_MODE), mode);
    currentDoc = new JSDOM('<article id="sdt-content"><p>English source</p><div class="zotero-bilingual-card zotero-bilingual-hidden">已有译文</div></article>').window.document;
    plugin.injectToolbarButton(reader, doc);
    assert.equal(currentDoc.documentElement.dataset.zrbDisplayMode, mode);
    assert.equal(select.value, mode);
    assert.equal(currentDoc.querySelector('.zotero-bilingual-card').classList.contains('zotero-bilingual-hidden'), mode === 'original');
    assert.equal(currentDoc.documentElement.classList.contains('zrb-translation-only'), mode === 'translation');
  }
});

test("the visible dropdown follows keyboard visibility changes and replaces stale controls", async () => {
  const { doc, plugin, reader, select } = setupToolbar();
  await plugin.toggleVisibility(reader);
  assert.equal(select.value, "original");
  await plugin.toggleVisibility(reader);
  assert.equal(select.value, "bilingual");

  select.dataset.zrbSession = "old-session";
  const legacy = doc.createElement("button");
  legacy.id = "zotero-reading-bilingual-btn";
  legacy.textContent = "隐藏译文";
  doc.querySelector(".end").appendChild(legacy);
  plugin.injectToolbarButton(reader, doc);
  assert.equal(doc.getElementById("zotero-reading-bilingual-btn"), null);
  assert.notEqual(doc.getElementById("zrb-display-mode"), select);
  assert.equal(doc.querySelectorAll("#zrb-display-mode").length, 1);
  assert.equal(doc.querySelectorAll("#zrb-display-mode-menu").length, 0);
  assert.equal(doc.getElementById("zrb-display-mode").value, "bilingual");
});

test("translated selections start translation once and preserve later display changes", async () => {
  const { doc, plugin, contentDoc, reader, select } = setupToolbar(false);
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  let calls = 0;
  plugin.translateActiveReader = async () => {
    calls++;
    await pending;
    const card = contentDoc.createElement("div");
    card.className = "zotero-bilingual-card";
    card.textContent = "译文";
    contentDoc.body.appendChild(card);
  };
  assert.equal(select.value, "original");
  const first = plugin.setReaderDisplayMode(reader, "translation");
  const second = plugin.setReaderDisplayMode(reader, "bilingual");
  assert.equal(calls, 1);
  assert.equal(select.value, "bilingual");
  await plugin.setReaderDisplayMode(reader, "original");
  finish();
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(select.value, "original", "finishing a translation must not replace the user's latest selection");
  assert.equal(contentDoc.documentElement.dataset.zrbDisplayMode, "original");
  assert.equal(plugin._displayModeTranslations.has(reader), false);
});

test("a translation that produces no cards restores the actual visible state", async () => {
  const { plugin, reader, select, contentDoc } = setupToolbar(false);
  plugin.translateActiveReader = async () => {};
  assert.equal(await plugin.setReaderDisplayMode(reader, "translation"), false);
  assert.equal(select.value, "original");
  assert.equal(contentDoc.documentElement.classList.contains("zrb-translation-only"), false);
});


test("Tools menu omits redundant display toggles but keeps the full-document translation command", async () => {
  const { doc, plugin, reader, contentDoc, select } = setupToolbar();
  const popup = doc.createElement("menupopup");
  popup.id = "menu_ToolsPopup";
  doc.body.appendChild(popup);
  doc.createXULElement = (tag) => doc.createElement(tag);
  for (const id of ["reading-bilingual-tools-toggle", "reading-bilingual-tools-translation-only"]) {
    const stale = doc.createXULElement("menuitem"); stale.id = id; popup.appendChild(stale);
    plugin.addedElementIDs.push(id);
  }
  plugin.getActiveReader = () => reader;
  const win = { document: doc };
  let stalePopupCalls = 0;
  const stalePopupHandler = () => stalePopupCalls++;
  popup.addEventListener("popupshowing", stalePopupHandler);
  plugin._toolsMenuListeners.set(win, { popup, handler: stalePopupHandler });
  plugin.injectMenus(win);
  plugin.injectMenus(win);
  assert.equal(doc.querySelectorAll("#reading-bilingual-tools-toggle").length, 0);
  assert.equal(doc.querySelectorAll("#reading-bilingual-tools-translation-only").length, 0);
  assert.equal(doc.querySelectorAll("#reading-bilingual-tools-translate").length, 1,
    "the separate full-document translation action remains available");
  popup.dispatchEvent(new doc.defaultView.Event("popupshowing"));
  assert.equal(stalePopupCalls, 0, "obsolete toggle listeners are removed during an in-place plugin update");
  plugin.removeMenus(win);
  assert.equal(doc.getElementById("reading-bilingual-tools-translate"), null);
});

test("translation-only hides inline ligature glyphs and aria-hidden prose without deleting real code or math", () => {
  const { doc, plugin } = setup();
  doc.body.innerHTML = `
    <p id="ligatures">scienti<code id="glyph">fi</code>c findings <span aria-hidden="true" id="decorative">fi</span> <code><em>ffi</em></code></p>
    <div class="zotero-bilingual-card">科学结果与合法变量 fi</div>
    <p id="mixed">Original formula <math id="equation"><mi>fi</mi><mo>+</mo><mn>1</mn></math><img id="figure"><code id="mixed-glyph">fi</code></p>
    <div class="zotero-bilingual-card">公式与图像</div>
    <pre id="program"><code>const fi = 1;</code></pre>
    <table id="glyph-table"><tbody><tr><td>coef<code>fi</code>cient</td></tr></tbody></table>
    <div class="zotero-bilingual-card">系数</div>
  `;
  const style = doc.createElement("style");
  style.textContent = plugin.getGeneratedCSS();
  doc.head.appendChild(style);
  const source = doc.getElementById("ligatures");
  const original = source.textContent;
  // Upgrade a document partly wrapped by version 1.6.8. A boolean marker
  // must not permanently exempt the previously skipped glyph nodes.
  for (const oldText of Array.from(source.childNodes).filter((node) => node.nodeType === 3)) {
    const oldWrapper = doc.createElement("span");
    oldWrapper.className = "zrb-original-text";
    source.insertBefore(oldWrapper, oldText);
    oldWrapper.appendChild(oldText);
  }
  source.dataset.zrbTranslationOnlyPrepared = "true";
  plugin.applyReaderDisplayMode(doc, "translation");
  for (const id of ["glyph", "decorative", "mixed-glyph"]) {
    const element = doc.getElementById(id);
    const wrapper = element.querySelector(".zrb-original-text");
    assert.ok(wrapper, `${id} must follow the visibility of source prose`);
    assert.equal(doc.defaultView.getComputedStyle(wrapper).display, "none");
  }
  assert.equal(doc.defaultView.getComputedStyle(doc.getElementById("glyph-table")).display, "none");
  assert.equal(doc.getElementById("program").textContent, "const fi = 1;");
  assert.equal(doc.getElementById("program").querySelector(".zrb-original-text"), null);
  assert.equal(doc.getElementById("equation").querySelector(".zrb-original-text"), null);
  assert.ok(doc.getElementById("figure"));
  assert.equal(source.textContent, original, "source content is retained for restoration");
  plugin.applyReaderDisplayMode(doc, "bilingual");
  assert.notEqual(doc.defaultView.getComputedStyle(doc.querySelector("#glyph .zrb-original-text")).display, "none");
  assert.equal(source.textContent, original);
  plugin.applyReaderDisplayMode(doc, "translation");
  assert.equal(source.querySelectorAll(".zrb-original-text .zrb-original-text").length, 0);
});
