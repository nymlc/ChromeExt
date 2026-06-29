/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-06-15 00:00:00
 * @FilePath: /ChromeExt/popup/modules/MasterGoManager.js
 * @Description: MasterGo 导航管理 - 面包屑路径导航，支持任意层级节点增删改
 */

class MasterGoManager extends BaseModule {
  constructor() {
    super('masterGoNav');
    this.nodes = [];         // 根节点数组（一级 = 项目）
    this.path = [];          // 面包屑路径
    this.editingNode = null; // 正在编辑的节点，null 为新建
    this._editType = 'module'; // 'module' | 'page'
    this.view = 'tree';      // 'tree' | 'edit'
  }

  async init() {
    await this.initModuleStatus();
    await this._load();
    this._migrate();
    this.path = [{ id: '__root__', name: '根目录', children: this.nodes }];
    this.bindModuleSwitch();
    this.render();
    this.updateModuleUI();
  }

  getModuleName() { return 'MasterGo 导航'; }

  async _load() {
    const result = await chrome.storage.local.get([
      'mastergoNavNodes', 'mastergoNavGroups', 'mastergoNavPoolCapacity',
    ]);
    this.poolCapacity = result.mastergoNavPoolCapacity ?? 3;
    if (result.mastergoNavNodes) {
      this.nodes = result.mastergoNavNodes;
    } else if (result.mastergoNavGroups) {
      this.nodes = (result.mastergoNavGroups || []).map(g => ({
        id: g.id, name: g.name,
        children: (g.pages || []).map(p => ({ id: p.id, name: p.name, url: p.pageId ? `https://mastergo.com/file/${p.pageId}` : '' })),
      }));
    } else {
      this.nodes = [];
    }
  }

  _migrate() {
    const ensure = (nodes) => nodes.forEach(n => {
      if (!n.id) n.id = this._id();
      // 旧数据 pageId → url 迁移
      if (n.pageId && !n.url) {
        n.url = `https://mastergo.com/file/${n.pageId}`;
        delete n.pageId;
      }
      if (n.children) ensure(n.children);
    });
    ensure(this.nodes);
  }

  async _save() {
    await chrome.storage.local.set({ mastergoNavNodes: this.nodes });
  }

