/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-01-26 15:28:40
 * @LastEditors: 林晨 linchen@yixin.im
 * @LastEditTime: 2026-03-05 14:34:30
 * @FilePath: /ChromeExt/content/content.js
 * @Description: Content Script 主入口 - 管理所有功能模块
 */

// 功能模块管理器
class ContentManager {
  constructor() {
    this.modules = {
      passwordHelper: null,
      credentialFiller: null,
    };
    this.init();
    this.setupStorageListener();
  }

  async init() {
    // 检查全局是否禁用
    const hostname = window.location.hostname;
    const globalResult = await chrome.storage.local.get(['globalDisabledSites']);
    const globalDisabledSites = globalResult.globalDisabledSites || [];

    if (globalDisabledSites.includes(hostname)) {
      console.log('扩展已在此网站全局禁用');
      return;
    }

    // 初始化各个功能模块（模块内部会检查是否被禁用）
    await this.initPasswordModule();
    await this.initCredentialModule();
  }

  async initPasswordModule() {
    if (this.modules.passwordHelper) {
      this.modules.passwordHelper.destroy();
    }
    this.modules.passwordHelper = new PasswordHelper();
    await this.modules.passwordHelper.init();
  }

  async initCredentialModule() {
    if (this.modules.credentialFiller) {
      this.modules.credentialFiller.destroy();
    }
    this.modules.credentialFiller = new CredentialFiller();
    await this.modules.credentialFiller.init();
  }

  setupStorageListener() {
    // 监听存储变化，动态启用/禁用模块
    chrome.storage.onChanged.addListener(async (changes) => {
      const hostname = window.location.hostname;

      // 监听全局启用状态变化
      if (changes.globalDisabledSites) {
        const disabledSites = changes.globalDisabledSites.newValue || [];
        const wasDisabled = changes.globalDisabledSites.oldValue?.includes(hostname);
        const isDisabled = disabledSites.includes(hostname);

        if (wasDisabled && !isDisabled) {
          // 从禁用变为启用，重新初始化所有模块
          console.log('全局启用，重新初始化模块');
          await this.init();
        } else if (!wasDisabled && isDisabled) {
          // 从启用变为禁用，清理所有模块
          console.log('全局禁用，清理所有模块');
          this.destroy();
        }
      }

      // 监听密码模块启用状态变化
      if (changes.passwordModuleEnabled) {
        const enabled = changes.passwordModuleEnabled.newValue;
        if (enabled) {
          console.log('密码模块全局启用，重新初始化');
          await this.initPasswordModule();
        } else {
          console.log('密码模块全局禁用，清理模块');
          if (this.modules.passwordHelper) {
            this.modules.passwordHelper.destroy();
          }
        }
      }

      // 监听密码模块网站禁用列表变化
      if (changes.disabledPasswordSites) {
        const disabledSites = changes.disabledPasswordSites.newValue || [];
        const wasDisabled = changes.disabledPasswordSites.oldValue?.includes(hostname);
        const isDisabled = disabledSites.includes(hostname);

        if (wasDisabled && !isDisabled) {
          // 从禁用变为启用
          console.log('密码模块在本网站启用，重新初始化');
          await this.initPasswordModule();
        } else if (!wasDisabled && isDisabled) {
          // 从启用变为禁用
          console.log('密码模块在本网站禁用，清理模块');
          if (this.modules.passwordHelper) {
            this.modules.passwordHelper.destroy();
          }
        }
      }

      // 监听凭证模块启用状态变化
      if (changes.credentialModuleEnabled) {
        const enabled = changes.credentialModuleEnabled.newValue;
        if (enabled) {
          await this.initCredentialModule();
        } else {
          if (this.modules.credentialFiller) {
            this.modules.credentialFiller.destroy();
          }
        }
      }

      // 监听凭证数据变化，通知 content 重新匹配项目
      if (changes.credentialProjects) {
        if (this.modules.credentialFiller) {
          await this.modules.credentialFiller.matchProject();
        }
      }
    });
  }

  destroy() {
    // 清理所有模块
    Object.values(this.modules).forEach(module => {
      if (module && typeof module.destroy === 'function') {
        module.destroy();
      }
    });
  }
}

// 初始化内容管理器
new ContentManager();
