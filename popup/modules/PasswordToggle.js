/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-03-05 14:35:00
 * @FilePath: /ChromeExt/popup/modules/PasswordToggle.js
 * @Description: 密码显示功能模块
 */

class PasswordToggle extends BaseModule {
  constructor() {
    super('password'); // 传入模块名称
    this.isVisible = false;
  }
  
  async init() {
    // 初始化模块启用状态（继承自BaseModule）
    await this.initModuleStatus();
    
    // 密码显示状态不持久化，每次打开 popup 默认为 false
    // 实际显示状态由 content script 维护
    this.isVisible = false;
    
    this.bindEvents();
    this.updateUI();
  }
  
  bindEvents() {
    // 密码显示切换按钮
    document.getElementById('togglePassword')
      ?.addEventListener('click', () => this.togglePassword());
    
    // 模块启用开关
    document.getElementById('passwordModuleEnabled')
      ?.addEventListener('change', (e) => this.onModuleToggle(e.target.checked));
    
    // 网站启用开关
    document.getElementById('passwordSiteEnabled')
      ?.addEventListener('change', (e) => this.onSiteToggle(e.target.checked));
  }
  
  async togglePassword() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    // 检查是否是特殊页面
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:')) {
      Toast.error('此页面不支持密码查看功能');
      return;
    }
    
    this.isVisible = !this.isVisible;
    
    // 发送消息给content script，不持久化到存储
    try {
      await chrome.tabs.sendMessage(tab.id, {
        action: 'togglePassword',
        show: this.isVisible
      });
    } catch (error) {
      console.log('无法连接到页面，可能需要刷新页面');
    }
    
    this.updateUI();
  }
  
  async onModuleToggle(enabled) {
    await this.toggleModuleEnabled(enabled);
    this.updateUI();
  }
  
  async onSiteToggle(enabled) {
    await this.toggleSiteEnabled(enabled);
    this.updateUI();
  }
  
  getModuleName() {
    return '密码功能';
  }
  
  updateUI() {
    // 更新密码显示按钮
    const toggleText = document.getElementById('toggleText');
    if (toggleText) toggleText.textContent = this.isVisible ? '隐藏所有密码' : '显示所有密码';
    
    // 更新模块开关
    const moduleSwitch = document.getElementById('passwordModuleEnabled');
    if (moduleSwitch) moduleSwitch.checked = this.moduleEnabled;
    
    // 更新网站开关
    const siteSwitch = document.getElementById('passwordSiteEnabled');
    if (siteSwitch) siteSwitch.checked = this.siteEnabled;
    
    // 更新模块内容区域状态
    const moduleContent = document.getElementById('passwordModuleContent');
    if (moduleContent) moduleContent.classList.toggle('disabled', !this.moduleEnabled);
  }
}
