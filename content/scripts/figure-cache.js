/* eslint-disable no-undef */

// This store owns only hashed PNG/JSON files in its dedicated directory.
// PDF/Reader/translation caches never pass through this interface.
var ZRBFigureCache = {
  create(options = {}) {
    return new ZRBFigureStore(options);
  },

  async digest(bytes) {
    if (typeof Components !== 'undefined' && Components.classes && Components.interfaces) {
      const hash = Components.classes['@mozilla.org/security/hash;1'].createInstance(Components.interfaces.nsICryptoHash);
      hash.init(hash.SHA256);
      hash.update(bytes, bytes.length);
      return Array.from(hash.finish(false), c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    }
    const data = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(data), b => b.toString(16).padStart(2, '0')).join('');
  },

  runtime() {
    let io = null;
    try {
      if (typeof IOUtils !== 'undefined' && typeof PathUtils !== 'undefined' && typeof Zotero !== 'undefined') {
        const root = PathUtils.join(Zotero.DataDirectory.getSubdirectory('cache', true), 'reading-bilingual', 'figures-v1');
        io = {
          join: name => PathUtils.join(root, name),
          read: (file, limit) => IOUtils.read(file, limit ? { maxBytes: limit + 1 } : {}),
          stat: file => IOUtils.stat(file),
          async write(file, bytes) {
            await IOUtils.makeDirectory(root, { ignoreExisting: true, createAncestors: true });
            await IOUtils.write(file, bytes, { tmpPath: file + '.tmp' });
          },
          remove: file => IOUtils.remove(file, { ignoreAbsent: true }),
          async list() {
            try { return await IOUtils.getChildren(root); }
            catch (e) { if (e.name === 'NotFoundError') return []; throw e; }
          },
        };
      }
    } catch (e) {}
    return this.create({ io });
  },
};

class ZRBFigureStore {
  constructor({ io = null, digest = ZRBFigureCache.digest, memoryLimit = 32 * 1024 * 1024,
    diskLimit = 128 * 1024 * 1024, entryLimit = 2000 } = {}) {
    Object.assign(this, { io, digest, memoryLimit, diskLimit, entryLimit });
    this.memory = new Map();
    this.pending = new Map();
    this.memoryBytes = 0;
    this.epoch = 0;
    this.diskQueue = Promise.resolve();
    this.renderQueue = Promise.resolve();
    this.lastError = null;
    this.metrics = { memoryHits: 0, diskHits: 0, renders: 0 };
  }

