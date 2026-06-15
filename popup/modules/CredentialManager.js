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
    }

    async init() {
        await this.initModuleStatus();
        await this.loadProjects();
        await this.getPageTitle();

        // 读取视图偏好
        const prefResult = await chrome.storage.local.get(['credentialViewMode']);
        if (prefResult.credentialViewMode) {
            this.credentialViewMode = prefResult.credentialViewMode;
        }

        // 绑定模块开关事件
        this.bindModuleSwitch();

        // 优先使用手动绑定的项目，其次自动匹配
        const bound = await this.getBoundProject();
        const matched = bound || this.findProjectByTitle(this.pageTitle);
        if (matched) {
            this.currentProject = matched;
            this.currentView = 'detail';
        }

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
        // 存量迁移：note string → string[]
        projects.forEach(p => {
            p.credentials.forEach(c => {
                if (typeof c.note === 'string') {
                    c.note = c.note ? [c.note] : [];
                } else if (!Array.isArray(c.note)) {
                    c.note = [];
                }
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

    // ==================== 渲染 ====================

    render() {
        const container = document.getElementById('credentialModuleContent');
        if (!container) return;

        container.innerHTML = '';
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

        // 视图切换行（仅在凭证数 > 0 且有多于 1 个分组时显示）
        const allNotes = [];
        project.credentials.forEach(c => {
            const ns = Array.isArray(c.note) ? c.note : (c.note ? [c.note] : []);
            ns.forEach(n => { if (!allNotes.includes(n)) allNotes.push(n); });
            if (ns.length === 0 && !allNotes.includes('')) allNotes.push('');
        });
        const tabGroups = allNotes.filter(n => n !== '');
        const hasUngrouped = project.credentials.some(c => {
            const ns = Array.isArray(c.note) ? c.note : (c.note ? [c.note] : []);
            return ns.length === 0;
        });
        if (hasUngrouped) tabGroups.push('');
        const useTabMode = this.credentialViewMode === 'tab' && tabGroups.length > 1;

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
                await chrome.storage.local.set({ credentialViewMode: this.credentialViewMode });
                this.render();
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

            // 列表模式下仍显示 note tags；tab 模式下不重复显示当前 tab 对应的 tag，其余 tag 仍展示
            const notes = Array.isArray(cred.note) ? cred.note : (cred.note ? [cred.note] : []);
            const tagsToShow = useTabMode
                ? notes.filter(n => n !== tabGroups[this.activeTabIndex])
                : notes;
            if (tagsToShow.length > 0) {
                const noteRow = document.createElement('div');
                noteRow.style.cssText = 'display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px;';
                tagsToShow.forEach(tag => {
                    const tagEl = document.createElement('span');
                    tagEl.textContent = tag;
                    tagEl.style.cssText = `
                        font-size: 11px; color: #996b00; background: #fffbf0;
                        border-radius: 4px; padding: 1px 6px;
                        border: 1px solid #f0c060; line-height: 1.5;
                    `;
                    noteRow.appendChild(tagEl);
                });
                card.appendChild(noteRow);
            }
            return card;
        };

        if (useTabMode) {
            // 越界保护
            if (this.activeTabIndex >= tabGroups.length) this.activeTabIndex = 0;

            // Tab 栏
            const tabBar = document.createElement('div');
            tabBar.style.cssText = `
                display: flex; gap: 0; overflow-x: auto; border-bottom: 2px solid #e8eaf6;
                margin-bottom: 8px; scrollbar-width: none; flex-shrink: 0;
            `;
            tabBar.style.setProperty('scrollbar-width', 'none');

            tabGroups.forEach((tabKey, idx) => {
                const tabLabel = tabKey === '' ? '其他' : tabKey;
                const tab = document.createElement('div');
                const isActive = idx === this.activeTabIndex;
                tab.textContent = tabLabel;
                tab.style.cssText = `
                    padding: 5px 12px; font-size: 12px; cursor: pointer; white-space: nowrap;
                    border-bottom: 2px solid ${isActive ? '#667eea' : 'transparent'};
                    color: ${isActive ? '#667eea' : '#888'}; font-weight: ${isActive ? '600' : '400'};
                    margin-bottom: -2px; transition: color 0.15s;
                `;
                tab.addEventListener('click', () => {
                    this.activeTabIndex = idx;
                    this.render();
                });
                tab.addEventListener('mouseenter', () => {
                    if (!isActive) tab.style.color = '#555';
                });
                tab.addEventListener('mouseleave', () => {
                    if (!isActive) tab.style.color = '#888';
                });
                tabBar.appendChild(tab);
            });
            container.appendChild(tabBar);

            // 当前 Tab 的凭证列表
            const currentKey = tabGroups[this.activeTabIndex];
            const tabCreds = sorted.filter(c => {
                const ns = Array.isArray(c.note) ? c.note : (c.note ? [c.note] : []);
                return currentKey === '' ? ns.length === 0 : ns.includes(currentKey);
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
        // 备注
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
                // 用户名重复则覆盖
                const existingIdx = this.currentProject.credentials.findIndex(c => c.username === username);
                if (existingIdx >= 0) {
                    const existing = this.currentProject.credentials[existingIdx];
                    existing.label = labelInput.input.value.trim() || existing.label;
                    existing.username = username;
                    existing.password = password;
                    existing.customFields = customFields;
                    existing.note = noteWrapper.getTags();
                    Toast.success('同名用户已存在，已覆盖更新');
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
        const tags = Array.isArray(initialTags) ? [...initialTags] : (initialTags ? [initialTags] : []);
        const wrapper = document.createElement('div');

        const label = document.createElement('div');
        label.textContent = '备注';
        label.style.cssText = 'font-size: 12px; color: #666; margin-bottom: 3px;';

        // 获取当前项目下已有的所有 tag（候选提示）
        const allTags = new Set();
        if (this.currentProject) {
            this.currentProject.credentials.forEach(c => {
                const notes = Array.isArray(c.note) ? c.note : (c.note ? [c.note] : []);
                notes.forEach(t => allTags.add(t));
            });
        }

        const tagContainer = document.createElement('div');
        tagContainer.style.cssText = `
            min-height: 36px; padding: 4px 8px; border: 1px solid #e0e0e0; border-radius: 6px;
            display: flex; flex-wrap: wrap; gap: 4px; align-items: center;
            cursor: text; transition: border-color 0.2s; background: #fff;
        `;
        tagContainer.addEventListener('click', () => input.focus());

        const renderTags = () => {
            // 清掉旧 tag 元素（保留 input）
            Array.from(tagContainer.children).forEach(el => {
                if (el !== input && el !== suggestBox) tagContainer.removeChild(el);
            });
            tags.forEach((tag, idx) => {
                const chip = document.createElement('span');
                chip.style.cssText = `
                    display: inline-flex; align-items: center; gap: 3px;
                    font-size: 11px; color: #996b00; background: #fffbf0;
                    border: 1px solid #f0c060; border-radius: 4px; padding: 1px 5px;
                    line-height: 1.6;
                `;
                const chipText = document.createElement('span');
                chipText.textContent = tag;
                const chipDel = document.createElement('span');
                chipDel.textContent = '×';
                chipDel.style.cssText = 'cursor: pointer; font-size: 13px; color: #c0a000; margin-left: 1px;';
                chipDel.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    tags.splice(idx, 1);
                    renderTags();
                });
                chip.appendChild(chipText);
                chip.appendChild(chipDel);
                tagContainer.insertBefore(chip, input);
            });
        };

        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = tags.length === 0 ? '输入备注回车添加，如：测试、线上' : '';
        input.style.cssText = `
            border: none; outline: none; font-size: 12px; flex: 1; min-width: 80px;
            background: transparent; color: #555; font-family: inherit; padding: 2px 0;
        `;

        // 候选提示下拉
        const suggestBox = document.createElement('div');
        suggestBox.style.cssText = `
            display: none; position: absolute; background: #fff; border: 1px solid #e0e0e0;
            border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); z-index: 9999;
            max-height: 120px; overflow-y: auto; min-width: 120px;
        `;

        const wrapPos = document.createElement('div');
        wrapPos.style.cssText = 'position: relative;';
        wrapPos.appendChild(tagContainer);
        wrapPos.appendChild(suggestBox);

        const showSuggestions = (val) => {
            const query = val.trim().toLowerCase();
            const candidates = [...allTags].filter(t => !tags.includes(t) && (!query || t.toLowerCase().includes(query)));
            suggestBox.innerHTML = '';
            if (candidates.length === 0) { suggestBox.style.display = 'none'; return; }
            candidates.forEach(t => {
                const opt = document.createElement('div');
                opt.textContent = t;
                opt.style.cssText = 'padding: 6px 10px; font-size: 12px; cursor: pointer; color: #333;';
                opt.addEventListener('mouseenter', () => { opt.style.background = '#f5f7ff'; });
                opt.addEventListener('mouseleave', () => { opt.style.background = ''; });
                opt.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    if (!tags.includes(t)) tags.push(t);
                    input.value = '';
                    input.placeholder = '';
                    suggestBox.style.display = 'none';
                    renderTags();
                    input.focus();
                });
                suggestBox.appendChild(opt);
            });
            suggestBox.style.display = 'block';
        };

        input.addEventListener('focus', () => {
            tagContainer.style.borderColor = '#667eea';
            showSuggestions(input.value);
        });
        input.addEventListener('blur', () => {
            tagContainer.style.borderColor = '#e0e0e0';
            setTimeout(() => { suggestBox.style.display = 'none'; }, 150);
            // blur 时若有未提交的文字，自动添加为 tag
            const val = input.value.trim();
            if (val && !tags.includes(val)) {
                tags.push(val);
                input.value = '';
                input.placeholder = '';
                renderTags();
            }
        });
        input.addEventListener('input', () => showSuggestions(input.value));
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                const val = input.value.trim().replace(/,$/, '');
                if (val && !tags.includes(val)) {
                    tags.push(val);
                    allTags.add(val);
                    input.value = '';
                    input.placeholder = '';
                    suggestBox.style.display = 'none';
                    renderTags();
                }
            } else if (e.key === 'Backspace' && input.value === '' && tags.length > 0) {
                tags.pop();
                renderTags();
            }
        });

        tagContainer.appendChild(input);
        renderTags();

        wrapper.appendChild(label);
        wrapper.appendChild(wrapPos);
        return { wrapper, getTags: () => [...tags] };
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
            const response = await chrome.tabs.sendMessage(tab.id, { action: 'scanPageInputs' });

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

            // 根据当前页面 title 匹配或自动创建项目
            let project = this.findProjectByTitle(this.pageTitle);
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

            // 保存凭证到项目（用户名重复则覆盖）
            const username = usernameField ? usernameField.value : '';
            const newCred = {
                id: this.generateId(),
                label: username || '采集的凭证',
                username,
                password: passwordField ? passwordField.value : '',
                customFields,
                note: [],
                status: 'active',
                disabledReason: ''
            };

            const existingIdx = project.credentials.findIndex(c => c.username === username && username);
            if (existingIdx >= 0) {
                // 保留原有 id、status 和 note
                newCred.id = project.credentials[existingIdx].id;
                newCred.status = project.credentials[existingIdx].status;
                newCred.disabledReason = project.credentials[existingIdx].disabledReason;
                newCred.note = project.credentials[existingIdx].note || [];
                project.credentials[existingIdx] = newCred;
                Toast.success('凭证已覆盖更新');
            } else {
                project.credentials.push(newCred);
                Toast.success('凭证已保存到项目：' + project.name);
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
     */
    async bindProjectToPage(projectId) {
        const result = await chrome.storage.local.get(['titleProjectBindings']);
        const bindings = result.titleProjectBindings || {};
        if (projectId) {
            bindings[this.pageTitle] = projectId;
        } else {
            delete bindings[this.pageTitle];
        }
        await chrome.storage.local.set({ titleProjectBindings: bindings });
    }
}
