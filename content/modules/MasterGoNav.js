/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-06-29 00:00:00
 * @FilePath: /ChromeExt/content/modules/MasterGoNav.js
 * @Description: MasterGo 导航模块 - 悬浮树状导航（支持左/右侧，夜间/白天双主题）
 *
 * ── 切换池模式 ────────────────────────────────────────────────────────────
 *   POOL_MODE = 'tab'    Tab 池：每个菜单项独立 tab，自动加入 tab 组，LRU 淘汰
 *   POOL_MODE = 'iframe' Iframe 池：接管当前页面，iframe 内加载各菜单项
 *
 *   切换为 iframe 模式时还需在 manifest.json 把 TabPool.js 换回 LRUCache.js + IframePool.js
 *   并将 run_at 改为 document_start
 * ─────────────────────────────────────────────────────────────────────────
 */

const POOL_MODE = 'tab'; // 'tab' | 'iframe'

// ─── 主题 ──────────────────────────────────────────────────────────────────

const MG_THEMES = {
  dark: {
    panelBg:   '#101016',   // 极深的蓝黑，近乎纯黑但带冷调
    headerBg:  '#08080e',   // 比面板更深，形成层次
    border:    '#1a1a28',   // 几乎不可见的边，保持轮廓
    text:      '#c8c8dc',   // 微蓝白，不刺眼
    textMuted: '#42425a',   // 沉闷的紫灰
    accent:    '#9b6dff',   // 饱和紫，鲜明但不浮夸
    blue:      '#5b8dee',   // 钴蓝
    green:     '#3dd68c',   // 翠绿
    red:       '#ff6b81',   // 珊瑚红
    activeBg:  'rgba(155,109,255,0.18)',
    hoverBg:   'rgba(200,200,220,0.05)',
    btnHover:  'rgba(155,109,255,0.2)',
    dotClosed: '#22223a',
    shadow:    '4px 0 32px rgba(0,0,0,0.7)',
    scrollbar: '#22223a',
    groupText: '#5b8dee',
  },
  light: {
    panelBg:   '#ffffff',
    headerBg:  '#f8f7ff',
    border:    '#eae8f8',
    text:      '#24243e',
    textMuted: '#9090b0',
    accent:    '#7c5ce8',
    blue:      '#4a7cf8',
    green:     '#16a34a',
    red:       '#dc2626',
    activeBg:  'rgba(124,92,232,0.1)',
    hoverBg:   'rgba(124,92,232,0.05)',
    btnHover:  'rgba(124,92,232,0.1)',
    dotClosed: '#d4d0f0',
    shadow:    '3px 0 20px rgba(0,0,0,0.09)',
    scrollbar: '#d0cff0',
    groupText: '#4a7cf8',
  },
};

// ─── SVG 图标 ─────────────────────────────────────────────────────────────

const MG_ICONS = {
  refresh:      `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`,
  flip:         `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 4l4 4-4 4"/><path d="M7 20l-4-4 4-4"/><line x1="21" y1="8" x2="3" y2="8"/><line x1="3" y1="16" x2="21" y2="16"/></svg>`,
  chevronLeft:  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`,
  chevronRight: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`,
  sun:          `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg>`,
  moon:         `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`,
  unbound:      `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/><line x1="5" y1="5" x2="19" y2="19"/></svg>`,
};

// ─── 组件 ─────────────────────────────────────────────────────────────────

class MasterGoNav extends BaseContentModule {
  constructor() {
    super('masterGoNav');
    this.nodes        = [];
    this.collapsed    = false;
    this.side         = 'left';
    this.theme        = 'dark';
    this.sidebarWidth = 220;
    this.poolCapacity = 3;
    this.collapsedIds = new Set();
    this.panel        = null;
    this.pool         = null;
    this.baseUrl      = this._cleanUrl(window.location.href);
    this._urlPollTimer   = null;
    this._resizeObserver = null;
    this.onStorageChange = this.onStorageChange.bind(this);
  }

