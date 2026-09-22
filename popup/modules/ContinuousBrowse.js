class ContinuousBrowse extends BaseModule {
  constructor() {
    super('continuousBrowse');
    this.moduleEnabled = false;
    this.siteEnabled = false;
    this.status = null;
    this.tabId = null;
    this.pageAvailable = false;
    this.isOpen = false;
    this.opening = false;
    this.pendingCommand = null;
    this.saving = false;
    this.needsDetection = true;
    this.connectionMessage = '';
    this.timer = null;
    this.generation = 0;
    this.statusRevision = 0;
  }

  async init(tab) {
    this.setTab(tab);
    await this.loadSettings();
    this.bindEvents();
    this.updateUI();
  }

  setTab(tab) {
    this.tabId = tab?.id;
    this.currentHostname = '';
    this.pageAvailable = false;
    try {
      const url = new URL(tab?.url);
      this.currentHostname = url.hostname;
      this.pageAvailable = Number.isInteger(this.tabId) && /^https?:$/.test(url.protocol);
    } catch (e) {
      // 浏览器内部页、无 URL 的标签页不视为已适配。
    }
  }

  async loadSettings() {
    const generation = this.generation;
    const statusRevision = this.statusRevision;
    const result = await chrome.storage.local.get([
      'continuousBrowseModuleEnabled', 'enabledContinuousBrowseSites', 'globalDisabledSites',
    ]);
    if (generation !== this.generation) return;
    // 读取期间若有设置变更，重新读取，避免旧快照覆盖 storageListener。
    if (statusRevision !== this.statusRevision) return this.loadSettings();
    this.moduleEnabled = result.continuousBrowseModuleEnabled === true;
    this.siteEnabled = (result.enabledContinuousBrowseSites || []).includes(this.currentHostname);
    this.isGloballyDisabled = (result.globalDisabledSites || []).includes(this.currentHostname);
  }

  bindEvents() {
    if (this.eventsBound) return;
    this.eventsBound = true;
    document.getElementById('continuousBrowseModuleEnabled')
      .addEventListener('change', (event) => this.saveToggle('module', event.target.checked));
    document.getElementById('continuousBrowseSiteEnabled')
      .addEventListener('change', (event) => this.saveToggle('site', event.target.checked));
    document.getElementById('continuousBrowseStart').addEventListener('click', () => this.sendCommand('start'));
    document.getElementById('continuousBrowsePause').addEventListener('click', () => {
      this.sendCommand(this.status?.state === 'paused' ? 'resume' : 'pause');
    });
    document.getElementById('continuousBrowseRetry').addEventListener('click', () => this.sendCommand('retry'));
    document.getElementById('continuousBrowseStop').addEventListener('click', () => this.sendCommand('stop'));
    document.getElementById('continuousBrowseDetect').addEventListener('click', () => {
      if (this.canCommand('status')) this.sendCommand('status');
    });

    this.storageListener = (changes, area) => {
      if (area !== 'local') return;
      const moduleChange = changes.continuousBrowseModuleEnabled;
      const siteChange = changes.enabledContinuousBrowseSites;
      const globalChange = changes.globalDisabledSites;
      if (!moduleChange && !siteChange && !globalChange) return;
      if (moduleChange) this.moduleEnabled = moduleChange.newValue === true;
      if (siteChange) this.siteEnabled = (siteChange.newValue || []).includes(this.currentHostname);
      if (globalChange) this.isGloballyDisabled = (globalChange.newValue || []).includes(this.currentHostname);
      // 丢弃旧会话及在途响应；自动启动完全由 content 根据设置控制。
      this.resetStatus();
      this.updateUI();
      if (this.isOpen && !this.saving && this.isEnabled()) this.sendCommand('status');
    };
    chrome.storage.onChanged.addListener(this.storageListener);
    window.addEventListener('pagehide', () => {
      this.onClose();
      chrome.storage.onChanged.removeListener(this.storageListener);
    }, { once: true });
  }

  async saveToggle(scope, enabled) {
    if (this.saving) return;
    const previous = scope === 'module' ? this.moduleEnabled : this.siteEnabled;
    this.saving = true;
    this.resetStatus();
    this.updateUI();
    try {
      if (scope === 'module') await this.toggleModuleEnabled(enabled);
      else await this.toggleSiteEnabled(enabled);
    } catch (e) {
      if (scope === 'module') this.moduleEnabled = previous;
      else this.siteEnabled = previous;
      Toast.error('连续浏览设置保存失败，请重试');
    } finally {
      this.saving = false;
      this.updateUI();
      if (this.isOpen && this.isEnabled()) this.sendCommand('status');
    }
  }

  async toggleSiteEnabled(enabled) {
    if (!this.pageAvailable || !this.currentHostname) return;
    const key = 'enabledContinuousBrowseSites';
    const result = await chrome.storage.local.get([key]);
    const sites = (result[key] || []).filter(site => site !== this.currentHostname);
    if (enabled) sites.push(this.currentHostname);
    await chrome.storage.local.set({ [key]: sites });
    this.siteEnabled = enabled;
    Toast.success(enabled ? '连续浏览已在本网站启用' : '连续浏览已在本网站关闭');
  }

  getModuleName() {
    return '连续浏览';
  }

  isEnabled() {
    return this.moduleEnabled && this.siteEnabled && !this.isGloballyDisabled;
  }

  resetStatus() {
    this.statusRevision++;
    this.clearPoll();
    this.status = null;
    this.needsDetection = true;
    this.connectionMessage = '';
  }

  async onOpen() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.opening = true;
    const generation = ++this.generation;
    this.resetStatus();
    this.updateUI();
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!this.isOpen || generation !== this.generation) return;
      this.setTab(tab);
      await this.loadSettings();
    } catch (e) {
      if (generation === this.generation) this.connectionMessage = '无法读取当前页面或设置，请重新打开弹窗后重试。';
    } finally {
      if (this.isOpen && generation === this.generation) {
        this.opening = false;
        this.updateUI();
        if (!this.connectionMessage) this.sendCommand('status');
      }
    }
  }

  onClose() {
    this.isOpen = false;
    this.opening = false;
    this.generation++;
    this.clearPoll();
    // 不停止网页会话，也不释放仍在等待响应的命令锁。
  }

  clearPoll() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  schedulePoll() {
    this.clearPoll();
    if (!this.isOpen || this.opening || !this.pageAvailable || this.connectionMessage || !this.isEnabled()) return;
    this.timer = setTimeout(() => this.sendCommand('status'), 3000);
  }

  canCommand(command) {
    if (!this.isOpen || this.opening || this.pendingCommand || this.saving || !this.pageAvailable) return false;
    if (!this.isEnabled()) return false;
    const status = this.status;
    // 完成后仍可查询新会话，或关闭本站并恢复原分页。
    if (command === 'status') return true;
    if (command === 'stop') return !!status?.active;
    if (status?.state === 'done') return false;
    if (this.connectionMessage || this.needsDetection || !status?.adapter || status.state === 'unsupported') return false;
    if (command === 'start') return status.state === 'idle' && !status.active;
    if (command === 'pause') return status.active && ['running', 'loading'].includes(status.state);
    if (command === 'resume') return status.active && status.state === 'paused';
    if (command === 'retry') return status.state === 'error';
    return false;
  }

  async sendCommand(command) {
    if (!this.isEnabled()) {
      this.clearPoll();
      return;
    }
    if (!this.canCommand(command)) return;

    const generation = this.generation;
    const statusRevision = this.statusRevision;
    this.clearPoll();
    this.pendingCommand = command;
    this.updateUI();
    try {
      const response = await chrome.tabs.sendMessage(this.tabId, {
        action: 'continuousBrowse', command,
      }, { frameId: 0 });
      if (!this.isOpen || generation !== this.generation || statusRevision !== this.statusRevision || !this.isEnabled()) return;
      const states = ['idle', 'unsupported', 'running', 'loading', 'paused', 'error', 'done'];
      if (!response || !states.includes(response.state) || typeof response.active !== 'boolean'
        || typeof response.adapter !== 'string' || typeof response.message !== 'string'
        || !Number.isFinite(response.loaded) || response.loaded < 0
        || !Number.isFinite(response.pages) || response.pages < 0
        || (response.total !== null && (!Number.isFinite(response.total) || response.total < 0))) {
        throw new Error('Invalid continuous browse status');
      }
      this.status = response;
      this.needsDetection = false;
      this.connectionMessage = '';
    } catch (e) {
      if (this.isOpen && generation === this.generation && statusRevision === this.statusRevision && this.isEnabled()) {
        // 未注入、受限页面或无效响应都不等于规则适配成功。
        this.needsDetection = true;
        this.connectionMessage = '无法连接连续浏览脚本。请刷新页面后重新检测；当前页面也可能受浏览器限制而不支持。';
      }
    } finally {
      this.pendingCommand = null;
      if (this.isOpen) {
        this.updateUI();
        // 开关变化期间保留命令锁，旧请求结束后再获取新会话状态。
        if (generation !== this.generation || statusRevision !== this.statusRevision) this.sendCommand('status');
        else this.schedulePoll();
      }
    }
  }

  updateUI() {
    const get = (name) => document.getElementById(`continuousBrowse${name}`);
    const setText = (name, text) => {
      const el = get(name);
      if (el.textContent !== text) el.textContent = text;
    };
    get('ModuleEnabled').checked = this.moduleEnabled;
    get('ModuleEnabled').disabled = this.saving;
    get('SiteEnabled').checked = this.siteEnabled;
    get('SiteEnabled').disabled = this.saving || !this.pageAvailable || !this.currentHostname
      || !this.moduleEnabled || this.isGloballyDisabled;
    get('Details').classList.toggle('disabled', !this.isEnabled());

    const status = this.isEnabled() ? this.status : null;
    const labels = {
      idle: '已适配，等待自动开启', unsupported: '当前页面暂未适配',
      running: '连续浏览中', loading: '正在加载下一页', paused: '已暂停',
      error: '加载失败', done: '已完成，可关闭本站并恢复原分页',
    };
    let label = status ? labels[status.state] : '尚未检测';
    let message = status?.message || '';
    if (status?.state === 'idle') {
      if (!status.adapter) label = '未检测到可用规则';
      else message = '支持的页面会自动开启，也可点击“立即开始”。';
    }
    if (this.opening || (this.pendingCommand === 'status' && !status)) label = '正在检测…';
    if (this.pendingCommand && this.pendingCommand !== 'status') message = '正在处理操作，请稍候…';
    if (this.connectionMessage) {
      label = '无法获取页面状态';
      message = this.connectionMessage;
    }
    if (!this.pageAvailable && !this.opening) {
      label = '当前页面不支持';
      message = '请在普通 HTTP(S) 网页中使用；浏览器内部页面不支持连续浏览。';
    }
    if (!this.isEnabled()) {
      label = '连续浏览已禁用';
      message = this.isGloballyDisabled ? '扩展已在本网站全局禁用，请先启用扩展。'
        : !this.moduleEnabled ? '请先在模块列表启用连续浏览，再手动开启当前网站；其他网站仍默认关闭。'
          : '本站未启用连续浏览。所有网站默认关闭，打开“当前网站启用”后才会运行，并记住该域名。';
    }
    setText('State', label);
    setText('Adapter', this.connectionMessage ? '—' : status?.adapter || '—');
    setText('Loaded', status ? `${status.loaded} 条 / ${status.total === null ? '总数未知' : `共 ${status.total} 条`}` : '—');
    setText('Pages', status ? `${status.pages} 页` : '—');
    setText('Message', message);
    get('Message').hidden = !message;
    get('Start').disabled = !this.canCommand('start');
    const pauseCommand = status?.state === 'paused' ? 'resume' : 'pause';
    setText('Pause', pauseCommand === 'resume' ? '继续' : '暂停');
    get('Pause').disabled = !this.canCommand(pauseCommand);
    get('Retry').disabled = !this.canCommand('retry');
    get('Stop').disabled = !this.canCommand('stop');
    get('Detect').disabled = !this.canCommand('status');
    get('Controls').setAttribute('aria-busy', String(!!this.pendingCommand));
  }
}
