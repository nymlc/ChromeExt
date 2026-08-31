/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-04-27 10:00:00
 * @FilePath: /ChromeExt/popup/modules/CredentialManager.js
 * @Description: 凭证管理功能模块 - 项目/凭证的增删改查
 */

class CredentialManager extends BaseModule {
    constructor() {
        super('credential');
        this.projects = [];
        this.currentView = 'list';       // list | detail | editCred
        this.currentProject = null;
        this.editingCredential = null;
        this.pageTitle = '';
        this.credentialViewMode = 'tab'; // tab | list，默认 tab
        this.activeTabIndex = 0;         // 当前激活的 Tab 索引
        this.activeTagKey = null;        // 当前激活标签，避免标签顺序变化后串组
        this.suppressNativeAutofill = true; // 默认抑制页面登录框聚焦时的 Chrome 原生密码建议
    }

    async init() {
        await this.initModuleStatus();
        await this.loadProjects();
        await this.getPageTitle();

        // 预读域名绑定信息，供详情页显示按钮状态
        const ub = await chrome.storage.local.get(['urlProjectBindings']);
        this.urlBindings = ub.urlProjectBindings || {};
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            this.currentHost = tab?.url ? new URL(tab.url).hostname : '';
        } catch (e) {
            this.currentHost = '';
        }

        // 读取视图偏好
        const prefResult = await chrome.storage.local.get(['credentialViewMode']);
        if (prefResult.credentialViewMode) {
            this.credentialViewMode = prefResult.credentialViewMode;
        }

        // 读取「抑制原生密码建议」偏好（默认开启；false 才关闭）
        const suppressResult = await chrome.storage.local.get(['suppressNativeAutofill']);
        this.suppressNativeAutofill = suppressResult.suppressNativeAutofill !== false;

        // 绑定模块开关事件
        this.bindModuleSwitch();

        // 优先使用手动绑定的项目，其次自动匹配
        const bound = await this.getBoundProject();
        const matched = bound || this.findProjectByTitle(this.pageTitle);
        if (matched) {
            this.currentProject = matched;
            this.currentView = 'detail';
        }

        // 监听凭证项目存储变更（如页面浮层内拖拽排序、其它标签页采集等），
        // 实时重载 projects 并刷新 currentProject 引用后重渲染，避免弹窗显示旧顺序。
        // 编辑视图（editCred）下只更新数据不重渲染，避免打断正在填写的表单。
        this._onCredentialProjectsChanged = (changes, area) => {
            if (area && area !== 'local') return;
            if (!changes || !changes.credentialProjects) return;
            (async () => {
                await this.loadProjects();
                if (this.currentProject) {
                    this.currentProject = this.projects.find(p => p.id === this.currentProject.id) || this.currentProject;
                }
                if (this.currentView !== 'editCred') this.render();
            })();
        };
        chrome.storage.onChanged.addListener(this._onCredentialProjectsChanged);

