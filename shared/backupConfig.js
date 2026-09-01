/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-08-31
 * @FilePath: /ChromeExt/shared/backupConfig.js
 * @Description: 卸载数据抢救配置（background 与 content 共用）
 */

(function (global) {
  // 备份键位取自 shared/dataKeys.js（导出/导入同一份口径），
  // 该文件未加载时退回内置清单，保证顺序依赖出错时仍有完整覆盖。
  var allKeys = (global.GEEK_ALL_DATA_KEYS && global.GEEK_ALL_DATA_KEYS.length)
    ? global.GEEK_ALL_DATA_KEYS.slice()
    : [
      'credentialProjects', 'titleProjectBindings', 'urlProjectBindings',
      'credentialViewMode', 'suppressNativeAutofill',
      'credentialModuleEnabled', 'disabledCredentialSites',
      'passwordModuleEnabled', 'disabledPasswordSites',
      'mastergoNavNodes', 'mastergoNavGroups', 'mastergoNavPoolCapacity',
      'mastergoNavCollapsed', 'mastergoNavSide', 'mastergoNavTheme',
      'masterGoNavModuleEnabled', 'disabledMasterGoNavSites',
      'timestampFormatterModuleEnabled', 'disabledTimestampFormatterSites',
      'timestampFormatterShowUTC', 'timestampFormatterShowRelative',
      'imagePreviewModuleEnabled', 'disabledImagePreviewSites', 'imagePreviewMaxSize',
      'qrCodeToolModuleEnabled', 'disabledQrCodeToolSites',
      'globalDisabledSites', 'moduleOrder', 'hiddenModules',
    ];

  global.GEEK_BACKUP_CONFIG = global.GEEK_BACKUP_CONFIG || {
    // 卸载后自动打开的恢复页（需部署到 GitHub Pages 等静态托管，改动后同步更新此地址）
    restorePageUrl: 'https://nymlc.github.io/ChromeExt/restore/index.html',
    // 备份包含的存储键：全部模块的设置 + 凭证数据（与导出/导入口径一致）
    // 卸载链接容量不足时只有凭证数据会被裁剪，设置项始终保留
    backupKeys: allKeys,
    // 体量最大、唯一参与容量裁剪的键
    trimmableKeys: ['credentialProjects', 'titleProjectBindings', 'urlProjectBindings'],
    // 恢复页在其来源 localStorage 中存放全量备份的键
    localStorageKey: 'geekToolboxRescueBackup',
    // chrome.runtime.setUninstallURL 的 URL 长度上限（Chrome 限制 1023）
    uninstallUrlLimit: 1023,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
