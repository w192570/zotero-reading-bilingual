/* eslint-disable no-undef */

// User decisions are documents, not an evictable image cache. Each file is
// keyed by attachment identity AND content fingerprint, and written atomically.
var ZRBManualFigureStore = {
  create(options) { return new ZRBManualCorrectionStore(options); },
  runtime() {
    const root = PathUtils.join(Zotero.DataDirectory.dir, 'reading-bilingual', 'manual-figures-v1');
    // Keep only a pending-write queue across plugin reloads. It contains no
    // Reader/DOM references once settled, and coordinates rollback with a new
    // plugin instance writing the same decision file.
    const serial = Zotero._readingBilingualManualRecordQueue || { tail: null };
    Zotero._readingBilingualManualRecordQueue = serial;
    return this.create({ digest: ZRBFigureCache.digest, serial, io: {
      join: name => PathUtils.join(root, name),
      read: file => IOUtils.read(file, { maxBytes: 2 * 1024 * 1024 + 1 }),
      async write(file, bytes) {
        await IOUtils.makeDirectory(root, { ignoreExisting: true, createAncestors: true });
        await IOUtils.write(file, bytes, { tmpPath: file + '.tmp' });
      },
    } });
  },
};

class ZRBManualCorrectionStore {
  constructor({ io, digest = ZRBFigureCache.digest, serial = { tail: null } }) {
    Object.assign(this, { io, digest, serial });
  }
  async key(documentID, fingerprint) {
    if (!documentID || !fingerprint) throw new Error('缺少文献标识或 PDF 指纹');
    return this.digest(new TextEncoder().encode(JSON.stringify([documentID, fingerprint])));
  }
  async read(documentID, fingerprint) {
    const file = this.io.join(await this.key(documentID, fingerprint) + '.json');
    try {
      const bytes = await this.io.read(file);
      if (bytes.length > 2 * 1024 * 1024) throw new Error('图片修正记录过大');
      const data = JSON.parse(new TextDecoder().decode(bytes));
      if (data.schema !== 1 || data.documentID !== documentID || data.fingerprint !== fingerprint
          || !Array.isArray(data.records) || data.records.length > 500) throw new Error('图片修正记录格式不正确');
      return { file, data };
    } catch (error) {
      if (error.name !== 'NotFoundError' && error.code !== 'ENOENT') throw error;
      return { file, data: { schema: 1, documentID, fingerprint, records: [] } };
    }
  }
  async list(documentID, fingerprint) { return (await this.read(documentID, fingerprint)).data.records; }
  change(documentID, fingerprint, update, alive = () => true) {
    const task = (this.serial.tail || Promise.resolve()).then(async () => {
      const { file, data } = await this.read(documentID, fingerprint);
      if (!alive()) throw new Error('操作已取消或阅读视图已关闭');
      const previous = new TextEncoder().encode(JSON.stringify(data));
      update(data.records);
      const bytes = new TextEncoder().encode(JSON.stringify(data));
      if (bytes.length > 2 * 1024 * 1024) throw new Error('图片修正记录过大');
      await this.io.write(file, bytes);
      if (!alive()) {
        // This runs inside the same serial queue, before a newer edit may
        // write. A cancelled disk write must never reappear on the next open.
        await this.io.write(file, previous);
        throw new Error('操作已取消，修正记录已还原');
      }
    });
    const settled = task.catch(() => {});
    this.serial.tail = settled;
    settled.then(() => { if (this.serial.tail === settled) this.serial.tail = null; });
    return task;
  }
  put(documentID, fingerprint, record, alive) {
    // Copy only JSON data. No DOM nodes, callbacks, images or model output.
    const copy = JSON.parse(JSON.stringify(record));
    if (!copy.id || typeof copy.id !== 'string' || copy.id.length > 1000 || !copy.anchor
        || !Array.isArray(copy.replacements) || !Array.isArray(copy.regions) || !copy.regions.length
        || copy.regions.length > 12) return Promise.reject(new Error('无效的图片修正记录'));
    return this.change(documentID, fingerprint, records => {
      const old = records.findIndex(item => item.id === copy.id);
      if (old < 0 && records.length >= 500) throw new Error('本篇文献的图片修正数量已达上限');
      if (old >= 0) records.splice(old, 1, copy); else records.push(copy);
    }, alive);
  }
  remove(documentID, fingerprint, id, alive) {
    return this.change(documentID, fingerprint, records => {
      const index = records.findIndex(record => record.id === id);
      if (index >= 0) records.splice(index, 1);
    }, alive);
  }
}