        this.render();
        this.updateModuleUI();
    }

    /**
     * 绑定模块开关事件
     */
    bindModuleSwitch() {
        const moduleSwitch = document.getElementById('credentialModuleEnabled');
        if (moduleSwitch) {
            moduleSwitch.addEventListener('change', async (e) => {
                await this.toggleModuleEnabled(e.target.checked);
                this.updateModuleUI();
            });
        }
    }

    /**
     * 更新模块 UI 状态（开关 + 内容区禁用）
     */
    updateModuleUI() {
        const moduleSwitch = document.getElementById('credentialModuleEnabled');
        if (moduleSwitch) moduleSwitch.checked = this.moduleEnabled;

        const moduleContent = document.getElementById('credentialModuleContent');
        if (moduleContent) moduleContent.classList.toggle('disabled', !this.moduleEnabled);
    }

    async loadProjects() {
        const result = await chrome.storage.local.get(['credentialProjects']);
        const projects = result.credentialProjects || [];
        // 存量兼容：note 是历史字段名，统一按多值标签数组在内存中使用。
        projects.forEach(p => {
            p.credentials.forEach(c => {
                c.note = CredentialTagUtils.normalizeTags(c.note);
            });
        });
        this.projects = projects;
    }

    async saveProjects() {
        await chrome.storage.local.set({ credentialProjects: this.projects });
        // 通知 content script 数据已更新
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab) {
                await chrome.tabs.sendMessage(tab.id, { action: 'credentialProjectUpdated' });
            }
        } catch (e) { /* 忽略 */ }
    }

    async getPageTitle() {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            this.pageTitle = tab?.title || '';
        } catch (e) {
            this.pageTitle = '';
        }
    }

    getModuleName() {
        return '凭证管理';
    }

    generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
    }

    /**
     * 比较两个标签集合是否等价（忽略顺序、首尾空格、空标签）。
     * 用于凭证判重：用户名相同 + 标签相同 => 视为同一条（覆盖）；标签不同 => 视为不同条目（并存）。
     */
    tagsEqual(a, b) {
        return CredentialTagUtils.tagsEqual(a, b);
    }

    normalizeTags(value) {
        return CredentialTagUtils.normalizeTags(value);
    }

    // ==================== 渲染 ====================

    render() {
        const container = document.getElementById('credentialModuleContent');
        if (!container) return;

        container.innerHTML = '';
        // 顶部常驻：全局偏好（抑制页面登录框的原生 Chrome 密码建议），各视图通用
        this._renderGlobalPrefs(container);
        switch (this.currentView) {
            case 'list':
                this.renderProjectList(container);
                break;
            case 'detail':
                this.renderProjectDetail(container);
                break;
            case 'editCred':
                this.renderCredentialEdit(container);
                break;
        }
    }

    /**
     * 渲染顶部常驻的全局偏好行（抑制页面登录框聚焦时的 Chrome 原生密码建议）。
     * 通过 StorageState 广播，content 脚本会实时收到开关变化并应用/还原。
     */
    _renderGlobalPrefs(container) {
        const row = document.createElement('div');
        row.className = 'setting-item';
        row.style.cssText = 'margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px solid #eee;';

        const label = document.createElement('span');
        label.textContent = '抑制页面登录框的原生密码建议';
        label.title = '开启后，聚焦被识别的用户名/密码框时不再弹出 Chrome 自带的密码管理器建议（与扩展浮层冲突时可关闭）';

        const sw = document.createElement('label');
        sw.className = 'switch';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.id = 'suppressNativeAutofill';
        input.checked = this.suppressNativeAutofill;
        input.addEventListener('change', async () => {
            this.suppressNativeAutofill = input.checked;
            await chrome.storage.local.set({ suppressNativeAutofill: input.checked });
        });
        const slider = document.createElement('span');
        slider.className = 'slider';
        sw.appendChild(input);
        sw.appendChild(slider);

        row.appendChild(label);
        row.appendChild(sw);
        container.appendChild(row);
    }

    /**
     * 第一层：项目列表
     */
    renderProjectList(container) {
        // 指定当前页面使用的项目
        if (this.projects.length > 0) {
            const bindRow = document.createElement('div');
            bindRow.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 10px; font-size: 12px;';

            const bindLabel = document.createElement('span');
            bindLabel.textContent = '当前页面项目：';
            bindLabel.style.cssText = 'color: #999; white-space: nowrap;';

            const select = document.createElement('select');
            select.style.cssText = `
      flex: 1; padding: 4px 6px; border: 1px solid #e0e0e0; border-radius: 6px;
      font-size: 12px; color: #333; outline: none; background: #fff; min-width: 0;
    `;

            const autoOpt = document.createElement('option');
            autoOpt.value = '';
            autoOpt.textContent = '未匹配';
            select.appendChild(autoOpt);

            this.projects.forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.id;
                opt.textContent = p.name;
                select.appendChild(opt);
            });

            select.addEventListener('change', async () => {
                const selectedId = select.value;
                if (selectedId) {
                    await this.bindProjectToPage(selectedId);
                    this.currentProject = this.projects.find(p => p.id === selectedId);
                    this.currentView = 'detail';
                    // 通知 content script
                    try {
                        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                        if (tab) await chrome.tabs.sendMessage(tab.id, { action: 'credentialProjectUpdated' });
                    } catch (e) { /* 忽略 */ }
                    this.render();
                }
            });

            bindRow.appendChild(bindLabel);
            bindRow.appendChild(select);
            container.appendChild(bindRow);
        }

        // 新建项目按钮
        const addBtn = document.createElement('button');
        addBtn.className = 'btn btn-primary btn-block';
        addBtn.textContent = '+ 新建项目';
        addBtn.addEventListener('click', () => this.createProject());
        container.appendChild(addBtn);

        if (this.projects.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'hint';
            empty.textContent = '暂无保存的项目';
            container.appendChild(empty);
            return;
        }

        // 项目列表
        const list = document.createElement('div');
        list.className = 'credential-project-list scrollable-area';
        list.style.cssText = 'margin-top: 10px; display: flex; flex-direction: column; gap: 8px;';

        this.projects.forEach(project => {
            const card = document.createElement('div');
            card.className = 'credential-project-card';
            card.style.cssText = `
        background: #f8f9ff; border-radius: 8px; padding: 10px 12px;
        cursor: pointer; transition: background 0.15s; display: flex;
        justify-content: space-between; align-items: center;
      `;
            card.addEventListener('mouseenter', () => { card.style.background = '#eef0ff'; });
            card.addEventListener('mouseleave', () => { card.style.background = '#f8f9ff'; });

            const info = document.createElement('div');
            info.addEventListener('click', () => {
                this.currentProject = project;
                this.currentView = 'detail';
                this.render();
            });
            info.style.cssText = 'flex: 1; min-width: 0;';

            const name = document.createElement('div');
            name.style.cssText = 'font-weight: 600; color: #333; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
            name.textContent = project.name;

            const count = document.createElement('div');
            count.style.cssText = 'font-size: 11px; color: #999; margin-top: 2px;';
            const activeCount = project.credentials.filter(c => c.status === 'active').length;
            const disabledCount = project.credentials.filter(c => c.status === 'disabled').length;
            let countText = `${activeCount} 个凭证`;
            if (disabledCount > 0) countText += `，${disabledCount} 个已失效`;
            count.textContent = countText;

            info.appendChild(name);
            info.appendChild(count);
            card.appendChild(info);

            // 删除按钮
            const delBtn = document.createElement('span');
            delBtn.textContent = '🗑️';
            delBtn.style.cssText = 'cursor: pointer; font-size: 14px; padding: 4px; flex-shrink: 0;';
            delBtn.title = '删除项目';
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.deleteProject(project.id);
            });
            card.appendChild(delBtn);

            list.appendChild(card);
        });

        container.appendChild(list);
    }

    /**
     * 第二层：项目详情 - 凭证列表
     */
    renderProjectDetail(container) {
        const project = this.currentProject;
        if (!project) return;

        // 顶部：返回 + 项目名
        const header = document.createElement('div');
        header.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 10px;';

        const backBtn = document.createElement('span');
        backBtn.textContent = '←';
        backBtn.style.cssText = 'cursor: pointer; font-size: 18px; color: #667eea; font-weight: bold;';
        backBtn.addEventListener('click', () => {
            this.currentView = 'list';
            this.currentProject = null;
            this.render();
        });

        const titleInput = document.createElement('input');
        titleInput.type = 'text';
        titleInput.value = project.name;
        titleInput.style.cssText = `
      flex: 1; border: 1px solid transparent; border-radius: 6px; padding: 4px 8px;
      font-size: 14px; font-weight: 600; color: #333; background: transparent;
      transition: border-color 0.2s;
    `;
        titleInput.addEventListener('focus', () => { titleInput.style.borderColor = '#667eea'; });
        titleInput.addEventListener('blur', async () => {
            titleInput.style.borderColor = 'transparent';
            if (titleInput.value.trim() && titleInput.value !== project.name) {
                project.name = titleInput.value.trim();
                project.matchTitle = project.name;
                project.updatedAt = Date.now();
                await this.saveProjects();
                Toast.success('项目名已更新');
            }
        });

        header.appendChild(backBtn);
        header.appendChild(titleInput);
        container.appendChild(header);

        // 域名绑定行（URL 绑定，对 hash 路由 SPA 更可靠，免依赖页面 title）
        if (this.currentHost) {
            const urlRow = document.createElement('div');
            urlRow.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 10px; font-size: 12px;';
            const urlLabel = document.createElement('span');
            urlLabel.textContent = '域名绑定：';
            urlLabel.style.cssText = 'color: #999; white-space: nowrap;';
            const isBound = this.urlBindings[this.currentHost] === project.id;
            const urlBtn = document.createElement('button');
            urlBtn.className = 'btn btn-secondary btn-small';
            urlBtn.textContent = isBound ? '✓ 已绑定本域名（点击解除）' : '绑定当前域名';
            urlBtn.style.cssText = `font-size: 11px; padding: 3px 8px; ${isBound ? 'border-color:#667eea; color:#667eea;' : ''}`;
            urlBtn.addEventListener('click', () => this.toggleUrlBinding());
            const hostTip = document.createElement('span');
            hostTip.textContent = this.currentHost;
            hostTip.style.cssText = 'color: #aaa; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0;';
            urlRow.appendChild(urlLabel);
            urlRow.appendChild(urlBtn);
            urlRow.appendChild(hostTip);
            container.appendChild(urlRow);
        }

        // 切换项目下拉
        if (this.projects.length > 1) {
            const switchRow = document.createElement('div');
            switchRow.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 10px; font-size: 12px;';

            const switchLabel = document.createElement('span');
            switchLabel.textContent = '指定项目：';
            switchLabel.style.cssText = 'color: #999; white-space: nowrap;';

            const select = document.createElement('select');
            select.style.cssText = `
      flex: 1; padding: 4px 6px; border: 1px solid #e0e0e0; border-radius: 6px;
      font-size: 12px; color: #333; outline: none; background: #fff; min-width: 0;
    `;

            // 自动匹配选项
            const autoOpt = document.createElement('option');
            autoOpt.value = '';
            autoOpt.textContent = '自动匹配';
            select.appendChild(autoOpt);

            this.projects.forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.id;
                opt.textContent = p.name;
                if (p.id === project.id) opt.selected = true;
                select.appendChild(opt);
            });

            // 如果是手动绑定的，选中对应项目；否则选"自动匹配"
            this.getBoundProject().then(bound => {
                if (bound) {
                    select.value = bound.id;
                } else {
                    // 当前是自动匹配到的，不选"自动匹配"，而是选中当前项目
                    select.value = project.id;
                }
            });

            select.addEventListener('change', async () => {
                const selectedId = select.value;
                if (!selectedId) {
                    // 清除手动绑定，恢复自动匹配
                    await this.bindProjectToPage(null);
                    const matched = this.findProjectByTitle(this.pageTitle);
                    if (matched) {
                        this.currentProject = matched;
                    } else {
                        this.currentProject = null;
                        this.currentView = 'list';
                    }
                } else {
                    await this.bindProjectToPage(selectedId);
                    this.currentProject = this.projects.find(p => p.id === selectedId);
                }
                // 通知 content script 重新匹配
                try {
                    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                    if (tab) {
                        await chrome.tabs.sendMessage(tab.id, { action: 'credentialProjectUpdated' });
                    }
                } catch (e) { /* 忽略 */ }
                this.render();
            });

            switchRow.appendChild(switchLabel);
            switchRow.appendChild(select);
            container.appendChild(switchRow);
        }

        // 标签是多值分类，Tab 仅作为标签集合的浏览方式。
        const namedGroups = [];
        project.credentials.forEach(c => {
            this.normalizeTags(c.note).forEach(tag => {
                if (!namedGroups.some(item => CredentialTagUtils.keyOf(item) === CredentialTagUtils.keyOf(tag))) {
                    namedGroups.push(tag);
                }
            });
        });
        const hasUngrouped = project.credentials.some(c => this.normalizeTags(c.note).length === 0);
        // 标签模式下始终保留「其他」作为默认分组：否则当所有凭证都带标签时，没有「其他」页，
        // 每次采集都会被强制带上某个命名标签。
        const forceUngrouped = this.credentialViewMode === 'tab';
        const tabGroups = (hasUngrouped || forceUngrouped) ? [...namedGroups, ''] : namedGroups;
        // 应用用户自定义标签页顺序（拖拽排序持久化到 project.tabOrder；新标签自动追加到末尾，「其他」始终最后）
        const orderedGroups = this.orderTabGroups(tabGroups, project.tabOrder);
        // 只要存在命名标签，就保留标签上下文；单一标签分组也能用于采集。
        const useTabMode = this.credentialViewMode === 'tab' && namedGroups.length > 0;
        this.tabGroups = orderedGroups;
        // 无有效选中时：默认定位到第一个标签（打开即高亮显示当前标签）；「其他」始终常驻，可点选以采集无标签凭证
        if (!orderedGroups.some(tag => tag === this.activeTagKey)) {
            this.activeTagKey = orderedGroups[0] ?? null;
        }
        this.activeTabIndex = Math.max(0, orderedGroups.indexOf(this.activeTagKey));

        if (project.credentials.length > 0) {
            const viewToggleRow = document.createElement('div');
            viewToggleRow.style.cssText = 'display: flex; justify-content: flex-end; margin-bottom: 6px;';
            const toggleBtn = document.createElement('button');
            const isTab = this.credentialViewMode === 'tab';
            toggleBtn.textContent = isTab ? '≡ 列表' : '⊟ 标签';
            toggleBtn.title = isTab ? '切换为列表模式' : '切换为标签模式';
            toggleBtn.style.cssText = `
                font-size: 11px; padding: 2px 8px; border: 1px solid #d0d0e8; border-radius: 4px;
                background: #f0f1fa; color: #667eea; cursor: pointer; transition: background 0.15s;
            `;
            toggleBtn.addEventListener('mouseenter', () => { toggleBtn.style.background = '#e4e6f8'; });
            toggleBtn.addEventListener('mouseleave', () => { toggleBtn.style.background = '#f0f1fa'; });
            toggleBtn.addEventListener('click', async () => {
                this.credentialViewMode = isTab ? 'list' : 'tab';
                this.activeTabIndex = 0;
                this.activeTagKey = this.tabGroups?.[0] ?? null;
                await chrome.storage.local.set({ credentialViewMode: this.credentialViewMode });
                this.render();
                // 通知页面内浮动弹框同步视图模式，否则需刷新页面才生效
                try {
                    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                    if (tab?.id) {
                        chrome.tabs.sendMessage(tab.id, { action: 'credentialViewModeChanged', mode: this.credentialViewMode }).catch(() => {});
                    }
                } catch (e) { /* 页面无 content script 时忽略 */ }
            });
            viewToggleRow.appendChild(toggleBtn);
            container.appendChild(viewToggleRow);
        }

        // 凭证列表：active 在前，disabled 在后
        const sorted = [...project.credentials].sort((a, b) => {
            if (a.status === 'active' && b.status !== 'active') return -1;
            if (a.status !== 'active' && b.status === 'active') return 1;
            return 0;
        });

        if (sorted.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'hint';
            empty.textContent = '暂无凭证，点击下方按钮添加';
            container.appendChild(empty);
        }

        const createSVGIcon = (type, title) => {
            const svgNS = "http://www.w3.org/2000/svg";
            const svg = document.createElementNS(svgNS, "svg");
            svg.setAttribute("viewBox", "0 0 24 24");
            svg.setAttribute("fill", "none");
            svg.setAttribute("stroke", "currentColor");
            svg.setAttribute("stroke-width", "2");
            svg.setAttribute("stroke-linecap", "round");
            svg.setAttribute("stroke-linejoin", "round");
            svg.style.cssText = 'width: 16px; height: 16px; opacity: 0.6; transition: all 0.15s;';
            let innerHTML = '';
            if (type === 'fill') {
                innerHTML = '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/>';
            } else if (type === 'disable') {
                innerHTML = '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/>';
            } else if (type === 'enable') {
                innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
            } else if (type === 'edit') {
                innerHTML = '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>';
            } else if (type === 'delete') {
                innerHTML = '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>';
            }
            svg.innerHTML = innerHTML;
            const wrapper = document.createElement('div');
            wrapper.title = title;
            wrapper.style.cssText = 'cursor: pointer; display: flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 6px; transition: background 0.15s;';
            wrapper.appendChild(svg);
            wrapper.addEventListener('mouseenter', () => {
                svg.style.opacity = '1';
                wrapper.style.background = type === 'delete' ? '#ffebee' : '#eef0ff';
                svg.style.color = type === 'delete' ? '#f44336' : '#667eea';
            });
            wrapper.addEventListener('mouseleave', () => {
                svg.style.opacity = '0.6';
                wrapper.style.background = 'transparent';
                svg.style.color = 'inherit';
            });
            return wrapper;
        };

        const buildCredCard = (cred) => {
            const isDisabled = cred.status === 'disabled';
            const card = document.createElement('div');
            card.style.cssText = `
                background: ${isDisabled ? '#fafafa' : '#f8f9ff'}; border-radius: 8px; padding: 10px 12px;
                opacity: ${isDisabled ? '0.6' : '1'}; border-left: 3px solid ${isDisabled ? '#ccc' : '#667eea'};
            `;

            const row1 = document.createElement('div');
            row1.style.cssText = 'display: flex; justify-content: space-between; align-items: center;';

            const labelEl = document.createElement('div');
            labelEl.style.cssText = 'font-weight: 600; color: #333; font-size: 13px; display: flex; align-items: center; gap: 6px;';
            labelEl.textContent = cred.label || '未命名';
            if (isDisabled) {
                const badge = document.createElement('span');
                badge.textContent = cred.disabledReason || '已失效';
                badge.style.cssText = 'font-size: 10px; font-weight: 400; color: #f44336; background: #ffebee; padding: 1px 6px; border-radius: 4px;';
                labelEl.appendChild(badge);
            }

            const actions = document.createElement('div');
            actions.style.cssText = 'display: flex; gap: 6px; align-items: center;';

            const fillBtn = createSVGIcon('fill', '填充到页面');
            fillBtn.addEventListener('click', () => this.fillCredential(cred));

            const toggleBtn = createSVGIcon(isDisabled ? 'enable' : 'disable', isDisabled ? '恢复正常' : '标记失效');
            toggleBtn.addEventListener('click', () => this.toggleCredentialStatus(project, cred));

            const editBtn = createSVGIcon('edit', '编辑');
            editBtn.addEventListener('click', () => {
                this.editingCredential = cred;
                this.currentView = 'editCred';
                this.render();
            });

            const delBtn = createSVGIcon('delete', '删除');
            delBtn.addEventListener('click', () => this.deleteCredential(project, cred.id));

            actions.appendChild(fillBtn);
            actions.appendChild(toggleBtn);
            actions.appendChild(editBtn);
            actions.appendChild(delBtn);
            row1.appendChild(labelEl);
            row1.appendChild(actions);
            card.appendChild(row1);

            const row2 = document.createElement('div');
            row2.style.cssText = 'font-size: 12px; color: #888; margin-top: 4px;';
            row2.textContent = cred.username;
            card.appendChild(row2);

            // 始终展示完整标签集合；当前分组只做视觉强调，不隐藏归属。
            const tagsToShow = this.normalizeTags(cred.note);
            if (tagsToShow.length > 0) {
                const noteRow = document.createElement('div');
                noteRow.style.cssText = 'display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px;';
                tagsToShow.forEach(tag => {
                    const isCurrent = useTabMode && CredentialTagUtils.keyOf(tag) === CredentialTagUtils.keyOf(this.activeTagKey || '');
                    const tagEl = document.createElement('span');
                    tagEl.textContent = tag;
                    tagEl.style.cssText = `
                        font-size: 11px; color: ${isCurrent ? '#5b3db2' : '#996b00'};
                        background: ${isCurrent ? '#f0ebff' : '#fffbf0'};
                        border-radius: 4px; padding: 1px 6px;
                        border: 1px solid ${isCurrent ? '#a890e8' : '#f0c060'}; line-height: 1.5;
                    `;
                    noteRow.appendChild(tagEl);
                });
                card.appendChild(noteRow);
            }
            return card;
        };

        if (useTabMode) {
            // Tab 栏
            const tabBar = document.createElement('div');
            tabBar.style.cssText = `
                display: flex; gap: 0; overflow-x: auto; border-bottom: 2px solid #e8eaf6;
                margin-bottom: 8px; scrollbar-width: none; flex-shrink: 0;
            `;
            tabBar.style.setProperty('scrollbar-width', 'none');

            // 拖拽插入指示线：绝对定位覆盖在 tab 栏上，不与源标签的「抬起」阴影冲突
            tabBar.style.position = 'relative';
            const dropLine = document.createElement('div');
            dropLine.style.cssText = 'position:absolute; top:4px; bottom:4px; width:3px; background:#667eea; border-radius:2px; display:none; pointer-events:none; z-index:5;';
            tabBar.appendChild(dropLine);

            this.tabGroups.forEach((tabKey, idx) => {
                const tabLabel = tabKey === '' ? '其他' : tabKey;
                const tab = document.createElement('div');
                const isActive = tabKey === this.activeTagKey;
                const isUngrouped = tabKey === '';
                tab.dataset.tabKey = tabKey;
                if (isActive) tab.classList.add('cmf-active-tab');
                tab.style.cssText = `
                    position: relative; display: flex; align-items: center; gap: 3px;
                    padding: 5px 12px; font-size: 12px; cursor: ${isUngrouped ? 'pointer' : 'grab'};
                    white-space: nowrap; border-bottom: 2px solid ${isActive ? '#667eea' : 'transparent'};
                    color: ${isActive ? '#667eea' : '#888'}; font-weight: ${isActive ? '600' : '400'};
                    margin-bottom: -2px; transition: color 0.15s, background 0.15s, box-shadow 0.15s, opacity 0.15s;
                `;
                // 命名标签：悬停淡入的拖拽手柄，提升可发现性
                let grip = null;
                if (!isUngrouped) {
                    grip = document.createElement('span');
                    grip.textContent = '⠿';
                    grip.style.cssText = 'font-size: 11px; line-height: 1; color: #c0c0c8; opacity: 0; transition: opacity 0.15s; user-select: none;';
                    tab.appendChild(grip);
                }
                const labelSpan = document.createElement('span');
                labelSpan.textContent = tabLabel;
                tab.appendChild(labelSpan);
                tab.title = isUngrouped ? '其他分组（固定末尾，不参与排序）' : '拖动可调整顺序';
                // 命名标签页支持拖拽排序（「其他」固定末尾不参与）。
                // 采用指针事件实现（非原生 HTML5 DnD）：扩展 popup 内原生拖拽会话极易被中断、
                // drop 不触发，指针事件更稳定、落点更可控。
                if (!isUngrouped) {
                    tab.style.userSelect = 'none';
                    tab.style.webkitUserSelect = 'none';
                    tab.addEventListener('pointerdown', (e) => {
                        if (e.button !== 0) return; // 仅响应左键
                        // setPointerCapture：即便光标短暂离开 popup 窗口也能持续收到 pointermove/up
                        let captured = false;
                        try { tab.setPointerCapture(e.pointerId); captured = true; } catch (_) {}
                        const st = {
                            startX: e.clientX, startY: e.clientY,
                            dragging: false,
                            srcKey: tabKey, srcTab: tab,
                            targetTab: null, targetKey: null, targetAfter: false,
                        };
                        const clearTargets = () => {
                            tabBar.querySelectorAll('.cmf-drop-target').forEach(t => {
                                t.style.background = '';
                                t.classList.remove('cmf-drop-target');
                            });
                        };
                        const onMove = (ev) => {
                            if (!st.dragging) {
                                const dx = ev.clientX - st.startX, dy = ev.clientY - st.startY;
                                if (Math.hypot(dx, dy) < 4) return; // 阈值：区分点击与拖拽
                                st.dragging = true;
                                st.srcTab.classList.add('cmf-dragging');
                                st.srcTab.style.opacity = '0.55';
                                st.srcTab.style.boxShadow = '0 3px 8px rgba(102,126,234,0.35)';
                                dropLine.style.display = 'block';
                                document.body.style.cursor = 'grabbing';
                            }
                            clearTargets();
                            // 基于光标 x 计算「有效落点」：整行命中（标签间缝隙/边缘也算），
                            // 且仅当会产生真实顺序变化时才显示指示线并允许落定——避免「拖了没反应」。
                            const barRect = tabBar.getBoundingClientRect();
                            const cx = ev.clientX, cy = ev.clientY;
                            const inRow = cy >= barRect.top - 10 && cy <= barRect.bottom + 10
                                       && cx >= barRect.left - 10 && cx <= barRect.right + 10;
                            let landTarget = null, landAfter = false, landLeft = 0, changed = false;
                            if (inRow) {
                                const namedEls = [...tabBar.querySelectorAll('[data-tab-key]')]
                                    .filter(t => t.dataset.tabKey && t.dataset.tabKey !== '');
                                const others = namedEls.filter(t => t !== st.srcTab);
                                const ins = others.filter(t => {
                                    const r = t.getBoundingClientRect();
                                    return cx > r.left + r.width / 2;
                                }).length;
                                const curOrder = namedEls.map(t => t.dataset.tabKey);
                                const newOrder = others.map(t => t.dataset.tabKey);
                                newOrder.splice(ins, 0, st.srcKey);
                                changed = newOrder.length === curOrder.length
                                       && newOrder.some((k, i) => k !== curOrder[i]);
                                if (changed) {
                                    if (ins < others.length) {
                                        landTarget = others[ins];
                                        landAfter = false;
                                    } else {
                                        landTarget = others[others.length - 1];
                                        landAfter = true;
                                    }
                                    const r = landTarget.getBoundingClientRect();
                                    landLeft = (landAfter ? r.right : r.left) - barRect.left - 1.5;
                                }
                            }
                            if (changed && landTarget) {
                                dropLine.style.left = landLeft + 'px';
                                dropLine.style.display = 'block';
                                landTarget.style.background = '#f0f1ff';
                                landTarget.classList.add('cmf-drop-target');
                                st.targetTab = landTarget;
                                st.targetKey = landTarget.dataset.tabKey;
                                st.targetAfter = landAfter;
                            } else {
                                dropLine.style.display = 'none';
                                st.targetTab = null; st.targetKey = null;
                            }
                        };
                        const onUp = (ev) => {
                            document.removeEventListener('pointermove', onMove);
                            document.removeEventListener('pointerup', onUp);
                            document.body.style.cursor = '';
                            if (captured) { try { tab.releasePointerCapture(ev.pointerId); } catch (_) {} }
                            dropLine.style.display = 'none';
                            clearTargets();
                            if (!st.dragging) return; // 未发生拖拽，按普通点击处理
                            st.srcTab.classList.remove('cmf-dragging');
                            st.srcTab.style.opacity = '';
                            st.srcTab.style.boxShadow = '';
                            if (st.targetKey && st.targetKey !== st.srcKey) {
                                this._suppressNextClick = true;
                                this.reorderTabGroups(st.srcKey, st.targetKey, st.targetAfter ? 'after' : 'before');
                            }
                        };
                        document.addEventListener('pointermove', onMove);
                        document.addEventListener('pointerup', onUp);
                    });
                }
                tab.addEventListener('click', () => {
                    if (this._suppressNextClick) { this._suppressNextClick = false; return; }
                    this.activeTabIndex = idx;
                    this.activeTagKey = tabKey;
                    this.render();
                });
                tab.addEventListener('mouseenter', () => {
                    if (!isActive) tab.style.color = '#555';
                    if (grip) grip.style.opacity = '1';
                });
                tab.addEventListener('mouseleave', () => {
                    if (!isActive) tab.style.color = '#888';
                    if (grip && !tab.classList.contains('cmf-dragging')) grip.style.opacity = '0';
                });
                tabBar.appendChild(tab);
            });
            container.appendChild(tabBar);

            // 当前 Tab 的凭证列表
            const currentKey = this.activeTagKey;
            const tabCreds = sorted.filter(c => {
                const tags = this.normalizeTags(c.note);
                return currentKey === '' ? tags.length === 0 : CredentialTagUtils.hasTag(tags, currentKey);
            });

            const list = document.createElement('div');
            list.className = 'scrollable-area';
            list.style.cssText = 'display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px;';
            tabCreds.forEach(cred => list.appendChild(buildCredCard(cred)));
            container.appendChild(list);
        } else {
            const list = document.createElement('div');
            list.className = 'scrollable-area';
            list.style.cssText = 'display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px;';
            sorted.forEach(cred => list.appendChild(buildCredCard(cred)));
            container.appendChild(list);
        }

        // 操作按钮区
        const btnGroup = document.createElement('div');
        btnGroup.style.cssText = 'display: flex; gap: 8px; flex-shrink: 0; margin-top: auto;';

        const addBtn = document.createElement('button');
        addBtn.className = 'btn btn-primary';
        addBtn.style.cssText = 'flex: 1; font-size: 12px; padding: 8px;';
        addBtn.textContent = '+ 添加凭证';
        addBtn.addEventListener('click', () => {
            this.editingCredential = null;
            this.currentView = 'editCred';
            this.render();
        });

        const saveFromPageBtn = document.createElement('button');
        saveFromPageBtn.className = 'btn btn-secondary';
        saveFromPageBtn.style.cssText = 'flex: 1; font-size: 12px; padding: 8px;';
        saveFromPageBtn.textContent = '从页面采集';
        saveFromPageBtn.addEventListener('click', () => this.scanAndSave());

        btnGroup.appendChild(addBtn);
        btnGroup.appendChild(saveFromPageBtn);
        container.appendChild(btnGroup);
    }

    /**
     * 第三层：新建/编辑凭证
     */
    renderCredentialEdit(container) {
        const isEdit = !!this.editingCredential;
        const cred = this.editingCredential || { label: '', username: '', password: '', note: [], customFields: [], status: 'active', disabledReason: '' };

        // 返回按钮
        const header = document.createElement('div');
        header.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 10px;';
        const backBtn = document.createElement('span');
        backBtn.textContent = '←';
        backBtn.style.cssText = 'cursor: pointer; font-size: 18px; color: #667eea; font-weight: bold;';
        backBtn.addEventListener('click', () => {
            this.currentView = 'detail';
            this.editingCredential = null;
            this.render();
        });
        const title = document.createElement('span');
        title.textContent = isEdit ? '编辑凭证' : '新建凭证';
        title.style.cssText = 'font-size: 14px; font-weight: 600; color: #333;';
        header.appendChild(backBtn);
        header.appendChild(title);
        container.appendChild(header);

        const form = document.createElement('div');
        form.className = 'scrollable-area';
        form.style.cssText = 'display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px;';

        // 备注名
        const labelInput = this.createInput('备注名', cred.label, '如：管理员账号');
        // 用户名
        const usernameInput = this.createInput('用户名', cred.username, '请输入用户名');
        // 密码
        const passwordInput = this.createInput('密码', cred.password, '请输入密码', 'text');
        // 标签
        const noteWrapper = this.createNoteInput(cred.note);

        form.appendChild(labelInput.wrapper);
        form.appendChild(usernameInput.wrapper);
        form.appendChild(passwordInput.wrapper);
        form.appendChild(noteWrapper.wrapper);

        // 自定义字段区域
        const customFieldsContainer = document.createElement('div');
        customFieldsContainer.style.cssText = 'display: flex; flex-direction: column; gap: 6px;';

        const cfTitle = document.createElement('div');
        cfTitle.style.cssText = 'font-size: 12px; color: #999; margin-top: 4px;';
        cfTitle.textContent = '自定义字段';
        customFieldsContainer.appendChild(cfTitle);

        const fieldsWrapper = document.createElement('div');
        fieldsWrapper.style.cssText = 'display: flex; flex-direction: column; gap: 6px;';
        customFieldsContainer.appendChild(fieldsWrapper);

        // 已有的自定义字段
        const customFieldInputs = [];
        (cred.customFields || []).forEach(field => {
            const row = this.createCustomFieldRow(field.label, field.value, field.selector, fieldsWrapper, customFieldInputs);
            customFieldInputs.push(row);
            fieldsWrapper.appendChild(row.wrapper);
        });

        // 添加自定义字段按钮
        const addFieldBtn = document.createElement('button');
        addFieldBtn.className = 'btn btn-secondary btn-small';
        addFieldBtn.textContent = '+ 添加字段';
        addFieldBtn.style.cssText = 'align-self: flex-start; margin-top: 4px; font-size: 11px;';
        addFieldBtn.addEventListener('click', () => {
            const row = this.createCustomFieldRow('', '', '', fieldsWrapper, customFieldInputs);
            customFieldInputs.push(row);
            fieldsWrapper.appendChild(row.wrapper);
        });
        customFieldsContainer.appendChild(addFieldBtn);

        form.appendChild(customFieldsContainer);

        // 保存按钮
        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn btn-primary btn-block';
        saveBtn.textContent = '保存';
        saveBtn.style.marginTop = '8px';
        saveBtn.addEventListener('click', async () => {
            const username = usernameInput.input.value.trim();
            const password = passwordInput.input.value.trim();
            if (!username || !password) {
                Toast.warning('用户名和密码不能为空');
                return;
            }

            const customFields = customFieldInputs
                .filter(cf => cf.labelInput.value.trim() && cf.valueInput.value.trim())
                .map(cf => ({
                    label: cf.labelInput.value.trim(),
                    value: cf.valueInput.value.trim(),
                    selector: cf.selectorInput.value.trim()
                }));

            if (isEdit) {
                cred.label = labelInput.input.value.trim() || '未命名';
                cred.username = username;
                cred.password = password;
                cred.customFields = customFields;
                cred.note = noteWrapper.getTags();
            } else {
                // 用户名 + 标签 都相同才视为重复（覆盖）；标签不同则当作不同条目并存
                const newTags = noteWrapper.getTags();
                const existingIdx = this.currentProject.credentials.findIndex(c =>
                    c.username === username && !!username && this.tagsEqual(c.note, newTags));
                if (existingIdx >= 0) {
                    const existing = this.currentProject.credentials[existingIdx];
                    existing.label = labelInput.input.value.trim() || existing.label;
                    existing.username = username;
                    existing.password = password;
                    existing.customFields = customFields;
                    existing.note = newTags;
                    Toast.success('同名且同标签，已覆盖更新');
                } else {
                    this.currentProject.credentials.push({
                        id: this.generateId(),
                        label: labelInput.input.value.trim() || '未命名',
                        username,
                        password,
                        customFields,
                        note: noteWrapper.getTags(),
                        status: 'active',
                        disabledReason: ''
                    });
                }
            }

            this.currentProject.updatedAt = Date.now();
            await this.saveProjects();
            Toast.success(isEdit ? '凭证已更新' : '凭证已保存');
            this.currentView = 'detail';
            this.editingCredential = null;
            this.render();
        });

        container.appendChild(form);
        
        saveBtn.style.flexShrink = '0';
        container.appendChild(saveBtn);
    }

    /**
     * 创建输入框组件
     */
    createInput(labelText, value, placeholder, type = 'text') {
        const wrapper = document.createElement('div');
        const label = document.createElement('div');
        label.textContent = labelText;
        label.style.cssText = 'font-size: 12px; color: #666; margin-bottom: 3px;';

        const input = document.createElement('input');
        input.type = type;
        input.value = value || '';
        input.placeholder = placeholder || '';
        input.style.cssText = `
      width: 100%; padding: 8px 10px; border: 1px solid #e0e0e0; border-radius: 6px;
      font-size: 13px; outline: none; transition: border-color 0.2s; box-sizing: border-box;
    `;
        input.addEventListener('focus', () => { input.style.borderColor = '#667eea'; });
        input.addEventListener('blur', () => { input.style.borderColor = '#e0e0e0'; });

        wrapper.appendChild(label);
        wrapper.appendChild(input);
        return { wrapper, input };
    }

    /**
     * 创建备注 tag 输入组件
     * 返回 { wrapper, getTags }，getTags() 返回当前 tag 数组
     */
    createNoteInput(initialTags) {
        const tags = this.normalizeTags(initialTags);
        const wrapper = document.createElement('section');
        wrapper.className = 'cmf-tag-panel';

        const label = document.createElement('label');
        const inputId = `credentialTagInput_${this.generateId()}`;
        label.htmlFor = inputId;
        label.className = 'cmf-tag-panel-title';
        label.textContent = '标签';

        const hint = document.createElement('p');
        hint.className = 'cmf-tag-panel-hint';
        hint.textContent = '用于分组；新建后点击添加或按 Enter、逗号确认';

        const usage = new Map();
        (this.currentProject?.credentials || []).forEach(credential => {
            this.normalizeTags(credential.note).forEach(tag => {
                const key = CredentialTagUtils.keyOf(tag);
                const entry = usage.get(key) || { tag, count: 0 };
                entry.count += 1;
                usage.set(key, entry);
            });
        });
        const recommendations = [...usage.values()].sort((a, b) =>
            b.count - a.count || a.tag.localeCompare(b.tag, 'zh-CN'));

        const selectedSection = document.createElement('div');
        selectedSection.className = 'cmf-tag-selected';
        const selectedLabel = document.createElement('span');
        selectedLabel.className = 'cmf-tag-section-label';
        selectedLabel.textContent = '已添加';
        const selectedList = document.createElement('div');
        selectedList.className = 'cmf-tag-list';
        selectedList.setAttribute('role', 'list');
        const selectedEmpty = document.createElement('span');
        selectedEmpty.className = 'cmf-tag-empty';
        selectedEmpty.textContent = '暂未添加标签';
        selectedSection.append(selectedLabel, selectedList, selectedEmpty);

        const createRow = document.createElement('div');
        createRow.className = 'cmf-tag-create-row';
        const input = document.createElement('input');
        input.id = inputId;
        input.type = 'text';
        input.className = 'cmf-tag-create-input';
        input.placeholder = '输入新标签';
        input.autocomplete = 'off';
        const addButton = document.createElement('button');
        addButton.type = 'button';
        addButton.className = 'cmf-tag-add-button';
        addButton.textContent = '添加';
        createRow.append(input, addButton);

        const recommendationSection = document.createElement('div');
        recommendationSection.className = 'cmf-tag-recommendations';
        const recommendationId = `credentialTagRecommendations_${this.generateId()}`;
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'cmf-tag-recommendations-toggle';
        toggle.setAttribute('aria-controls', recommendationId);
        let isExpanded = true;
        const recommendationList = document.createElement('div');
        recommendationList.id = recommendationId;
        recommendationList.className = 'cmf-tag-recommendations-list';
        recommendationList.setAttribute('role', 'list');
        recommendationSection.append(toggle, recommendationList);

        const getScrollState = () => {
            const scrollEl = wrapper.closest('.scrollable-area');
            const wasFocused = document.activeElement === input;
            return {
                scrollEl,
                top: scrollEl?.scrollTop || 0,
                left: scrollEl?.scrollLeft || 0,
                wasFocused,
                start: wasFocused ? input.selectionStart : null,
                end: wasFocused ? input.selectionEnd : null,
            };
        };
        const restoreScrollState = (state) => {
            requestAnimationFrame(() => {
                if (state.scrollEl?.isConnected) {
                    state.scrollEl.scrollTop = state.top;
                    state.scrollEl.scrollLeft = state.left;
                }
                if (state.wasFocused && input.isConnected) {
                    input.focus({ preventScroll: true });
                    if (typeof input.setSelectionRange === 'function') input.setSelectionRange(state.start, state.end);
                }
            });
        };
        const isSelected = (tag) => tags.some(item => CredentialTagUtils.keyOf(item) === CredentialTagUtils.keyOf(tag));
        const refreshToggle = () => {
            toggle.textContent = `常用标签（${recommendations.length}） ${isExpanded ? '⌃' : '⌄'}`;
            toggle.setAttribute('aria-expanded', String(isExpanded));
            recommendationList.hidden = !isExpanded;
        };
        const renderSelected = () => {
            selectedList.innerHTML = '';
            selectedEmpty.hidden = tags.length > 0;
            tags.forEach((tag, index) => {
                const chip = document.createElement('span');
                chip.className = 'cmf-tag-chip';
                chip.setAttribute('role', 'listitem');
                const text = document.createElement('span');
                text.textContent = tag;
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'cmf-tag-remove';
                remove.textContent = '×';
                remove.setAttribute('aria-label', `移除标签：${tag}`);
                remove.addEventListener('click', () => {
                    tags.splice(index, 1);
                    renderAll();
                    input.focus();
                });
                chip.append(text, remove);
                selectedList.appendChild(chip);
            });
        };
        const renderRecommendations = () => {
            recommendationList.innerHTML = '';
            if (!recommendations.length) {
                const empty = document.createElement('span');
                empty.className = 'cmf-tag-empty';
                empty.textContent = '当前项目暂无可推荐标签';
                recommendationList.appendChild(empty);
                return;
            }
            recommendations.forEach(({ tag, count }) => {
                const selected = isSelected(tag);
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'cmf-tag-recommendation';
                button.setAttribute('aria-pressed', String(selected));
                button.setAttribute('aria-label', `${selected ? '移除' : '添加'}标签：${tag}，已被 ${count} 个凭证使用`);
                button.textContent = `${tag} · ${count}`;
                button.addEventListener('click', () => {
                    const index = tags.findIndex(item => CredentialTagUtils.keyOf(item) === CredentialTagUtils.keyOf(tag));
                    if (index >= 0) tags.splice(index, 1);
                    else tags.push(tag);
                    renderAll();
                });
                recommendationList.appendChild(button);
            });
        };
        const renderAll = () => {
            const scrollState = getScrollState();
            const normalized = this.normalizeTags(tags);
            tags.splice(0, tags.length, ...normalized);
            renderSelected();
            renderRecommendations();
            refreshToggle();
            restoreScrollState(scrollState);
        };
        const commitInput = () => {
            const raw = input.value.replace(/[，、,]$/, '').trim();
            const tag = this.normalizeTags([raw])[0];
            if (!tag || isSelected(tag)) return false;
            tags.push(tag);
            input.value = '';
            renderAll();
            return true;
        };

        addButton.addEventListener('click', () => {
            commitInput();
            input.focus();
        });
        input.addEventListener('keydown', (event) => {
            if (event.isComposing) return;
            if (event.key === 'Enter' || event.key === ',' || event.key === '，' || event.key === '、') {
                event.preventDefault();
                commitInput();
            } else if (event.key === 'Backspace' && !input.value && tags.length) {
                tags.pop();
                renderAll();
            } else if (event.key === 'Escape') {
                if (input.value) input.value = '';
                else {
                    isExpanded = false;
                    refreshToggle();
                }
            }
        });
        toggle.addEventListener('click', () => {
            isExpanded = !isExpanded;
            refreshToggle();
        });

        renderAll();
        wrapper.append(label, hint, selectedSection, createRow, recommendationSection);
        return { wrapper, getTags: () => this.normalizeTags(tags) };
    }

    /**
     * 创建自定义字段行
     */
    createCustomFieldRow(label, value, selector, fieldsWrapper, customFieldInputs) {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'display: flex; gap: 4px; align-items: center;';

        const inputStyle = `
      flex: 1; padding: 6px 8px; border: 1px solid #e0e0e0; border-radius: 6px;
      font-size: 12px; outline: none; min-width: 0; box-sizing: border-box;
    `;

        const labelInput = document.createElement('input');
        labelInput.placeholder = '字段名';
        labelInput.value = label || '';
        labelInput.style.cssText = inputStyle;

        const valueInput = document.createElement('input');
        valueInput.placeholder = '值';
        valueInput.value = value || '';
        valueInput.style.cssText = inputStyle;

        const selectorInput = document.createElement('input');
        selectorInput.placeholder = 'selector';
        selectorInput.value = selector || '';
        selectorInput.style.cssText = inputStyle + 'flex: 0.8;';

        const delBtn = document.createElement('span');
        delBtn.textContent = '✕';
        delBtn.style.cssText = 'cursor: pointer; color: #f44336; font-size: 14px; padding: 2px 4px; flex-shrink: 0;';
        delBtn.addEventListener('click', () => {
            wrapper.remove();
            const idx = customFieldInputs.findIndex(cf => cf.wrapper === wrapper);
            if (idx >= 0) customFieldInputs.splice(idx, 1);
        });

        wrapper.appendChild(labelInput);
        wrapper.appendChild(valueInput);
        wrapper.appendChild(selectorInput);
        wrapper.appendChild(delBtn);

        return { wrapper, labelInput, valueInput, selectorInput };
    }

    // ==================== 操作方法 ====================

    /**
     * 新建项目
     */
    async createProject() {
        // 检查项目名是否重复
        const name = this.pageTitle || '新项目';
        const existing = this.projects.find(p => p.name === name);
        if (existing) {
            Toast.warning('项目已存在，已跳转到该项目');
            this.currentProject = existing;
            this.currentView = 'detail';
            this.render();
            return;
        }

        const project = {
            id: this.generateId(),
            name,
            matchTitle: name,
            credentials: [],
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        this.projects.push(project);
        await this.saveProjects();
        Toast.success('项目已创建');
        this.currentProject = project;
        this.currentView = 'detail';
        this.render();
    }

    /**
     * 删除项目
     */
    async deleteProject(projectId) {
        this.projects = this.projects.filter(p => p.id !== projectId);
        await this.saveProjects();
        Toast.success('项目已删除');
        this.render();
    }

    /**
     * 删除凭证
     */
    async deleteCredential(project, credId) {
        project.credentials = project.credentials.filter(c => c.id !== credId);
        project.updatedAt = Date.now();
        await this.saveProjects();
        Toast.success('凭证已删除');
        this.render();
    }

    /**
     * 切换凭证状态（active / disabled）
     */
    async toggleCredentialStatus(project, cred) {
        if (cred.status === 'active') {
            // 弹出输入失效原因
            const reason = prompt('请输入失效原因（可选）：', '');
            cred.status = 'disabled';
            cred.disabledReason = reason || '已失效';
        } else {
            cred.status = 'active';
            cred.disabledReason = '';
        }
        project.updatedAt = Date.now();
        await this.saveProjects();
        Toast.success(cred.status === 'active' ? '凭证已恢复' : '凭证已标记失效');
        this.render();
    }

    /**
     * 填充凭证到当前页面
     */
    async fillCredential(cred) {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            await chrome.tabs.sendMessage(tab.id, {
                action: 'fillCredential',
                credential: cred
            });
            Toast.success('凭证已填充');
        } catch (e) {
            Toast.error('填充失败，请刷新页面后重试');
        }
    }

    /**
     * 从页面采集输入框内容并保存为凭证
     */
    async scanAndSave() {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

            // 全 frame 扫描，取已填写字段最多的一帧：
            // sendMessage 广播由最先响应的 frame 决定结果，跨域 iframe 登录页
            // （顶层无输入框）可能被空响应抢占而漏采，故改为逐帧直采后合并
            let response = null;
            try {
                const results = await chrome.scripting.executeScript({
                    target: { tabId: tab.id, allFrames: true },
                    func: () => {
                        const filler = globalThis.__geekToolboxManager?.modules?.credentialFiller;
                        if (!filler) return null;
                        return { success: true, fields: filler.scanInputs(), hasPasswordField: filler.hasPasswordField() };
                    }
                });
                const frames = (results || [])
                    .map(item => item && item.result)
                    .filter(r => r && Array.isArray(r.fields));
                frames.sort((a, b) => b.fields.length - a.fields.length);
                response = frames[0] || null;
            } catch (e) {
                response = null;
            }
            // 注入不可用（受限页面或旧版内容脚本未挂全局实例）时回退到消息通道
            if (!response) {
                response = await chrome.tabs.sendMessage(tab.id, { action: 'scanPageInputs' });
            }

            if (!response?.success || !response.fields?.length) {
                Toast.warning('未检测到已填写的输入框');
                return;
            }

            const fields = response.fields;
            const passwordField = fields.find(f => f.type === 'password');
            const usernameField = fields.find(f => f.type === 'username');
            const customFields = fields.filter(f => f.type === 'custom').map(f => ({
                label: f.label,
                value: f.value,
                selector: f.selector
            }));

            const username = (usernameField ? usernameField.value : '').trim();
            const password = passwordField ? passwordField.value : '';
            // 用户名/手机号是凭证的身份标识，不可缺失
            if (!username) {
                Toast.warning('请先填写用户名或手机号再采集');
                return;
            }
            // 短信验证码等无密码登录页没有密码框可采，允许仅采集用户名/手机号；
            // 存在可见密码框的账号密码登录页仍要求两者都完整
            if (response.hasPasswordField && password.length === 0) {
                Toast.warning('用户名和密码必须都填写完整才能采集');
                return;
            }

            // 采集的目标项目 = 用户当前正在查看的项目（与详情页 UI 完全一致）。
            // 若因异常缺失，则回退到按页面 title 自动匹配/新建，保证不崩溃。
            let project = this.currentProject || this.findProjectByTitle(this.pageTitle);
            if (!project) {
                project = {
                    id: this.generateId(),
                    name: this.pageTitle || '新项目',
                    matchTitle: this.pageTitle || '新项目',
                    credentials: [],
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                };
                this.projects.push(project);
            }

            // 标签视图下才将当前标签作为采集上下文；列表视图保持无标签采集。
            const currentTabKey = this.credentialViewMode === 'tab' ? (this.activeTagKey || '') : '';
            const contextTags = this.normalizeTags(currentTabKey);
            const newCred = {
                id: this.generateId(),
                label: username || '采集的凭证',
                username,
                password,
                customFields,
                note: contextTags,
                status: 'active',
                disabledReason: ''
            };

            let existingIdx = project.credentials.findIndex(c =>
                c.username === username && !!username && this.tagsEqual(c.note, contextTags));
            if (existingIdx < 0 && contextTags.length) {
                const contextMatches = project.credentials
                    .map((credential, index) => ({ credential, index }))
                    .filter(({ credential }) => credential.username === username
                        && CredentialTagUtils.hasTag(credential.note, contextTags[0]));
                if (contextMatches.length === 1) existingIdx = contextMatches[0].index;
            }

            if (existingIdx >= 0) {
                const existing = project.credentials[existingIdx];
                newCred.id = existing.id;
                newCred.status = existing.status;
                newCred.disabledReason = existing.disabledReason;
                newCred.note = this.normalizeTags(existing.note);
                project.credentials[existingIdx] = newCred;
                Toast.success(currentTabKey ? `「${currentTabKey}」下已存在同名账号，已覆盖更新` : '凭证已覆盖更新');
            } else {
                project.credentials.push(newCred);
                Toast.success(currentTabKey ? `凭证已采集到「${currentTabKey}」` : '凭证已保存到项目：' + project.name);
            }

            project.updatedAt = Date.now();
            await this.saveProjects();
            this.currentProject = project;
            this.currentView = 'detail';
            this.render();

        } catch (e) {
            Toast.error('采集失败，请刷新页面后重试');
        }
    }

    /**
     * 在当前域名上绑定/解绑项目（URL 匹配，对 hash 路由 SPA 等 title 不稳的页面更可靠）
     */
    async toggleUrlBinding() {
        if (!this.currentProject) {
            Toast.warning('请先进入一个项目再绑定本域名');
            return;
        }
        if (!this.currentHost) {
            Toast.warning('无法获取当前页面域名');
            return;
        }
        const result = await chrome.storage.local.get(['urlProjectBindings']);
        const m = result.urlProjectBindings || {};
        if (m[this.currentHost] === this.currentProject.id) {
            delete m[this.currentHost];
            this.urlBindings[this.currentHost] = undefined;
            await chrome.storage.local.set({ urlProjectBindings: m });
            Toast.success('已解除域名绑定');
        } else {
            m[this.currentHost] = this.currentProject.id;
            this.urlBindings[this.currentHost] = this.currentProject.id;
            await chrome.storage.local.set({ urlProjectBindings: m });
            Toast.success('已绑定到域名 ' + this.currentHost);
        }
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab) await chrome.tabs.sendMessage(tab.id, { action: 'credentialProjectUpdated' });
        } catch (e) { /* 忽略 */ }
        this.render();
    }

    /**
     * 根据页面 title 模糊匹配已有项目
     */
    findProjectByTitle(title) {
        if (!title) return null;
        const t = title.toLowerCase();
        return this.projects.find(p => {
            if (!p.matchTitle) return false;
            const mt = p.matchTitle.toLowerCase();
            return t.includes(mt) || mt.includes(t);
        }) || null;
    }

    /**
     * 获取当前页面手动绑定的项目
     */
    async getBoundProject() {
        const result = await chrome.storage.local.get(['titleProjectBindings']);
        const bindings = result.titleProjectBindings || {};
        const projectId = bindings[this.pageTitle];
        if (!projectId) return null;
        return this.projects.find(p => p.id === projectId) || null;
    }

    /**
     * 手动绑定当前页面到指定项目
     * 同时以 标题 与 域名 作为键写入，保证 content 脚本（只能拿到 hostname）也能命中。
     */
    async bindProjectToPage(projectId) {
        const result = await chrome.storage.local.get(['titleProjectBindings']);
        const bindings = result.titleProjectBindings || {};
        // 用标题与域名作为候选键，空 title 页面会回退到域名（与 content 侧匹配键一致）
        const keys = [this.pageTitle, this.currentHost].filter(Boolean);
        keys.forEach((k) => {
            if (projectId) {
                bindings[k] = projectId;
            } else {
                delete bindings[k];
            }
        });
        await chrome.storage.local.set({ titleProjectBindings: bindings });
    }

    /**
     * 按用户自定义顺序排列表签分组；新出现的标签追加到末尾，「其他」始终最后。
     * @param {string[]} groups 原始分组（含 '' 表示「其他」）
     * @param {string[]|undefined} order  用户保存的顺序（小写 tag key）
     * @returns {string[]}
     */
    orderTabGroups(groups, order) {
        const named = groups.filter(g => g !== '');
        const orderArr = (order || []).map(k => CredentialTagUtils.keyOf(k));
        const ordered = named
            .map(g => ({ key: CredentialTagUtils.keyOf(g), g }))
            .sort((a, b) => {
                const ia = orderArr.indexOf(a.key);
                const ib = orderArr.indexOf(b.key);
                if (ia === -1 && ib === -1) return 0;   // 都不在自定义顺序中：保持原相对顺序
                if (ia === -1) return 1;                 // 新标签排到后面
                if (ib === -1) return -1;
                return ia - ib;
            })
            .map(x => x.g);
        const hasUngrouped = groups.includes('');
        return hasUngrouped ? [...ordered, ''] : ordered;
    }

    /**
     * 拖拽完成后更新并持久化标签顺序，然后重渲染。
     * 「其他」固定末尾不参与排序；拖到「其他」上视为无效操作。
     */
    async reorderTabGroups(draggedKey, targetKey, position = 'before') {
        const project = this.currentProject;
        if (!project || !draggedKey || !targetKey) return;
        const dKey = CredentialTagUtils.keyOf(draggedKey);
        const tKey = CredentialTagUtils.keyOf(targetKey);
        if (dKey === tKey || tKey === '') return;
        // 仅对命名标签页排序（当前 this.tabGroups 已是上一轮排好序的列表）
        const current = this.tabGroups.filter(g => g !== '').map(g => CredentialTagUtils.keyOf(g));
        const dIdx = current.indexOf(dKey);
        const tIdx = current.indexOf(tKey);
        if (dIdx === -1 || tIdx === -1) return;
        current.splice(dIdx, 1);
        const insertAt = position === 'after' ? current.indexOf(tKey) + 1 : current.indexOf(tKey);
        current.splice(insertAt, 0, dKey);
        project.tabOrder = current;
        await this.saveProjects();
        this.render();
    }
}
