/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-06-29 00:00:00
 * @FilePath: /ChromeExt/background/managers/TabPoolManager.js
 * @Description: Tab 池管理 - 维护最多 N 个 MasterGo tab，LRU 淘汰，统一加入 tab 组
 */

class TabPoolManager {
  constructor() {
    this.capacity = 3;
    // url → { tabId, name, windowId }
    this.pool = new Map();
    // 最旧在前的 LRU 顺序
    this.lru = [];
    this.groupId = null;

    chrome.tabs.onRemoved.addListener(tabId => this._onTabRemoved(tabId));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.mastergoNavPoolCapacity) {
        this.capacity = changes.mastergoNavPoolCapacity.newValue ?? 3;
      }
    });
    // 保存 promise，让 handle() 等恢复完成再处理消息，避免返回未校验的旧数据
    this._ready = this._restore();
  }

  canHandle(msg) { return msg.action?.startsWith('tabPool_'); }

  async handle(msg, sender) {
    await this._ready;
    switch (msg.action) {
      case 'tabPool_register':
        return this._register(msg.url, msg.name, sender.tab.id, sender.tab.windowId);
      case 'tabPool_open':
        return this._open(msg.url, msg.name, sender.tab?.windowId);
      case 'tabPool_close':
        return this._close(msg.url);
      case 'tabPool_getState':
        return this._getState();
      case 'tabPool_scanWindow':
        return this._scanWindow(msg.navItems, sender.tab?.windowId);
    }
  }

  // 把「调用方所在的 tab」注册进池（页面加载时自动调用）
  async _register(url, name, tabId, windowId) {
    if (this.pool.has(url)) {
      this._touch(url);
      await this._ensureInGroup(tabId);
      this._persist();
      return { ok: true };
    }
    if (this.pool.size >= this.capacity) await this._evict();
    this.pool.set(url, { tabId, name, windowId });
    this._touch(url);
    await this._ensureInGroup(tabId);
    this._persist();
    this._broadcast();
    return { ok: true };
  }

  // 导航到目标 url：已在池中就切换，否则新建 tab
  async _open(url, name, fromWindowId) {
    if (this.pool.has(url)) {
      const entry = this.pool.get(url);
      this._touch(url);
      try {
        await chrome.tabs.update(entry.tabId, { active: true });
        await chrome.windows.update(entry.windowId, { focused: true });
        await this._ensureInGroup(entry.tabId); // 可能被手动移出组，移回来
      } catch (_) {
        // tab 已被关闭，重建
        this.pool.delete(url);
        this.lru = this.lru.filter(u => u !== url);
        return this._open(url, name, fromWindowId);
      }
      this._persist();
      return { ok: true };
    }
    if (this.pool.size >= this.capacity) await this._evict();

    // 组外是否已有匹配的 tab，有则直接移进来
    const existing = await this._findOpenTab(url);
    if (existing) {
      await chrome.tabs.update(existing.id, { active: true });
      await chrome.windows.update(existing.windowId, { focused: true });
      await this._ensureInGroup(existing.id);
      this.pool.set(url, { tabId: existing.id, name, windowId: existing.windowId });
      this._touch(url);
      this._persist();
      this._broadcast();
      return { ok: true };
    }

    const windowId = (await this._groupWindowId()) || fromWindowId;
    const tab = await chrome.tabs.create({ url, windowId, active: true });
    await this._ensureInGroup(tab.id);
    this.pool.set(url, { tabId: tab.id, name, windowId: tab.windowId });
    this._touch(url);
    this._persist();
    this._broadcast();
    return { ok: true };
  }

  // 扫描当前窗口，把匹配菜单项且不在池里的 tab 挪进组（不超过池容量）
  async _scanWindow(navItems, windowId) {
    if (!navItems?.length || !windowId) return { count: 0 };

    // 菜单 url → name 的映射
    const navMap = new Map(navItems.map(({ url, name }) => [url, name]));

    let tabs = [];
    try {
      tabs = await chrome.tabs.query({ windowId });
    } catch (_) { return { count: 0 }; }

    let count = 0;
    for (const tab of tabs) {
      const cleanUrl = this._cleanUrl(tab.url || '');
      if (!navMap.has(cleanUrl)) continue;

      if (this.pool.has(cleanUrl) && this.pool.get(cleanUrl).tabId === tab.id) {
        // 已在池中，补一次确保在组内（可能被手动移出）
        await this._ensureInGroup(tab.id);
        count++;
      } else if (!this.pool.has(cleanUrl) && this.pool.size < this.capacity) {
        // 不在池中且未满，加入
        await this._ensureInGroup(tab.id);
        this.pool.set(cleanUrl, { tabId: tab.id, name: navMap.get(cleanUrl), windowId: tab.windowId });
        this._touch(cleanUrl);
        count++;
      }
    }

    if (count > 0) {
      this._persist();
      this._broadcast();
    }
    return { count };
  }

  async _close(url) {
    const entry = this.pool.get(url);
    if (!entry) return { ok: false };
    try { await chrome.tabs.remove(entry.tabId); } catch (_) {}
    this.pool.delete(url);
    this.lru = this.lru.filter(u => u !== url);
    this._persist();
    this._broadcast();
    return { ok: true };
  }

  _getState() {
    return {
      entries: [...this.pool.entries()].map(([url, e]) => ({
        url, tabId: e.tabId, name: e.name,
      })),
    };
  }

  // ── 内部工具 ─────────────────────────────────────────────────────────────

  _cleanUrl(href) {
    try {
      const url = new URL(href);
      const pageId = url.searchParams.get('page_id');
      const clean = new URL(url.origin + url.pathname);
      if (pageId) clean.searchParams.set('page_id', pageId);
      return clean.toString();
    } catch { return href; }
  }

  // 在所有打开的 mastergo.com tab 中找 URL 匹配的（排除已在池中的）
  async _findOpenTab(url) {
    try {
      const tabs = await chrome.tabs.query({ url: 'https://mastergo.com/*' });
      const poolTabIds = new Set([...this.pool.values()].map(e => e.tabId));
      return tabs.find(t => !poolTabIds.has(t.id) && this._cleanUrl(t.url) === url) || null;
    } catch (_) {
      return null;
    }
  }

  _touch(url) {
    this.lru = this.lru.filter(u => u !== url);
    this.lru.push(url);
  }

  async _evict() {
    const oldest = this.lru[0];
    if (!oldest) return;
    const entry = this.pool.get(oldest);
    if (entry) {
      try { await chrome.tabs.remove(entry.tabId); } catch (_) {}
    }
    this.pool.delete(oldest);
    this.lru.shift();
  }

  async _ensureInGroup(tabId) {
    // 先拿到 tab 所在窗口，组必须和 tab 在同一窗口
    let tabWindowId;
    try {
      const tab = await chrome.tabs.get(tabId);
      tabWindowId = tab.windowId;
    } catch (_) { return; }

    // 验证已有 groupId 是否有效且在同一窗口
    if (this.groupId) {
      try {
        const g = await chrome.tabGroups.get(this.groupId);
        if (g.windowId !== tabWindowId) this.groupId = null; // 跨窗口，作废
      } catch (_) {
        this.groupId = null;
      }
    }

    // 在 tab 所在窗口里找同名组
    if (!this.groupId) {
      try {
        const groups = await chrome.tabGroups.query({ title: 'MasterGo', windowId: tabWindowId });
        if (groups.length > 0) this.groupId = groups[0].id;
      } catch (_) {}
    }

    try {
      if (this.groupId) {
        await chrome.tabs.group({ tabIds: [tabId], groupId: this.groupId });
      } else {
        const gid = await chrome.tabs.group({ tabIds: [tabId] });
        this.groupId = gid;
        await chrome.tabGroups.update(gid, { title: 'MasterGo', color: 'blue' });
      }
    } catch (e) {
      console.warn('[TabPool] 加入 tab 组失败:', e.message);
    }
  }

  async _groupWindowId() {
    if (!this.groupId) return null;
    try {
      const g = await chrome.tabGroups.get(this.groupId);
      return g.windowId;
    } catch (_) {
      this.groupId = null;
      return null;
    }
  }

  _onTabRemoved(tabId) {
    for (const [url, entry] of this.pool) {
      if (entry.tabId === tabId) {
        this.pool.delete(url);
        this.lru = this.lru.filter(u => u !== url);
        this._persist();
        this._broadcast();
        break;
      }
    }
  }

  async _broadcast() {
    const state = this._getState();
    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: 'https://mastergo.com/*' }); } catch (_) {}
    for (const tab of tabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, {
          action: 'tabPool_stateChanged',
          entries: state.entries,
        });
      } catch (_) {}
    }
  }

  _persist() {
    chrome.storage.session.set({
      tabPool: { pool: [...this.pool.entries()], lru: this.lru, groupId: this.groupId },
    }).catch(() => {});
  }

  async _restore() {
    try {
      const { mastergoNavPoolCapacity } = await chrome.storage.local.get('mastergoNavPoolCapacity');
      if (mastergoNavPoolCapacity != null) this.capacity = mastergoNavPoolCapacity;
    } catch (_) {}

    try {
      const { tabPool } = await chrome.storage.session.get('tabPool');
      if (!tabPool) return;
      this.lru     = tabPool.lru     || [];
      this.pool    = new Map(tabPool.pool || []);
      this.groupId = tabPool.groupId ?? null;

      if (this.groupId) {
        try { await chrome.tabGroups.get(this.groupId); }
        catch (_) { this.groupId = null; }
      }
      for (const [url, entry] of this.pool) {
        try {
          const tab = await chrome.tabs.get(entry.tabId);
          // tab ID 可能被复用，还要验证 URL 是否还匹配
          if (this._cleanUrl(tab.url) !== url) throw new Error('url mismatch');
        } catch (_) {
          this.pool.delete(url);
          this.lru = this.lru.filter(u => u !== url);
        }
      }
    } catch (_) {}
  }
}
