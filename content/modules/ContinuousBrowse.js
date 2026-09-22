class ContinuousBrowse extends BaseContentModule {
  constructor() {
    super('continuousBrowse');
    this.state = 'idle';
    this.adapter = null;
    this.message = '';
    this.pages = 0;
    this._session = 0;
    this._destroyed = false;
    this._onMessage = this._onMessage.bind(this);
    this._checkContext = this._checkContext.bind(this);
  }

  get defaultEnabled() { return false; }

  async init() {
    if (window !== window.top || this._destroyed) return;
    chrome.runtime.onMessage.addListener(this._onMessage);
    if (!await this.checkModuleEnabled() || this._destroyed) return;
    this._pageUrl = location.href;
    this._pageObserver = new MutationObserver(() => this._scheduleAutoStart());
    this._pageObserver.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'],
    });
    this._contextTimer = setInterval(this._checkContext, 500);
    for (const type of ['popstate', 'hashchange', 'pagehide', 'pageshow']) {
      window.addEventListener(type, this._checkContext);
    }
    this.start();
  }

  _scheduleAutoStart() {
    if (this._destroyed || !this.isEnabled || this._pageHidden || this.adapter || this._autoStartTimer || this._autoStartBlocked) return;
    this._autoStartTimer = setTimeout(() => {
      this._autoStartTimer = null;
      if (!this._destroyed && this.isEnabled && !this._pageHidden) this.start();
    }, 300);
  }

  detect() {
    return ContinuousBrowseYApiAdapter.detect() || ContinuousBrowseTableAdapter.detect() || ContinuousBrowseHtmlAdapter.detect();
  }

  _onMessage(request, _sender, sendResponse) {
    if (request?.action !== 'continuousBrowse') return;
    if (!['status', 'start', 'pause', 'resume', 'retry', 'stop'].includes(request.command)) return;
    this.command(request.command).then(sendResponse).catch(() => sendResponse({
      ...this.status(), message: '连续浏览操作失败，请恢复原分页后重试',
    }));
    return true;
  }

  async command(command) {
    this._checkContext();
    if (command === 'start') {
      if (await this.checkModuleEnabled() && !this._destroyed) this.start();
    } else if (command === 'stop') {
      this.isEnabled = false;
      this.stop('已在本站关闭连续浏览，下次访问仍保持关闭');
      const key = 'disabledContinuousBrowseSites';
      const data = await chrome.storage.local.get([key]);
      const disabledSites = data[key] || [];
      if (!disabledSites.includes(location.hostname)) {
        await chrome.storage.local.set({ [key]: [...disabledSites, location.hostname] });
      }
    } else if (command === 'pause' && this.adapter && ['running', 'loading'].includes(this.state)) {
      this.state = 'paused';
      this.message = '已暂停，当前请求完成后不再自动加载';
      this._observer?.disconnect();
    } else if (command === 'retry' && this._autoStartBlocked) {
      this._autoStartBlocked = false;
      this.stop();
      this.start();
    } else if (['resume', 'retry'].includes(command) && this.adapter && ['paused', 'error'].includes(this.state)) {
      this.state = 'running';
      this.message = '';
      this._autoPages = 0;
      if (!this._request) this._observe();
    }
    this._render();
    return this.status();
  }

  status() {
    const detected = this.adapter || this.detect();
    return {
      state: this.adapter ? this.state : (detected ? 'idle' : 'unsupported'),
      active: !!this.adapter,
      adapter: detected?.name || '',
      loaded: this.adapter?.loaded || 0,
      total: this.adapter?.total ?? null,
      pages: this.pages,
      message: this.message || (!detected ? '当前页面暂未适配' : this.adapter ? '' : '已识别分页，将自动开启连续浏览'),
    };
  }

  start() {
    if (this.adapter || !this.isEnabled || this._destroyed || this._pageHidden || this._autoStartBlocked) return;
    const adapter = this.detect();
    if (!adapter || (adapter.start && !adapter.start())) {
      this.message = '当前页面暂未适配';
      return;
    }
    this.adapter = adapter;
    this.state = adapter.nextUrl ? 'running' : 'done';
    this.message = '';
    this.pages = 1;
    this._autoPages = 0;
    this._pageUrl = location.href;
    this._session++;
    this._mount();
    if (!adapter.interactive) {
      this._mutationObserver = new MutationObserver(() => {
        this.stop('原页面内容已变化，正在重新检测');
        this._scheduleAutoStart();
      });
      this._mutationObserver.observe(adapter.element, { childList: true, subtree: true, characterData: true });
    }
    this._observe();
    this._render();
  }

  _mount() {
    const host = document.createElement('div');
    host.dataset.geekContinuousBrowse = 'true';
    const anchor = this.adapter.element.closest('table') || this.adapter.element;
    if (this.adapter.mountTarget) this.adapter.mountTarget.appendChild(host);
    else anchor.after(host);
    this._host = host;
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { display: block; color: #24292f; font: 14px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      section { margin: 16px 0; padding: 16px; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; overflow-x: auto; }
      h2 { margin: 0 0 12px; font-size: 13px; font-weight: 500; color: #6b7280; }
      p { margin: 8px 0; } img { max-width: 100%; height: auto; }
      a { color: #1677ff; text-decoration: none; } a:hover { text-decoration: underline; }
      table { width: 100%; border-collapse: collapse; font-size: 13px; }
      th, td { padding: 12px 10px; border-bottom: 1px solid #eee; text-align: left; overflow-wrap: anywhere; min-width: 70px; }
      th { background: #fafafa; white-space: nowrap; } td:first-child { min-width: 140px; }
      li { margin: 8px 0; } pre { white-space: pre-wrap; overflow-wrap: anywhere; }
      .controls { position: fixed; bottom: 16px; right: 16px; z-index: 2147483646; width: 300px; max-width: calc(100vw - 32px); padding: 12px; border: 1px solid #dbe3ee; border-radius: 12px; background: #fff; box-shadow: 0 4px 20px #0002; font-size: 12px; }
      .title { font-weight: 600; font-size: 13px; } .status { margin: 4px 0 8px; overflow-wrap: anywhere; }
      .buttons { display: flex; gap: 8px; } button { font: inherit; cursor: pointer; border: 1px solid #dbe3ee; border-radius: 6px; background: #f6f8fa; padding: 5px 10px; color: #0969da; }
      button:disabled { opacity: .5; cursor: default; } button:focus-visible { outline: 2px solid #1677ff; }
      .sentinel { height: 1px; } .note { color: #777; font-size: 12px; margin-bottom: 8px; }
    `;
    root.appendChild(style);
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = this.adapter.interactive
      ? '连续浏览 · 保留原表格交互；点击行内业务操作时自动恢复该行所在分页，筛选或刷新后重新检测。'
      : '连续浏览 · 追加内容为只读，编辑请恢复原分页；详情链接在新标签页打开。';
    root.appendChild(note);
    this._content = document.createElement('div');
    root.appendChild(this._content);
    const initial = this.adapter.initial();
    if (initial) this._append(initial, this.adapter.page);
    this._sentinel = document.createElement('div');
    this._sentinel.className = 'sentinel';
    root.appendChild(this._sentinel);
    const controls = document.createElement('div');
    controls.className = 'controls';
    controls.setAttribute('role', 'region');
    controls.setAttribute('aria-label', '连续浏览控制');
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = `连续浏览 · ${this.adapter.name}`;
    controls.appendChild(title);
    this._statusEl = document.createElement('div');
    this._statusEl.className = 'status';
    this._statusEl.setAttribute('role', 'status');
    controls.appendChild(this._statusEl);
    const buttons = document.createElement('div');
    buttons.className = 'buttons';
    this._toggleButton = document.createElement('button');
    this._toggleButton.type = 'button';
    this._toggleButton.addEventListener('click', () => this.command(
      this.state === 'error' ? 'retry' : this.state === 'paused' ? 'resume' : 'pause'));
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.textContent = '关闭本站并恢复分页';
    stop.addEventListener('click', () => this.command('stop'));
    buttons.append(this._toggleButton, stop);
    controls.appendChild(buttons);
    root.appendChild(controls);
    this._hidden = [];
    for (const element of [this.adapter.hideOriginal && this.adapter.element, this.adapter.pager]) {
      if (!element || element.tagName === 'LINK') continue;
      this._hidden.push([element, element.style.getPropertyValue('display'), element.style.getPropertyPriority('display')]);
      element.style.setProperty('display', 'none', 'important');
    }
  }

  _append(fragment, page) {
    const section = document.createElement('section');
    const heading = document.createElement('h2');
    heading.textContent = `第 ${page} 页`;
    section.append(heading, fragment);
    this._content.appendChild(section);
  }

  _scrollRoot() {
    for (let element = this._host.parentElement; element && element !== document.body && element !== document.documentElement; element = element.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight) return element;
    }
    return null;
  }

  _observe() {
    this._observer?.disconnect();
    if (!this.adapter?.nextUrl || this.state !== 'running') return;
    this._observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) this._load();
    }, { root: this._scrollRoot(), rootMargin: '0px 0px 240px 0px' });
    this._observer.observe(this._sentinel);
  }

  async _load() {
    this._checkContext();
    if (this.state !== 'running' || this._request || !this.adapter?.nextUrl) return;
    const session = this._session;
    const adapter = this.adapter;
    const controller = new AbortController();
    this._request = controller;
    this._observer?.disconnect();
    this.state = 'loading';
    this._render();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const fragment = await adapter.load(controller.signal);
      this._checkContext();
      if (session !== this._session) return;
      if (fragment) this._append(fragment, adapter.page);
      if (fragment || adapter.interactive) this.pages++;
      this._autoPages++;
      if (!adapter.nextUrl) {
        this.state = 'done';
        this.message = '已到最后一页';
      } else if (this.state !== 'paused') {
        this.state = this._autoPages >= 20 ? 'paused' : 'running';
        this.message = this.state === 'paused' ? '已连续加载 20 页，点击继续可加载更多' : '';
      }
    } catch (error) {
      if (session !== this._session) return;
      this.state = 'error';
      if (adapter.interactive && (error.name === 'AbortError' || !adapter.isCurrent())) this._autoStartBlocked = true;
      this.message = error.name === 'AbortError' ? '加载超时，请重试' : error.message || '加载失败，请重试';
    } finally {
      clearTimeout(timer);
      if (session === this._session) {
        this._request = null;
        this._render();
        this._observe();
      }
    }
  }

  _render() {
    if (!this._statusEl || !this.adapter) return;
    const labels = { running: '滚动到底部加载下一页', loading: '正在加载下一页', paused: '已暂停', error: '加载失败', done: '已到最后一页' };
    const count = this.adapter.total === null ? `${this.adapter.loaded}` : `${this.adapter.loaded}/${this.adapter.total}`;
    this._statusEl.textContent = `已加载 ${count} 条 · ${this.pages} 页 · ${this.message || labels[this.state]}`;
    this._toggleButton.textContent = this.state === 'paused' ? '继续' : this.state === 'error' ? '重试' : '暂停';
    this._toggleButton.disabled = this.state === 'done';
  }

  _checkContext(event) {
    if (this._destroyed || !this._pageUrl) return;
    if (event?.type === 'pagehide') {
      this._pageHidden = true;
      this.stop();
      return;
    }
    if (event?.type === 'pageshow') {
      this._pageHidden = false;
      this._autoStartBlocked = false;
      this._scheduleAutoStart();
    }
    if (this._pageHidden) return;
    if (location.href !== this._pageUrl || (this.adapter
      && (!this.adapter.element.isConnected || !this._host?.isConnected
        || (!this._autoStartBlocked && this.adapter.isCurrent && !this.adapter.isCurrent())))) {
      this._autoStartBlocked = false;
      this._pageUrl = location.href;
      this.stop('页面已变化，正在重新检测');
      this._scheduleAutoStart();
    }
  }

  stop(message = '') {
    clearTimeout(this._autoStartTimer);
    this._autoStartTimer = null;
    this._session++;
    this._request?.abort();
    this._request = null;
    this._observer?.disconnect();
    this._mutationObserver?.disconnect();
    this.adapter?.destroy?.();
    this._host?.remove();
    for (const [element, display, priority] of this._hidden || []) {
      if (display) element.style.setProperty('display', display, priority);
      else element.style.removeProperty('display');
    }
    this._hidden = [];
    this._host = null;
    this._content = null;
    this._statusEl = null;
    this._toggleButton = null;
    this._sentinel = null;
    this.adapter = null;
    this.pages = 0;
    this.state = 'idle';
    this.message = message;
  }

  destroy() {
    this._destroyed = true;
    this.stop();
    this._pageObserver?.disconnect();
    clearInterval(this._contextTimer);
    for (const type of ['popstate', 'hashchange', 'pagehide', 'pageshow']) {
      window.removeEventListener(type, this._checkContext);
    }
    chrome.runtime.onMessage.removeListener(this._onMessage);
  }
}
