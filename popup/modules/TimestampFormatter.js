/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-08-06
 * @FilePath: /ChromeExt/popup/modules/TimestampFormatter.js
 * @Description: 时间戳格式化功能模块（popup 端开关）
 */

class TimestampFormatter extends BaseModule {
  constructor() {
    super('timestampFormatter'); // 模块名称需与 content 侧一致
  }

  async init() {
    await this.initModuleStatus();
    this.bindEvents();
    this.updateUI();
  }

  bindEvents() {
    document.getElementById('timestampFormatterModuleEnabled')
      ?.addEventListener('change', (e) => this.onModuleToggle(e.target.checked));
    document.getElementById('timestampFormatterSiteEnabled')
      ?.addEventListener('change', (e) => this.onSiteToggle(e.target.checked));
    document.getElementById('tsfShowUTC')
      ?.addEventListener('change', (e) => this._setPref('timestampFormatterShowUTC', e.target.checked));
    document.getElementById('tsfShowRelative')
      ?.addEventListener('change', (e) => this._setPref('timestampFormatterShowRelative', e.target.checked));
  }

  async _setPref(key, val) {
    await chrome.storage.local.set({ [key]: val });
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
    return '时间戳格式化';
  }

  updateUI() {
    const moduleSwitch = document.getElementById('timestampFormatterModuleEnabled');
    if (moduleSwitch) moduleSwitch.checked = this.moduleEnabled;

    const siteSwitch = document.getElementById('timestampFormatterSiteEnabled');
    if (siteSwitch) siteSwitch.checked = this.siteEnabled;

    chrome.storage.local.get(['timestampFormatterShowUTC', 'timestampFormatterShowRelative']).then((r) => {
      this._prefUTC = r.timestampFormatterShowUTC !== false;
      this._prefRelative = r.timestampFormatterShowRelative !== false;
      const utc = document.getElementById('tsfShowUTC');
      if (utc) utc.checked = this._prefUTC;
      const rel = document.getElementById('tsfShowRelative');
      if (rel) rel.checked = this._prefRelative;
    });

    const moduleContent = document.getElementById('timestampFormatterModuleContent');
    if (moduleContent) moduleContent.classList.toggle('disabled', !this.moduleEnabled);
  }
}
