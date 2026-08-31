/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-08-31
 * @FilePath: /ChromeExt/shared/backupConfig.js
 * @Description: 卸载数据抢救配置（background 与 content 共用）
 */

(function (global) {
  global.GEEK_BACKUP_CONFIG = global.GEEK_BACKUP_CONFIG || {
    // 卸载后自动打开的恢复页（需部署到 GitHub Pages 等静态托管，改动后同步更新此地址）
    restorePageUrl: 'https://nymlc.github.io/ChromeExt/restore/index.html',
    // 备份包含的存储键（与导出/导入的凭证模块口径一致）
    backupKeys: ['credentialProjects', 'titleProjectBindings', 'urlProjectBindings'],
    // 恢复页在其来源 localStorage 中存放全量备份的键
    localStorageKey: 'geekToolboxRescueBackup',
    // chrome.runtime.setUninstallURL 的 URL 长度上限（Chrome 限制 1023）
    uninstallUrlLimit: 1023,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
