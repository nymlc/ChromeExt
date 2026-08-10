/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-08-06
 * @FilePath: /ChromeExt/shared/storageState.js
 * @Description: 全局存储缓存单例（仅 content script 环境）
 *   集中读取 chrome.storage.local 并注册唯一的 onChanged 监听，
 *   向订阅者广播变更，避免各模块重复挂 storage.onChanged 与重复 get。
 */

(function (global) {
  class StorageState {
    constructor() {
      this._cache = {};
      this._subscribers = new Set();
      this._initialized = false;
      this._onChanged = this._onChanged.bind(this);
    }

    /**
     * 初始化：拉取全量存储并注册唯一变更监听（幂等）
     */
    async init() {
      if (this._initialized) return;
      this._initialized = true;
      try {
        this._cache = await chrome.storage.local.get(null) || {};
      } catch (e) {
        this._cache = {};
      }
      chrome.storage.onChanged.addListener(this._onChanged);
    }

    /**
     * 唯一监听：同步缓存并广播给订阅者
     */
    _onChanged(changes, area) {
      if (area && area !== 'local') return;
      for (const [key, change] of Object.entries(changes)) {
        if (change.newValue === undefined) {
          delete this._cache[key];
        } else {
          this._cache[key] = change.newValue;
        }
      }
      this._subscribers.forEach((cb) => {
        try { cb(changes); } catch (e) { console.error('[StorageState] subscriber error', e); }
      });
    }

    get(key, fallback = undefined) {
      return Object.prototype.hasOwnProperty.call(this._cache, key) ? this._cache[key] : fallback;
    }

    getAll() {
      return Object.assign({}, this._cache);
    }

    async refresh(keys) {
      const result = await chrome.storage.local.get(keys || null);
      Object.assign(this._cache, result);
      return result;
    }

    /**
     * 写回存储并立即更新本地缓存，保证订阅者拿到一致数据
     */
    async set(items) {
      await chrome.storage.local.set(items);
      Object.assign(this._cache, items);
    }

    /**
     * 订阅变更。返回取消订阅函数。
     */
    subscribe(cb) {
      this._subscribers.add(cb);
      return () => this._subscribers.delete(cb);
    }
  }

  // 单例：content script 多文件共享同一全局作用域
  global.StorageState = global.StorageState || new StorageState();
})(typeof globalThis !== 'undefined' ? globalThis : this);
