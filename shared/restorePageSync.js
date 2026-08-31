/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-08-31
 * @FilePath: /ChromeExt/shared/restorePageSync.js
 * @Description: 恢复页全量备份同步（卸载数据抢救主通道）
 *   用户访问恢复页（restorePageUrl）时，把最新的全量备份写入该页所在来源的
 *   localStorage——网页的存储不属于扩展，卸载扩展不会删除它。
 *   卸载后再打开同一页面即可读取并下载完整数据。
 */

(function () {
  const cfg = (typeof GEEK_BACKUP_CONFIG !== 'undefined') ? GEEK_BACKUP_CONFIG : null;
  if (!cfg) return;

  let pageUrl;
  try { pageUrl = new URL(cfg.restorePageUrl); } catch (e) { return; }
  if (location.origin !== pageUrl.origin) return;

  // 仅在恢复页路径下写入，避免干扰同源的其他页面
  const dir = pageUrl.pathname.replace(/index\.html$/, '');
  if (!location.pathname.startsWith(dir)) return;

  const sync = async () => {
    try {
      const stored = await chrome.storage.local.get(cfg.backupKeys);
      let version = '';
      try { version = chrome.runtime.getManifest().version; } catch (e) { /* 上下文失效 */ }
      localStorage.setItem(cfg.localStorageKey, JSON.stringify({
        syncedAt: new Date().toISOString(),
        version,
        data: stored,
      }));
    } catch (e) { /* 扩展上下文失效或存储不可用时静默忽略 */ }
  };

  sync();

  // 数据变化时实时刷新备份；优先复用 StorageState 的唯一监听
  if (typeof StorageState !== 'undefined') {
    StorageState.init().then(() => {
      StorageState.subscribe((changes) => {
        if (cfg.backupKeys.some(k => changes[k])) sync();
      });
    });
  } else {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && cfg.backupKeys.some(k => changes[k])) sync();
    });
  }
})();
