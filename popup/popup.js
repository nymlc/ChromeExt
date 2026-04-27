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
    };
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

    // 初始化密码模块
    this.modules.passwordToggle = new PasswordToggle();
    await this.modules.passwordToggle.init();

    this.modules.credentialManager = new CredentialManager();
    await this.modules.credentialManager.init();

    // 恢复模块顺序并初始化拖拽
    await this.restoreModuleOrder();
    this.initDragSort();
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

  bindGlobalEvents() {
    const globalToggle = document.getElementById('globalToggle');
    globalToggle.addEventListener('click', () => this.toggleGlobal());

    document.getElementById('exportDataBtn').addEventListener('click', () => this.showExportDialog());
    document.getElementById('importDataBtn').addEventListener('click', () => this.showImportDialog());
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
    const globalToggleText = document.getElementById('globalToggleText');

    if (this.globalEnabled) {
      globalToggleText.textContent = '已启用';
      globalToggle.className = 'btn btn-small btn-primary';
    } else {
      globalToggleText.textContent = '已禁用';
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
        keys: ['credentialProjects', 'titleProjectBindings']
      },
      password: {
        name: '密码显示',
        keys: ['passwordModuleEnabled', 'disabledPasswordSites']
      },
      global: {
        name: '全局设置',
        keys: ['globalDisabledSites', 'moduleOrder']
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
    const data = {
      version: '1.0.0',
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
      const importing = dataToImport.credentialProjects;

      importing.forEach(importProject => {
        const existingProject = existing.find(p => p.name === importProject.name);
        if (existingProject) {
          (importProject.credentials || []).forEach(cred => {
            const existingCred = existingProject.credentials.find(c => c.username === cred.username);
            if (existingCred) {
              Object.assign(existingCred, cred, { id: existingCred.id });
            } else {
              existingProject.credentials.push(cred);
            }
          });
          existingProject.updatedAt = Date.now();
        } else {
          existing.push(importProject);
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
