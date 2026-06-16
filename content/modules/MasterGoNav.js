/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-06-15 00:00:00
 * @FilePath: /ChromeExt/content/modules/MasterGoNav.js
 * @Description: MasterGo 导航模块 - 接管页面，iframe 池 + 悬浮树状导航（支持左/右侧）
 */

class MasterGoNav extends BaseContentModule {
  constructor() {
    super('masterGoNav');
    this.nodes        = [];
    this.collapsed    = false;
    this.side         = 'left';   // 'left' | 'right'
    this.sidebarWidth = 220;      // 跟随对应侧宽度
    this.collapsedIds = new Set();
    this.panel        = null;
    this.pool         = null;
    this.baseUrl      = this._cleanUrl(window.location.href);
    this._urlPollTimer    = null;
    this._resizeObserver  = null;
    this.onStorageChange  = this.onStorageChange.bind(this);
  }

  _cleanUrl(href) {
    try {
      const url = new URL(href);
      const pageId = url.searchParams.get('page_id');
      const clean = new URL(url.origin + url.pathname);
      if (pageId) clean.searchParams.set('page_id', pageId);
      return clean.toString();
    } catch { return href; }
  }

  async init() {
    const enabled = await this.checkModuleEnabled();
    if (!enabled) return;
    const validPaths = ['/file/', '/prototyping/', '/design/'];
    if (!validPaths.some(p => location.pathname.startsWith(p))) return;
    await this.load();
    await this._waitForBody();
    this._takeover();
    this.render();
    this._syncSidebarWidth();
    chrome.storage.onChanged.addListener(this.onStorageChange);
  }

  _waitForBody() {
    return new Promise(resolve => {
      if (document.body) return resolve();
      const obs = new MutationObserver(() => {
        if (document.body) { obs.disconnect(); resolve(); }
      });
      obs.observe(document.documentElement, { childList: true });
    });
  }

  async load() {
    const result = await chrome.storage.local.get([
      'mastergoNavNodes', 'mastergoNavCollapsed', 'mastergoNavSide',
    ]);
    this.nodes     = result.mastergoNavNodes     || [];
    this.collapsed = result.mastergoNavCollapsed || false;
    this.side      = result.mastergoNavSide      || 'left';
  }

  // ─── 接管页面 ─────────────────────────────────────────────────────────────
  _takeover() {
    const style = document.createElement('style');
    style.id = 'mg-takeover-style';
    style.textContent = `
      body > *:not([id^="mg-"]),
      body > *:not([id^="mg-"]) * { visibility:hidden!important; pointer-events:none!important; }
      [id^="mg-"] { visibility:visible!important; pointer-events:auto!important; }
      body { margin:0; padding:0; overflow:hidden; background:#000; }
    `;
    document.head.appendChild(style);

    this.pool = new IframePool({
      capacity: 2,
      maxHits:  3,
      baseStyle:   'position:fixed;inset:0;width:100%;height:100%;border:none;',
      activeStyle: 'z-index:1;visibility:visible;pointer-events:auto;',
      onActivate: (iframe) => {
        iframe.addEventListener('load', () => {
          this._clearOriginalPage();
          this._updateActiveState(this.getCurrentUrl());
          this._watchIframeUrlChange(iframe);
          this._syncSidebarWidth();
        }, { once: true });
      },
      onEvict: (_iframe, url) => console.log('[IframePool] evicted:', url),
    });

    this.pool.show(this.baseUrl, document.body);

    const bodyObs = new MutationObserver(() => {
      for (const iframe of this.pool._cache.values()) {
        if (!document.body.contains(iframe)) document.body.appendChild(iframe);
      }
      if (this.panel && !document.body.contains(this.panel)) {
        document.body.appendChild(this.panel);
      }
    });
    bodyObs.observe(document.body, { childList: true });
  }