  async key(descriptor) { return this.digest(new TextEncoder().encode(JSON.stringify(descriptor))); }
  validKey(key) { return /^[a-f0-9]{64}$/.test(key); }
  encode(value) { return new TextEncoder().encode(JSON.stringify(value)); }
  decode(bytes) { return JSON.parse(new TextDecoder().decode(bytes)); }
  async readBounded(file, limit) {
    if (this.io.stat && (await this.io.stat(file)).size > limit) throw new Error('Cache file exceeds limit');
    const bytes = await this.io.read(file, limit);
    if (bytes.length > limit) throw new Error('Cache file exceeds limit');
    return bytes;
  }
  enqueue(work) {
    const task = this.diskQueue.then(work);
    this.diskQueue = task.then(() => undefined, () => undefined);
    return task;
  }
  pngBytes(src) {
    if (!/^data:image\/png;base64,/.test(src)) throw new Error('Not a PNG cache result');
    const binary = atob(src.slice(src.indexOf(',') + 1));
    return Uint8Array.from(binary, c => c.charCodeAt(0));
  }
  pngURL(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
    return 'data:image/png;base64,' + btoa(binary);
  }
  dimensions(bytes) {
    const magic = [137,80,78,71,13,10,26,10];
    if (bytes.length < 24 || magic.some((value, i) => bytes[i] !== value)) throw new Error('Invalid cached PNG');
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = data.getUint32(16), height = data.getUint32(20);
    if (!width || !height || width > 65535 || height > 65535 || width * height > 16000000) throw new Error('Invalid PNG dimensions');
    return { width, height };
  }
  validMeta(meta, key) {
    return meta?.schema === 1 && meta.key === key && Number.isFinite(meta.used)
      && Array.isArray(meta.rect) && meta.rect.length === 4 && meta.rect.every(Number.isFinite)
      && meta.rect[2] > meta.rect[0] && meta.rect[3] > meta.rect[1]
      && ['above', 'below', 'left', 'right'].includes(meta.direction) && meta.displayWidth > 0
      && Number.isInteger(meta.pngBytes) && meta.pngBytes > 0 && meta.pngBytes <= this.diskLimit
      && /^[a-f0-9]{64}$/.test(meta.pngHash);
  }
  async removeDisk(key) {
    if (!this.validKey(key) || !this.io) return;
    await this.io.remove(this.io.join(key + '.json'));
    await this.io.remove(this.io.join(key + '.png'));
  }
  async readDisk(key) {
    try {
      const meta = this.decode(await this.readBounded(this.io.join(key + '.json'), 4096));
      if (!this.validMeta(meta, key)) throw new Error('Invalid image cache metadata');
      const bytes = new Uint8Array(await this.readBounded(this.io.join(key + '.png'), Math.min(meta.pngBytes, 48 * 1024 * 1024)));
      if (bytes.length !== meta.pngBytes || await this.digest(bytes) !== meta.pngHash) throw new Error('Cached PNG changed');
      const size = this.dimensions(bytes);
      meta.used = Date.now();
      try { await this.io.write(this.io.join(key + '.json'), this.encode(meta)); }
      catch (e) { this.lastError = String(e.message || e); }
      return { src: this.pngURL(bytes), ...size, rect: meta.rect, direction: meta.direction, displayWidth: meta.displayWidth };
    } catch (e) {
      if (!['NotFoundError', 'ENOENT'].includes(e.name) && e.code !== 'ENOENT') this.lastError = String(e.message || e);
      try { await this.removeDisk(key); } catch (e) {}
      return null;
    }
  }
  async scan() {
    const files = await this.io.list();
    const entries = [];
    for (const file of files) {
      const name = file.replace(/\\/g, '/').split('/').pop();
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const key = name.slice(0, -5);
      try {
        const metadata = await this.readBounded(this.io.join(name), 4096);
        const meta = this.decode(metadata);
        if (!this.validMeta(meta, key)) throw new Error('Invalid cache metadata');
        const size = this.io.stat ? (await this.io.stat(this.io.join(key + '.png'))).size
          : (await this.io.read(this.io.join(key + '.png'))).length;
        if (size !== meta.pngBytes) throw new Error('Incomplete cache entry');
        entries.push({ key, used: meta.used, bytes: size + metadata.length });
      } catch (e) { await this.removeDisk(key); }
    }
    const valid = new Set(entries.map(entry => entry.key));
    for (const file of files) {
      const name = file.replace(/\\/g, '/').split('/').pop();
      const match = name.match(/^([a-f0-9]{64})\.(png|json)(\.tmp)?$/);
      if (match && (match[3] || !valid.has(match[1]))) await this.io.remove(this.io.join(name));
    }
    return entries;
  }
  async writeDisk(key, result, epoch, alive) {
    if (epoch !== this.epoch || !alive()) return;
    const bytes = this.pngBytes(result.src);
    this.dimensions(bytes);
    const meta = { schema: 1, key, used: Date.now(), rect: result.rect, direction: result.direction,
      displayWidth: result.displayWidth, pngBytes: bytes.length, pngHash: await this.digest(bytes) };
    const metadata = this.encode(meta);
    if (bytes.length + metadata.length > this.diskLimit || !this.validMeta(meta, key)) return;
    await this.io.write(this.io.join(key + '.png'), bytes);
    if (epoch !== this.epoch || !alive()) { await this.removeDisk(key); return; }
    await this.io.write(this.io.join(key + '.json'), metadata);
    const entries = (await this.scan()).sort((a,b) => a.used - b.used);
    let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    while ((total > this.diskLimit || entries.length > this.entryLimit) && entries.length) {
      const entry = entries.shift();
      await this.removeDisk(entry.key);
      total -= entry.bytes;
    }
    this.lastError = null;
  }
  memoryCost(result) {
    return result.src.length * 2 + (result.width || 0) * (result.height || 0) * 4;
  }
  remember(key, result) {
    if (!result) return;
    this.forget(key);
    const bytes = this.memoryCost(result);
    if (bytes > this.memoryLimit) return;
    this.memory.set(key, { result, bytes });
    this.memoryBytes += bytes;
    while (this.memoryBytes > this.memoryLimit) this.forget(this.memory.keys().next().value);
  }
  forget(key) {
    const entry = this.memory.get(key);
    if (entry) this.memoryBytes -= entry.bytes;
    this.memory.delete(key);
  }
  clearMemory() { this.memory.clear(); this.memoryBytes = 0; }
  trimMemory(limit = this.memoryLimit) {
    while (this.memoryBytes > limit && this.memory.size) this.forget(this.memory.keys().next().value);
  }

