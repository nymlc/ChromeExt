/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-04-27 10:00:00
 * @FilePath: /ChromeExt/content/modules/CredentialFiller.js
 * @Description: 凭证填充功能模块 - 在页面输入框聚焦时弹出凭证选择列表
 */

class CredentialFiller extends BaseContentModule {
    constructor() {
        super('credential');
        this.currentProject = null;
        this.popupEl = null;
        this.activeInput = null;
        this.processedInputs = new WeakSet();
        this.observer = null;
    }

    async init() {
        const enabled = await this.checkModuleEnabled();
        if (!enabled) return;

        // 根据页面 title 匹配项目
        await this.matchProject();

        // 监听输入框聚焦
        this.setupInputListeners();
        this.observeNewInputs();

        // 监听来自 popup 的消息
        chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
            if (request.action === 'scanPageInputs') {
                const fields = this.scanInputs();
                sendResponse({ success: true, fields });
            } else if (request.action === 'fillCredential') {
                this.fillCredential(request.credential);
                sendResponse({ success: true });
            } else if (request.action === 'credentialProjectUpdated') {
                // 项目数据更新后重新匹配
                this.matchProject();
                sendResponse({ success: true });
            }
            return true;
        });
    }

    /**
     * 根据页面 title 模糊匹配项目
     */
    async matchProject() {
        const pageTitle = document.title;
        const result = await chrome.storage.local.get(['credentialProjects', 'titleProjectBindings']);
        const projects = result.credentialProjects || [];
        const bindings = result.titleProjectBindings || {};

        // 优先使用手动绑定的项目
        const boundId = bindings[pageTitle];
        if (boundId) {
            this.currentProject = projects.find(p => p.id === boundId) || null;
            if (this.currentProject) return;
        }

        // 其次模糊匹配
        this.currentProject = projects.find(p => {
            if (!p.matchTitle) return false;
            const mt = p.matchTitle.toLowerCase();
            const pt = pageTitle.toLowerCase();
            return pt.includes(mt) || mt.includes(pt);
        }) || null;
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
     * 绑定单个输入框
     */
    bindInput(input) {
        if (this.processedInputs.has(input)) return;
        this.processedInputs.add(input);

        input.addEventListener('focus', () => {
            if (this.currentProject && this.currentProject.credentials.length > 0) {
                this.showCredentialPopup(input);
            }
        });
    }

    /**
     * 监听 DOM 变化，处理动态添加的输入框
     */
    observeNewInputs() {
        this.observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeType !== 1) return;
                    if (node.tagName === 'INPUT') {
                        this.bindInput(node);
                    }
                    const inputs = node.querySelectorAll?.('input');
                    inputs?.forEach(input => this.bindInput(input));
                });
            });
        });

        this.observer.observe(document.body, { childList: true, subtree: true });
    }

    /**
     * 在输入框下方显示凭证选择浮层
     */
    showCredentialPopup(input) {
        this.hideCredentialPopup();
        this.activeInput = input;
        this._isSelecting = false;

        const credentials = this.currentProject.credentials;
        // active 在前，disabled 在后
        const sorted = [...credentials].sort((a, b) => {
            if (a.status === 'active' && b.status !== 'active') return -1;
            if (a.status !== 'active' && b.status === 'active') return 1;
            return 0;
        });

        // 创建浮层
        const popup = document.createElement('div');
        popup.className = 'credential-filler-popup';
        popup.style.cssText = `
      position: fixed;
      z-index: 2147483647;
      background: #fff;
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.15);
      max-height: 240px;
      overflow-y: auto;
      min-width: 260px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif;
      font-size: 13px;
      -webkit-overflow-scrolling: touch;
    `;

        sorted.forEach(cred => {
            const item = document.createElement('div');
            const isDisabled = cred.status === 'disabled';
            item.style.cssText = `
        padding: 10px 14px;
        cursor: pointer;
        border-bottom: 1px solid #f5f5f5;
        display: flex;
        flex-direction: column;
        gap: 2px;
        opacity: ${isDisabled ? '0.5' : '1'};
        transition: background 0.15s;
      `;

            const labelLine = document.createElement('div');
            labelLine.style.cssText = `font-weight: 600; color: #333; display: flex; align-items: center; gap: 6px;`;
            labelLine.textContent = cred.label || '未命名';
            if (isDisabled) {
                const badge = document.createElement('span');
                badge.textContent = cred.disabledReason || '已失效';
                badge.style.cssText = `
          font-size: 11px; font-weight: 400; color: #f44336;
          background: #ffebee; padding: 1px 6px; border-radius: 4px;
        `;
                labelLine.appendChild(badge);
            }

            const userLine = document.createElement('div');
            userLine.style.cssText = `color: #888; font-size: 12px;`;
            userLine.textContent = cred.username;

            item.appendChild(labelLine);
            item.appendChild(userLine);

            // 桌面端
            item.addEventListener('mouseenter', () => { item.style.background = '#f5f7ff'; });
            item.addEventListener('mouseleave', () => { item.style.background = ''; });
            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                this._isSelecting = true;
                this.fillCredential(cred);
                this.hideCredentialPopup();
            });

            // 移动端
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

            popup.appendChild(item);
        });

        document.body.appendChild(popup);
        this.popupEl = popup;
        this.positionPopup(popup, input);

        // 点击/触摸外部关闭
        this._outsideClickHandler = (e) => {
            if (!popup.contains(e.target) && e.target !== input) {
                this.hideCredentialPopup();
            }
        };
        setTimeout(() => {
            document.addEventListener('mousedown', this._outsideClickHandler);
            document.addEventListener('touchstart', this._outsideClickHandler);
        }, 100);

        // 输入框失焦时延迟关闭（移动端键盘弹出也会触发 blur，加长延迟）
        this._blurHandler = () => {
            setTimeout(() => {
                if (!this._isSelecting && this.popupEl) {
                    this.hideCredentialPopup();
                }
            }, 300);
        };
        input.addEventListener('blur', this._blurHandler, { once: true });

        // 页面滚动/resize 时重新定位
        this._repositionHandler = () => {
            if (this.popupEl && this.activeInput) {
                this.positionPopup(this.popupEl, this.activeInput);
            }
        };
        window.addEventListener('scroll', this._repositionHandler, true);
        window.addEventListener('resize', this._repositionHandler);
    }

    /**
     * 定位浮层到输入框下方（使用 fixed 定位，基于视口）
     */
    positionPopup(popup, input) {
        const rect = input.getBoundingClientRect();
        const popupHeight = popup.offsetHeight || 240;
        const viewportHeight = window.innerHeight;

        // 判断下方空间是否足够，不够则显示在上方
        const spaceBelow = viewportHeight - rect.bottom;
        if (spaceBelow < popupHeight && rect.top > spaceBelow) {
            popup.style.top = '';
            popup.style.bottom = `${viewportHeight - rect.top + 4}px`;
        } else {
            popup.style.bottom = '';
            popup.style.top = `${rect.bottom + 4}px`;
        }

        popup.style.left = `${Math.max(4, rect.left)}px`;
        popup.style.minWidth = `${Math.max(rect.width, 260)}px`;
        // 不超出右边界
        const maxWidth = window.innerWidth - Math.max(4, rect.left) - 4;
        popup.style.maxWidth = `${maxWidth}px`;
    }

    /**
     * 隐藏浮层
     */
    hideCredentialPopup() {
        if (this.popupEl) {
            this.popupEl.remove();
            this.popupEl = null;
        }
        if (this._outsideClickHandler) {
            document.removeEventListener('mousedown', this._outsideClickHandler);
            document.removeEventListener('touchstart', this._outsideClickHandler);
            this._outsideClickHandler = null;
        }
        if (this._repositionHandler) {
            window.removeEventListener('scroll', this._repositionHandler, true);
            window.removeEventListener('resize', this._repositionHandler);
            this._repositionHandler = null;
        }
        this._isSelecting = false;
        this.activeInput = null;
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

    destroy() {
        this.hideCredentialPopup();
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
        this.processedInputs = new WeakSet();
        console.log('凭证填充功能已清理');
    }
}
