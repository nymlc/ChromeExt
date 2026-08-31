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
    this._cfg = (typeof GEEK_BACKUP_CONFIG !== 'undefined') ? GEEK_BACKUP_CONFIG : null;

    if (!this._cfg) return;

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (!this._cfg.backupKeys.some(k => changes[k])) return;
      this._scheduleUpdate();
    });

    chrome.runtime.onInstalled.addListener((details) => {
      this.updateUninstallUrl();
      // 首次安装打开一次恢复页：激活 localStorage 全量同步并让用户知晓该机制
      if (details.reason === 'install') this._openRestorePageOnce();
    });

    // SW 每次启动兜底刷新一次（setUninstallURL 的结果由浏览器持久化，此调用幂等）
    this.updateUninstallUrl();
  }

  canHandle() { return false; } // 只监听存储变化，不处理消息

  _scheduleUpdate() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.updateUninstallUrl(), 1500);
  }

  async _openRestorePageOnce() {
    try {
      const { rescuePageOpened } = await chrome.storage.local.get(['rescuePageOpened']);
      if (rescuePageOpened) return;
      await chrome.storage.local.set({ rescuePageOpened: true });
      await chrome.tabs.create({ url: this._cfg.restorePageUrl });
    } catch (e) { /* 不阻塞主流程 */ }
  }

  /**
   * 重建并设置卸载 URL（数据为空时仅指向恢复页，卸载后仍可看到指引）
   */
  async updateUninstallUrl() {
    try {
      const { url } = await this.buildUninstallUrl();
      await chrome.runtime.setUninstallURL(url);
    } catch (e) {
      console.warn('[BackupRescue] 更新卸载 URL 失败', e);
    }
  }

  async buildUninstallUrl() {
    const base = this._cfg.restorePageUrl;
    const stored = await chrome.storage.local.get(this._cfg.backupKeys);
    const projects = Array.isArray(stored.credentialProjects) ? stored.credentialProjects : [];
    const hasBindings = Object.keys(stored.titleProjectBindings || {}).length > 0
      || Object.keys(stored.urlProjectBindings || {}).length > 0;

    if (projects.length === 0 && !hasBindings) {
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
   * 依次产出可尝试的候选数据（完整 → 精简 → 逐级裁剪），命中容量即停止
   */
  _truncationSequence(stored) {
    const seq = [];
    const cloneProjects = () => JSON.parse(JSON.stringify(stored.credentialProjects || []));
    const countOf = (projects) => projects.reduce((n, p) => n + ((p.credentials || []).length), 0);

    // 1) 完整数据
    seq.push({ data: this._packData(cloneProjects(), stored, true), truncated: false, count: countOf(cloneProjects()) });

    // 2) 去掉凭证自定义字段（selector 等较长，但恢复导入时不依赖）
    const slim = cloneProjects();
    slim.forEach(p => (p.credentials || []).forEach(c => delete c.customFields));
    seq.push({ data: this._packData(slim, stored, true), truncated: true, count: countOf(slim) });

    // 3) 从最旧的凭证开始逐条移除（id 以 Date.now 的 base36 开头，字符串比较近似时间序）
    const projects = cloneProjects();
    projects.forEach(p => (p.credentials || []).forEach(c => delete c.customFields));
    let guard = 0;
    while (countOf(projects) > 0 && guard++ < 2000) {
      let oldest = null;
      projects.forEach(p => (p.credentials || []).forEach(c => {
        if (!oldest || String(c.id || '') < String(oldest.c.id || '')) oldest = { p, c };
      }));
      if (!oldest) break;
      oldest.p.credentials = oldest.p.credentials.filter(c => c !== oldest.c);
      seq.push({ data: this._packData(projects, stored, true), truncated: true, count: countOf(projects) });
    }

    // 4) 凭证已清空仍超量：丢绑定 → 只留空项目列表
    seq.push({ data: this._packData([], stored, false), truncated: true, count: 0 });
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
