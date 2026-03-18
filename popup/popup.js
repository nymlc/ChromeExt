/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-01-26 15:28:40
 * @LastEditors: 林晨 linchen@yixin.im
 * @LastEditTime: 2026-03-05 14:58:18
 * @FilePath: /ChromeExt/popup/popup.js
 * @Description: Popup 主入口 - 管理所有功能模块
 */

// Popup 管理器
class PopupManager {
  constructor() {
    this.currentHostname = '';
    this.globalEnabled = true;
    this.modules = {
      passwordToggle: null,
      // 未来可以添加更多模块
      // autoFill: null,
      // formValidator: null,
    };
  }
  
  async init() {
    // 获取当前网站
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      try {
        const url = new URL(tab.url);
        this.currentHostname = url.hostname;
      } catch (e) {
        this.currentHostname = '';
      }
    }
    
    // 读取全局设置
    const result = await chrome.storage.local.get(['globalDisabledSites']);
    const disabledSites = result.globalDisabledSites || [];
    this.globalEnabled = !disabledSites.includes(this.currentHostname);
    
    // 绑定全局开关
    this.bindGlobalEvents();
    this.updateGlobalUI();
    
    // 初始化密码模块
    this.modules.passwordToggle = new PasswordToggle();
    await this.modules.passwordToggle.init();
    
    // 未来可以在这里初始化其他模块
    // this.modules.autoFill = new AutoFill();
    // await this.modules.autoFill.init();
  }
  
  bindGlobalEvents() {
    const globalToggle = document.getElementById('globalToggle');
    globalToggle.addEventListener('click', () => this.toggleGlobal());
  }
  
  async toggleGlobal() {
    if (!this.currentHostname) {
      Toast.error('无法获取当前网站信息');
      return;
    }
    
    this.globalEnabled = !this.globalEnabled;
    
    const result = await chrome.storage.local.get(['globalDisabledSites']);
    let disabledSites = result.globalDisabledSites || [];
    
    if (this.globalEnabled) {
      // 启用：从禁用列表中移除
      disabledSites = disabledSites.filter(site => site !== this.currentHostname);
      Toast.success('扩展已在本网站启用', 2000);
    } else {
      // 禁用：添加到禁用列表
      if (!disabledSites.includes(this.currentHostname)) {
        disabledSites.push(this.currentHostname);
      }
      Toast.success('扩展已在本网站禁用所有功能', 2000);
    }
    
    await chrome.storage.local.set({ globalDisabledSites: disabledSites });
    this.updateGlobalUI();
  }
  
  updateGlobalUI() {
    const globalToggle = document.getElementById('globalToggle');
    const globalToggleText = document.getElementById('globalToggleText');
    
    if (this.globalEnabled) {
      globalToggleText.textContent = '已启用';
      globalToggle.className = 'btn btn-small btn-primary';
    } else {
      globalToggleText.textContent = '已禁用';
      globalToggle.className = 'btn btn-small btn-danger';
    }
  }
}

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
  const manager = new PopupManager();
  await manager.init();
});
