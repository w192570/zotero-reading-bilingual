const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { test } = require('node:test');

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6n0AAAAASUVORK5CYII=';
const image = { src: png, width: 1, height: 1, rect: [1,2,3,4], direction: 'above', displayWidth: 10 };
async function fixture(options = {}) {
  const scope = { TextEncoder, TextDecoder, Uint8Array, atob, btoa };
  vm.runInNewContext(await fs.readFile(path.join(__dirname, '../content/scripts/figure-cache.js'), 'utf8'), scope);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zrb-cache-'));
  const io = {
    async read(file) { return new Uint8Array(await fs.readFile(file)); },
    async write(file, bytes) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file + '.tmp', bytes); await fs.rename(file + '.tmp', file); },
    async remove(file) { await fs.unlink(file).catch(e => { if (e.code !== 'ENOENT') throw e; }); },
    async list() { return (await fs.readdir(root)).map(name => path.join(root, name)); },
    join: name => path.join(root, name),
  };
  const digest = async bytes => crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
  const create = extra => scope.ZRBFigureCache.create({ io, digest, memoryLimit: 1024, diskLimit: 1024, ...options, ...extra });
  return { create, io, root };
}

test('successful images survive a new cache instance and avoid re-rendering', async () => {
  const { create } = await fixture();
  let renders = 0;
  const first = create(); const key = await first.key({ pdf: 'a', rect: [1,2,3,4], algorithm: 1 });
  const producer = async () => { renders++; return image; };
  await first.getOrCreate(key, producer);
  const reopened = create();
  const hit = await reopened.getOrCreate(key, producer);
  assert.equal(hit.src, png);
  assert.equal(renders, 1);
  assert.ok((await reopened.stats()).diskBytes > 0);
});

test('left and right figure crops survive reopening without native rerendering', async()=>{
  const {create}=await fixture();let renders=0;
  for(const direction of ['left','right']) {
    const first=create(),key=await first.key({direction});
    const producer=async()=>{renders++;return {...image,direction};};
    await first.getOrCreate(key,producer);
    const reopened=create();const hit=await reopened.getOrCreate(key,producer);
    assert.equal(hit.direction,direction);assert.equal((await reopened.stats()).diskHits,1);
  }
  assert.equal(renders,2);
});

test('changed PDF or crop version misses, and simultaneous requests share one render', async () => {
  const { create } = await fixture(); const cache = create();
  let renders = 0;
  const produce = async () => { renders++; await new Promise(resolve => setImmediate(resolve)); return image; };
  const a = await cache.key({ pdf: 'original', algorithm: 1 });
  await Promise.all([cache.getOrCreate(a, produce), cache.getOrCreate(a, produce)]);
  await cache.getOrCreate(await cache.key({ pdf: 'changed', algorithm: 1 }), produce);
  await cache.getOrCreate(await cache.key({ pdf: 'original', algorithm: 2 }), produce);
  assert.equal(renders, 3);
});

test('disabled persistence uses no disk and memory never exceeds its configured budget', async () => {
  const { create, root } = await fixture(); const cache = create({ memoryLimit: 500 });
  for (let i=0; i<10; i++) await cache.getOrCreate(await cache.key({ i }), async () => image, { persist: false });
  assert.deepEqual(await fs.readdir(root), []);
  assert.ok((await cache.stats()).memoryBytes <= 500);
});

test('disk limits remove old entries and clear preserves unrelated files', async () => {
  const { create, root } = await fixture(); const cache = create({ diskLimit: 1500, entryLimit: 2 });
  for (let i=0; i<4; i++) await cache.getOrCreate(await cache.key({ i }), async () => image);
  const stats = await cache.stats();
  assert.ok(stats.diskBytes <= 1500); assert.equal(stats.diskEntries, 2);
  await fs.writeFile(path.join(root, 'keep-user-file.txt'), 'untouched');
  await cache.clear();
  assert.deepEqual(await fs.readdir(root), ['keep-user-file.txt']);
});

test('corrupt PNG is regenerated and failed writes do not prevent reading', async () => {
  const { create, root } = await fixture(); let cache = create(); const key = await cache.key({ pdf: 'a' });
  await cache.getOrCreate(key, async () => image);
  await fs.writeFile(path.join(root, key + '.png'), 'broken');
  let renders = 0;
  const reopened = create();
  await reopened.getOrCreate(key, async () => { renders++; return image; });
  assert.equal(renders, 1);
  const broken = create({ io: { ...reopened.io, async write() { throw new Error('disk full'); } } });
  const output = await broken.getOrCreate(await broken.key({ pdf: 'new' }), async () => image);
  assert.equal(output.src, png);
});

test('clear or closing the producer prevents a late render from repopulating disk', async () => {
  const { create } = await fixture(); const cache = create(); let finish;
  const key = await cache.key({ pdf: 'a' });
  const request = cache.getOrCreate(key, () => new Promise(resolve => { finish = resolve; }));
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  await cache.clear(); finish(image); await request;
  assert.equal((await cache.stats()).diskEntries, 0);
  assert.equal((await cache.stats()).memoryEntries, 0);
  let active = true;
  const second = cache.getOrCreate(key, () => { active = false; return image; }, { alive: () => active });
  await second;
  assert.equal((await cache.stats()).diskEntries, 0);
});

test('a second view can recover when a shared producer closes during rendering', async () => {
  const { create } = await fixture(); const cache = create();
  const key = await cache.key({ pdf: 'shared' });
  let finish, alive = true;
  const first = cache.getOrCreate(key, () => new Promise((resolve, reject) => { finish = reject; }), { alive: () => alive });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  const second = cache.getOrCreate(key, async () => image);
  alive = false; finish(new Error('view closed'));
  await assert.rejects(first, /view closed/);
  assert.equal((await second).src, png);
});

test('multiple open documents cannot render large figures simultaneously', async () => {
  const { create } = await fixture(); const cache = create();
  let active=0, peak=0;
  await Promise.all(Array.from({length:8}, async (_,i) => cache.getOrCreate(await cache.key({i}), async () => {
    active++; peak=Math.max(peak,active);
    await new Promise(resolve=>setImmediate(resolve)); active--; return image;
  }, {persist:false})));
  assert.equal(peak,1);
});

test('turning persistence off while a crop is running prevents its disk write', async () => {
  const {create}=await fixture(); const cache=create();
  let persist=true,finish;
  const request=cache.getOrCreate(await cache.key({pdf:'toggle'}),()=>new Promise(resolve=>{finish=resolve;}),{persist:()=>persist});
  while(!finish)await new Promise(resolve=>setImmediate(resolve));
  persist=false;finish(image);
  assert.equal((await request).src,png);
  assert.equal((await cache.stats()).diskEntries,0);
});
