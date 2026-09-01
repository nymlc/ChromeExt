/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-08-31
 * @FilePath: /ChromeExt/background/managers/BackupRescueManager.js
 * @Description: 卸载数据抢救（兜底通道）
 *   Chrome 卸载扩展时会删除扩展存储且无卸载前钩子，
 *   唯一可用的钩子是 setUninstallURL：卸载后自动打开指定网址。
 *   因此在凭证数据每次变化后，把数据压缩并内嵌进该 URL 的 hash 段，
 *   恢复页（restore/index.html）打开后从 hash 解出并提供下载。
 *   URL 上限 1023 字符，超量时按策略裁剪（去自定义字段 → 丢绑定 → 逐条丢最旧凭证）。
 *   全量备份走 content 侧的 localStorage 同步，见 shared/restorePageSync.js。
 */

class BackupRescueManager {
  constructor() {
    this._timer = null;
    this._syncing = false;
    this._syncTabId = null;
    this._syncFallbackTimer = null;
    this._cfg = (typeof GEEK_BACKUP_CONFIG !== 'undefined') ? GEEK_BACKUP_CONFIG : null;

    if (!this._cfg) return;

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (!this._cfg.backupKeys.some(k => changes[k])) return;
      this._scheduleUpdate();
    });

    // content 脚本在恢复页完成 localStorage 写入后回报，立即关掉用于同步的后台标签
    chrome.runtime.onMessage.addListener((msg, sender) => {
      if (msg && msg.type === 'geek-rescue-synced' && sender.tab && sender.tab.id === this._syncTabId) {
        this._closeSyncTab();
      }
    });

    chrome.runtime.onInstalled.addListener(() => {
      this.updateUninstallUrl();
      this.syncFullBackup();
    });

    // SW 每次启动兜底刷新一次（setUninstallURL 的结果由浏览器持久化，此调用幂等）
    this.updateUninstallUrl();
    this.syncFullBackup();
  }

  canHandle() { return false; } // 只监听存储变化，不处理消息

  _scheduleUpdate() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this.updateUninstallUrl();
      this.syncFullBackup();
    }, 1500);
  }

  _closeSyncTab() {
    if (this._syncFallbackTimer) { clearTimeout(this._syncFallbackTimer); this._syncFallbackTimer = null; }
    const id = this._syncTabId;
    this._syncTabId = null;
    this._syncing = false;
    if (id != null) chrome.tabs.remove(id).catch(() => {});
  }

  /**
   * 把全量备份写入恢复页所在来源的 localStorage（网页存储，卸载不受影响）。
   * 首选：往已打开的普通网页里注入一个不可见的 1px iframe 指向恢复页，
   * 由注入 iframe 的 content 脚本（restorePageSync.js）完成写入——无标签、无闪烁、不抢焦点。
   * 个别站点 CSP 会阻止第三方 iframe，故最多尝试 3 个候选标签（写入幂等，重复无害）。
   * 兜底：一个可注入的网页都没有时，才退化为后台开标签。
   */
  async syncFullBackup() {
    if (!this._cfg || this._syncing) return;
    this._syncing = true; // 先占位再 await，避免并发调用重复触发
    try {
      const stored = await chrome.storage.local.get(this._cfg.backupKeys);
      // 设置项（模块隐藏、模块顺序、各模块开关/站点禁用）即使没有凭证也要抢救
      if (!this._hasAnyData(stored)) return; // 空存储不必同步

      // 仅当"恢复页本身"已开着才可跳过：该页的 content 脚本订阅了存储变化会自行同步。
      // 必须匹配到恢复页路径前缀——同源的其它页面其 content 脚本会提前返回、并不会同步。
      let restorePrefix = '';
      try {
        const u = new URL(this._cfg.restorePageUrl);
        restorePrefix = u.origin + u.pathname.replace(/index\.html$/, '');
      } catch (e) { /* 配置异常则跳过该优化 */ }

      const tabs = await chrome.tabs.query({});
      if (restorePrefix && tabs.some(t => (t.url || '').startsWith(restorePrefix))) return;

      if (await this._syncViaHiddenIframe(tabs)) return;
      await this._syncViaBackgroundTab();
    } catch (e) {
      /* 静默：同步失败不影响主流程 */
    } finally {
      // iframe 方式自行定时清理；后台标签兜底路径在关标签时才释放（见 _closeSyncTab）
      if (this._syncTabId == null) this._syncing = false;
    }
  }

  async _syncViaHiddenIframe(tabs) {
    const candidates = tabs
      .filter(t => /^https?:/.test(t.url || ''))
      .sort((a, b) => Number(!!b.active) - Number(!!a.active))
      .slice(0, 3);
    if (candidates.length === 0) return false;

    let injected = false;
    for (const t of candidates) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: t.id },
          func: (url) => {
            try {
              if (window.top !== window) return; // 已在 iframe 中则不再嵌套
              const f = document.createElement('iframe');
              f.src = url;
              f.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none;';
              f.setAttribute('aria-hidden', 'true');
              f.tabIndex = -1;
              (document.body || document.documentElement).appendChild(f);
              // 给足加载与写入时间后自行移除，无需外部协调
              setTimeout(() => { try { f.remove(); } catch (_) {} }, 15000);
            } catch (_) { /* 页面环境异常时忽略 */ }
          },
          args: [this._cfg.restorePageUrl],
        });
        injected = true;
      } catch (e) { /* 该标签不可注入（内部页等），尝试下一个 */ }
    }
    return injected;
  }

  async _syncViaBackgroundTab() {
    try {
      const tab = await chrome.tabs.create({ url: this._cfg.restorePageUrl, active: false });
      this._syncTabId = tab.id;
      // 兜底：即便 content 脚本没回报（页面加载失败等），也不能让标签残留
      this._syncFallbackTimer = setTimeout(() => this._closeSyncTab(), 6000);
    } catch (e) {
      this._syncTabId = null;
    }
  }

  /**
   * 重建并设置卸载 URL（数据为空时仅指向恢复页，卸载后仍可看到指引）
   */
  async updateUninstallUrl() {
    try {
      const { url, truncated, credentialCount } = await this.buildUninstallUrl();
      await chrome.runtime.setUninstallURL(url);
      // Chrome 没有 getUninstallURL，只能靠日志确认每次重建的结果
      const settingsCount = Object.keys(this._settingsSlice(
        await chrome.storage.local.get(this._cfg.backupKeys))).length;
      console.log(`[BackupRescue] 卸载链接已更新：凭证 ${credentialCount} 条${truncated ? '（已裁剪）' : ''}`
        + ` · 设置项 ${settingsCount} 个（始终保留） · 长度 ${url.length}`);
    } catch (e) {
      console.warn('[BackupRescue] 更新卸载 URL 失败', e);
    }
  }

  async buildUninstallUrl() {
    const base = this._cfg.restorePageUrl;
    const stored = await chrome.storage.local.get(this._cfg.backupKeys);
    const projects = Array.isArray(stored.credentialProjects) ? stored.credentialProjects : [];
    const credentialCount = projects.reduce((n, p) => n + ((p.credentials || []).length), 0);

    // 一点数据都没有时链接只指向恢复页，卸载后仍可看到指引
    if (!this._hasAnyData(stored)) {
      return { url: base, truncated: false, credentialCount: 0 };
    }

    // '#d=' 前缀占 3 字符
    const budget = this._cfg.uninstallUrlLimit - base.length - 3;
    for (const candidate of this._truncationSequence(stored)) {
      const payload = {
        version: chrome.runtime.getManifest().version,
        exportedAt: new Date().toISOString(),
        // 与导出文件同构：导入对话框据此勾选模块
        modules: this._presentModules(candidate.data),
        data: candidate.data,
        _rescue: 'uninstall-url',
        _truncated: candidate.truncated,
        _credentialCount: candidate.count,
      };
      const compressed = LZString.compressToEncodedURIComponent(JSON.stringify(payload));
      if (compressed.length <= budget) {
        return { url: `${base}#d=${compressed}`, truncated: candidate.truncated, credentialCount: candidate.count };
      }
    }
    // 极端情况下任何裁剪都放不下：至少打开恢复页展示指引
    return { url: base, truncated: true, credentialCount: 0 };
  }

  _hasAnyData(data) {
    if (typeof GEEK_DATA_UTILS !== 'undefined' && GEEK_DATA_UTILS.hasAnyData) {
      return GEEK_DATA_UTILS.hasAnyData(data);
    }
    return Object.keys(data || {}).some(k => {
      const v = data[k];
      if (v === undefined || v === null || v === '') return false;
      if (Array.isArray(v)) return v.length > 0;
      if (typeof v === 'object') return Object.keys(v).length > 0;
      return true;
    });
  }

  _presentModules(data) {
    if (typeof GEEK_DATA_UTILS !== 'undefined' && GEEK_DATA_UTILS.presentModules) {
      return GEEK_DATA_UTILS.presentModules(data);
    }
    return Object.keys(data || {}).reduce((acc, k) => { acc[k] = true; return acc; }, {});
  }

  /**
   * 除凭证外的全部设置：模块隐藏、模块顺序、各模块开关与站点禁用列表等。
   * 体积很小（通常压缩后几百字节），任何候选都完整保留，不参与裁剪。
   */
  _settingsSlice(stored) {
    const trimmable = this._cfg.trimmableKeys || [];
    const out = {};
    Object.keys(stored || {}).forEach(k => {
      if (trimmable.indexOf(k) !== -1) return;
      if (stored[k] === undefined) return;
      out[k] = JSON.parse(JSON.stringify(stored[k]));
    });
    return out;
  }

  /**
   * 依次产出可尝试的候选数据（完整 → 精简 → 逐级裁剪），命中容量即停止。
   * 裁剪优先级：凭证自定义字段 → 绑定 → 逐条丢最旧凭证。
   * 绑定只是自动填充的辅助匹配，必须先于凭证丢弃——否则绑定自身超容量时，
   * 会把所有携带它的候选（含全部凭证）连坐挤掉。
   * 设置项（trimmableKeys 之外）任何候选都不丢，保证模块隐藏等偏好必然被抢救回来。
   */
  _truncationSequence(stored) {
    const seq = [];
    const settings = this._settingsSlice(stored);
    const cloneProjects = () => JSON.parse(JSON.stringify(stored.credentialProjects || []));
    const countOf = (projects) => projects.reduce((n, p) => n + ((p.credentials || []).length), 0);
    const slimClone = () => {
      const ps = cloneProjects();
      ps.forEach(p => (p.credentials || []).forEach(c => delete c.customFields));
      return ps;
    };

    // 1) 完整数据
    const full = cloneProjects();
    seq.push({ data: this._packData(full, settings, stored, true), truncated: false, count: countOf(full) });

    // 2) 去掉凭证自定义字段（selector 等较长，但恢复导入时不依赖）
    const slim = slimClone();
    seq.push({ data: this._packData(slim, settings, stored, true), truncated: countOf(slim) !== countOf(full), count: countOf(slim) });

    // 3) 丢弃绑定，保留全部凭证
    const noBindings = slimClone();
    const bindingsExist = stored.titleProjectBindings !== undefined || stored.urlProjectBindings !== undefined;
    seq.push({ data: this._packData(noBindings, settings, stored, false), truncated: !!bindingsExist, count: countOf(noBindings) });

    // 4) 从最旧的凭证开始逐条移除（id 以 Date.now 的 base36 开头，字符串比较近似时间序）
    const projects = slimClone();
    const totalCount = countOf(projects);
    let guard = 0;
    while (countOf(projects) > 0 && guard++ < 2000) {
      let oldest = null;
      projects.forEach(p => (p.credentials || []).forEach(c => {
        if (!oldest || String(c.id || '') < String(oldest.c.id || '')) oldest = { p, c };
      }));
      if (!oldest) break;
      oldest.p.credentials = oldest.p.credentials.filter(c => c !== oldest.c);
      seq.push({ data: this._packData(projects, settings, stored, false), truncated: true, count: countOf(projects) });
    }

    // 5) 全部凭证都放不下：只留设置项，至少保住模块隐藏/模块顺序/各模块开关
    seq.push({ data: JSON.parse(JSON.stringify(settings)), truncated: totalCount > 0, count: 0 });
    return seq;
  }

  _packData(projects, settings, stored, withBindings) {
    // 深拷贝：裁剪循环会持续变更同一个 projects 对象，候选必须各自持有稳定快照
    const data = Object.assign({}, JSON.parse(JSON.stringify(settings)));
    if (projects && projects.length > 0) {
      data.credentialProjects = JSON.parse(JSON.stringify(projects));
    }
    if (withBindings) {
      if (stored.titleProjectBindings !== undefined) data.titleProjectBindings = stored.titleProjectBindings;
      if (stored.urlProjectBindings !== undefined) data.urlProjectBindings = stored.urlProjectBindings;
    }
    return data;
  }
}