  async getOrCreate(key, producer, { persist = true, alive = () => true } = {}) {
    const canPersist = typeof persist === 'function' ? persist : () => persist;
    if (!this.validKey(key)) throw new Error('Invalid figure cache key');
    const memory = this.memory.get(key);
    if (memory) {
      this.memory.delete(key); this.memory.set(key, memory);
      this.metrics.memoryHits++;
      return memory.result;
    }
    const pending = this.pending.get(key);
    if (pending && pending.epoch === this.epoch) {
      try {
        const result = await pending.task;
        if (result || pending.alive() || !alive()) return result;
      } catch (e) { if (pending.alive() || !alive()) throw e; }
      // Another tab owned the shared render and has since closed. Retry using
      // this caller's live Reader rather than retaining the closed view.
      if (this.pending.get(key) === pending) this.pending.delete(key);
      return this.getOrCreate(key, producer, { persist, alive });
    }
    const epoch = this.epoch;
    const task = (async () => {
      let result = canPersist() && this.io ? await this.enqueue(() => this.readDisk(key)) : null;
      if (result) this.metrics.diskHits++;
      else {
        const render = this.renderQueue.then(() => {
          if (!alive()) return null;
          this.metrics.renders++;
          return producer();
        });
        this.renderQueue = render.then(() => undefined, () => undefined);
        result = await render;
        if (result && canPersist() && this.io && alive() && epoch === this.epoch) {
          try { await this.enqueue(() => this.writeDisk(key, result, epoch, () => alive() && canPersist())); }
          catch (e) { this.lastError = String(e.message || e); }
        }
      }
      if (alive() && epoch === this.epoch) this.remember(key, result);
      return result;
    })();
    const entry = { task, alive, epoch };
    this.pending.set(key, entry);
    try { return await task; }
    finally { if (this.pending.get(key) === entry) this.pending.delete(key); }
  }
  async invalidate(key) {
    this.forget(key);
    if (this.io) { try { await this.enqueue(() => this.removeDisk(key)); } catch (e) {} }
  }
  async clear() {
    this.epoch++;
    this.clearMemory();
    if (this.io) await this.enqueue(async () => {
      for (const file of await this.io.list()) {
        const name = file.replace(/\\/g, '/').split('/').pop();
        if (/^[a-f0-9]{64}\.(png|json)(\.tmp)?$/.test(name)) await this.io.remove(this.io.join(name));
      }
    });
    this.lastError = null;
    return this.stats();
  }
  async stats() {
    let entries = [];
    if (this.io) {
      try { entries = await this.enqueue(() => this.scan()); }
      catch (e) { this.lastError = String(e.message || e); }
    }
    return { diskBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), diskEntries: entries.length,
      memoryBytes: this.memoryBytes, memoryEntries: this.memory.size, memoryLimit: this.memoryLimit,
      diskLimit: this.diskLimit, available: !!this.io, error: this.lastError, ...this.metrics };
  }
}
