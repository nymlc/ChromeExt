/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-06-15 00:00:00
 * @FilePath: /ChromeExt/shared/LRUCache.js
 * @Description: 通用 LRU 缓存 - 固定容量，超出时淘汰最久未使用的项
 */

class LRUCache {
  /**
   * @param {number} capacity 最大容量
   * @param {function} [onEvict] 淘汰回调 (key, value) => void
   */
  constructor(capacity, onEvict) {
    this.capacity = capacity;
    this.onEvict = onEvict || null;
    // Map 的迭代顺序即插入顺序，head（最旧）→ tail（最新）
    this._map = new Map();
  }

  /** 获取值，同时将该项移动到 tail（最近使用） */
  get(key) {
    if (!this._map.has(key)) return undefined;
    const val = this._map.get(key);
    this._map.delete(key);
    this._map.set(key, val);
    return val;
  }

  /** 写入/更新，超容时淘汰 head */
  set(key, value) {
    if (this._map.has(key)) {
      this._map.delete(key);
    } else if (this._map.size >= this.capacity) {
      const oldestKey = this._map.keys().next().value;
      const oldestVal = this._map.get(oldestKey);
      this._map.delete(oldestKey);
      if (this.onEvict) this.onEvict(oldestKey, oldestVal);
    }
    this._map.set(key, value);
  }

  has(key) { return this._map.has(key); }

  delete(key) {
    if (!this._map.has(key)) return;
    const val = this._map.get(key);
    this._map.delete(key);
    if (this.onEvict) this.onEvict(key, val);
  }

  get size() { return this._map.size; }

  keys()   { return this._map.keys(); }
  values() { return this._map.values(); }
  entries(){ return this._map.entries(); }

  /** 清空全部，每项都触发 onEvict */
  clear() {
    for (const [k, v] of this._map) {
      if (this.onEvict) this.onEvict(k, v);
    }
    this._map.clear();
  }

  /** 变更容量，超出部分从最旧开始淘汰 */
  resize(newCapacity) {
    this.capacity = newCapacity;
    while (this._map.size > this.capacity) {
      const oldestKey = this._map.keys().next().value;
      const oldestVal = this._map.get(oldestKey);
      this._map.delete(oldestKey);
      if (this.onEvict) this.onEvict(oldestKey, oldestVal);
    }
  }
}