  /** 清空原页面 DOM，只保留 mg-* 元素，释放原页面资源 */
  _clearOriginalPage() {
    if (this._pageCleared) return;
    this._pageCleared = true;

    // 收集需要保留的 mg-* 节点
    const keepHead = [...document.head.querySelectorAll('[id^="mg-"]')];
    const keepBody = [...document.body.children].filter(el => el.id?.startsWith('mg-'));

    // 清空原页面
    document.head.innerHTML = '';
    document.body.innerHTML = '';

    // 恢复 mg-* 节点
    keepHead.forEach(el => document.head.appendChild(el));
    keepBody.forEach(el => document.body.appendChild(el));
  }

  // ─── 导航 ─────────────────────────────────────────────────────────────────
  getCurrentUrl() {
    try {
      const href = this.pool?.current?.contentWindow?.location?.href;
      if (href && href !== 'about:blank') return this._cleanUrl(href);
    } catch (_) {}
    return this._cleanUrl(this.pool?.activeUrl || this.baseUrl);
  }

  navigateTo(url) {
    this.pool.show(url, document.body);
    this._updateActiveState(url);
  }

  _watchIframeUrlChange(iframe) {
    if (this._urlPollTimer) clearInterval(this._urlPollTimer);
    let lastUrl = this.getCurrentUrl();
    try {
      iframe.contentWindow?.addEventListener('popstate', () => {
        const url = this.getCurrentUrl();
        if (url !== lastUrl) { lastUrl = url; this._updateActiveState(url); }
      });
    } catch (_) {}
    this._urlPollTimer = setInterval(() => {
      if (iframe !== this.pool?.current) return;
      try {
        const url = this.getCurrentUrl();
        if (url && url !== lastUrl) { lastUrl = url; this._updateActiveState(url); }
      } catch (_) {}
    }, 800);
  }

  // ─── 侧边栏宽度同步（左/右自适应） ──────────────────────────────────────
  _syncSidebarWidth() {
    if (this._resizeObserver) { this._resizeObserver.disconnect(); this._resizeObserver = null; }

    const getEl = (doc) => {
      if (!doc) return null;
      if (this.side === 'right') {
        // comments-sidebar 优先（且不是 display:none）
        const cs = doc.querySelector('.comments-sidebar');
        if (cs && getComputedStyle(cs).display !== 'none' && cs.offsetWidth > 0) return cs;
        const rc = doc.querySelector('.right__container--box');
        if (rc && rc.offsetWidth > 0) return rc;
        return null;
      }
      return doc.querySelector('.left-bar') || null;
    };

    const apply = (w) => {
      if (!w || w === this.sidebarWidth) return;
      this.sidebarWidth = w;
      if (this.panel && !this.collapsed) {
        this.panel.style.width = w + 'px';
      }
    };

    const tryNow = () => {
      try {
        const doc = this.pool?.current?.contentDocument;
        const el = getEl(doc) || getEl(document);
        if (el) {
          apply(el.offsetWidth);
          this._resizeObserver = new ResizeObserver(() => apply(el.offsetWidth));
          this._resizeObserver.observe(el);
          return true;
        }
      } catch (_) {}
      return false;
    };

    if (tryNow()) return;

    // 等待元素出现
    const targets = [];
    try {
      const doc = this.pool?.current?.contentDocument;
      if (doc) targets.push(doc.body || doc.documentElement);
    } catch (_) {}
    targets.push(document.body);

    targets.forEach(target => {
      const obs = new MutationObserver(() => { if (tryNow()) obs.disconnect(); });
      obs.observe(target, { childList: true, subtree: true });
      setTimeout(() => obs.disconnect(), 12000);
    });
  }

  // ─── 渲染 ─────────────────────────────────────────────────────────────────
  render() {
    if (this.panel) this.panel.remove();
    this.panel = document.createElement('div');
    this.panel.id = 'mg-nav-panel';
    this.panel.style.cssText = this._panelStyle();

    if (this.collapsed) {
      this.panel.innerHTML = this._collapsedHTML();
    } else {
      this.panel.innerHTML = this._expandedHTML();
      this._renderTree();
      this._bindTreeEvents();
    }
    this._bindHeaderEvents();
    document.body.appendChild(this.panel);
  }

