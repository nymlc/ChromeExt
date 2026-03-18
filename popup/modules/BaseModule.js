/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-03-05 15:10:00
 * @FilePath: /ChromeExt/popup/modules/BaseModule.js
 * @Description: 功能模块基类 - 提供通用的启用/禁用功能
 */

class BaseModule {
  constructor(moduleName) {
    this.moduleName = moduleName; // 模块名称，如 'password', 'autoFill'
    this.moduleEnabled = true;
    this.siteEnabled = true;
    this.currentHostname = '';
  }
  
  /**
   * 获取当前网站域名
   */
  async getCurrentHostname() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      try {
        const url = new URL(tab.url);
        this.currentHostname = url.hostname;
      } catch (e) {
        this.currentHostname = '';
      }
    }
    return this.currentHostname;
  }
  
  /**
   * 初始化模块启用状态
   */
  async initModuleStatus() {
    await this.getCurrentHostname();
    
    // 读取模块全局启用状态
    const moduleKey = `${this.moduleName}ModuleEnabled`;
    const siteKey = `disabled${this.capitalize(this.moduleName)}Sites`;
    
    const result = await chrome.storage.local.get([moduleKey, siteKey, 'globalDisabledSites']);
    
    // 检查全局禁用
    const globalDisabledSites = result.globalDisabledSites || [];
    if (globalDisabledSites.includes(this.currentHostname)) {
      this.moduleEnabled = false;
      this.siteEnabled = false;
      return;
    }
    
    // 检查模块全局启用状态
    this.moduleEnabled = result[moduleKey] !== false; // 默认启用
    
    // 检查网站禁用列表
    const disabledSites = result[siteKey] || [];
    this.siteEnabled = !disabledSites.includes(this.currentHostname);
  }
  
  /**
   * 切换模块全局启用状态
   */
  async toggleModuleEnabled(enabled) {
    this.moduleEnabled = enabled;
    const moduleKey = `${this.moduleName}ModuleEnabled`;
    await chrome.storage.local.set({ [moduleKey]: enabled });
    
    if (enabled) {
      Toast.success(`${this.getModuleName()}已全局启用`, 2000);
    } else {
      Toast.success(`${this.getModuleName()}已在所有网站禁用`, 2000);
    }
  }
  
  /**
   * 切换当前网站启用状态
   */
  async toggleSiteEnabled(enabled) {
    if (!this.currentHostname) {
      Toast.error('无法获取当前网站信息');
      return;
    }
    
    this.siteEnabled = enabled;
    
    const siteKey = `disabled${this.capitalize(this.moduleName)}Sites`;
    const result = await chrome.storage.local.get([siteKey]);
    let disabledSites = result[siteKey] || [];
    
    if (enabled) {
      // 启用：从禁用列表中移除
      disabledSites = disabledSites.filter(site => site !== this.currentHostname);
      Toast.success(`${this.getModuleName()}已在本网站启用`, 2000);
    } else {
      // 禁用：添加到禁用列表
      if (!disabledSites.includes(this.currentHostname)) {
        disabledSites.push(this.currentHostname);
      }
      Toast.success(`${this.getModuleName()}已在本网站禁用`, 2000);
    }
    
    await chrome.storage.local.set({ [siteKey]: disabledSites });
  }
  
  /**
   * 更新模块UI状态（子类需要实现）
   */
  updateModuleUI() {
    // 子类实现具体的UI更新逻辑
  }
  
  /**
   * 获取模块显示名称（子类可以覆盖）
   */
  getModuleName() {
    return this.moduleName;
  }
  
  /**
   * 工具方法：首字母大写
   */
  capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
}
