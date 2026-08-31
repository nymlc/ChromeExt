/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-08-31
 * @FilePath: /ChromeExt/background/managers/BackupRescueManager.js
 * @Description: 卸载数据抢救（兜底通道）
 *   Chrome 卸载扩展时会删除扩展存储且无卸载前钩子，
 *   唯一可用的钩子是 setUninstallURL：卸载后自动打开指定网址。
 *   因此在凭证数据每次变化后，把数据压缩并内嵌进该 URL 的 hash 段，
 *   恢复页（restore/index.html）打开后从 hash 解出并提供下载。
 *   URL 上限 1023 字符，超量时按策略裁剪（去自定义字段 → 删最旧凭证 → 丢绑定）。
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
   * 把全量备份写入恢复页所在来源的 localStorage。
   * 网页的 localStorage 只能由该来源的文档写入，因此后台静默打开恢复页，
   * 让注入其中的 content 脚本（restorePageSync.js）完成写入后立即关闭标签——
   * 不弹窗、不抢焦点。卸载扩展不会清除网页存储，卸载后重新打开即可取回。
   */
  async syncFullBackup() {
    if (!this._cfg || this._syncing) return;
    this._syncing = true; // 先占位再 await，避免并发调用重复开标签
    try {
      const stored = await chrome.storage.local.get(this._cfg.backupKeys);
      const projects = Array.isArray(stored.credentialProjects) ? stored.credentialProjects : [];
      if (projects.length === 0) { this._syncing = false; return; } // 无凭证不必同步
      const tab = await chrome.tabs.create({ url: this._cfg.restorePageUrl, active: false });
      this._syncTabId = tab.id;
      // 兜底：即便 content 脚本没回报（页面加载失败等），也不能让标签残留
      this._syncFallbackTimer = setTimeout(() => this._closeSyncTab(), 6000);
    } catch (e) {
      this._syncing = false;
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
      console.log(`[BackupRescue] 卸载链接已更新：凭证 ${credentialCount} 条${truncated ? '（已裁剪）' : ''}，长度 ${url.length}`);
    } catch (e) {
      console.warn('[BackupRescue] 更新卸载 URL 失败', e);
    }
  }

  async buildUninstallUrl() {
    const base = this._cfg.restorePageUrl;
    const stored = await chrome.storage.local.get(this._cfg.backupKeys);
    const projects = Array.isArray(stored.credentialProjects) ? stored.credentialProjects : [];
    const credentialCount = projects.reduce((n, p) => n + ((p.credentials || []).length), 0);

    // 无凭证时链接只指向恢复页：残留的绑定没有项目可挂，嵌入只会产出「0 条凭证」的误导载荷
    if (credentialCount === 0) {
      return { url: base, truncated: false, credentialCount: 0 };
    }

    // '#d=' 前缀占 3 字符
    const budget = this._cfg.uninstallUrlLimit - base.length - 3;
    for (const candidate of this._truncationSequence(stored)) {
      const payload = {
        version: chrome.runtime.getManifest().version,
        exportedAt: new Date().toISOString(),
        modules: { credential: true },
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

  /**
   * 依次产出可尝试的候选数据（完整 → 精简 → 逐级裁剪），命中容量即停止。
   * 裁剪优先级：自定义字段 → 绑定 → 凭证。绑定只是自动填充的辅助匹配，
   * 必须先于凭证丢弃——否则绑定自身超容量时，会把所有携带它的候选（含全部凭证）连坐挤掉。
   */
  _truncationSequence(stored) {
    const seq = [];
    const cloneProjects = () => JSON.parse(JSON.stringify(stored.credentialProjects || []));
    const countOf = (projects) => projects.reduce((n, p) => n + ((p.credentials || []).length), 0);
    const slimClone = () => {
      const ps = cloneProjects();
      ps.forEach(p => (p.credentials || []).forEach(c => delete c.customFields));
      return ps;
    };

    // 1) 完整数据
    const full = cloneProjects();
    seq.push({ data: this._packData(full, stored, true), truncated: false, count: countOf(full) });

    // 2) 去掉凭证自定义字段（selector 等较长，但恢复导入时不依赖）
    const slim = slimClone();
    seq.push({ data: this._packData(slim, stored, true), truncated: true, count: countOf(slim) });

    // 3) 丢弃绑定，保留全部凭证
    const noBindings = slimClone();
    seq.push({ data: this._packData(noBindings, stored, false), truncated: true, count: countOf(noBindings) });

    // 4) 从最旧的凭证开始逐条移除（id 以 Date.now 的 base36 开头，字符串比较近似时间序）
    const projects = slimClone();
    let guard = 0;
    while (countOf(projects) > 0 && guard++ < 2000) {
      let oldest = null;
      projects.forEach(p => (p.credentials || []).forEach(c => {
        if (!oldest || String(c.id || '') < String(oldest.c.id || '')) oldest = { p, c };
      }));
      if (!oldest) break;
      oldest.p.credentials = oldest.p.credentials.filter(c => c !== oldest.c);
      seq.push({ data: this._packData(projects, stored, false), truncated: true, count: countOf(projects) });
    }

    // 5) 全部凭证已丢仍超量：只留空项目列表，至少打开恢复页展示指引
    seq.push({ data: { credentialProjects: [] }, truncated: true, count: 0 });
    return seq;
  }

  _packData(projects, stored, withBindings) {
    // 深拷贝：裁剪循环会持续变更同一个 projects 对象，候选必须各自持有稳定快照
    const data = { credentialProjects: JSON.parse(JSON.stringify(projects)) };
    if (withBindings) {
      if (stored.titleProjectBindings !== undefined) data.titleProjectBindings = stored.titleProjectBindings;
      if (stored.urlProjectBindings !== undefined) data.urlProjectBindings = stored.urlProjectBindings;
    }
    return data;
  }
}