  _id() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
  }

  _currentChildren() {
    return this.path[this.path.length - 1].children;
  }

  // 收集所有项目（根目录一级的模块节点），用于移动时选择
  _allProjects() {
    return this.nodes.filter(n => Array.isArray(n.children));
  }

  // 根据 id 在整棵树中找节点的父 children 数组
  _findParent(id, nodes = this.nodes, parent = this.nodes) {
    for (const n of nodes) {
      if (n.id === id) return parent;
      if (n.children) {
        const found = this._findParent(id, n.children, n.children);
        if (found) return found;
      }
    }
    return null;
  }

  // 把节点从原位置移动到目标模块（或根目录）
  _moveNode(nodeId, targetParentId) {
    const srcParent = this._findParent(nodeId);
    if (!srcParent) return;
    const nodeIdx = srcParent.findIndex(n => n.id === nodeId);
    if (nodeIdx === -1) return;
    const [node] = srcParent.splice(nodeIdx, 1);

    if (targetParentId === '__root__') {
      this.nodes.push(node);
    } else {
      const targetParent = this._findById(targetParentId);
      if (targetParent && Array.isArray(targetParent.children)) {
        targetParent.children.push(node);
      }
    }
  }

  _findById(id, nodes = this.nodes) {
    for (const n of nodes) {
      if (n.id === id) return n;
      if (n.children) {
        const found = this._findById(id, n.children);
        if (found) return found;
      }
    }
    return null;
  }

  bindModuleSwitch() {
    const sw = document.getElementById('masterGoNavModuleEnabled');
    if (sw) sw.addEventListener('change', async (e) => {
      await this.toggleModuleEnabled(e.target.checked);
      this.updateModuleUI();
    });
  }

  updateModuleUI() {
    const sw = document.getElementById('masterGoNavModuleEnabled');
    if (sw) sw.checked = this.moduleEnabled;
    const content = document.getElementById('masterGoNavModuleContent');
    if (content) content.classList.toggle('disabled', !this.moduleEnabled);
  }

  // ─── 渲染入口 ──────────────────────────────────────────────────────────────
  render() {
    const c = document.getElementById('masterGoNavModuleContent');
    if (!c) return;
    c.innerHTML = '';
    this.view === 'tree' ? this._renderTree(c) : this._renderEdit(c);
  }

  // ─── 树视图 ───────────────────────────────────────────────────────────────
  _renderTree(c) {
    c.appendChild(this._breadcrumb());

    // 根目录顶部：Tab 池大小配置
    if (this.path.length === 1) {
      c.appendChild(this._renderPoolCapacity());
    }

    const isRoot = this.path.length === 1;
    const toolbar = document.createElement('div');
    toolbar.style.cssText = 'display:flex;gap:6px;justify-content:flex-end;margin-bottom:10px;';

    if (isRoot) {
      // 根目录只能加项目（模块）
      const addBtn = this._btn('+ 项目', 'primary', 'small');
      addBtn.title = '添加一个项目（顶层模块）';
      addBtn.addEventListener('click', () => this._openEdit(null, 'module'));
      toolbar.appendChild(addBtn);
    } else {
      // 模块内可以加子模块或页面
      const addModuleBtn = this._btn('+ 模块', 'secondary', 'small');
      const addPageBtn = this._btn('+ 页面', 'primary', 'small');
      addModuleBtn.addEventListener('click', () => this._openEdit(null, 'module'));
      addPageBtn.addEventListener('click', () => this._openEdit(null, 'page'));
      toolbar.appendChild(addModuleBtn);
      toolbar.appendChild(addPageBtn);
    }
    c.appendChild(toolbar);

    const children = this._currentChildren();
    if (!children.length) {
      const empty = document.createElement('p');
      empty.style.cssText = 'color:#999;font-size:12px;text-align:center;padding:16px 0;';
      empty.textContent = isRoot ? '暂无项目，点击上方按钮添加' : '暂无内容，点击上方按钮添加';
      c.appendChild(empty);
      return;
    }

    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
    children.forEach((node, idx) => list.appendChild(this._renderRow(node, idx, children)));
    c.appendChild(list);

    this._initDragSort(list, children);
  }

  _renderPoolCapacity() {
    const wrap = document.createElement('div');
    wrap.style.cssText = `
      display:flex;align-items:center;justify-content:space-between;
      padding:8px 10px;margin-bottom:10px;
      background:var(--card-bg);border:1px solid var(--border-color);border-radius:8px;
      font-size:13px;
    `;

    const label = document.createElement('span');
    label.style.cssText = 'color:var(--text-main);';
    label.textContent = 'Tab 池大小';

    const right = document.createElement('div');
    right.style.cssText = 'display:flex;align-items:center;gap:6px;';

    const hint = document.createElement('span');
    hint.style.cssText = 'font-size:11px;color:#999;';
    hint.textContent = '个标签页';

    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.max = '10';
    input.value = this.poolCapacity;
    input.style.cssText = `
      width:48px;padding:4px 6px;text-align:center;
      border:1px solid var(--border-color);border-radius:6px;
      font-size:13px;color:var(--text-main);background:var(--card-bg);outline:none;
    `;
    input.addEventListener('focus', () => input.style.borderColor = 'var(--accent-color)');
    input.addEventListener('blur',  () => input.style.borderColor = 'var(--border-color)');
    input.addEventListener('change', async () => {
      const v = Math.min(10, Math.max(1, parseInt(input.value) || 3));
      input.value = v;
      this.poolCapacity = v;
      await chrome.storage.local.set({ mastergoNavPoolCapacity: v });
      Toast.success('已保存', 1200);
    });

    right.appendChild(input);
    right.appendChild(hint);
    wrap.appendChild(label);
    wrap.appendChild(right);
    return wrap;
  }

  _breadcrumb() {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;align-items:center;flex-wrap:wrap;gap:2px;margin-bottom:10px;font-size:12px;color:#999;';

    this.path.forEach((seg, i) => {
      const isLast = i === this.path.length - 1;
      const crumb = document.createElement('span');
      crumb.textContent = seg.name;
      crumb.style.cssText = isLast
        ? 'color:var(--text-main);font-weight:600;'
        : 'color:var(--accent-color);cursor:pointer;';
      if (!isLast) crumb.addEventListener('click', () => {
        this.path = this.path.slice(0, i + 1);
        this.render();
      });
      wrap.appendChild(crumb);
      if (!isLast) {
        const sep = document.createElement('span');
        sep.textContent = ' › ';
        sep.style.cssText = 'color:#ccc;';
        wrap.appendChild(sep);
      }
    });

    return wrap;
  }

  _renderRow(node, idx, siblings) {
    const isModule = Array.isArray(node.children);
    const row = document.createElement('div');
    row.dataset.idx = idx;
    row.draggable = true;
    row.style.cssText = `
      display:flex;align-items:center;gap:6px;
      padding:7px 10px;
      background:var(--card-bg);
      border:1px solid var(--border-color);
      border-radius:8px;
      cursor:default;
    `;

    // 拖拽手柄
    const handle = document.createElement('span');
    handle.textContent = '⠿';
    handle.title = '拖拽排序';
    handle.style.cssText = 'font-size:14px;color:#ccc;cursor:grab;flex-shrink:0;line-height:1;';
    row.appendChild(handle);

    const icon = document.createElement('span');
    icon.style.cssText = 'font-size:11px;flex-shrink:0;color:#999;';
    icon.textContent = isModule ? '▶' : '◆';
    row.appendChild(icon);

    const name = document.createElement('span');
    name.style.cssText = 'flex:1;font-size:13px;color:var(--text-main);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    name.textContent = node.name;
    row.appendChild(name);

    if (!isModule) {
      const pid = document.createElement('span');
      pid.style.cssText = 'font-size:11px;flex-shrink:0;max-width:64px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      pid.style.color = node.url ? '#bbb' : 'var(--danger-color)';
      pid.textContent = node.url ? (() => { try { return new URL(node.url).pathname.split('/').pop() || node.url; } catch { return node.url; } })() : '未绑定';
      row.appendChild(pid);
    } else {
      const count = document.createElement('span');
      count.style.cssText = 'font-size:11px;color:#bbb;flex-shrink:0;';
      count.textContent = `${node.children.length}项`;
      row.appendChild(count);
    }

    const editBtn = this._iconBtn('✎', '编辑');
    editBtn.addEventListener('click', (e) => { e.stopPropagation(); this._openEdit(node); });
    row.appendChild(editBtn);

    const delBtn = this._iconBtn('✕', '删除');
    delBtn.style.color = 'var(--danger-color)';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const label = isModule ? `模块「${node.name}」及其所有子节点` : `页面「${node.name}」`;
      if (!confirm(`确认删除${label}？`)) return;
      siblings.splice(idx, 1);
      this._save();
      this.render();
    });
    row.appendChild(delBtn);

    if (isModule) {
      row.style.cursor = 'pointer';
      row.addEventListener('click', (e) => {
        if (e.target.closest('button') || e.target === handle) return;
        this.path.push(node);
        this.render();
      });
    }

    return row;
  }

  // ─── 拖拽排序 ────────────────────────────────────────────────────────────
  _initDragSort(list, siblings) {
    let dragging = null;

    list.addEventListener('dragstart', (e) => {
      dragging = e.target.closest('[draggable]');
      if (!dragging) return;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => dragging.style.opacity = '0.4', 0);
    });

    list.addEventListener('dragend', () => {
      if (dragging) dragging.style.opacity = '';
      list.querySelectorAll('.mg-drag-over').forEach(el => el.classList.remove('mg-drag-over'));
      dragging = null;
    });

    list.addEventListener('dragover', (e) => {
      e.preventDefault();
      const target = e.target.closest('[draggable]');
      if (!target || target === dragging) return;
      list.querySelectorAll('.mg-drag-over').forEach(el => el.classList.remove('mg-drag-over'));
      target.style.outline = '2px solid var(--accent-color)';
      target.classList.add('mg-drag-over');
    });

    list.addEventListener('dragleave', (e) => {
      const target = e.target.closest('[draggable]');
      if (target) { target.style.outline = ''; target.classList.remove('mg-drag-over'); }
    });

    list.addEventListener('drop', (e) => {
      e.preventDefault();
      const target = e.target.closest('[draggable]');
      if (!target || !dragging || target === dragging) return;
      target.style.outline = '';
      target.classList.remove('mg-drag-over');

      const fromIdx = parseInt(dragging.dataset.idx);
      const toIdx = parseInt(target.dataset.idx);
      if (isNaN(fromIdx) || isNaN(toIdx)) return;

      // 调整插入位置：拖到目标上方还是下方
      const rect = target.getBoundingClientRect();
      const insertBefore = e.clientY < rect.top + rect.height / 2;
      const insertIdx = insertBefore ? toIdx : toIdx + 1;

      const [item] = siblings.splice(fromIdx, 1);
      const finalIdx = insertIdx > fromIdx ? insertIdx - 1 : insertIdx;
      siblings.splice(finalIdx, 0, item);

      this._save();
      this.render();
    });
  }

  // ─── 编辑/新建节点 ────────────────────────────────────────────────────────
  _openEdit(node, forceType) {
    this.editingNode = node;
    this._editType = forceType || (node && Array.isArray(node.children) ? 'module' : 'page');
    this.view = 'edit';
    this.render();
  }

  _renderEdit(c) {
    const isNew = !this.editingNode;
    const isModule = this._editType === 'module';
    const isRoot = this.path.length === 1;

    // 标题
    const title = document.createElement('p');
    title.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-main);margin-bottom:12px;';
    title.textContent = isNew
      ? (isRoot ? '新建项目' : (isModule ? '新建模块' : '新建页面'))
      : (isModule ? '编辑模块' : '编辑页面');
    c.appendChild(title);

    // 名称
    const nameWrap = this._input('名称', this.editingNode?.name || '');
    c.appendChild(nameWrap);

    // 所属模块（根目录的项目不需要）
    let parentSelect = null;
    if (!isRoot || !isNew) {
      // 编辑时始终可以改所属模块（移动节点）
      // 新建时：在模块内部新建，默认当前模块，可以改到其他模块
      parentSelect = this._renderParentSelect(isNew ? this.path[this.path.length - 1] : this._getParentOf(this.editingNode?.id));
      if (parentSelect) c.appendChild(parentSelect);
    }

    // URL（仅页面）
    let urlInput = null;
    if (!isModule) {
      const urlRow = document.createElement('div');
      urlRow.style.cssText = 'display:flex;gap:6px;align-items:flex-end;';

      const urlWrap = document.createElement('div');
      urlWrap.style.cssText = 'flex:1;';
      urlInput = this._input('MasterGo 页面 URL', this.editingNode?.url || '');
      urlWrap.appendChild(urlInput);

      const fetchBtn = this._btn('抓取', 'secondary', 'small');
      fetchBtn.style.cssText += 'flex-shrink:0;height:32px;align-self:flex-end;margin-bottom:10px;';
      fetchBtn.title = '从当前 MasterGo 标签页自动抓取 URL';
      fetchBtn.addEventListener('click', async () => {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab?.url) { Toast.error('无法获取当前标签页'); return; }
          const url = new URL(tab.url);
          if (!url.hostname.includes('mastergo.com')) { Toast.error('当前标签页不是 MasterGo'); return; }
          // 只保留路径和 page_id
          const clean = new URL(url.origin + url.pathname);
          const pageId = url.searchParams.get('page_id');
          if (pageId) clean.searchParams.set('page_id', pageId);
          urlInput.querySelector('input').value = clean.toString();
          Toast.success('已抓取 URL', 1500);
        } catch { Toast.error('抓取失败'); }
      });

      urlRow.appendChild(urlWrap);
      urlRow.appendChild(fetchBtn);
      c.appendChild(urlRow);

      const hint = document.createElement('p');
      hint.style.cssText = 'font-size:11px;color:#999;margin-top:-4px;margin-bottom:12px;';
      hint.textContent = '在 MasterGo 切到对应页面后点「抓取」可自动填入';
      c.appendChild(hint);
    }

    // 按钮行
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;margin-top:4px;';

    const cancelBtn = this._btn('取消', 'secondary', 'small');
    cancelBtn.style.flex = '1';
    cancelBtn.addEventListener('click', () => { this.view = 'tree'; this.render(); });

    const saveBtn = this._btn('保存', 'primary', 'small');
    saveBtn.style.flex = '1';
    saveBtn.addEventListener('click', () => {
      const name = nameWrap.querySelector('input').value.trim();
      if (!name) { Toast.error('请输入名称'); return; }

      const selectedParentId = parentSelect?.querySelector('select')?.value ?? '__current__';

      if (isNew) {
        const newNode = isModule
          ? { id: this._id(), name, children: [] }
          : { id: this._id(), name, url: urlInput?.querySelector('input').value.trim() || '' };

        if (selectedParentId === '__root__') {
          this.nodes.push(newNode);
        } else if (selectedParentId === '__current__') {
          this._currentChildren().push(newNode);
        } else {
          const targetParent = this._findById(selectedParentId);
          if (targetParent) targetParent.children.push(newNode);
        }
      } else {
        // 更新名称和 pageId
        const node = this._findById(this.editingNode.id);
        if (node) {
          node.name = name;
          if (!isModule) node.url = urlInput?.querySelector('input').value.trim() || '';
        }
        // 移动节点
        const originalParentId = this._getParentIdOf(this.editingNode.id);
        if (selectedParentId && selectedParentId !== originalParentId) {
          this._moveNode(this.editingNode.id, selectedParentId);
          // 移动后重置路径到根
          this.path = [{ id: '__root__', name: '根目录', children: this.nodes }];
        }
      }

      this._save();
      this.view = 'tree';
      this.editingNode = null;
      this.render();
      Toast.success(isNew ? '已添加' : '已更新', 1500);
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(saveBtn);
    c.appendChild(btnRow);
  }

  // 渲染"所属模块"下拉
  _renderParentSelect(currentParent) {
    // 收集所有模块节点（包括根目录）作为可选父节点
    const options = [{ id: '__root__', label: '根目录（顶层项目）' }];
    const collect = (nodes, prefix = '') => {
      nodes.forEach(n => {
        if (Array.isArray(n.children)) {
          options.push({ id: n.id, label: prefix + n.name });
          collect(n.children, prefix + n.name + ' / ');
        }
      });
    };
    collect(this.nodes);

    if (options.length <= 1) return null; // 只有根目录时不显示

    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin-bottom:10px;';

    const label = document.createElement('label');
    label.style.cssText = 'font-size:11px;color:#999;display:block;margin-bottom:4px;';
    label.textContent = '所属模块';
    wrap.appendChild(label);

    const select = document.createElement('select');
    select.style.cssText = `
      width:100%;padding:7px 10px;border:1px solid var(--border-color);
      border-radius:8px;font-size:13px;color:var(--text-main);
      outline:none;background:var(--card-bg);box-sizing:border-box;
    `;

    options.forEach(opt => {
      const el = document.createElement('option');
      el.value = opt.id;
      el.textContent = opt.label;
      if (currentParent && opt.id === (currentParent.id || '__root__')) el.selected = true;
      select.appendChild(el);
    });

    select.addEventListener('focus', () => select.style.borderColor = 'var(--accent-color)');
    select.addEventListener('blur', () => select.style.borderColor = 'var(--border-color)');
    wrap.appendChild(select);
    return wrap;
  }

  // 找节点的父节点 id
  _getParentIdOf(nodeId, nodes = this.nodes, parentId = '__root__') {
    for (const n of nodes) {
      if (n.id === nodeId) return parentId;
      if (n.children) {
        const found = this._getParentIdOf(nodeId, n.children, n.id);
        if (found) return found;
      }
    }
    return null;
  }

  // 找节点的父节点对象
  _getParentOf(nodeId) {
    if (!nodeId) return this.path[this.path.length - 1];
    const parentId = this._getParentIdOf(nodeId);
    if (parentId === '__root__') return { id: '__root__', name: '根目录', children: this.nodes };
    return this._findById(parentId) || this.path[this.path.length - 1];
  }

  // ─── 工具方法 ──────────────────────────────────────────────────────────────
  _btn(text, type = 'primary', size = '') {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.className = ['btn', `btn-${type}`, size ? `btn-${size}` : ''].filter(Boolean).join(' ');
    return btn;
  }

  _iconBtn(icon, title) {
    const btn = document.createElement('button');
    btn.textContent = icon;
    btn.title = title;
    btn.style.cssText = 'background:none;border:none;cursor:pointer;color:#999;font-size:13px;padding:2px 4px;flex-shrink:0;line-height:1;';
    return btn;
  }

  _input(placeholder, value = '') {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin-bottom:10px;';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = placeholder;
    input.value = value;
    input.style.cssText = `
      width:100%;padding:7px 10px;border:1px solid var(--border-color);
      border-radius:8px;font-size:13px;color:var(--text-main);
      outline:none;background:var(--card-bg);box-sizing:border-box;
    `;
    input.addEventListener('focus', () => input.style.borderColor = 'var(--accent-color)');
    input.addEventListener('blur', () => input.style.borderColor = 'var(--border-color)');
    wrap.appendChild(input);
    return wrap;
  }
}
