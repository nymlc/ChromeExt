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
      credentialManager: null,
      masterGoManager: null,
      imagePreview: null,
    };
    this.activeSubpageModule = null; // 'credential' | 'masterGoNav' | 'password' | 'timestampFormatter' | 'imagePreview' | 'qrCodeTool' | 'hiddenModules'

    // 子页内容容器映射（data-driven，openSubpage / _syncSubpageHeight 共用）
    this.contentMap = {
      credential: 'credentialModuleContent',
      masterGoNav: 'masterGoNavModuleContent',
      password: 'passwordModuleContent',
      timestampFormatter: 'timestampFormatterModuleContent',
      imagePreview: 'imagePreviewModuleContent',
      qrCodeTool: 'qrCodeToolModuleContent',
      hiddenModules: 'hiddenModulesModuleContent',
    };

    // 已隐藏的模块 id 列表
    this.hiddenModules = [];
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

    // 版本号从 manifest 动态注入（避免写死，manifest 为唯一版本源）
    this.renderVersion();

    // 初始化密码模块
    this.modules.passwordToggle = new PasswordToggle();
    await this.modules.passwordToggle.init();

    this.modules.credentialManager = new CredentialManager();
    await this.modules.credentialManager.init();

    this.modules.masterGoManager = new MasterGoManager();
    await this.modules.masterGoManager.init();

    this.modules.timestampFormatter = new TimestampFormatter();
    await this.modules.timestampFormatter.init();

    this.modules.imagePreview = new ImagePreview();
    await this.modules.imagePreview.init();

    this.modules.qrCodeTool = new QrCodeTool();
    await this.modules.qrCodeTool.init();

    // 恢复模块顺序并初始化拖拽
    await this.restoreModuleOrder();
    this.initDragSort();

    // 初始化路由导航
    this.initNavigation();

    // 初始化模块隐藏功能
    await this.initModuleHiding();
  }

  // 版本号从 manifest 动态读取并注入页脚（manifest 为唯一版本源，避免写死）
  renderVersion() {
    const el = document.querySelector('.version');
    if (!el) return;
    let v = '';
    try {
      const manifest = chrome.runtime.getManifest();
      v = (manifest && manifest.version) || '';
    } catch (e) {
      v = '';
    }
    el.textContent = v ? `v${v}` : '';
  }

  initNavigation() {
    // 统一的模块卡片点击处理：
    // - 开关 / 拖拽手柄 / 右侧「隐藏」按钮(.module-reveal) 不触发进子页
    // - 其余点击进入该模块子页（hover 左滑露出的隐藏按钮由它自己的 handler 处理）
    const bindEntry = (el, moduleId, title) => {
      if (!el) return;
      el.addEventListener('click', (e) => {
        if (e.target.closest('.switch') || e.target.closest('.drag-handle') || e.target.closest('.module-reveal')) return;
        // 已左滑揭示态：点卡片主体只收起，不进子页
        if (el.classList.contains('slid')) { el.classList.remove('slid'); return; }
        this.openSubpage(title, moduleId);
      });
    };

    bindEntry(document.getElementById('credentialModuleEntry'), 'credential', '凭证管理');
    bindEntry(document.getElementById('masterGoNavModuleEntry'), 'masterGoNav', 'MasterGo 导航');
    bindEntry(document.getElementById('passwordModuleEntry'), 'password', '密码显示');
    bindEntry(document.getElementById('timestampFormatterModuleEntry'), 'timestampFormatter', '时间戳格式化');
    bindEntry(document.getElementById('imagePreviewModuleEntry'), 'imagePreview', '图片预览');
    bindEntry(document.getElementById('qrCodeToolModuleEntry'), 'qrCodeTool', '二维码工具');

    // 顶部「已隐藏 N 个模块」入口
    const hiddenEntry = document.getElementById('hiddenModulesEntry');
    if (hiddenEntry) {
      hiddenEntry.addEventListener('click', () => {
        this.openSubpage('已隐藏的模块', 'hiddenModules');
      });
    }

    const backBtn = document.getElementById('subpageBackBtn');
    if (backBtn) {
      backBtn.addEventListener('click', () => this.closeSubpage());
    }
  }

  openSubpage(title, moduleId) {
    this.activeSubpageModule = moduleId;

    // 切换可见的 content 容器（data-driven）
    const activeContentId = this.contentMap[moduleId];
    Object.values(this.contentMap).forEach(cid => {
      const el = document.getElementById(cid);
      if (el) el.style.display = (cid === activeContentId) ? '' : 'none';
    });

    const titleEl = document.getElementById('subpageTitle');
    if (titleEl) titleEl.textContent = title;

    // 隐藏模块管理面板：进入时渲染最新列表
    if (moduleId === 'hiddenModules') this.renderHiddenModulesPanel();

    const wrapper = document.getElementById('appWrapper');
    if (wrapper) {
      wrapper.classList.add('show-subpage');
      // 等待模块渲染完成后再测量
      setTimeout(() => this._syncSubpageHeight(), 50);
    }
  }

  closeSubpage() {
    const wrapper = document.getElementById('appWrapper');
    if (wrapper) {
      wrapper.classList.remove('show-subpage');
      // 恢复主页时清除定高，让主页内容自然撑开
      wrapper.style.height = '';
    }
    if (this._subpageObserver) {
      this._subpageObserver.disconnect();
      this._subpageObserver = null;
    }
  }

  /**
   * 动态同步子页面高度：按内容自适应，最大 492px
   */
  _syncSubpageHeight() {
    const wrapper = document.getElementById('appWrapper');
    const subpage = document.getElementById('viewSubpage');
    const header = document.querySelector('.subpage-header');
    const contentId = this.contentMap[this.activeSubpageModule] || 'credentialModuleContent';
    const content = document.getElementById(contentId);
    if (!wrapper || !content || !subpage) return;

    const measure = () => {
      if (!wrapper.classList.contains('show-subpage')) return;
      const headerH = header ? header.offsetHeight : 50;
      const scrollStates = Array.from(content.querySelectorAll('.scrollable-area')).map(el => ({
        el,
        top: el.scrollTop,
        left: el.scrollLeft,
      }));
      const activeEl = document.activeElement;
      const selection = activeEl instanceof HTMLInputElement || activeEl instanceof HTMLTextAreaElement
        ? { start: activeEl.selectionStart, end: activeEl.selectionEnd }
        : null;

      // scrollHeight 已包含完整可滚动内容，无需临时修改 flex，避免重置编辑表单滚动范围。
      let childrenH = 0;
      for (const child of content.children) {
        const style = getComputedStyle(child);
        const mt = parseFloat(style.marginTop) || 0;
        const mb = parseFloat(style.marginBottom) || 0;
        childrenH += child.scrollHeight + mt + mb;
      }

      const cs = getComputedStyle(content);
      const paddingH = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      const total = headerH + paddingH + childrenH;
      const h = Math.max(200, Math.min(total, 492));
      const nextHeight = h + 'px';

      // 必须设置 wrapper 的高度，因为 view-subpage 是绝对定位(height: 100%)，依赖它！
      if (wrapper.style.height !== nextHeight) wrapper.style.height = nextHeight;

      requestAnimationFrame(() => {
        scrollStates.forEach(({ el, top, left }) => {
          if (el.isConnected) {
            el.scrollTop = top;
            el.scrollLeft = left;
          }
        });
        if (activeEl?.isConnected && document.activeElement !== activeEl && typeof activeEl.focus === 'function') {
          activeEl.focus({ preventScroll: true });
          if (selection && typeof activeEl.setSelectionRange === 'function') {
            activeEl.setSelectionRange(selection.start, selection.end);
          }
        }
      });
    };

    measure();

    // 持续监听内容变化
    if (this._subpageObserver) this._subpageObserver.disconnect();
    const observerOptions = this.activeSubpageModule === 'credential'
      ? { childList: true }
      : { childList: true, subtree: true, characterData: true };
    this._subpageObserver = new MutationObserver(() => {
      // 凭证页仅在整页 render 时重测；标签局部更新由编辑表单自身承载滚动。
      this._subpageObserver.disconnect();
      requestAnimationFrame(() => {
        if (!wrapper.classList.contains('show-subpage') || this.activeSubpageModule !== contentId.replace('ModuleContent', '')) return;
        measure();
        this._subpageObserver?.observe(content, observerOptions);
      });
    });
    this._subpageObserver.observe(content, observerOptions);
  }

  /**
   * 恢复保存的模块顺序
   */
  async restoreModuleOrder() {
    const result = await chrome.storage.local.get(['moduleOrder']);
    const order = result.moduleOrder;
    if (!order || !order.length) return;

    const container = document.getElementById('modulesContainer');
    const modules = Array.from(container.querySelectorAll('.feature-module[data-module-id]'));
    const moduleMap = {};
    modules.forEach(m => { moduleMap[m.dataset.moduleId] = m; });

    // 按保存的顺序重新排列
    order.forEach(id => {
      if (moduleMap[id]) {
        container.appendChild(moduleMap[id]);
      }
    });
  }

  /**
   * 初始化模块拖拽排序
   */
  initDragSort() {
    const container = document.getElementById('modulesContainer');
    let draggedEl = null;

    container.addEventListener('dragstart', (e) => {
      const module = e.target.closest('.feature-module[data-module-id]');
      if (!module) return;
      // 从表单控件（输入框/文本域/按钮/开关）起拖时不启动模块拖拽，避免误触
      if (e.target.closest('input, textarea, button, label.switch')) {
        e.preventDefault();
        return;
      }
      draggedEl = module;
      module.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    container.addEventListener('dragend', () => {
      if (draggedEl) {
        draggedEl.classList.remove('dragging');
        draggedEl = null;
      }
      // 清除所有 drag-over 样式
      container.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
      // 保存顺序
      this.saveModuleOrder();
    });

    container.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const target = e.target.closest('.feature-module[data-module-id]');
      if (!target || target === draggedEl) return;

      // 清除其他的 drag-over
      container.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
      target.classList.add('drag-over');
    });

    container.addEventListener('dragleave', (e) => {
      const target = e.target.closest('.feature-module[data-module-id]');
      if (target) target.classList.remove('drag-over');
    });

    container.addEventListener('drop', (e) => {
      e.preventDefault();
      const target = e.target.closest('.feature-module[data-module-id]');
      if (!target || !draggedEl || target === draggedEl) return;

      target.classList.remove('drag-over');

      // 判断插入位置
      const rect = target.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY < midY) {
        container.insertBefore(draggedEl, target);
      } else {
        container.insertBefore(draggedEl, target.nextSibling);
      }
    });
  }

  /**
   * 保存模块顺序
   */
  async saveModuleOrder() {
    const container = document.getElementById('modulesContainer');
    const order = Array.from(container.querySelectorAll('.feature-module[data-module-id]'))
      .map(el => el.dataset.moduleId);
    await chrome.storage.local.set({ moduleOrder: order });
  }

  // ==================== 模块隐藏 ====================

  /**
   * 初始化模块隐藏：读取已隐藏列表、套用、绑定「隐藏」按钮、渲染顶部入口
   */
  async initModuleHiding() {
    const result = await chrome.storage.local.get(['hiddenModules']);
    this.hiddenModules = Array.isArray(result.hiddenModules) ? result.hiddenModules : [];

    this.applyHiddenModules();

    // 把每张卡片的现有内容包进 .module-inner（仅包一次）：
    // 左滑只位移 .module-inner，外层 .feature-module 始终不动 -> mouseleave 判定“是否还在这一行”才精确。
    document.querySelectorAll('.feature-module[data-module-id]').forEach(fm => {
      if (fm.firstElementChild && fm.firstElementChild.classList.contains('module-inner')) return;
      const inner = document.createElement('div');
      inner.className = 'module-inner';
      while (fm.firstChild) inner.appendChild(fm.firstChild);
      fm.appendChild(inner);
    });

    // 微信式 v3：每个模块右侧注入两个独立元素，互不干扰：
    //  - .module-sliver：hover 时从右缘探出的「全圆角小药丸」，点它 -> 内层左滑
    //  - .module-reveal：左滑后出现的完整「隐藏」按钮，点它 -> 执行隐藏
    // 缺失才创建，已有的不重复。
    document.querySelectorAll('.feature-module[data-module-id]').forEach(fm => {
      const id = fm.dataset.moduleId;
      // hover 细滑块（圆角小药丸）
      let sliver = fm.querySelector('.module-sliver');
      if (!sliver) {
        sliver = document.createElement('button');
        sliver.type = 'button';
        sliver.className = 'module-sliver';
        sliver.title = '隐藏模块';
        sliver.setAttribute('aria-label', '隐藏模块');
        fm.appendChild(sliver);
      }
      // 左滑后的完整「隐藏」按钮
      let reveal = fm.querySelector('.module-reveal');
      if (!reveal) {
        reveal = document.createElement('button');
        reveal.type = 'button';
        reveal.className = 'module-reveal';
        reveal.title = '隐藏模块';
        reveal.textContent = '隐藏';
        fm.appendChild(reveal);
      }
      // 点细滑块 -> 内层左滑（收起其它已展开的）
      sliver.addEventListener('click', (e) => {
        e.stopPropagation(); // 不触发卡片「进子页」、也不冒泡到 document 收起
        if (fm.classList.contains('slid')) return;
        document.querySelectorAll('.feature-module.slid').forEach(o => { if (o !== fm) o.classList.remove('slid'); });
        fm.classList.add('slid');
      });
      // 点隐藏按钮 -> 执行隐藏并收起
      reveal.addEventListener('click', (e) => {
        e.stopPropagation(); // 不触发卡片「进子页」、也不冒泡到 document 收起
        if (fm.classList.contains('slid')) {
          fm.classList.remove('slid');
          this.toggleHideModule(id, true);
        }
      });

      // 鼠标离开该模块 -> 自动收起左滑（恢复常态），避免卡在左滑态
      fm.addEventListener('mouseleave', () => fm.classList.remove('slid'));
    });

    // 点击卡片以外的区域 -> 收起所有已左滑揭示的模块（避免卡在左滑态）
    document.addEventListener('click', (e) => {
      if (e.target.closest('.feature-module')) return;
      document.querySelectorAll('.feature-module.slid').forEach(o => o.classList.remove('slid'));
    });

    this.renderHiddenEntry();
  }

  /**
   * 根据 hiddenModules 显隐卡片
   */
  applyHiddenModules() {
    document.querySelectorAll('.feature-module[data-module-id]').forEach(fm => {
      const id = fm.dataset.moduleId;
      const hidden = this.hiddenModules.includes(id);
      fm.style.display = hidden ? 'none' : '';
      if (hidden) fm.classList.remove('slid');
    });
  }

  /**
   * 切换单个模块的隐藏状态并持久化
   */
  async toggleHideModule(id, hide) {
    if (hide) {
      if (!this.hiddenModules.includes(id)) this.hiddenModules.push(id);
    } else {
      this.hiddenModules = this.hiddenModules.filter(x => x !== id);
    }
    // 先同步更新 UI（即时响应），再持久化
    this.applyHiddenModules();
    this.renderHiddenEntry();
    // 若管理面板正打开，同步刷新列表
    if (this.activeSubpageModule === 'hiddenModules') this.renderHiddenModulesPanel();
    await chrome.storage.local.set({ hiddenModules: this.hiddenModules });
  }

  /**
   * 渲染顶部「已隐藏 N 个模块」入口
   */
  renderHiddenEntry() {
    const entry = document.getElementById('hiddenModulesEntry');
    if (!entry) return;
    if (this.hiddenModules.length === 0) {
      entry.style.display = 'none';
      return;
    }
    entry.style.display = '';
    const countEl = entry.querySelector('.hidden-count');
    if (countEl) countEl.textContent = this.hiddenModules.length;
  }

  /**
   * 渲染隐藏模块管理面板：已隐藏模块以与正常列表一致的卡片样式呈现，逐个可恢复
   */
  renderHiddenModulesPanel() {
    const container = document.getElementById('hiddenModulesModuleContent');
    if (!container) return;
    const names = this.getModuleDataKeys();

    container.innerHTML = '';
    if (this.hiddenModules.length === 0) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.style.cssText = 'padding:16px 4px;';
      p.textContent = '暂无隐藏的模块';
      container.appendChild(p);
      return;
    }

    this.hiddenModules.forEach(id => {
      const src = document.querySelector(`.feature-module[data-module-id="${id}"]`);
      const card = document.createElement('div');
      card.className = 'feature-module hidden-card';
      card.dataset.moduleId = id;

      let name = (names[id] && names[id].name) || id;
      if (src) {
        const header = src.querySelector('.module-header');
        if (header) {
          const clone = header.cloneNode(true);
          // 去掉开关，保留「进入详情(›)」图标；右侧补「显示」按钮，视觉与正常卡片一致
          const right = clone.querySelector('.module-header-right');
          if (right) {
            right.querySelectorAll('.switch').forEach(el => el.remove());
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'module-show-btn';
            btn.dataset.show = id;
            btn.textContent = '显示';
            right.appendChild(btn);
          }
          card.appendChild(clone);
        }
      } else {
        const h = document.createElement('h2');
        h.textContent = name;
        card.appendChild(h);
      }
      // 点击卡片（除「显示」按钮外）-> 进入该模块详情页，与正常模块行为一致
      card.addEventListener('click', () => this.openSubpage(name, id));
      container.appendChild(card);
    });

    container.querySelectorAll('[data-show]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation(); // 不触发卡片「进详情」
        this.toggleHideModule(btn.dataset.show, false);
      });
    });
  }

  bindGlobalEvents() {
    const globalToggle = document.getElementById('globalToggle');
    globalToggle.addEventListener('click', () => this.toggleGlobal());

    document.getElementById('exportDataBtn').addEventListener('click', () => this.showExportDialog());
    document.getElementById('importDataBtn').addEventListener('click', () => this.showImportDialog());

    // 齿轮菜单
    const gearBtn = document.getElementById('gearBtn');
    const gearDropdown = document.getElementById('gearDropdown');

    gearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = gearDropdown.classList.contains('show');
      gearDropdown.classList.toggle('show');
      gearBtn.classList.toggle('active', !isOpen);
    });

    // 点击外部关闭
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#gearMenuWrapper')) {
        gearDropdown.classList.remove('show');
        gearBtn.classList.remove('active');
      }
    });
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

    if (this.globalEnabled) {
      globalToggle.textContent = '已启用';
      globalToggle.className = 'btn btn-small btn-primary';
    } else {
      globalToggle.textContent = '已禁用';
      globalToggle.className = 'btn btn-small btn-danger';
    }
  }

  // ==================== 数据导入导出 ====================

  /**
   * 模块数据的 storage key 映射
   */
  getModuleDataKeys() {
    return {
      credential: {
        name: '凭证管理',
        keys: ['credentialProjects', 'titleProjectBindings', 'urlProjectBindings']
      },
      password: {
        name: '密码显示',
        keys: ['passwordModuleEnabled', 'disabledPasswordSites']
      },
      masterGoNav: {
        name: 'MasterGo 导航',
        keys: ['mastergoNavNodes', 'mastergoNavCollapsed', 'masterGoNavModuleEnabled', 'mastergoNavSide']
      },
      timestampFormatter: {
        name: '时间戳格式化',
        keys: ['timestampFormatterModuleEnabled', 'disabledTimestampFormatterSites', 'timestampFormatterShowUTC', 'timestampFormatterShowRelative']
      },
      imagePreview: {
        name: '图片预览',
        keys: [
          'imagePreviewModuleEnabled',
          'disabledImagePreviewSites',
          'imagePreviewMaxSize'
        ]
      },
      global: {
        name: '全局设置',
        keys: ['globalDisabledSites', 'moduleOrder', 'hiddenModules']
      }
    };
  }

  /**
   * 显示导出对话框（选择模块）
   */
  showExportDialog() {
    const modules = this.getModuleDataKeys();
    const selected = {};

    // 创建遮罩
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.4); z-index: 9999;
      display: flex; align-items: center; justify-content: center;
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: #fff; border-radius: 12px; padding: 16px; width: 280px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.2);
    `;

    const title = document.createElement('h3');
    title.textContent = '选择导出内容';
    title.style.cssText = 'margin: 0 0 12px; font-size: 15px; color: #333;';
    dialog.appendChild(title);

    // 全选
    const allLabel = document.createElement('label');
    allLabel.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 13px; color: #333; font-weight: 600; cursor: pointer;';
    const allCheck = document.createElement('input');
    allCheck.type = 'checkbox';
    allCheck.checked = true;
    allLabel.appendChild(allCheck);
    allLabel.appendChild(document.createTextNode('全部'));
    dialog.appendChild(allLabel);

    const checkboxes = [];
    Object.entries(modules).forEach(([key, mod]) => {
      selected[key] = true;
      const label = document.createElement('label');
      label.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 13px; color: #555; cursor: pointer; padding-left: 12px;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.addEventListener('change', () => {
        selected[key] = cb.checked;
        allCheck.checked = Object.values(selected).every(v => v);
      });
      checkboxes.push(cb);
      label.appendChild(cb);
      label.appendChild(document.createTextNode(mod.name));
      dialog.appendChild(label);
    });

    allCheck.addEventListener('change', () => {
      checkboxes.forEach(cb => { cb.checked = allCheck.checked; });
      Object.keys(selected).forEach(k => { selected[k] = allCheck.checked; });
    });

    // 按钮
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display: flex; gap: 8px; margin-top: 14px;';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-secondary btn-small';
    cancelBtn.style.flex = '1';
    cancelBtn.textContent = '取消';
    cancelBtn.addEventListener('click', () => overlay.remove());

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn btn-primary btn-small';
    confirmBtn.style.flex = '1';
    confirmBtn.textContent = '导出';
    confirmBtn.addEventListener('click', async () => {
      await this.doExport(selected);
      overlay.remove();
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(confirmBtn);
    dialog.appendChild(btnRow);

    overlay.appendChild(dialog);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  /**
   * 执行导出
   */
  async doExport(selected) {
    const modules = this.getModuleDataKeys();
    const keysToExport = [];

    Object.entries(selected).forEach(([key, isSelected]) => {
      if (isSelected && modules[key]) {
        keysToExport.push(...modules[key].keys);
      }
    });

    if (keysToExport.length === 0) {
      Toast.warning('请至少选择一个模块');
      return;
    }

    const result = await chrome.storage.local.get(keysToExport);
    let appVersion = '';
    try {
      const manifest = chrome.runtime.getManifest();
      appVersion = (manifest && manifest.version) || '';
    } catch (e) {
      appVersion = '';
    }
    const data = {
      version: appVersion,
      exportedAt: new Date().toISOString(),
      modules: selected,
      data: result
    };

    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `password_helper_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    Toast.success('数据已导出');
  }

  /**
   * 显示导入对话框
   */
  showImportDialog() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.style.display = 'none';

    input.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      try {
        const text = await file.text();
        const data = JSON.parse(text);

        if (!data.data || typeof data.data !== 'object') {
          Toast.error('文件格式不正确');
          return;
        }

        // 显示确认对话框，让用户选择要导入哪些模块
        this.showImportConfirmDialog(data);
      } catch (err) {
        Toast.error('导入失败：文件解析错误');
      }
    });

    document.body.appendChild(input);
    input.click();
    document.body.removeChild(input);
  }

  /**
   * 导入确认对话框
   */
  showImportConfirmDialog(fileData) {
    const modules = this.getModuleDataKeys();
    const availableModules = fileData.modules || {};
    const selected = {};

    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.4); z-index: 9999;
      display: flex; align-items: center; justify-content: center;
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: #fff; border-radius: 12px; padding: 16px; width: 280px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.2);
    `;

    const title = document.createElement('h3');
    title.textContent = '选择导入内容';
    title.style.cssText = 'margin: 0 0 8px; font-size: 15px; color: #333;';
    dialog.appendChild(title);

    const hint = document.createElement('p');
    hint.textContent = `导出时间：${new Date(fileData.exportedAt).toLocaleString()}`;
    hint.style.cssText = 'font-size: 11px; color: #999; margin-bottom: 10px;';
    dialog.appendChild(hint);

    Object.entries(modules).forEach(([key, mod]) => {
      const hasData = availableModules[key];
      selected[key] = !!hasData;

      const label = document.createElement('label');
      label.style.cssText = `display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 13px; color: ${hasData ? '#555' : '#ccc'}; cursor: ${hasData ? 'pointer' : 'default'};`;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!hasData;
      cb.disabled = !hasData;
      cb.addEventListener('change', () => { selected[key] = cb.checked; });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(mod.name + (hasData ? '' : '（无数据）')));
      dialog.appendChild(label);
    });

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display: flex; gap: 8px; margin-top: 14px;';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-secondary btn-small';
    cancelBtn.style.flex = '1';
    cancelBtn.textContent = '取消';
    cancelBtn.addEventListener('click', () => overlay.remove());

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn btn-primary btn-small';
    confirmBtn.style.flex = '1';
    confirmBtn.textContent = '导入';
    confirmBtn.addEventListener('click', async () => {
      await this.doImport(fileData, selected);
      overlay.remove();
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(confirmBtn);
    dialog.appendChild(btnRow);

    overlay.appendChild(dialog);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  /**
   * 执行导入
   */
  async doImport(fileData, selected) {
    const modules = this.getModuleDataKeys();
    const dataToImport = {};

    Object.entries(selected).forEach(([key, isSelected]) => {
      if (!isSelected || !modules[key]) return;
      modules[key].keys.forEach(storageKey => {
        if (fileData.data[storageKey] !== undefined) {
          // 凭证项目特殊处理：合并而非覆盖
          if (storageKey === 'credentialProjects') {
            dataToImport[storageKey] = fileData.data[storageKey]; // 先标记，后面合并
          } else {
            dataToImport[storageKey] = fileData.data[storageKey];
          }
        }
      });
    });

    // 凭证项目合并逻辑
    if (dataToImport.credentialProjects) {
      const result = await chrome.storage.local.get(['credentialProjects']);
      const existing = result.credentialProjects || [];
      existing.forEach(project => {
        (project.credentials || []).forEach(credential => {
          credential.note = CredentialTagUtils.normalizeTags(credential.note);
        });
      });
      const importing = dataToImport.credentialProjects;

      importing.forEach(importProject => {
        const existingProject = existing.find(p => p.name === importProject.name);
        if (existingProject) {
          (importProject.credentials || []).forEach(cred => {
            const importedCred = Object.assign({}, cred, {
              note: CredentialTagUtils.normalizeTags(cred.note),
            });
            const existingCred = existingProject.credentials.find(c =>
              c.username === importedCred.username && CredentialTagUtils.tagsEqual(c.note, importedCred.note));
            if (existingCred) {
              Object.assign(existingCred, importedCred, { id: existingCred.id });
            } else {
              existingProject.credentials.push(importedCred);
            }
          });
          existingProject.updatedAt = Date.now();
        } else {
          const normalizedProject = Object.assign({}, importProject, {
            credentials: (importProject.credentials || []).map(cred => Object.assign({}, cred, {
              note: CredentialTagUtils.normalizeTags(cred.note),
            })),
          });
          existing.push(normalizedProject);
        }
      });

      dataToImport.credentialProjects = existing;
    }

    await chrome.storage.local.set(dataToImport);
    Toast.success('数据已导入');

    // 刷新页面状态
    if (this.modules.credentialManager) {
      await this.modules.credentialManager.loadProjects();
      this.modules.credentialManager.render();
    }
  }
}

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
  const manager = new PopupManager();
  await manager.init();
});
