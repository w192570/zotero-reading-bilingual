const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { firefox } = require('playwright');

test('pixel trimming preserves a rotated graphic and rejects an empty region', async () => {
  const browser = await firefox.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ path: path.resolve(__dirname, '../../content/scripts/pdf-figure-fallback.js') });
    const result = await page.evaluate(async () => {
      const source = document.createElement('canvas'); source.width = 400; source.height = 200;
      const ctx = source.getContext('2d');ctx.fillStyle = 'white';ctx.fillRect(0, 0, 400, 200);
      const state = { doc: document, structure: { catalog: { pages: [{ rotation: 90 }] } } };
      const candidate = { direction: 'above', rect: [0, 0, 50, 100] };
      const blank = await ZRBPDFFigureFallback.trimImage(state, source.toDataURL(), candidate, 0);
      ctx.fillStyle = 'blue';ctx.fillRect(40, 20, 320, 160);
      const cropped = await ZRBPDFFigureFallback.trimImage(state, source.toDataURL(), candidate, 0);
      const image = new Image();await ZRBPDFFigureFallback.loadImage(image, cropped.src);
      return { blank, rect: cropped.rect, width: image.naturalWidth, height: image.naturalHeight };
    });
    assert.equal(result.blank, null);
    assert.deepEqual(result.rect, [3, 8, 47, 92]);
    assert.deepEqual([result.width, result.height], [336, 176]);
  } finally { await browser.close(); }
});
