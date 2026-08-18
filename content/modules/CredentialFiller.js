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
        this.activeTagKey = null;
        this.suppressNativeAutofill = true; // 是否抑制页面登录框的原生 Chrome 密码建议（默认开启）
        this._unsubSuppress = null;
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

        // 读取「抑制原生密码建议」偏好（默认开启），并订阅变更实时生效
        try {
            const pref = await chrome.storage.local.get(['suppressNativeAutofill']);
            this.suppressNativeAutofill = pref.suppressNativeAutofill !== false;
        } catch (e) { /* 默认开启 */ }
        this._subscribeSuppressSetting();

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
                // 等 matchProject 重载完 currentProject（含新 tabOrder）再重渲染已打开的浮层
                (async () => {
                    await this.matchProject();
                    this.setupInputListeners();
                    if (this.activeInput) this.showCredentialPopup(this.activeInput);
                    sendResponse({ success: true });
                })();
            } else if (request.action === 'credentialViewModeChanged') {
                // popup 切换了标签/列表模式：更新内存值，若浮动弹框正显示则按新模式即时重渲染
                if (request.mode) this.credentialViewMode = request.mode;
                if (this.activeInput) this.showCredentialPopup(this.activeInput);
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
            const { type, credential, currentTabKey } = data || {};
            if (type === 'CREDENTIAL_FILLER_FILL') {
                this.fillCredential(credential);
                this._clearBlurHandler();
                this.activeInput = null;
            } else if (type === 'CREDENTIAL_FILLER_COLLECT') {
                this.collectCurrentCredential(currentTabKey ?? null);
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
     * 根据页面 title / 域名匹配项目
     * 关键：直读 chrome.storage，绕开 StorageState 缓存时序，保证绑定即时生效。
     */
    async matchProject() {
        const { title: pageTitle } = await this._getTopContext();
        const hostname = window.location.hostname;

        // 直读存储，绕开缓存，保证拿到最新绑定（绑定可能在脚本加载后才发生）
        const data = await chrome.storage.local.get([
            'credentialProjects', 'titleProjectBindings', 'urlProjectBindings', 'credentialViewMode'
        ]);
        const projects = data.credentialProjects || [];
        const titleBindings = data.titleProjectBindings || {};
        const urlBindings = data.urlProjectBindings || {};
        if (data.credentialViewMode) this.credentialViewMode = data.credentialViewMode;

        // 候选匹配键：document.title / hostname / 完整 href / origin / 去协议 href
        // 兼容空 title 页面 tab.title 回退为“完整网址（不带协议头）”的情况
        // （日志已证实本页绑定键即 "pre-ipaas.aicare360.cn/iot-gate/...#/login..." 这种去协议完整 URL）
        const hrefNoProto = window.location.href.replace(/^https?:\/\//, '');
        const candidates = [
            pageTitle, hostname, window.location.href, window.location.origin, hrefNoProto,
        ].filter(Boolean);
        const findBoundId = (bindings) => {
            for (const key of candidates) {
                if (bindings[key]) return bindings[key];
            }
            return null;
        };

        // 1. title / 域名 手动绑定（候选键兜底，使「指定项目」在任何键写法下都能命中）
        const boundId = findBoundId(titleBindings);
        if (boundId) {
            const proj = projects.find(p => p.id === boundId) || null;
            if (proj) {
                this.currentProject = proj;
                return;
            }
        }

        // 2. URL（域名）手动绑定：对 hash 路由 SPA 更可靠，免依赖页面 title
        const urlMatch = Object.keys(urlBindings).find(rule =>
            hostname === rule || hostname.endsWith('.' + rule)
        );
        if (urlMatch) {
            const proj = projects.find(p => p.id === urlBindings[urlMatch]) || null;
            if (proj) {
                this.currentProject = proj;
                return;
            }
        }

        // 3. title 模糊匹配（pageTitle 为空时跳过，避免空字符串匹配任意项目）
        this.currentProject = pageTitle ? (projects.find(p => {
            if (!p.matchTitle) return false;
            const mt = p.matchTitle.toLowerCase();
            const pt = pageTitle.toLowerCase();
            return pt.includes(mt) || mt.includes(pt);
        }) || null) : null;
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

        // 再兜底：页面存在密码框，且“可见文本输入框仅此一个”时，它就是登录用户名框
        // 覆盖 SPA 中用户名框无占位符/无 name 等语义线索的场景
        if (this.hasPasswordField()) {
            const texts = this.getVisibleInputs().filter(i => this.detectFieldType(i) !== 'password');
            if (texts.length === 1 && texts[0] === input) return true;
        }

        return false;
    }

    /**
     * 绑定单个输入框
     */
    bindInput(input) {
        if (this.processedInputs.has(input)) return;
        this.processedInputs.add(input);

        // 抑制 Chrome 原生密码管理器在聚焦登录框时弹出的建议下拉。
        // autocomplete 是内容脚本唯一可控的杠杆：用随机 token（用户名框）+
        // new-password（密码框）绕过 Chrome「对登录表单忽略 autocomplete=off」的启发式，
        // 可靠压住原生建议，避免与扩展自带浮层重复弹出。
        const fType = this.detectFieldType(input);
        if (fType === 'username' || fType === 'password') {
            if (this.suppressNativeAutofill) this._suppressNativeAutofill(input, fType);
        }

        input.addEventListener('focus', () => this.tryShowPopup(input));
        input.addEventListener('click', () => this.tryShowPopup(input));

        // 如果输入框当前已经处于聚焦状态（比如动态插入后自动聚焦），立即弹出
        if (document.activeElement === input) {
            this.tryShowPopup(input);
        }
    }

    /**
     * 抑制 Chrome 原生密码管理器对该输入框的建议下拉。
     * 记住原始 autocomplete，写到 data-gtb-ac，便于 cleanup 时还原。
     * @param {HTMLInputElement} input
     * @param {'username'|'password'} fType
     */
    _suppressNativeAutofill(input, fType) {
        if (input.dataset.gtbAc !== undefined) return; // 已处理过
        input.dataset.gtbAc = input.getAttribute('autocomplete') || '';
        if (fType === 'password') {
            // new-password 让 Chrome 将其视为“设置新密码”框，不提供已存密码、不弹建议
            input.setAttribute('autocomplete', 'new-password');
        } else {
            // 随机 token：Chrome 无法识别为已知登录语义，等同于 off，且不触发“忽略 off”启发式
            input.setAttribute('autocomplete', 'gtb-' + Math.random().toString(36).slice(2, 10));
        }
    }

    /**
     * 订阅「抑制原生密码建议」开关：popup 改动 storage 后经 StorageState 广播，
     * 这里实时对所有页面登录框应用或还原，无需刷新页面。
     */
    _subscribeSuppressSetting() {
        if (typeof StorageState === 'undefined') return;
        try { StorageState.init(); } catch (e) { /* 忽略 */ }
        this._unsubSuppress = StorageState.subscribe((changes) => {
            if (!Object.prototype.hasOwnProperty.call(changes, 'suppressNativeAutofill')) return;
            const on = changes.suppressNativeAutofill.newValue !== false;
            this.suppressNativeAutofill = on;
            if (on) this._applySuppressionToAllInputs();
            else this._restoreAllSuppressed();
        });
    }

    /**
     * 对当前页面所有尚未抑制的登录框执行抑制（开关打开或被打开时调用）。
     */
    _applySuppressionToAllInputs() {
        document.querySelectorAll(
            'input[type="text"], input[type="email"], input[type="password"], input[type="tel"], input:not([type])'
        ).forEach(inp => {
            const t = this.detectFieldType(inp);
            if ((t === 'username' || t === 'password') && inp.dataset.gtbAc === undefined) {
                this._suppressNativeAutofill(inp, t);
            }
        });
    }

    /**
     * 还原所有被本扩展抑制过的输入框的 autocomplete（开关关闭或 cleanup 时调用）。
     */
    _restoreAllSuppressed() {
        document.querySelectorAll('input[data-gtb-ac]').forEach(inp => {
            const orig = inp.dataset.gtbAc;
            if (orig === '') inp.removeAttribute('autocomplete');
            else inp.setAttribute('autocomplete', orig);
            delete inp.dataset.gtbAc;
        });
    }

    /**
     * 尝试在指定输入框弹出凭证浮层（统一前置校验，bindInput 与分步登录第二步主动触发共用）
     */
    tryShowPopup(input) {
        // 前置条件：页面必须存在密码框（含被切换为明文显示的）才认为是登录页
        // 分步登录第一步（仅用户名框）不弹，等第二步密码框出现再弹
        if (!this.hasPasswordField()) return;

        // 在事件触发时实时检测是否为登录输入框，避免因 DOM 动态加载顺序导致推断失败
        if (!this.isLoginInput(input)) return;

        // 如果当前已经在此输入框显示了弹窗，则不再重复创建
        if (this._tooltip.isVisible && this.activeInput === input) return;

        this.showCredentialPopup(input);
    }

    /**
     * 监听 DOM 变化，处理动态添加的输入框
     */
    observeNewInputs() {
        if (this.observer) return; // 避免重复监听

        this.observer = new MutationObserver((mutations) => {
            let hasNewInputs = false;
            let hasNewPassword = false;
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeType !== 1) return;
                    const consider = (el) => {
                        if (el.tagName !== 'INPUT') return;
                        this.bindInput(el);
                        hasNewInputs = true;
                        if (el.type === 'password' || el.getAttribute('data-password-toggle') === 'true') {
                            hasNewPassword = true;
                        }
                    };
                    if (node.tagName === 'INPUT') consider(node);
                    const inputs = node.querySelectorAll?.('input');
                    if (inputs?.length) inputs.forEach(consider);
                });
            });
            // 分步登录：第二步密码框出现后，若已匹配到项目且浮层未显示，主动尝试弹出
            if (hasNewPassword && this.currentProject && !(this._tooltip && this._tooltip.isVisible)) {
                const active = document.activeElement;
                if (active && active.tagName === 'INPUT' && active !== document.body) {
                    this.tryShowPopup(active);
                }
            }
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

        // 标签是多值分类，Tab 仅用于浏览标签集合。
        const namedGroups = [];
        sorted.forEach(c => {
            CredentialTagUtils.normalizeTags(c.note).forEach(tag => {
                if (!namedGroups.some(item => CredentialTagUtils.keyOf(item) === CredentialTagUtils.keyOf(tag))) {
                    namedGroups.push(tag);
                }
            });
        });
        const hasUngroupedMain = sorted.some(c => CredentialTagUtils.normalizeTags(c.note).length === 0);
        // 标签模式下始终保留「其他」作为默认分组，避免所有凭证都带标签时采集被迫带标签
        const forceUngrouped = this.credentialViewMode === 'tab';
        const tabGroups = (hasUngroupedMain || forceUngrouped) ? [...namedGroups, ''] : namedGroups;
        // 应用用户自定义标签页顺序（拖拽排序持久化到 project.tabOrder；新标签自动追加末尾，「其他」始终最后）
        const orderedGroups = this.orderTabGroups(tabGroups, this.currentProject?.tabOrder);
        this.tabGroups = orderedGroups;
        const useTabMode = this.credentialViewMode === 'tab' && namedGroups.length > 0;
        // 无有效选中时：默认定位到第一个标签（打开即高亮显示当前标签）；「其他」始终常驻，可点选以采集无标签凭证
        if (!orderedGroups.some(tag => tag === this.activeTagKey)) {
            this.activeTagKey = orderedGroups[0] ?? null;
        }
        this.activeTabIndex = Math.max(0, orderedGroups.indexOf(this.activeTagKey));

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

            const tagsToShow = CredentialTagUtils.normalizeTags(cred.note);
            if (tagsToShow.length > 0) {
                const noteRow = document.createElement('div');
                noteRow.style.cssText = 'display: flex; flex-wrap: wrap; gap: 3px; margin-top: 3px;';
                tagsToShow.forEach(tag => {
                    const isCurrent = useTabMode && CredentialTagUtils.keyOf(tag) === CredentialTagUtils.keyOf(currentTabKey || '');
                    const tagEl = document.createElement('span');
                    tagEl.textContent = tag;
                    tagEl.style.cssText = `font-size: 11px; color: ${isCurrent ? '#5b3db2' : '#996b00'}; background: ${isCurrent ? '#f0ebff' : '#fffbf0'}; border-radius: 4px; padding: 1px 5px; border: 1px solid ${isCurrent ? '#a890e8' : '#f0c060'}; line-height: 1.5;`;
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

        // 顶部标题条：占位 ~28px，让 SideTooltip 的指向箭头落在标题区，不压住下方 tab 栏
        const headerEl = document.createElement('div');
        headerEl.textContent = this.currentProject?.name || '凭证管理';
        headerEl.title = this.currentProject?.name || '';
        headerEl.style.cssText = 'flex-shrink: 0; padding: 7px 14px; font-size: 12px; font-weight: 600; color: #555; background: #fff; border-bottom: 1px solid #e8eaf6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
        listContainer.appendChild(headerEl);

        if (useTabMode) {
            const tabBar = document.createElement('div');
            tabBar.style.cssText = 'display: flex; overflow-x: auto; border-bottom: 1px solid #e8eaf6; background: #fafbff; flex-shrink: 0; scrollbar-width: none;';
            const contentArea = document.createElement('div');
            contentArea.style.cssText = 'overflow-y: auto; flex: 1;';

            const renderTabContent = (idx) => {
                contentArea.innerHTML = '';
                const key = this.tabGroups[idx];
                const filteredCreds = sorted.filter(c => {
                    const tags = CredentialTagUtils.normalizeTags(c.note);
                    return key === '' ? tags.length === 0 : CredentialTagUtils.hasTag(tags, key);
                });
                filteredCreds.forEach(cred => contentArea.appendChild(buildCredItem(cred, key)));
            };

            // 拖拽插入指示线：绝对定位覆盖在 tab 栏上，不与源标签的「抬起」阴影冲突
            tabBar.style.position = 'relative';
            const dropLine = document.createElement('div');
            dropLine.style.cssText = 'position:absolute; top:4px; bottom:4px; width:3px; background:#667eea; border-radius:2px; display:none; pointer-events:none; z-index:5;';
            tabBar.appendChild(dropLine);

            this.tabGroups.forEach((tabKey, idx) => {
                const isActive = tabKey === this.activeTagKey;
                const isUngrouped = tabKey === '';
                const tab = document.createElement('div');
                tab.dataset.tabKey = tabKey;
                tab.style.cssText = `position: relative; display: flex; align-items: center; gap: 3px; padding: 6px 12px; font-size: 11px; cursor: ${isUngrouped ? 'pointer' : 'grab'}; white-space: nowrap; border-bottom: 2px solid ${isActive ? '#667eea' : 'transparent'}; color: ${isActive ? '#667eea' : '#999'}; font-weight: ${isActive ? '600' : '400'}; transition: color 0.15s, background 0.15s, box-shadow 0.15s, opacity 0.15s; background: transparent;`;
                // 命名标签：悬停淡入的拖拽手柄，提升可发现性
                let grip = null;
                if (!isUngrouped) {
                    grip = document.createElement('span');
                    grip.textContent = '⠿';
                    grip.style.cssText = 'font-size: 11px; line-height: 1; color: #c0c0c8; opacity: 0; transition: opacity 0.15s; user-select: none;';
                    tab.appendChild(grip);
                }
                const labelSpan = document.createElement('span');
                labelSpan.textContent = tabKey === '' ? '其他' : tabKey;
                tab.appendChild(labelSpan);
                tab.title = isUngrouped ? '其他分组（固定末尾，不参与排序）' : '拖动可调整顺序';
                if (!isUngrouped) {
                    // 采用指针事件实现拖拽排序（非原生 HTML5 DnD）：原生拖拽在浮层内 drop 不触发，
                    // 指针事件配合 setPointerCapture 更稳定、落点更可控。move/up 挂 document 兜底，
                    // 即便 capture 失败或光标短暂离开 tab 也能继续收到事件。
                    tab.style.userSelect = 'none';
                    tab.style.webkitUserSelect = 'none';
                    tab.style.webkitUserDrag = 'none';
                    // 阻止原生文本/图片拖拽产生的「幽灵拖影」
                    tab.addEventListener('dragstart', (e) => e.preventDefault());
                    tab.addEventListener('pointerdown', (e) => {
                        if (e.button !== 0) return; // 仅响应左键
                        let captured = false;
                        try { tab.setPointerCapture(e.pointerId); captured = true; } catch (_) {}
                        const st = {
                            startX: e.clientX, startY: e.clientY,
                            dragging: false,
                            srcTab: tab, srcKey: tabKey,
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
                            if (captured) { try { tab.releasePointerCapture(ev.pointerId); } catch (_) {} }
                            dropLine.style.display = 'none';
                            clearTargets();
                            if (!st.dragging) return; // 未发生拖拽，按普通点击处理（mousedown 已切 tab）
                            st.srcTab.classList.remove('cmf-dragging');
                            st.srcTab.style.opacity = '';
                            st.srcTab.style.boxShadow = '';
                            if (st.targetKey && st.targetKey !== st.srcKey) {
                                this.reorderTabGroups(st.srcKey, st.targetKey, st.targetAfter ? 'after' : 'before');
                            }
                        };
                        document.addEventListener('pointermove', onMove);
                        document.addEventListener('pointerup', onUp);
                    });
                }
                tab.addEventListener('mouseenter', () => {
                    if (!isActive) tab.style.color = '#555';
                    if (grip) grip.style.opacity = '1';
                });
                tab.addEventListener('mouseleave', () => {
                    if (!isActive) tab.style.color = '#999';
                    if (grip && !tab.classList.contains('cmf-dragging')) grip.style.opacity = '0';
                });
                tab.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    this.activeTabIndex = idx;
                    this.activeTagKey = tabKey;
                    Array.from(tabBar.children).forEach((t) => {
                        if (!t.dataset || t.dataset.tabKey === undefined) return;
                        const a = t.dataset.tabKey === tabKey;
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

        // 空状态提示：帮助判断是“未匹配项目”还是“该项目暂无凭证”
        if (sorted.length === 0) {
            const tip = document.createElement('div');
            tip.style.cssText = 'padding: 10px 14px; color: #999; font-size: 12px; line-height: 1.5;';
            tip.textContent = this.currentProject
                ? '该项目暂无凭证，可点击下方按钮采集'
                : '未匹配到项目，请在插件中把本页面绑定到对应项目，或采集新凭证';
            listContainer.appendChild(tip);
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
            const currentTabKey = useTabMode ? this.activeTagKey : null;
            await this.collectCurrentCredential(currentTabKey);
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
        const iframeNamedGroups = [];
        credentials.forEach(c => {
            CredentialTagUtils.normalizeTags(c.note).forEach(tag => {
                if (!iframeNamedGroups.some(item => CredentialTagUtils.keyOf(item) === CredentialTagUtils.keyOf(tag))) {
                    iframeNamedGroups.push(tag);
                }
            });
        });
        const iframeHasUngrouped = credentials.some(c => CredentialTagUtils.normalizeTags(c.note).length === 0);
        const iframeTabGroups = iframeHasUngrouped ? [...iframeNamedGroups, ''] : iframeNamedGroups;
        const iframeUseTab = this.credentialViewMode === 'tab' && iframeNamedGroups.length > 0;
        if (!iframeTabGroups.some(tag => tag === this.activeTagKey)) this.activeTagKey = iframeTabGroups[0] ?? null;
        this.activeTabIndex = Math.max(0, iframeTabGroups.indexOf(this.activeTagKey));

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

            const tagsToShow = CredentialTagUtils.normalizeTags(cred.note);
            if (tagsToShow.length > 0) {
                const noteRow = document.createElement('div');
                noteRow.style.cssText = 'display: flex; flex-wrap: wrap; gap: 3px; margin-top: 3px;';
                tagsToShow.forEach(tag => {
                    const isCurrent = iframeUseTab && CredentialTagUtils.keyOf(tag) === CredentialTagUtils.keyOf(currentTabKey || '');
                    const tagEl = document.createElement('span');
                    tagEl.textContent = tag;
                    tagEl.style.cssText = `font-size: 11px; color: ${isCurrent ? '#5b3db2' : '#996b00'}; background: ${isCurrent ? '#f0ebff' : '#fffbf0'}; border-radius: 4px; padding: 1px 5px; border: 1px solid ${isCurrent ? '#a890e8' : '#f0c060'}; line-height: 1.5;`;
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

        // 顶部标题条：占位 ~28px，让 SideTooltip 的指向箭头落在标题区，不压住下方 tab 栏
        const headerEl = document.createElement('div');
        headerEl.textContent = this.currentProject?.name || '凭证管理';
        headerEl.title = this.currentProject?.name || '';
        headerEl.style.cssText = 'flex-shrink: 0; padding: 7px 14px; font-size: 12px; font-weight: 600; color: #555; background: #fff; border-bottom: 1px solid #e8eaf6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
        listContainer.appendChild(headerEl);

        if (iframeUseTab) {
            const tabBar = document.createElement('div');
            tabBar.style.cssText = 'display: flex; overflow-x: auto; border-bottom: 1px solid #e8eaf6; background: #fafbff; flex-shrink: 0; scrollbar-width: none;';
            const contentArea = document.createElement('div');
            contentArea.style.cssText = 'overflow-y: auto; flex: 1;';

            const renderIframeTabContent = (idx) => {
                contentArea.innerHTML = '';
                const key = iframeTabGroups[idx];
                credentials.filter(c => {
                    const tags = CredentialTagUtils.normalizeTags(c.note);
                    return key === '' ? tags.length === 0 : CredentialTagUtils.hasTag(tags, key);
                }).forEach(cred => contentArea.appendChild(buildIframeItem(cred, key)));
            };

            iframeTabGroups.forEach((tabKey, idx) => {
                const isActive = tabKey === this.activeTagKey;
                const tab = document.createElement('div');
                tab.textContent = tabKey === '' ? '其他' : tabKey;
                tab.style.cssText = `padding: 6px 12px; font-size: 11px; cursor: pointer; white-space: nowrap; border-bottom: 2px solid ${isActive ? '#667eea' : 'transparent'}; color: ${isActive ? '#667eea' : '#999'}; font-weight: ${isActive ? '600' : '400'}; transition: color 0.15s; background: transparent;`;
                tab.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    this.activeTabIndex = idx;
                    this.activeTagKey = tabKey;
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
            const currentTabKey = iframeUseTab ? this.activeTagKey : null;
            this._iframeSource?.postMessage(JSON.stringify({ type: 'CREDENTIAL_FILLER_COLLECT', currentTabKey }), '*');
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
        const usernameInput = this.findUsernameInput({ includeHidden: true });

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
    findUsernameInput(options = {}) {
        const includeHidden = !!options.includeHidden;
        // 基础池：排除 type=hidden 与 display:none 的框（仍含 visibility:hidden / 离屏的“收起”框）
        const base = Array.from(document.querySelectorAll(
            'input[type="text"], input[type="email"], input[type="tel"], input:not([type])'
        )).filter(i => i.type !== 'hidden' && window.getComputedStyle(i).display !== 'none');
        const pool = includeHidden ? base : this.getVisibleInputs();

        // 优先通过语义识别找用户名框
        const byHint = pool.find(input => this.detectFieldType(input) === 'username');
        if (byHint) return byHint;

        // 分步登录：第二步用户名框可能被 display:none 收起（值保留在 DOM），仍尝试用语义识别命中
        if (includeHidden) {
            const hiddenUser = Array.from(document.querySelectorAll(
                'input[type="text"], input[type="email"], input[type="tel"], input:not([type])'
            )).find(i => i.type !== 'hidden' && window.getComputedStyle(i).display === 'none'
                && this.detectFieldType(i) === 'username');
            if (hiddenUser) return hiddenUser;
        }

        // 兜底：找密码框前面最近的文本输入框
        const passwordInput = this.findPasswordInput();
        if (!passwordInput) return pool[0] || null;

        let closest = null;
        for (const input of pool) {
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
            // 排除真正隐藏的元素；offsetParent 为 null 仅代表脱离文档流（如 position:fixed），不代表不可见
            if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
            if (input.offsetParent === null && style.position !== 'fixed') return false;
            return true;
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
        // 与浮层展示/填充共用同一个「密码框前最近文本框」兜底，
        // 避免无语义的账号框在采集时被错误归类为自定义字段。
        const fallbackUsernameInput = this.findUsernameInput();

        allInputs.forEach(input => {
            const style = window.getComputedStyle(input);
            if (style.display === 'none' || style.visibility === 'hidden') return;
            if (!input.value) return;

            const type = (input.type || 'text').toLowerCase();
            // 跳过不相关的类型
            if (['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'image', 'reset'].includes(type)) return;

            const selector = this.generateSelector(input);
            let fieldType = this.detectFieldType(input);
            if (input === fallbackUsernameInput && fieldType === 'other') {
                fieldType = 'username';
            }
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
     * 比较两个标签集合是否等价（忽略顺序、首尾空格、空标签）。
     */
    tagsEqual(a, b) {
        return CredentialTagUtils.tagsEqual(a, b);
    }

    /**
     * 在页面内采集当前填写的凭证并直接保存
     */
    async collectCurrentCredential(currentTabKey = null) {
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
        // 密码必须保留原始值；trim 会篡改合法的首尾空格密码。
        const password = passwordField ? passwordField.value : '';
        if (!username || password.length === 0) {
            Toast.warning('用户名和密码必须都填写完整才能采集');
            return;
        }

        const { title: pageTitle } = await this._getTopContext();
        let projects;
        try {
            const stored = typeof StorageState !== 'undefined'
                ? { credentialProjects: StorageState.get('credentialProjects', []) }
                : await chrome.storage.local.get(['credentialProjects']);
            projects = stored.credentialProjects || [];
        } catch (e) {
            if (e.message && e.message.includes('Extension context invalidated')) {
                Toast.error('插件刚被重新加载，请刷新当前网页以继续使用。');
                return;
            }
            throw e;
        }

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

        const contextTag = CredentialTagUtils.normalizeTags(currentTabKey)[0] || '';
        const note = contextTag ? [contextTag] : [];
        let existingIdx = project.credentials.findIndex(c => (
            c.username === username && this.tagsEqual(c.note, note)
        ));
        // 当前标签命中唯一多标签凭证时，更新它但保留完整标签集合。
        if (existingIdx < 0 && contextTag) {
            const contextMatches = project.credentials
                .map((credential, index) => ({ credential, index }))
                .filter(({ credential }) => credential.username === username
                    && CredentialTagUtils.hasTag(credential.note, contextTag));
            if (contextMatches.length === 1) existingIdx = contextMatches[0].index;
        }
        let msg = '';
        if (existingIdx >= 0) {
            const existing = project.credentials[existingIdx];
            existing.password = password;
            existing.customFields = customFields;
            existing.note = CredentialTagUtils.normalizeTags(existing.note);
            msg = '已覆盖更新该账号凭证！';
        } else {
            project.credentials.push({
                id: Date.now().toString(36) + Math.random().toString(36).substr(2, 9),
                label: username || '未命名',
                username,
                password,
                customFields,
                note,
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
        // 还原被本扩展改为抑制原生密码建议的输入框的 autocomplete 属性
        this._restoreAllSuppressed();
        // 退订「抑制原生密码建议」开关监听
        if (this._unsubSuppress) { this._unsubSuppress(); this._unsubSuppress = null; }
        console.log('凭证填充功能已清理');
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
     * 拖拽完成后更新并持久化标签顺序，然后重渲染浮层。
     * 「其他」固定末尾不参与排序；拖到「其他」上视为无效操作。
     */
    async reorderTabGroups(draggedKey, targetKey, position = 'before') {
        const project = this.currentProject;
        if (!project || !draggedKey || !targetKey) return;
        const dKey = CredentialTagUtils.keyOf(draggedKey);
        const tKey = CredentialTagUtils.keyOf(targetKey);
        if (dKey === tKey || tKey === '') return;
        // 仅对命名标签页排序（当前 this.tabGroups 已是上一轮排好序的列表）
        const current = (this.tabGroups || []).filter(g => g !== '').map(g => CredentialTagUtils.keyOf(g));
        const dIdx = current.indexOf(dKey);
        const tIdx = current.indexOf(tKey);
        if (dIdx === -1 || tIdx === -1) return;
        current.splice(dIdx, 1);
        const insertAt = position === 'after' ? current.indexOf(tKey) + 1 : current.indexOf(tKey);
        current.splice(insertAt, 0, dKey);
        // 持久化到 storage（直读后写回同一 id 的项目，绕开缓存时序）
        try {
            const data = await chrome.storage.local.get(['credentialProjects']);
            const projects = data.credentialProjects || [];
            const idx = projects.findIndex(p => p.id === project.id);
            if (idx >= 0) projects[idx].tabOrder = current;
            await chrome.storage.local.set({ credentialProjects: projects });
            project.tabOrder = current;
        } catch (e) { /* 持久化失败不阻断排序体验 */ }
        // 重渲染浮层（沿用当前聚焦的输入框）
        if (this.activeInput) this.showCredentialPopup(this.activeInput);
    }
}
