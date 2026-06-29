/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-06-29 00:00:00
 * @FilePath: /ChromeExt/shared/TabPool.js
 * @Description: Tab 池客户端 - content script 端薄客户端，通过消息与 background TabPoolManager 通信
 */

class TabPool {
  constructor({ capacity = 3 } = {}) {
    this.capacity = capacity;
    this._cache   = new Map();  // url → { tabId, name }
    this._listener = null;
  }

  // 从 background 同步当前池状态，重建本地缓存
  async sync() {
    const res = await this._send('tabPool_getState', {});
    if (res?.entries) {
      this._cache.clear();
      for (const e of res.entries) {
        this._cache.set(e.url, { tabId: e.tabId, name: e.name });
      }
    }
  }

  // 把当前 tab 自动注册进池（页面加载时调用，background 从 sender.tab.id 获取 tabId）
  async register(url, name) {
    const res = await this._send('tabPool_register', { url, name });
    if (res?.ok) this._cache.set(url, { name });
    return res?.ok || false;
  }

  // 打开或切换到目标 tab（点击导航项时调用）
  async open(url, name) {
    const res = await this._send('tabPool_open', { url, name });
    if (res?.ok) this._cache.set(url, { name });
    return res?.ok || false;
  }

  // 关闭指定 tab 并移出池
  async close(url) {
    const res = await this._send('tabPool_close', { url });
    if (res?.ok) this._cache.delete(url);
    return res?.ok || false;
  }

  // 本地缓存直接判断（零延迟，用于绿点渲染）
  has(url) { return this._cache.has(url); }

  // 扫描当前窗口，把匹配菜单项的 tab 挪进组（结果通过 onUpdate 广播刷新）
  async scanWindow(navItems) {
    return this._send('tabPool_scanWindow', { navItems });
  }

  // 监听 background 广播的状态更新，自动刷新本地缓存后回调
  onUpdate(cb) {
    this.stopListening();
    this._listener = (msg) => {
      if (msg.action !== 'tabPool_stateChanged') return;
      this._cache.clear();
      for (const e of msg.entries || []) {
        this._cache.set(e.url, { tabId: e.tabId, name: e.name });
      }
      cb(this._cache);
    };
    chrome.runtime.onMessage.addListener(this._listener);
  }

  stopListening() {
    if (this._listener) {
      chrome.runtime.onMessage.removeListener(this._listener);
      this._listener = null;
    }
  }

  _send(action, params) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ action, ...params }, res => {
          if (chrome.runtime.lastError) {
            const msg = chrome.runtime.lastError.message || '';
            if (msg.includes('context invalidated') || msg.includes('Extension context')) {
              this._onContextInvalid();
            }
            resolve(null);
          } else {
            resolve(res);
          }
        });
      } catch (e) {
        if (e?.message?.includes('Extension context')) {
          this._onContextInvalid();
        }
        resolve(null);
      }
    });
  }

  _onContextInvalid() {
    if (this._contextInvalidNotified) return;
    this._contextInvalidNotified = true;
    // 扩展已重载，content script 失效，提示用户刷新
    if (typeof Toast !== 'undefined') {
      Toast.warning('扩展已更新，请刷新页面', 0);
    }
  }
}