  _panelStyle() {
    const isRight = this.side === 'right';
    const w = this.collapsed ? '36px' : `${this.sidebarWidth}px`;
    return [
      'position:fixed', 'top:0',
      isRight ? 'right:0;left:auto' : 'left:0;right:auto',
      `width:${w}`,
      'height:100vh',
      'background:' + (this.collapsed ? 'transparent' : '#1e1e2e'),
      this.collapsed ? '' : (isRight ? 'box-shadow:-2px 0 16px rgba(0,0,0,0.5)' : 'box-shadow:2px 0 16px rgba(0,0,0,0.5)'),
      'z-index:9999',
      'font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif',
      'font-size:13px', 'color:#cdd6f4',
      'display:flex', 'flex-direction:column',
      'overflow:visible',
      'transition:width 0.22s cubic-bezier(.4,0,.2,1)',
      'user-select:none',
    ].filter(Boolean).join(';');
  }

  _collapsedHTML() {
    const isRight = this.side === 'right';
    const arrow = isRight ? '&#9664;' : '&#9654;';
    return `
      <div id="mg-btn-toggle" title="展开导航" style="
        position:absolute;
        top:50%; ${isRight ? 'right:4px' : 'left:4px'};
        transform:translateY(-50%);
        width:28px; height:28px;
        display:flex; align-items:center; justify-content:center;
        cursor:pointer; color:#89b4fa; font-size:13px;
        background:#1e1e2e;
        border-radius:6px;
        box-shadow:${isRight ? '-2px' : '2px'} 0 12px rgba(0,0,0,0.5);
      ">${arrow}</div>
    `;
  }

  // 展开态：头部 + 树
  _expandedHTML() {
    const isRight = this.side === 'right';
    const sideIcon    = isRight ? '&#9664;&#9664;' : '&#9654;&#9654;';
    const sideTitle   = isRight ? '切换到左侧' : '切换到右侧';
    const collapseIcon = isRight ? '&#9654;' : '&#9664;';

    return `
      <div id="mg-header" style="
        display:flex; align-items:center; gap:4px;
        padding:0 8px; height:44px; flex-shrink:0;
        border-bottom:1px solid #313244;
        background:#181825;
      ">
        <span style="
          flex:1; font-weight:700; font-size:12px;
          color:#cba6f7; letter-spacing:0.6px; white-space:nowrap;
          overflow:hidden; text-overflow:ellipsis;
        ">MasterGo 导航</span>

        <button id="mg-btn-refresh" title="刷新导航" style="${this._btnStyle()}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"></polyline>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
          </svg>
        </button>

        <button id="mg-btn-side" title="${sideTitle}" style="${this._btnStyle()}">
          <span style="font-size:11px; font-weight:700; letter-spacing:-1px;">${sideIcon}</span>
        </button>

        <button id="mg-btn-toggle" title="收起" style="${this._btnStyle()}">
          <span style="font-size:14px; line-height:1;">${collapseIcon}</span>
        </button>
      </div>

      <div id="mg-nav-tree" style="overflow-y:auto;flex:1;padding:6px 0;"></div>
    `;
  }

  _btnStyle() {
    return [
      'background:none', 'border:none', 'cursor:pointer',
      'color:#6c7086', 'padding:5px', 'border-radius:6px',
      'display:flex', 'align-items:center', 'justify-content:center',
      'flex-shrink:0', 'transition:background 0.15s,color 0.15s',
      'width:28px', 'height:28px',
    ].join(';');
  }

