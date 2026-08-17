/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-08-17
 * @FilePath: /ChromeExt/popup/modules/ImagePreview.js
 * @Description: 图片地址预览功能模块（popup 端开关与配置）
 */

class ImagePreview extends BaseModule {
  constructor() {
    super('imagePreview');
    this.defaultMaxSize = 480;
  }

  async init() {
    await this.initModuleStatus();
    this.bindEvents();
    this.updateUI();
  }

  bindEvents() {
    document.getElementById('imagePreviewModuleEnabled')
      ?.addEventListener('change', (e) => this.onModuleToggle(e.target.checked));
    document.getElementById('imagePreviewSiteEnabled')
      ?.addEventListener('change', (e) => this.onSiteToggle(e.target.checked));

    const maxSize = document.getElementById('imagePreviewMaxSize');
    if (maxSize) {
      const save = async () => {
        const value = this._normalizeMaxSize(maxSize.value);
        maxSize.value = value;
        await chrome.storage.local.set({ imagePreviewMaxSize: value });
      };
      maxSize.addEventListener('change', save);
      maxSize.addEventListener('blur', save);
    }
  }

  _normalizeMaxSize(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return this.defaultMaxSize;
    return Math.max(160, Math.min(1600, Math.round(number)));
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
    return '图片预览';
  }

  updateUI() {
    const moduleSwitch = document.getElementById('imagePreviewModuleEnabled');
    if (moduleSwitch) moduleSwitch.checked = this.moduleEnabled;

    const siteSwitch = document.getElementById('imagePreviewSiteEnabled');
    if (siteSwitch) siteSwitch.checked = this.siteEnabled;

    chrome.storage.local.get(['imagePreviewMaxSize']).then((result) => {
      const maxSize = document.getElementById('imagePreviewMaxSize');
      if (maxSize) maxSize.value = this._normalizeMaxSize(result.imagePreviewMaxSize);
    });

    const moduleContent = document.getElementById('imagePreviewModuleContent');
    if (moduleContent) moduleContent.classList.toggle('disabled', !this.moduleEnabled);
  }
}
