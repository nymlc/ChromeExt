/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-04-27 10:00:00
 * @FilePath: /ChromeExt/content/modules/CredentialFiller.js
 * @Description: 凭证填充功能模块 - 在页面输入框聚焦时弹出凭证选择列表
 */

class CredentialFiller extends BaseContentModule {
    constructor() {
        super('credential');
        this._currentProject = null;
        this.activeInput = null;
        this.processedInputs = new WeakSet();
        this.observer = null;
        this._tooltip = new SideTooltip({
            gap: 25,
            maxHeight: 280,
            width: 260,
            className: 'credential-filler-popup'
        });
        this._anchorEl = null;
        this._iframeSource = null;
        this._parentMessageHandler = null;
        this.credentialViewMode = 'tab'; // tab | list，默认 tab
        this.activeTabIndex = 0;
    }

    get currentProject() { return this._currentProject; }
    set currentProject(val) {
        // console.trace('[CredentialFiller] currentProject =', val?.name ?? null);
        this._currentProject = val;
    }

    async init() {
        const enabled = await this.checkModuleEnabled();
        if (!enabled) return;

        // 提前启动 observer，避免 matchProject 异步期间漏掉动态插入的输入框
        this.observeNewInputs();
        this._observeTitleChange();

        // 根据页面 title 匹配项目
        await this.matchProject();

        this.setupInputListeners();
        this._startRetryScanning();

        if (window !== window.top) {
            // iframe 内：监听父页面回传的填充/采集/关闭指令
            this._setupParentMessageListener();
        } else {
            // 顶层页面：监听来自 iframe 的弹窗请求
            this._setupIframeMessageListener();
        }

        // 监听来自 popup 的消息（扫描和填充不受限制）
        chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
            if (request.action === 'scanPageInputs') {
                const fields = this.scanInputs();
                sendResponse({ success: true, fields });
            } else if (request.action === 'fillCredential') {
                this.fillCredential(request.credential);
                sendResponse({ success: true });
            } else if (request.action === 'credentialProjectUpdated') {
                this.matchProject();
                // 重新扫描页面上的输入框并绑定
                this.setupInputListeners();
                sendResponse({ success: true });
            }
            return true;
        });
    }

    _setupParentMessageListener() {
        this._parentMessageHandler = (e) => {
            if (e.source !== window.parent) return;
            let data;
            try { data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
            const { type, credential } = data || {};
            if (type === 'CREDENTIAL_FILLER_FILL') {
                this.fillCredential(credential);
                this._clearBlurHandler();
                this.activeInput = null;
            } else if (type === 'CREDENTIAL_FILLER_COLLECT') {
                this.collectCurrentCredential();
                this._clearBlurHandler();
                this.activeInput = null;
            } else if (type === 'CREDENTIAL_FILLER_HIDE') {
                this._clearBlurHandler();
                this.activeInput = null;
            }
        };
        window.addEventListener('message', this._parentMessageHandler);
    }

    _setupIframeMessageListener() {
        window.addEventListener('message', (e) => {
            let data;
            try { data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }

            // 响应 iframe 的上下文请求
            if (data?.type === 'CREDENTIAL_GET_CONTEXT') {
                e.source?.postMessage(JSON.stringify({
                    type: 'CREDENTIAL_CONTEXT_RESPONSE',
                    msgId: data.msgId,
                    context: { title: document.title }
                }), '*');
                return;
            }

            if (data?.type !== 'CREDENTIAL_FILLER_SHOW') return;
            // 验证消息来源是页面内已知的 iframe
            const iframeEl = Array.from(document.querySelectorAll('iframe'))
                .find(f => f.contentWindow === e.source);
            if (!iframeEl) return;
            this._showPopupForIframe(data, iframeEl, e.source);
        });
    }

    /**
     * 获取顶层页面的上下文（title 等）
     * 顶层页面直接返回，跨域 iframe 通过 postMessage 请求顶层回传
     */
    _getTopContext() {
        return new Promise((resolve) => {
            if (window === window.top) {
                resolve({ title: document.title });
                return;
            }

            const msgId = Math.random().toString(36).slice(2);
            const handler = (e) => {
                let data;
                try { data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
                if (data?.type === 'CREDENTIAL_CONTEXT_RESPONSE' && data?.msgId === msgId) {
                    window.removeEventListener('message', handler);
                    resolve(data.context);
                }
            };
            window.addEventListener('message', handler);
            window.top.postMessage(JSON.stringify({ type: 'CREDENTIAL_GET_CONTEXT', msgId }), '*');

            // 500ms 超时兜底，避免顶层页面无响应时卡住
            setTimeout(() => {
                window.removeEventListener('message', handler);
                resolve({ title: '' });
            }, 500);
        });
    }

    _observeTitleChange() {
        // 只在顶层页面监听 title 变化，iframe 不需要
        if (window !== window.top) return;

        const titleEl = document.querySelector('title');
        if (!titleEl) return;

        this._titleObserver = new MutationObserver(() => {
            this.matchProject();
        });
        this._titleObserver.observe(titleEl, { childList: true });
    }

    _startRetryScanning() {
        const MAX_DURATION = 5000;
        const INTERVAL = 500;
        const start = Date.now();

        this._retryScanTimer = setInterval(() => {
            if (Date.now() - start >= MAX_DURATION) {
                clearInterval(this._retryScanTimer);
                this._retryScanTimer = null;
                return;
            }
            this.setupInputListeners();
        }, INTERVAL);
    }

    /**
     * 检测页面是否存在密码输入框（兼容密码可见功能切换后的状态）
     */
    hasPasswordField() {
        return !!document.querySelector('input[type="password"], input[data-password-toggle="true"]');
    }

    /**
     * 根据页面 title 模糊匹配项目
     */
    async matchProject() {
        const { title: pageTitle } = await this._getTopContext();
        const result = await chrome.storage.local.get(['credentialProjects', 'titleProjectBindings', 'credentialViewMode']);
        const projects = result.credentialProjects || [];
        const bindings = result.titleProjectBindings || {};
        if (result.credentialViewMode) this.credentialViewMode = result.credentialViewMode;

        // 优先使用手动绑定的项目
        const boundId = bindings[pageTitle];
        if (boundId) {
            this.currentProject = projects.find(p => p.id === boundId) || null;
            if (this.currentProject) return;
        }

        // 其次模糊匹配（pageTitle 为空时跳过，避免空字符串匹配任意项目）
        this.currentProject = pageTitle ? (projects.find(p => {
            if (!p.matchTitle) return false;
            const mt = p.matchTitle.toLowerCase();
            const pt = pageTitle.toLowerCase();
            return pt.includes(mt) || mt.includes(pt);
        }) || null) : null;

        // console.log('[CredentialFiller] matchProject', {
        //     href: window.location.href,
        //     pageTitle,
        //     matched: this._currentProject ? { id: this._currentProject.id, name: this._currentProject.name, matchTitle: this._currentProject.matchTitle } : null,
        //     allProjects: projects.map(p => ({ id: p.id, name: p.name, matchTitle: p.matchTitle }))
        // });
    }

    /**
     * 为页面上的输入框绑定聚焦事件
     */
    setupInputListeners() {
        const inputs = document.querySelectorAll(
            'input[type="text"], input[type="email"], input[type="password"], input[type="tel"], input:not([type])'
        );
        inputs.forEach(input => this.bindInput(input));
    }

    /**
     * 判断输入框是否是登录相关的（用户名或密码）
     */
    isLoginInput(input) {
        const type = this.detectFieldType(input);
        if (type === 'username' || type === 'password') return true;

        // 兜底逻辑：如果它是被推断出的用户名框（离密码框最近的前置文本框），也认为它是登录框
        const fallbackUser = this.findUsernameInput();
        if (fallbackUser === input) return true;

        return false;
    }

    /**
     * 绑定单个输入框
     */
    bindInput(input) {
        if (this.processedInputs.has(input)) return;
        this.processedInputs.add(input);
        
        const showPopup = () => {
            // 前置条件：页面必须存在密码框（含被切换为明文显示的）才认为是登录页
            if (!this.hasPasswordField()) return;

            // 在事件触发时实时检测是否为登录输入框，避免因 DOM 动态加载顺序导致推断失败
            if (!this.isLoginInput(input)) return;

            // 如果当前已经在此输入框显示了弹窗，则不再重复创建
            if (this._tooltip.isVisible && this.activeInput === input) return;

            this.showCredentialPopup(input);
        };

        input.addEventListener('focus', showPopup);
        input.addEventListener('click', showPopup);

        // 如果输入框当前已经处于聚焦状态（比如动态插入后自动聚焦），立即弹出
        if (document.activeElement === input) {
            showPopup();
        }
    }

    /**
     * 监听 DOM 变化，处理动态添加的输入框
     */
    observeNewInputs() {
        if (this.observer) return; // 避免重复监听

        this.observer = new MutationObserver((mutations) => {
            let hasNewInputs = false;
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeType !== 1) return;
                    if (node.tagName === 'INPUT') {
                        this.bindInput(node);
                        hasNewInputs = true;
                    }
                    const inputs = node.querySelectorAll?.('input');
                    if (inputs?.length) {
                        inputs.forEach(input => this.bindInput(input));
                        hasNewInputs = true;
                    }
                });
            });
        });

        this.observer.observe(document.body, { childList: true, subtree: true });
    }

    /**
     * 在输入框下方显示凭证选择浮层
     */
    showCredentialPopup(input) {
        // iframe 内：通过 postMessage 委托父页面渲染，避免被 iframe 边界裁剪
        if (window !== window.top) {
            this._showPopupViaParent(input);
            return;
        }

        this.hideCredentialPopup();
        this.activeInput = input;
        this._isSelecting = false;

        const credentials = this.currentProject ? this.currentProject.credentials : [];
        // active 在前，disabled 在后
        const sorted = [...credentials].sort((a, b) => {
            if (a.status === 'active' && b.status !== 'active') return -1;
            if (a.status !== 'active' && b.status === 'active') return 1;
            return 0;
        });

        // 计算 tab 分组
        const namedGroups = [];
        sorted.forEach(c => {
            const ns = Array.isArray(c.note) ? c.note : (c.note ? [c.note] : []);
            ns.forEach(n => { if (!namedGroups.includes(n)) namedGroups.push(n); });
            if (ns.length === 0 && !namedGroups.includes('')) namedGroups.push('');
        });
        const hasUngroupedMain = sorted.some(c => {
            const ns = Array.isArray(c.note) ? c.note : (c.note ? [c.note] : []);
            return ns.length === 0;
        });
        if (hasUngroupedMain && !namedGroups.includes('')) namedGroups.push('');
        const useTabMode = this.credentialViewMode === 'tab' && namedGroups.filter(n => n !== '').length > 0 && namedGroups.length > 1;
        if (this.activeTabIndex >= namedGroups.length) this.activeTabIndex = 0;

        const buildCredItem = (cred, currentTabKey) => {
            const item = document.createElement('div');
            const isDisabled = cred.status === 'disabled';
            item.style.cssText = `
                padding: 10px 14px; cursor: pointer; border-bottom: 1px solid #f5f5f5;
                display: flex; flex-direction: column; gap: 2px;
                opacity: ${isDisabled ? '0.5' : '1'}; transition: background 0.15s;
            `;
            const labelLine = document.createElement('div');
            labelLine.style.cssText = 'font-weight: 600; color: #333; display: flex; align-items: center; gap: 6px;';
            labelLine.textContent = cred.label || '未命名';
            if (isDisabled) {
                const badge = document.createElement('span');
                badge.textContent = cred.disabledReason || '已失效';
                badge.style.cssText = 'font-size: 11px; font-weight: 400; color: #f44336; background: #ffebee; padding: 1px 6px; border-radius: 4px;';
                labelLine.appendChild(badge);
            }
            const userLine = document.createElement('div');
            userLine.style.cssText = 'color: #888; font-size: 12px;';
            userLine.textContent = cred.username;
            item.appendChild(labelLine);
            item.appendChild(userLine);

            const notes = Array.isArray(cred.note) ? cred.note : (cred.note ? [cred.note] : []);
            const tagsToShow = useTabMode ? notes.filter(n => n !== currentTabKey) : notes;
            if (tagsToShow.length > 0) {
                const noteRow = document.createElement('div');
                noteRow.style.cssText = 'display: flex; flex-wrap: wrap; gap: 3px; margin-top: 3px;';
                tagsToShow.forEach(tag => {
                    const tagEl = document.createElement('span');
                    tagEl.textContent = tag;
                    tagEl.style.cssText = 'font-size: 11px; color: #996b00; background: #fffbf0; border-radius: 4px; padding: 1px 5px; border: 1px solid #f0c060; line-height: 1.5;';
                    noteRow.appendChild(tagEl);
                });
                item.appendChild(noteRow);
            }

            item.addEventListener('mouseenter', () => { item.style.background = '#f5f7ff'; });
            item.addEventListener('mouseleave', () => { item.style.background = ''; });
            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                this._isSelecting = true;
                this.fillCredential(cred);
                this.hideCredentialPopup();
            });
            item.addEventListener('touchstart', (e) => {
                e.preventDefault();
                this._isSelecting = true;
                item.style.background = '#f5f7ff';
            }, { passive: false });
            item.addEventListener('touchend', (e) => {
                e.preventDefault();
                this.fillCredential(cred);
                this.hideCredentialPopup();
            });
            return item;
        };

        // 构建列表容器
        const listContainer = document.createElement('div');
        listContainer.style.cssText = 'flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; display: flex; flex-direction: column;';

        if (useTabMode) {
            const tabBar = document.createElement('div');
            tabBar.style.cssText = 'display: flex; overflow-x: auto; border-bottom: 1px solid #e8eaf6; background: #fafbff; flex-shrink: 0; scrollbar-width: none;';
            const contentArea = document.createElement('div');
            contentArea.style.cssText = 'overflow-y: auto; flex: 1;';

            const renderTabContent = (idx) => {
                contentArea.innerHTML = '';
                const key = namedGroups[idx];
                const filteredCreds = sorted.filter(c => {
                    const ns = Array.isArray(c.note) ? c.note : (c.note ? [c.note] : []);
                    return key === '' ? ns.length === 0 : ns.includes(key);
                });
                filteredCreds.forEach(cred => contentArea.appendChild(buildCredItem(cred, key)));
            };

            namedGroups.forEach((tabKey, idx) => {
                const isActive = idx === this.activeTabIndex;
                const tab = document.createElement('div');
                tab.textContent = tabKey === '' ? '其他' : tabKey;
                tab.style.cssText = `padding: 6px 12px; font-size: 11px; cursor: pointer; white-space: nowrap; border-bottom: 2px solid ${isActive ? '#667eea' : 'transparent'}; color: ${isActive ? '#667eea' : '#999'}; font-weight: ${isActive ? '600' : '400'}; transition: color 0.15s; background: transparent;`;
                tab.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    this.activeTabIndex = idx;
                    Array.from(tabBar.children).forEach((t, i) => {
                        const a = i === idx;
                        t.style.borderBottomColor = a ? '#667eea' : 'transparent';
                        t.style.color = a ? '#667eea' : '#999';
                        t.style.fontWeight = a ? '600' : '400';
                    });
                    renderTabContent(idx);
                });
                tabBar.appendChild(tab);
            });

            listContainer.appendChild(tabBar);
            renderTabContent(this.activeTabIndex);
            listContainer.appendChild(contentArea);
        } else {
            sorted.forEach(cred => listContainer.appendChild(buildCredItem(cred, null)));
        }

        // 添加采集按钮
        const collectBtn = document.createElement('div');
        collectBtn.style.cssText = `
            padding: 10px 14px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #007aff;
            font-weight: 600;
            background: #fff;
            border-top: 1px solid #e5e5ea;
            flex-shrink: 0;
            transition: background 0.15s;
        `;
        collectBtn.textContent = '+ 采集当前填写凭证';

        collectBtn.addEventListener('mouseenter', () => { collectBtn.style.background = '#eef0ff'; });
        collectBtn.addEventListener('mouseleave', () => { collectBtn.style.background = '#fff'; });

        const handleCollect = async (e) => {
            e.preventDefault();
            this._isSelecting = true;
            await this.collectCurrentCredential();
            this.hideCredentialPopup();
        };

        collectBtn.addEventListener('mousedown', handleCollect);
        collectBtn.addEventListener('touchstart', handleCollect, { passive: false });

        // 使用 SideTooltip 显示浮层
        this._tooltip.show(input, [listContainer, collectBtn]);

        // 输入框失焦时延迟关闭（移动端键盘弹出也会触发 blur，加长延迟）
        this._blurHandler = () => {
            setTimeout(() => {
                // 如果已经切换到了其他输入框（新弹窗已创建），旧的 blur 不应关闭新弹窗
                if (this.activeInput !== input) return;
                // 如果正在选择凭证项，或者焦点回到了弹窗内部，不关闭
                if (!this._isSelecting && this._tooltip.isVisible) {
                    // 检查焦点是否仍在输入框或弹窗内
                    if (this._tooltip.popupEl && this._tooltip.popupEl.contains(document.activeElement)) return;
                    if (document.activeElement === input) return;
                    this.hideCredentialPopup();
                }
            }, 300);
        };
        input.addEventListener('blur', this._blurHandler);
    }

    /**
     * iframe 内：把弹窗请求委托给父页面渲染
     */
    _showPopupViaParent(input) {
        this._clearBlurHandler();
        this.activeInput = input;
        this._isSelecting = false;

        const rect = input.getBoundingClientRect();
        window.parent.postMessage(JSON.stringify({
            type: 'CREDENTIAL_FILLER_SHOW',
            rect: { top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right, width: rect.width, height: rect.height },
        }), '*');

        this._blurHandler = () => {
            setTimeout(() => {
                if (this.activeInput !== input) return;
                if (!this._isSelecting) {
                    window.parent.postMessage(JSON.stringify({ type: 'CREDENTIAL_FILLER_HIDE' }), '*');
                    this._clearBlurHandler();
                    this.activeInput = null;
                }
            }, 300);
        };
        input.addEventListener('blur', this._blurHandler);
    }

    /**
     * 顶层页面：接收 iframe 的弹窗请求，在父页面 DOM 里渲染 tooltip
     */
    _showPopupForIframe(data, iframeEl, iframeSource) {
        this.hideCredentialPopup();

        const iframeRect = iframeEl.getBoundingClientRect();
        const inputRect = data.rect;
        const projectCredentials = this.currentProject ? this.currentProject.credentials : [];
        const credentials = [...projectCredentials].sort((a, b) => {
            if (a.status === 'active' && b.status !== 'active') return -1;
            if (a.status !== 'active' && b.status === 'active') return 1;
            return 0;
        });
        this._iframeSource = iframeSource;

        // 创建 0x0 锚点 div，位置 = iframe 偏移 + input 在 iframe 内的偏移
        const anchor = document.createElement('div');
        anchor.style.cssText = `
            position: fixed;
            width: ${inputRect.width}px;
            height: ${inputRect.height}px;
            top: ${iframeRect.top + inputRect.top}px;
            left: ${iframeRect.left + inputRect.left}px;
            pointer-events: none;
        `;
        document.body.appendChild(anchor);
        this._anchorEl = anchor;

        // 构建凭证列表
        const iframeTabGroups = [];
        credentials.forEach(c => {
            const ns = Array.isArray(c.note) ? c.note : (c.note ? [c.note] : []);
            ns.forEach(n => { if (!iframeTabGroups.includes(n)) iframeTabGroups.push(n); });
            if (ns.length === 0 && !iframeTabGroups.includes('')) iframeTabGroups.push('');
        });
        const iframeUseTab = this.credentialViewMode === 'tab' && iframeTabGroups.filter(n => n !== '').length > 0 && iframeTabGroups.length > 1;
        if (this.activeTabIndex >= iframeTabGroups.length) this.activeTabIndex = 0;

        const buildIframeItem = (cred, currentTabKey) => {
            const item = document.createElement('div');
            const isDisabled = cred.status === 'disabled';
            item.style.cssText = `padding: 10px 14px; cursor: pointer; border-bottom: 1px solid #f5f5f5; display: flex; flex-direction: column; gap: 2px; opacity: ${isDisabled ? '0.5' : '1'}; transition: background 0.15s;`;
            const labelLine = document.createElement('div');
            labelLine.style.cssText = 'font-weight: 600; color: #333; display: flex; align-items: center; gap: 6px;';
            labelLine.textContent = cred.label || '未命名';
            if (isDisabled) {
                const badge = document.createElement('span');
                badge.textContent = cred.disabledReason || '已失效';
                badge.style.cssText = 'font-size: 11px; font-weight: 400; color: #f44336; background: #ffebee; padding: 1px 6px; border-radius: 4px;';
                labelLine.appendChild(badge);
            }
            const userLine = document.createElement('div');
            userLine.style.cssText = 'color: #888; font-size: 12px;';
            userLine.textContent = cred.username;
            item.appendChild(labelLine);
            item.appendChild(userLine);

            const notes = Array.isArray(cred.note) ? cred.note : (cred.note ? [cred.note] : []);
            const tagsToShow = iframeUseTab ? notes.filter(n => n !== currentTabKey) : notes;
            if (tagsToShow.length > 0) {
                const noteRow = document.createElement('div');
                noteRow.style.cssText = 'display: flex; flex-wrap: wrap; gap: 3px; margin-top: 3px;';
                tagsToShow.forEach(tag => {
                    const tagEl = document.createElement('span');
                    tagEl.textContent = tag;
                    tagEl.style.cssText = 'font-size: 11px; color: #996b00; background: #fffbf0; border-radius: 4px; padding: 1px 5px; border: 1px solid #f0c060; line-height: 1.5;';
                    noteRow.appendChild(tagEl);
                });
                item.appendChild(noteRow);
            }

            item.addEventListener('mouseenter', () => { item.style.background = '#f5f7ff'; });
            item.addEventListener('mouseleave', () => { item.style.background = ''; });
            item.addEventListener('mousedown', (ev) => {
                ev.preventDefault();
                this._iframeSource?.postMessage(JSON.stringify({ type: 'CREDENTIAL_FILLER_FILL', credential: cred }), '*');
                this.hideCredentialPopup();
            });
            item.addEventListener('touchend', (ev) => {
                ev.preventDefault();
                this._iframeSource?.postMessage(JSON.stringify({ type: 'CREDENTIAL_FILLER_FILL', credential: cred }), '*');
                this.hideCredentialPopup();
            });
            return item;
        };

        const listContainer = document.createElement('div');
        listContainer.style.cssText = 'flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; display: flex; flex-direction: column;';

        if (iframeUseTab) {
            const tabBar = document.createElement('div');
            tabBar.style.cssText = 'display: flex; overflow-x: auto; border-bottom: 1px solid #e8eaf6; background: #fafbff; flex-shrink: 0; scrollbar-width: none;';
            const contentArea = document.createElement('div');
            contentArea.style.cssText = 'overflow-y: auto; flex: 1;';

            const renderIframeTabContent = (idx) => {
                contentArea.innerHTML = '';
                const key = iframeTabGroups[idx];
                credentials.filter(c => {
                    const ns = Array.isArray(c.note) ? c.note : (c.note ? [c.note] : []);
                    return key === '' ? ns.length === 0 : ns.includes(key);
                }).forEach(cred => contentArea.appendChild(buildIframeItem(cred, key)));
            };

            iframeTabGroups.forEach((tabKey, idx) => {
                const isActive = idx === this.activeTabIndex;
                const tab = document.createElement('div');
                tab.textContent = tabKey === '' ? '其他' : tabKey;
                tab.style.cssText = `padding: 6px 12px; font-size: 11px; cursor: pointer; white-space: nowrap; border-bottom: 2px solid ${isActive ? '#667eea' : 'transparent'}; color: ${isActive ? '#667eea' : '#999'}; font-weight: ${isActive ? '600' : '400'}; transition: color 0.15s; background: transparent;`;
                tab.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    this.activeTabIndex = idx;
                    Array.from(tabBar.children).forEach((t, i) => {
                        const a = i === idx;
                        t.style.borderBottomColor = a ? '#667eea' : 'transparent';
                        t.style.color = a ? '#667eea' : '#999';
                        t.style.fontWeight = a ? '600' : '400';
                    });
                    renderIframeTabContent(idx);
                });
                tabBar.appendChild(tab);
            });

            listContainer.appendChild(tabBar);
            renderIframeTabContent(this.activeTabIndex);
            listContainer.appendChild(contentArea);
        } else {
            credentials.forEach(cred => listContainer.appendChild(buildIframeItem(cred, null)));
        }

        // 采集按钮
        const collectBtn = document.createElement('div');
        collectBtn.style.cssText = `
            padding: 10px 14px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #007aff;
            font-weight: 600;
            background: #fff;
            border-top: 1px solid #e5e5ea;
            flex-shrink: 0;
            transition: background 0.15s;
        `;
        collectBtn.textContent = '+ 采集当前填写凭证';
        collectBtn.addEventListener('mouseenter', () => { collectBtn.style.background = '#eef0ff'; });
        collectBtn.addEventListener('mouseleave', () => { collectBtn.style.background = '#fff'; });

        const handleCollect = (ev) => {
            ev.preventDefault();
            this._iframeSource?.postMessage(JSON.stringify({ type: 'CREDENTIAL_FILLER_COLLECT' }), '*');
            this.hideCredentialPopup();
        };
        collectBtn.addEventListener('mousedown', handleCollect);
        collectBtn.addEventListener('touchstart', handleCollect, { passive: false });

        this._tooltip.show(anchor, [listContainer, collectBtn], {
            onHide: () => {
                this._iframeSource?.postMessage(JSON.stringify({ type: 'CREDENTIAL_FILLER_HIDE' }), '*');
                if (this._anchorEl) {
                    this._anchorEl.remove();
                    this._anchorEl = null;
                }
                this._iframeSource = null;
            }
        });
    }

    /**
     * 隐藏浮层
     */
    hideCredentialPopup() {
        this._tooltip.hide();
        this._clearBlurHandler();
        // 父页面：清理 iframe 锚点
        if (this._anchorEl) {
            this._anchorEl.remove();
            this._anchorEl = null;
        }
        this._iframeSource = null;
        this._isSelecting = false;
        this.activeInput = null;
    }

    _clearBlurHandler() {
        if (this.activeInput && this._blurHandler) {
            this.activeInput.removeEventListener('blur', this._blurHandler);
            this._blurHandler = null;
        }
    }

    /**
     * 填充凭证到页面
     */
    fillCredential(credential) {
        const passwordInput = this.findPasswordInput();
        const usernameInput = this.findUsernameInput();

        // 填充用户名
        if (usernameInput && credential.username) {
            this.setInputValue(usernameInput, credential.username);
        }

        // 填充密码
        if (passwordInput && credential.password) {
            this.setInputValue(passwordInput, credential.password);
        }

        // 填充自定义字段：通过保存的 selector 定位，匹配不到则用 label 匹配 placeholder
        if (credential.customFields && credential.customFields.length > 0) {
            credential.customFields.forEach(field => {
                if (!field.value) return;
                let el = null;

                // 优先用 selector
                if (field.selector) {
                    try { el = document.querySelector(field.selector); } catch (e) { /* selector 无效 */ }
                }

                // fallback：用 label 匹配 placeholder
                if (!el && field.label) {
                    const label = field.label.toLowerCase();
                    el = Array.from(this.getVisibleInputs()).find(input => {
                        const ph = (input.placeholder || '').toLowerCase();
                        const name = (input.name || '').toLowerCase();
                        return ph === label || name === label || ph.includes(label) || name.includes(label);
                    });
                }

                if (el) {
                    this.setInputValue(el, field.value);
                }
            });
        }
    }

    /**
     * 识别输入框的语义类型
     * 通过 placeholder、name、id、type、autocomplete 等属性综合判断
     */
    detectFieldType(input) {
        const type = (input.type || 'text').toLowerCase();
        if (type === 'password') return 'password';

        // 兼容密码可见功能：被切换为 text 的密码框
        if (input.getAttribute('data-password-toggle') === 'true') return 'password';

        // 收集所有可用于识别的文本线索
        const hints = [
            input.placeholder,
            input.name,
            input.id,
            input.getAttribute('autocomplete'),
            input.getAttribute('aria-label'),
        ].filter(Boolean).map(s => s.toLowerCase()).join(' ');

        // 用户名/账号关键词
        const usernameKeywords = [
            'user', 'username', 'account', 'login', 'email', 'phone', 'mobile', 'tel',
            '用户', '账号', '帐号', '手机', '邮箱', '登录名', '工号'
        ];
        if (usernameKeywords.some(k => hints.includes(k))) return 'username';
        if (type === 'email' || type === 'tel') return 'username';

        // 密码关键词（针对 type 不是 password 但语义是密码的情况）
        const passwordKeywords = ['pass', 'password', 'pwd', '密码', '口令'];
        if (passwordKeywords.some(k => hints.includes(k))) return 'password';

        return 'other';
    }

    /**
     * 查找页面上的用户名输入框
     */
    findUsernameInput() {
        const allInputs = this.getVisibleInputs();

        // 优先通过语义识别找用户名框
        const byHint = allInputs.find(input => this.detectFieldType(input) === 'username');
        if (byHint) return byHint;

        // 兜底：找密码框前面最近的文本输入框
        const passwordInput = this.findPasswordInput();
        if (!passwordInput) return allInputs[0] || null;

        let closest = null;
        for (const input of allInputs) {
            if (input.type === 'password') continue;
            if (passwordInput.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_PRECEDING) {
                closest = input;
            }
        }
        return closest;
    }

    /**
     * 查找页面上的密码输入框
     */
    findPasswordInput() {
        // 优先找 type="password"
        const pwdInput = document.querySelector('input[type="password"]');
        if (pwdInput) return pwdInput;

        // 兼容密码可见功能切换后的状态
        const toggledInput = document.querySelector('input[data-password-toggle="true"]');
        if (toggledInput) return toggledInput;

        // 兜底：通过语义识别
        const allInputs = this.getVisibleInputs();
        return allInputs.find(input => this.detectFieldType(input) === 'password') || null;
    }

    /**
     * 获取页面上所有可见的输入框
     */
    getVisibleInputs() {
        return Array.from(document.querySelectorAll(
            'input[type="text"], input[type="email"], input[type="tel"], input[type="password"], input:not([type])'
        )).filter(input => {
            const style = window.getComputedStyle(input);
            return style.display !== 'none' && style.visibility !== 'hidden' && input.offsetParent !== null;
        });
    }

    /**
     * 设置输入框的值并触发事件（兼容前端框架）
     */
    setInputValue(input, value) {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
        ).set;
        nativeInputValueSetter.call(input, value);

        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    /**
     * 扫描页面上所有已填写的输入框（供保存凭证时使用）
     */
    scanInputs() {
        const allInputs = document.querySelectorAll('input');
        const fields = [];

        allInputs.forEach(input => {
            const style = window.getComputedStyle(input);
            if (style.display === 'none' || style.visibility === 'hidden') return;
            if (!input.value) return;

            const type = (input.type || 'text').toLowerCase();
            // 跳过不相关的类型
            if (['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'image', 'reset'].includes(type)) return;

            const selector = this.generateSelector(input);
            const fieldType = this.detectFieldType(input);
            const label = input.placeholder || input.name || input.id || type;

            if (fieldType === 'password') {
                fields.push({ type: 'password', label: '密码', value: input.value, selector });
            } else if (fieldType === 'username') {
                fields.push({ type: 'username', label: label, value: input.value, selector });
            } else {
                fields.push({ type: 'custom', label: label, value: input.value, selector });
            }
        });

        return fields;
    }

    /**
     * 为输入框生成稳定的 CSS selector
     */
    generateSelector(input) {
        if (input.id) return `#${CSS.escape(input.id)}`;
        if (input.name) return `input[name="${CSS.escape(input.name)}"]`;

        // 用 placeholder 属性匹配
        if (input.placeholder) {
            return `input[placeholder="${CSS.escape(input.placeholder)}"]`;
        }

        // 兜底：构建从 body 到 input 的完整路径
        const path = [];
        let el = input;
        while (el && el !== document.body) {
            let selector = el.tagName.toLowerCase();
            if (el.parentElement) {
                const siblings = Array.from(el.parentElement.children).filter(c => c.tagName === el.tagName);
                if (siblings.length > 1) {
                    const index = siblings.indexOf(el) + 1;
                    selector += `:nth-of-type(${index})`;
                }
            }
            path.unshift(selector);
            el = el.parentElement;
        }
        return path.join(' > ');
    }

    /**
     * 在页面内采集当前填写的凭证并直接保存
     */
    async collectCurrentCredential() {
        const fields = this.scanInputs();
        if (!fields || fields.length === 0) {
            Toast.warning('未检测到已填写的输入框');
            return;
        }

        const usernameField = fields.find(f => f.type === 'username');
        const passwordField = fields.find(f => f.type === 'password');
        const customFields = fields.filter(f => f.type === 'custom').map(f => ({
            label: f.label,
            value: f.value,
            selector: f.selector
        }));

        if (!usernameField && !passwordField) {
            Toast.warning('未填写任何用户名或密码');
            return;
        }

        const username = usernameField ? usernameField.value.trim() : '';
        const password = passwordField ? passwordField.value.trim() : '';
        if (!username || !password) {
            Toast.warning('用户名和密码必须都填写完整才能采集');
            return;
        }

        const { title: pageTitle } = await this._getTopContext();
        let result;
        try {
            result = await chrome.storage.local.get(['credentialProjects']);
        } catch (e) {
            if (e.message.includes('Extension context invalidated')) {
                Toast.error('插件刚被重新加载，请刷新当前网页以继续使用。');
                return;
            }
            throw e;
        }
        const projects = result.credentialProjects || [];

        let project = this.currentProject;
        if (!project) {
            // 尝试通过 title 匹配
            project = projects.find(p => p.matchTitle && (pageTitle.toLowerCase().includes(p.matchTitle.toLowerCase()) || p.matchTitle.toLowerCase().includes(pageTitle.toLowerCase())));
        }

        if (!project) {
            project = {
                id: Date.now().toString(36) + Math.random().toString(36).substr(2, 9),
                name: pageTitle || '新项目',
                matchTitle: pageTitle || '新项目',
                credentials: [],
                createdAt: Date.now(),
                updatedAt: Date.now()
            };
            projects.push(project);
        } else {
            // 获取最新引用
            const existingProj = projects.find(p => p.id === project.id);
            if (existingProj) {
                project = existingProj;
            } else {
                projects.push(project);
            }
        }

        const existingIdx = project.credentials.findIndex(c => c.username === username);
        let msg = '';
        if (existingIdx >= 0) {
            project.credentials[existingIdx].password = password;
            project.credentials[existingIdx].customFields = customFields;
            msg = '已覆盖更新该账号凭证！';
        } else {
            project.credentials.push({
                id: Date.now().toString(36) + Math.random().toString(36).substr(2, 9),
                label: username || '未命名',
                username,
                password,
                customFields,
                note: [],
                status: 'active',
                disabledReason: ''
            });
            msg = '凭证采集成功！';
        }

        project.updatedAt = Date.now();
        await chrome.storage.local.set({ credentialProjects: projects });

        // 仅在本来就匹配到项目时更新引用，避免 iframe 等无 title 页面错误认领新建项目
        if (this.currentProject && this.currentProject.id === project.id) {
            this.currentProject = project;
        }
        Toast.success(msg);
    }

    destroy() {
        this.hideCredentialPopup();
        if (this._retryScanTimer) {
            clearInterval(this._retryScanTimer);
            this._retryScanTimer = null;
        }
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
        if (this._titleObserver) {
            this._titleObserver.disconnect();
            this._titleObserver = null;
        }
        if (this._parentMessageHandler) {
            window.removeEventListener('message', this._parentMessageHandler);
            this._parentMessageHandler = null;
        }
        this.processedInputs = new WeakSet();
        console.log('凭证填充功能已清理');
    }
}
