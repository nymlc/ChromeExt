/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-01-26 15:28:40
 * @LastEditors: 林晨 linchen@yixin.im
 * @LastEditTime: 2026-08-06
 * @FilePath: /ChromeExt/content/content.js
 * @Description: Content Script 主入口 - 管理所有功能模块
 */

// 功能模块管理器
class ContentManager {
  constructor() {
    this.modules = {
      passwordHelper: null,
      credentialFiller: null,
      timestampFormatter: null,
      qrCodeTool: null,
    };
    this._subscribed = false;
    this._unsub = null;
    this.init();
  }

  async init() {
    // 集中初始化存储缓存（全页面仅注册一次 onChanged 监听）
    await StorageState.init();

    // 检查全局是否禁用
    const hostname = window.location.hostname;
    const globalDisabledSites = StorageState.get('globalDisabledSites', []) || [];

    if (globalDisabledSites.includes(hostname)) {
      console.log('扩展已在此网站全局禁用');
      return;
    }

    // 确保只订阅一次存储变更
    this._subscribeOnce();

    // 初始化各个功能模块（模块内部会检查是否被禁用）
    await this.initPasswordModule();
    await this.initCredentialModule();
    await this.initTimestampModule();
    await this.initQrCodeModule();
  }

  _subscribeOnce() {
    if (this._subscribed) return;
    this._subscribed = true;
    this._unsub = StorageState.subscribe((changes) => this.onStorageChange(changes));
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

  async initTimestampModule() {
    if (this.modules.timestampFormatter) {
      this.modules.timestampFormatter.destroy();
    }
    this.modules.timestampFormatter = new TimestampFormatter();
    await this.modules.timestampFormatter.init();
  }

  async initQrCodeModule() {
    if (this.modules.qrCodeTool) {
      this.modules.qrCodeTool.destroy();
    }
    this.modules.qrCodeTool = new QrCodeTool();
    await this.modules.qrCodeTool.init();
  }

  onStorageChange(changes) {
    const hostname = window.location.hostname;

    // 监听全局启用状态变化
    if (changes.globalDisabledSites) {
      const disabledSites = changes.globalDisabledSites.newValue || [];
      const wasDisabled = changes.globalDisabledSites.oldValue?.includes(hostname);
      const isDisabled = disabledSites.includes(hostname);

      if (wasDisabled && !isDisabled) {
        // 从禁用变为启用，重新初始化所有模块
        console.log('全局启用，重新初始化模块');
        this.destroy();
        this.init();
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
        this.initPasswordModule();
      } else {
        console.log('密码模块全局禁用，清理模块');
        if (this.modules.passwordHelper) {
          this.modules.passwordHelper.destroy();
          this.modules.passwordHelper = null;
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
        this.initPasswordModule();
      } else if (!wasDisabled && isDisabled) {
        // 从启用变为禁用
        console.log('密码模块在本网站禁用，清理模块');
        if (this.modules.passwordHelper) {
          this.modules.passwordHelper.destroy();
          this.modules.passwordHelper = null;
        }
      }
    }

    // 监听凭证模块启用状态变化
    if (changes.credentialModuleEnabled) {
      const enabled = changes.credentialModuleEnabled.newValue;
      if (enabled) {
        this.initCredentialModule();
      } else {
        if (this.modules.credentialFiller) {
          this.modules.credentialFiller.destroy();
          this.modules.credentialFiller = null;
        }
      }
    }

    // 监听凭证模块网站禁用列表变化
    if (changes.disabledCredentialSites) {
      const disabledSites = changes.disabledCredentialSites.newValue || [];
      const wasDisabled = changes.disabledCredentialSites.oldValue?.includes(hostname);
      const isDisabled = disabledSites.includes(hostname);

      if (wasDisabled && !isDisabled) {
        console.log('凭证模块在本网站启用，重新初始化');
        this.initCredentialModule();
      } else if (!wasDisabled && isDisabled) {
        console.log('凭证模块在本网站禁用，清理模块');
        if (this.modules.credentialFiller) {
          this.modules.credentialFiller.destroy();
          this.modules.credentialFiller = null;
        }
      }
    }

    // 监听凭证数据/域名绑定变化，通知 content 重新匹配项目
    if (changes.credentialProjects || changes.urlProjectBindings) {
      if (this.modules.credentialFiller) {
        this.modules.credentialFiller.matchProject();
      }
    }

    // 监听时间戳模块全局启用状态变化
    if (changes.timestampFormatterModuleEnabled) {
      const enabled = changes.timestampFormatterModuleEnabled.newValue;
      if (enabled) {
        this.initTimestampModule();
      } else if (this.modules.timestampFormatter) {
        this.modules.timestampFormatter.destroy();
        this.modules.timestampFormatter = null;
      }
    }

    // 监听时间戳模块网站禁用列表变化
    if (changes.disabledTimestampFormatterSites) {
      const disabledSites = changes.disabledTimestampFormatterSites.newValue || [];
      const wasDisabled = changes.disabledTimestampFormatterSites.oldValue?.includes(hostname);
      const isDisabled = disabledSites.includes(hostname);
      if (wasDisabled && !isDisabled) {
        this.initTimestampModule();
      } else if (!wasDisabled && isDisabled) {
        if (this.modules.timestampFormatter) {
          this.modules.timestampFormatter.destroy();
          this.modules.timestampFormatter = null;
        }
      }
    }

    // 监听二维码模块全局启用状态变化
    if (changes.qrCodeToolModuleEnabled) {
      const enabled = changes.qrCodeToolModuleEnabled.newValue;
      if (enabled) {
        this.initQrCodeModule();
      } else if (this.modules.qrCodeTool) {
        this.modules.qrCodeTool.destroy();
        this.modules.qrCodeTool = null;
      }
    }

    // 监听二维码模块网站禁用列表变化
    if (changes.disabledQrCodeToolSites) {
      const disabledSites = changes.disabledQrCodeToolSites.newValue || [];
      const wasDisabled = changes.disabledQrCodeToolSites.oldValue?.includes(hostname);
      const isDisabled = disabledSites.includes(hostname);
      if (wasDisabled && !isDisabled) {
        this.initQrCodeModule();
      } else if (!wasDisabled && isDisabled) {
        if (this.modules.qrCodeTool) {
          this.modules.qrCodeTool.destroy();
          this.modules.qrCodeTool = null;
        }
      }
    }
  }

  destroy() {
    // 清理所有模块
    Object.values(this.modules).forEach(module => {
      if (module && typeof module.destroy === 'function') {
        module.destroy();
      }
    });
    this.modules.passwordHelper = null;
    this.modules.credentialFiller = null;
    this.modules.timestampFormatter = null;
    // 保留存储订阅：全局重新启用时仍需监听；重复 init 由 _subscribeOnce 去重
  }
}

// 初始化内容管理器
new ContentManager();