  _bindHeaderEvents() {
    if (!this.panel) return;

    // 悬停高亮
    this.panel.querySelectorAll('button[id^="mg-btn-"]').forEach(btn => {
      btn.addEventListener('mouseenter', () => {
        btn.style.background = 'rgba(137,180,250,0.12)';
        btn.style.color = '#cdd6f4';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.background = 'none';
        btn.style.color = '#6c7086';
      });
    });

    // 收起/展开
    this.panel.querySelector('#mg-btn-toggle')?.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      chrome.storage.local.set({ mastergoNavCollapsed: this.collapsed });
      this.render();
    });

    // 刷新
    this.panel.querySelector('#mg-btn-refresh')?.addEventListener('click', () => {
      this._renderTree();
      this._bindTreeEvents();
    });

    // 左右切换
    this.panel.querySelector('#mg-btn-side')?.addEventListener('click', () => {
      this.side = this.side === 'left' ? 'right' : 'left';
      chrome.storage.local.set({ mastergoNavSide: this.side });
      this._syncSidebarWidth();
      this.render();
    });
  }

  // ─── 树渲染 ──────────────────────────────────────────────────────────────
  _renderTree() {
    const treeEl = this.panel.querySelector('#mg-nav-tree');
    if (!treeEl) return;
    const activeUrl = this.getCurrentUrl();
    if (!this.nodes.length) {
      treeEl.innerHTML = `<div style="padding:20px 14px;color:#6c7086;font-size:12px;text-align:center;">
        暂无导航配置<br><span style="color:#45475a;">请在插件 popup 中添加</span></div>`;
      return;
    }
    treeEl.innerHTML = '';
    this.nodes.forEach(node => treeEl.appendChild(this._renderNode(node, 0, activeUrl)));
  }

  _renderNode(node, depth, activeUrl) {
    const isLeaf = !node.children || node.children.length === 0;
    const wrap = document.createElement('div');

    if (isLeaf) {
      const nodeUrl = node.url ? this._cleanUrl(node.url) : '';
      const isActive = nodeUrl && nodeUrl === activeUrl;
      const cached = nodeUrl && this.pool?.has(nodeUrl);
      wrap.className = 'mg-nav-page';
      wrap.dataset.url = nodeUrl;
      wrap.style.cssText = [
        `padding:5px 10px 5px ${16 + depth * 14}px`,
        `cursor:${nodeUrl ? 'pointer' : 'default'}`,
        `color:${isActive ? '#cba6f7' : '#cdd6f4'}`,
        `background:${isActive ? 'rgba(203,166,247,0.14)' : 'transparent'}`,
        `border-left:2px solid ${isActive ? '#cba6f7' : 'transparent'}`,
        'border-radius:0 6px 6px 0',
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis',
        'font-size:12px;line-height:1.7;display:flex;align-items:center;gap:6px',
        'transition:background 0.12s',
      ].join(';');

      wrap.innerHTML = `
        <span style="font-size:8px;color:${cached ? '#a6e3a1' : '#45475a'};flex-shrink:0;"
          title="${cached ? '已缓存' : '未缓存'}">&#11044;</span>
        <span style="overflow:hidden;text-overflow:ellipsis;flex:1;" title="${this._esc(node.name)}">${this._esc(node.name)}</span>
        ${cached ? '<span class="mg-cache-del" style="cursor:pointer;color:#f38ba8;font-size:11px;flex-shrink:0;padding:0 2px;" title="清除缓存">&#10005;</span>' : ''}
        ${!nodeUrl ? '<span style="color:#f38ba8;font-size:10px;flex-shrink:0;">(未绑定)</span>' : ''}
      `;
      if (nodeUrl) {
        wrap.addEventListener('mouseenter', () => {
          if (!wrap.style.background.includes('0.14')) {
            wrap.style.background = 'rgba(137,180,250,0.07)';
          }
        });
        wrap.addEventListener('mouseleave', () => {
          const isAct = wrap.dataset.url === this.getCurrentUrl();
          wrap.style.background = isAct ? 'rgba(203,166,247,0.14)' : 'transparent';
        });
      }
    } else {
      const isCollapsed = this.collapsedIds.has(node.id);
      const header = document.createElement('div');
      header.className = 'mg-nav-group-header';
      header.dataset.nodeId = node.id;
      header.style.cssText = [
        `padding:6px 10px 6px ${10 + depth * 14}px`,
        'cursor:pointer;display:flex;align-items:center;gap:6px',
        'color:#89b4fa;font-weight:600;font-size:12px;letter-spacing:0.3px',
        'transition:background 0.12s;border-radius:4px;',
      ].join(';');
      header.innerHTML = `
        <span class="mg-arrow" style="
          font-size:9px;flex-shrink:0;color:#585b70;
          transition:transform 0.18s;
          transform:rotate(${isCollapsed ? '0deg' : '90deg'})
        ">&#9654;</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
          title="${this._esc(node.name)}">${this._esc(node.name)}</span>
      `;
      header.addEventListener('mouseenter', () => header.style.background = 'rgba(137,180,250,0.08)');
      header.addEventListener('mouseleave', () => header.style.background = 'transparent');

      const children = document.createElement('div');
      children.className = 'mg-nav-children';
      children.dataset.nodeId = node.id;
      children.style.display = isCollapsed ? 'none' : 'block';
      node.children.forEach(child =>
        children.appendChild(this._renderNode(child, depth + 1, activeUrl))
      );
      wrap.appendChild(header);
      wrap.appendChild(children);
    }
    return wrap;
  }

  _bindTreeEvents() {
    const treeEl = this.panel.querySelector('#mg-nav-tree');
    if (!treeEl) return;
    treeEl.addEventListener('click', (e) => {
      const header = e.target.closest('.mg-nav-group-header');
      if (header) {
        const nodeId = header.dataset.nodeId;
        const childrenEl = treeEl.querySelector(`.mg-nav-children[data-node-id="${nodeId}"]`);
        const arrow = header.querySelector('.mg-arrow');
        if (this.collapsedIds.has(nodeId)) {
          this.collapsedIds.delete(nodeId);
          if (childrenEl) childrenEl.style.display = 'block';
          if (arrow) arrow.style.transform = 'rotate(90deg)';
        } else {
          this.collapsedIds.add(nodeId);
          if (childrenEl) childrenEl.style.display = 'none';
          if (arrow) arrow.style.transform = 'rotate(0deg)';
        }
        return;
      }
      const del = e.target.closest('.mg-cache-del');
      if (del) {
        e.stopPropagation();
        const page = del.closest('.mg-nav-page');
        if (page && page.dataset.url) {
          this.pool.remove(page.dataset.url);
          this._renderTree();
          this._bindTreeEvents();
        }
        return;
      }
      const page = e.target.closest('.mg-nav-page');
      if (page && page.dataset.url) {
        this.navigateTo(page.dataset.url);
        this._renderTree();
        this._bindTreeEvents();
      }
    });
  }

  _updateActiveState(activeUrl) {
    const treeEl = this.panel?.querySelector('#mg-nav-tree');
    if (!treeEl) return;
    treeEl.querySelectorAll('.mg-nav-page').forEach(el => {
      const isActive = el.dataset.url === activeUrl;
      el.style.color      = isActive ? '#cba6f7' : '#cdd6f4';
      el.style.background = isActive ? 'rgba(203,166,247,0.14)' : 'transparent';
      el.style.borderLeft = `2px solid ${isActive ? '#cba6f7' : 'transparent'}`;
    });
  }

  // ─── storage 变化 ─────────────────────────────────────────────────────────
  async onStorageChange(changes) {
    if (changes.mastergoNavNodes) {
      this.nodes = changes.mastergoNavNodes.newValue || [];
      if (!this.collapsed) { this._renderTree(); this._bindTreeEvents(); }
    }
    if (changes.mastergoNavModuleEnabled) {
      const enabled = changes.mastergoNavModuleEnabled.newValue !== false;
      if (enabled) { this._takeover(); this.render(); } else { this.destroy(); }
    }
  }

  _esc(str) {
    return String(str || '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  destroy() {
    if (this.panel) { this.panel.remove(); this.panel = null; }
    if (this.pool)  { this.pool.destroy(); this.pool = null; }
    if (this._resizeObserver) { this._resizeObserver.disconnect(); this._resizeObserver = null; }
    if (this._urlPollTimer)   { clearInterval(this._urlPollTimer); this._urlPollTimer = null; }
    chrome.storage.onChanged.removeListener(this.onStorageChange);
  }
}

(async () => {
  const nav = new MasterGoNav();
  await nav.init();
})();
