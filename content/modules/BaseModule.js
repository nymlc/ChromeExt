/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-03-05 15:10:00
 * @FilePath: /ChromeExt/content/modules/BaseModule.js
 * @Description: Content 功能模块基类 - 提供通用的启用检查功能
 */

class BaseContentModule {
  constructor(moduleName) {
    this.moduleName = moduleName; // 模块名称，如 'password', 'autoFill'
    this.isEnabled = true;
  }
  
  /**
   * 检查模块是否应该启用
   * @returns {Promise<boolean>} 是否启用
   */
  async checkModuleEnabled() {
    const hostname = window.location.hostname;

    // 等待缓存就绪（首屏由 ContentManager / MasterGoNav 的 init 触发）
    if (typeof StorageState !== 'undefined') {
      try { await StorageState.init(); } catch (e) { /* 忽略，降级为直读 */ }
    }

    // 1. 检查全局是否禁用
    const globalDisabledSites = (typeof StorageState !== 'undefined'
      ? StorageState.get('globalDisabledSites', [])
      : (await chrome.storage.local.get(['globalDisabledSites'])).globalDisabledSites) || [];

    if (globalDisabledSites.includes(hostname)) {
      console.log(`扩展已在 ${hostname} 全局禁用`);
      this.isEnabled = false;
      return false;
    }

    // 2. 检查模块是否全局启用
    const moduleKey = `${this.moduleName}ModuleEnabled`;
    const moduleEnabled = (typeof StorageState !== 'undefined'
      ? StorageState.get(moduleKey, true)
      : (await chrome.storage.local.get([moduleKey]))[moduleKey]) !== false;

    if (!moduleEnabled) {
      console.log(`${this.moduleName} 功能已全局禁用`);
      this.isEnabled = false;
      return false;
    }

    // 3. 检查当前网站是否禁用了该功能
    const siteKey = `disabled${this.capitalize(this.moduleName)}Sites`;
    const disabledSites = (typeof StorageState !== 'undefined'
      ? StorageState.get(siteKey, [])
      : (await chrome.storage.local.get([siteKey]))[siteKey]) || [];

    if (disabledSites.includes(hostname)) {
      console.log(`${this.moduleName} 功能已在 ${hostname} 禁用`);
      this.isEnabled = false;
      return false;
    }

    this.isEnabled = true;
    return true;
  }
  
  /**
   * 初始化方法（子类需要实现）
   */
  async init() {
    throw new Error('子类必须实现 init 方法');
  }
  
  /**
   * 销毁方法（子类可以覆盖）
   */
  destroy() {
    // 子类实现清理逻辑
  }
  
  /**
   * 工具方法：首字母大写
   */
  capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
}