  _t() { return MG_THEMES[this.theme] || MG_THEMES.dark; }

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
    const inValidPaths = ['/files/'];
    if (inValidPaths.some(p => location.pathname.startsWith(p))) return;
    await this.load();
    await this._waitForBody();
    await this._initPool();
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
      'mastergoNavPoolCapacity', 'mastergoNavTheme',
    ]);
    this.nodes        = result.mastergoNavNodes        || [];
    this.collapsed    = result.mastergoNavCollapsed    || false;
    this.side         = result.mastergoNavSide         || 'left';
    this.poolCapacity = result.mastergoNavPoolCapacity ?? 3;
    this.theme        = result.mastergoNavTheme        || 'dark';
  }

  // ─── 池初始化（切换点） ───────────────────────────────────────────────────

  async _initPool() {
    if (POOL_MODE === 'tab') {
      this.pool = new TabPool({ capacity: this.poolCapacity });
      await this.pool.sync();

      const currentUrl = this._cleanUrl(window.location.href);
      const node = this._findNavNode(currentUrl);
      if (node) await this.pool.register(currentUrl, node.name);

      this.pool.onUpdate(() => {
        if (!this.collapsed) this._renderTree();
      });
    } else {
      this._takeover();
    }
  }

  // ─── 导航（切换点） ───────────────────────────────────────────────────────

  getCurrentUrl() {
    if (POOL_MODE === 'iframe') {
      try {
        const href = this.pool?.current?.contentWindow?.location?.href;
        if (href && href !== 'about:blank') return this._cleanUrl(href);
      } catch (_) {}
      return this._cleanUrl(this.pool?.activeUrl || this.baseUrl);
    }
    return this._cleanUrl(window.location.href);
  }

  async navigateTo(url) {
    const cleanUrl = this._cleanUrl(url);
    if (POOL_MODE === 'tab') {
      if (cleanUrl === this.getCurrentUrl()) return;
      const node = this._findNavNode(cleanUrl);
      await this.pool.open(cleanUrl, node?.name || '');
    } else {
      this.pool.show(cleanUrl, document.body);
      this._updateActiveState(cleanUrl);
    }
  }

  _findNavNode(url) {
    const search = (nodes) => {
      for (const node of nodes) {
        if (node.url && this._cleanUrl(node.url) === url) return node;
        if (node.children?.length) {
          const found = search(node.children);
          if (found) return found;
        }
      }
      return null;
    };
    return search(this.nodes);
  }

  _collectNavItems() {
    const items = [];
    const collect = (nodes) => {
      for (const node of nodes) {
        if (node.url) items.push({ url: this._cleanUrl(node.url), name: node.name || '' });
        if (node.children?.length) collect(node.children);
      }
    };
    collect(this.nodes);
    return items;
  }

  // ─── Iframe 池：接管页面 ─────────────────────────────────────────────────

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
      capacity: 2, maxHits: 3,
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

  _clearOriginalPage() {
    if (this._pageCleared) return;
    this._pageCleared = true;
    const keepHead = [...document.head.querySelectorAll('[id^="mg-"]')];
    const keepBody = [...document.body.children].filter(el => el.id?.startsWith('mg-'));
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    keepHead.forEach(el => document.head.appendChild(el));
    keepBody.forEach(el => document.body.appendChild(el));
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

  // ─── 侧边栏宽度同步 ───────────────────────────────────────────────────────

  _syncSidebarWidth() {
    if (this._resizeObserver) { this._resizeObserver.disconnect(); this._resizeObserver = null; }

    const getEl = (doc) => {
      if (!doc) return null;
      if (this.side === 'right') {
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
      if (this.panel && !this.collapsed) this.panel.style.width = w + 'px';
    };

    const tryNow = () => {
      try {
        const doc = POOL_MODE === 'iframe' ? this.pool?.current?.contentDocument : null;
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
    const targets = [];
    if (POOL_MODE === 'iframe') {
      try {
        const doc = this.pool?.current?.contentDocument;
        if (doc) targets.push(doc.body || doc.documentElement);
      } catch (_) {}
    }
    targets.push(document.body);
    targets.forEach(target => {
      const obs = new MutationObserver(() => { if (tryNow()) obs.disconnect(); });
      obs.observe(target, { childList: true, subtree: true });
      setTimeout(() => obs.disconnect(), 12000);
    });
  }

  // ─── CSS 注入（主题驱动的 hover / 动画样式） ─────────────────────────────

  _injectStyles() {
    document.getElementById('mg-nav-styles')?.remove();
    const t = this._t();
    const style = document.createElement('style');
    style.id = 'mg-nav-styles';
    style.textContent = `
      #mg-nav-panel * { box-sizing: border-box; }

      /* 滚动条 */
      #mg-nav-tree::-webkit-scrollbar { width: 3px; }
      #mg-nav-tree::-webkit-scrollbar-track { background: transparent; }
      #mg-nav-tree::-webkit-scrollbar-thumb { background: ${t.scrollbar}; border-radius: 2px; }

      /* 图标按钮 */
      #mg-nav-panel .mg-icon-btn {
        background: none; border: none; cursor: pointer; outline: none;
        color: ${t.textMuted};
        width: 28px; height: 28px; padding: 0;
        display: flex; align-items: center; justify-content: center;
        border-radius: 6px; flex-shrink: 0;
        transition: background 0.15s, color 0.15s;
      }
      #mg-nav-panel .mg-icon-btn:hover {
        background: ${t.btnHover};
        color: ${t.text};
      }

      /* 叶节点行 */
      #mg-nav-panel .mg-nav-page {
        display: flex; align-items: center;
        transition: background 0.12s;
        cursor: pointer;
        border-radius: 0 6px 6px 0;
      }
      #mg-nav-panel .mg-nav-page:hover { background: ${t.hoverBg}; }
      #mg-nav-panel .mg-nav-page[data-active="true"] { background: ${t.activeBg}; }
      #mg-nav-panel .mg-nav-page[data-active="true"]:hover { background: ${t.activeBg}; }

      /* 关闭按钮：hover 时才显示 */
      #mg-nav-panel .mg-pool-remove {
        opacity: 0; transition: opacity 0.15s;
        cursor: pointer; flex-shrink: 0;
        padding: 2px 5px; border-radius: 4px;
        font-size: 11px; line-height: 1;
      }
      #mg-nav-panel .mg-nav-page:hover .mg-pool-remove { opacity: 0.55; }
      #mg-nav-panel .mg-pool-remove:hover { opacity: 1 !important; }

      /* 分组标题 */
      #mg-nav-panel .mg-nav-group-header {
        display: flex; align-items: center;
        cursor: pointer; border-radius: 5px;
        transition: background 0.12s;
      }
      #mg-nav-panel .mg-nav-group-header:hover { background: ${t.hoverBg}; }

      /* 箭头过渡 */
      #mg-nav-panel .mg-arrow {
        display: inline-flex; align-items: center;
        transition: transform 0.18s;
        flex-shrink: 0;
      }
    `;
    document.head.appendChild(style);
  }

  // ─── 渲染 ─────────────────────────────────────────────────────────────────

  render() {
    if (this.panel) this.panel.remove();
    this._injectStyles();

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
    const t = this._t();
    const isRight = this.side === 'right';
    if (this.collapsed) {
      // 收起时：面板本身透明无尺寸，只是个定位锚点
      return [
        'position:fixed', 'top:50%', 'transform:translateY(-50%)',
        isRight ? 'right:0;left:auto' : 'left:0;right:auto',
        'width:0', 'height:0',
        'background:none', 'border:none', 'box-shadow:none',
        'z-index:2147483647',
        'overflow:visible',
        'user-select:none',
        'font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif',
      ].join(';');
    }
    const borderSide = isRight ? 'border-left' : 'border-right';
    return [
      'position:fixed', 'top:0', 'bottom:0',
      isRight ? 'right:0;left:auto' : 'left:0;right:auto',
      `width:${this.sidebarWidth}px`,
      `background:${t.panelBg}`,
      `${borderSide}:1px solid ${t.border}`,
      `box-shadow:${t.shadow}`,
      'z-index:2147483647',
      'font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif',
      'font-size:13px',
      `color:${t.text}`,
      'display:flex', 'flex-direction:column',
      'overflow:visible',
      'transition:width 0.22s cubic-bezier(.4,0,.2,1)',
      'user-select:none',
    ].join(';');
  }

  _collapsedHTML() {
    const t = this._t();
    const isRight = this.side === 'right';
    const icon = isRight ? MG_ICONS.chevronLeft : MG_ICONS.chevronRight;
    // 面板是 width:0 height:0 的锚点，按钮用 absolute 从锚点偏移出来
    return `
      <button id="mg-btn-toggle" title="展开导航" style="
        position:absolute;
        top:0; ${isRight ? 'right:10px' : 'left:10px'};
        transform:translateY(-50%);
        width:32px; height:32px; padding:0;
        display:flex; align-items:center; justify-content:center;
        background:${t.panelBg};
        border:1px solid ${t.border};
        border-radius:10px;
        box-shadow:0 4px 16px rgba(0,0,0,0.3);
        color:${t.accent};
        cursor:pointer;
        outline:none;
        transition:box-shadow 0.15s, color 0.15s;
      " onmouseenter="this.style.boxShadow='0 6px 20px rgba(0,0,0,0.4)';this.style.color='${t.text}'"
         onmouseleave="this.style.boxShadow='0 4px 16px rgba(0,0,0,0.3)';this.style.color='${t.accent}'"
      >${icon}</button>
    `;
  }

  _expandedHTML() {
    const t = this._t();
    const isRight = this.side === 'right';
    const collapseIcon = isRight ? MG_ICONS.chevronRight : MG_ICONS.chevronLeft;
    const themeIcon = this.theme === 'dark' ? MG_ICONS.sun : MG_ICONS.moon;
    const themeTitle = this.theme === 'dark' ? '切换白天' : '切换夜间';

    return `
      <div id="mg-header" style="
        display:flex; align-items:center; gap:2px;
        padding:0 8px 0 12px; height:46px; flex-shrink:0;
        border-bottom:1px solid ${t.border};
        background:${t.headerBg};
      ">
        <span style="
          flex:1; font-weight:700; font-size:12px; letter-spacing:0.8px;
          color:${t.accent}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
          text-transform:uppercase;
        ">MasterGo</span>

        <button id="mg-btn-refresh" class="mg-icon-btn" title="刷新 / 扫描窗口">${MG_ICONS.refresh}</button>
        <button id="mg-btn-theme"   class="mg-icon-btn" title="${themeTitle}">${themeIcon}</button>
        <button id="mg-btn-side"    class="mg-icon-btn" title="切换左右侧">${MG_ICONS.flip}</button>
        <button id="mg-btn-toggle"  class="mg-icon-btn" title="收起">${collapseIcon}</button>
      </div>

      <div id="mg-nav-tree" style="
        overflow-y:auto; flex:1; padding:6px 0 12px;
      "></div>
    `;
  }

  _bindHeaderEvents() {
    if (!this.panel) return;

    this.panel.querySelector('#mg-btn-toggle')?.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      chrome.storage.local.set({ mastergoNavCollapsed: this.collapsed });
      this.render();
    });

    this.panel.querySelector('#mg-btn-refresh')?.addEventListener('click', async () => {
      if (POOL_MODE === 'tab') {
        await this.pool.scanWindow(this._collectNavItems());
      } else {
        this._renderTree();
      }
    });

    this.panel.querySelector('#mg-btn-theme')?.addEventListener('click', () => {
      this.theme = this.theme === 'dark' ? 'light' : 'dark';
      chrome.storage.local.set({ mastergoNavTheme: this.theme });
      this.render();
      this._syncSidebarWidth();
    });

    this.panel.querySelector('#mg-btn-side')?.addEventListener('click', () => {
      this.side = this.side === 'left' ? 'right' : 'left';
      chrome.storage.local.set({ mastergoNavSide: this.side });
      this._syncSidebarWidth();
      this.render();
    });
  }

  // ─── 树渲染 ──────────────────────────────────────────────────────────────

  _renderTree() {
    const treeEl = this.panel?.querySelector('#mg-nav-tree');
    if (!treeEl) return;
    const t = this._t();
    const activeUrl = this.getCurrentUrl();

    if (!this.nodes.length) {
      treeEl.innerHTML = `
        <div style="padding:32px 16px;text-align:center;">
          <div style="font-size:24px;margin-bottom:10px;opacity:0.3;">☰</div>
          <div style="font-size:12px;color:${t.textMuted};line-height:1.6;">
            暂无导航配置<br>
            <span style="color:${t.dotClosed};">请在插件 popup 中添加</span>
          </div>
        </div>`;
      return;
    }
    treeEl.innerHTML = '';
    this.nodes.forEach(node => treeEl.appendChild(this._renderNode(node, 0, activeUrl)));
  }

  _renderNode(node, depth, activeUrl) {
    const t = this._t();
    const isLeaf = !node.children || node.children.length === 0;
    const wrap = document.createElement('div');

    if (isLeaf) {
      const nodeUrl  = node.url ? this._cleanUrl(node.url) : '';
      const isActive = nodeUrl && nodeUrl === activeUrl;
      const inPool   = nodeUrl && this.pool?.has(nodeUrl);

      wrap.className = 'mg-nav-page';
      wrap.dataset.url    = nodeUrl;
      wrap.dataset.active = isActive ? 'true' : '';
      wrap.style.cssText = [
        `padding:6px 10px 6px ${14 + depth * 12}px`,
        `color:${isActive ? t.accent : t.text}`,
        `border-left:2px solid ${isActive ? t.accent : 'transparent'}`,
        'gap:7px',
        'font-size:12px; line-height:1.5;',
      ].join(';');

      wrap.innerHTML = `
        <span style="
          width:6px; height:6px; border-radius:50%; flex-shrink:0;
          background:${inPool ? t.green : t.dotClosed};
          box-shadow:${inPool ? `0 0 4px ${t.green}60` : 'none'};
          transition:background 0.2s;
        " title="${inPool ? (POOL_MODE === 'tab' ? '已打开' : '已缓存') : '未打开'}"></span>
        <span style="
          overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1;
        " title="${this._esc(node.name)}">${this._esc(node.name)}</span>
        ${inPool
          ? `<span class="mg-pool-remove" style="color:${t.red};" title="${POOL_MODE === 'tab' ? '关闭标签页' : '清除缓存'}">✕</span>`
          : ''
        }
        ${!nodeUrl ? `<span style="color:${t.red};opacity:0.7;flex-shrink:0;display:inline-flex;align-items:center;" title="未绑定 URL">${MG_ICONS.unbound}</span>` : ''}
      `;
    } else {
      const isCollapsed = this.collapsedIds.has(node.id);

      const header = document.createElement('div');
      header.className = 'mg-nav-group-header';
      header.dataset.nodeId = node.id;
      header.style.cssText = [
        `padding:7px 10px 7px ${10 + depth * 12}px`,
        'gap:6px',
        `color:${t.groupText}`,
        'font-weight:600; font-size:11px; letter-spacing:0.6px; text-transform:uppercase;',
      ].join(';');
      header.innerHTML = `
        <span class="mg-arrow" style="
          transform:rotate(${isCollapsed ? '0deg' : '90deg'});
          color:${t.textMuted}; width:12px;
        ">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
          title="${this._esc(node.name)}">${this._esc(node.name)}</span>
      `;

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
    const treeEl = this.panel?.querySelector('#mg-nav-tree');
    if (!treeEl) return;
    treeEl.addEventListener('click', (e) => {
      // 折叠/展开分组
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

      // 关闭/移除
      const remove = e.target.closest('.mg-pool-remove');
      if (remove) {
        e.stopPropagation();
        const page = remove.closest('.mg-nav-page');
        if (page?.dataset.url) {
          if (POOL_MODE === 'tab') {
            this.pool.close(page.dataset.url);
          } else {
            this.pool.remove(page.dataset.url);
            this._renderTree();
          }
        }
        return;
      }

      // 点击导航
      const page = e.target.closest('.mg-nav-page');
      if (page?.dataset.url) {
        this.navigateTo(page.dataset.url);
        if (POOL_MODE === 'iframe') this._renderTree();
      }
    });
  }

  _updateActiveState(activeUrl) {
    const t = this._t();
    const treeEl = this.panel?.querySelector('#mg-nav-tree');
    if (!treeEl) return;
    treeEl.querySelectorAll('.mg-nav-page').forEach(el => {
      const isActive = el.dataset.url === activeUrl;
      el.dataset.active     = isActive ? 'true' : '';
      el.style.color        = isActive ? t.accent : t.text;
      el.style.borderLeftColor = isActive ? t.accent : 'transparent';
    });
  }

  // ─── storage 变化 ─────────────────────────────────────────────────────────

  async onStorageChange(changes) {
    if (changes.mastergoNavNodes) {
      this.nodes = changes.mastergoNavNodes.newValue || [];
      if (!this.collapsed) this._renderTree();
    }
    if (changes.mastergoNavTheme) {
      this.theme = changes.mastergoNavTheme.newValue || 'dark';
      this.render();
    }
    if (changes.mastergoNavModuleEnabled) {
      const enabled = changes.mastergoNavModuleEnabled.newValue !== false;
      if (enabled) { await this._initPool(); this.render(); } else { this.destroy(); }
    }
  }

  _esc(str) {
    return String(str || '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  destroy() {
    if (this.panel) { this.panel.remove(); this.panel = null; }
    document.getElementById('mg-nav-styles')?.remove();
    if (this.pool) {
      if (POOL_MODE === 'tab') this.pool.stopListening();
      else this.pool.destroy();
      this.pool = null;
    }
    if (this._resizeObserver) { this._resizeObserver.disconnect(); this._resizeObserver = null; }
    if (this._urlPollTimer)   { clearInterval(this._urlPollTimer); this._urlPollTimer = null; }
    chrome.storage.onChanged.removeListener(this.onStorageChange);
  }
}

(async () => {
  const nav = new MasterGoNav();
  await nav.init();
})();
