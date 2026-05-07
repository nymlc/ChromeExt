/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-03-05 14:30:00
 * @FilePath: /ChromeExt/content/modules/PasswordHelper.js
 * @Description: 密码显示功能模块
 */

class PasswordHelper extends BaseContentModule {
  constructor() {
    super('password'); // 传入模块名称
    this.isVisible = false;
    this.observer = null;
    this.processedInputs = new WeakSet();
    this.managedFields = []; // [{ input, icon }]
    this.iconContainer = null;
    this.updatePositions = this.updatePositions.bind(this);
  }
  
  async init() {
    // 检查模块是否应该启用（继承自BaseContentModule）
    const enabled = await this.checkModuleEnabled();
    if (!enabled) {
      return;
    }
    
    // 读取保存的状态（session storage 以 tabId 为 key，刷新后自动重置为 false）
    this.isVisible = false;
    
    // 等待DOM加载完成
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this.setupPasswordFields());
    } else {
      this.setupPasswordFields();
    }
    
    // 监听来自popup的消息
    chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
      if (request.action === 'togglePassword') {
        this.isVisible = request.show;
        this.toggleAllPasswords(request.show);
        sendResponse({ success: true });
      }
    });
    
    // 监听DOM变化，自动处理新添加的密码框
    this.observePasswordFields();
    
    // 监听存储变化（只监听启用/禁用相关的变化，密码显示状态通过消息传递）
    chrome.storage.onChanged.addListener((changes) => {
    });
  }
  
  ensureIconContainer() {
    if (!this.iconContainer) {
      this.iconContainer = document.createElement('div');
      this.iconContainer.id = 'geek-toolbox-password-icons';
      this.iconContainer.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 0; pointer-events: none; z-index: 2147483647;';
      
      const parent = document.body || document.documentElement;
      if (parent) parent.appendChild(this.iconContainer);
      
      window.addEventListener('scroll', this.updatePositions, true);
      window.addEventListener('resize', this.updatePositions);
      this.positionInterval = setInterval(this.updatePositions, 500);
    }
  }

  setupPasswordFields() {
    this.ensureIconContainer();

    // 为所有密码框添加功能
    const passwordInputs = document.querySelectorAll('input[type="password"]');
    passwordInputs.forEach(input => this.enhancePasswordInput(input));
    
    // 立即应用状态
    if (this.isVisible) {
      this.toggleAllPasswords(true);
    }
  }
  
  enhancePasswordInput(input) {
    // 避免重复处理
    if (this.processedInputs.has(input)) return;
    this.processedInputs.add(input);
    
    // 添加眼睛图标
    this.addEyeIcon(input);
    
    // 添加双击切换功能
    input.addEventListener('dblclick', (e) => {
      e.preventDefault();
      this.toggleSinglePassword(input);
    });
  }
  
  addEyeIcon(input) {
    this.ensureIconContainer();
    if (!this.iconContainer) return;
    
    // 创建眼睛图标
    const icon = document.createElement('div');
    icon.className = 'password-toggle-icon';
    icon.style.cssText = `
      position: absolute;
      transform: translateY(-50%);
      cursor: pointer;
      user-select: none;
      color: #888;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border-radius: 4px;
      pointer-events: auto;
      transition: background 0.2s, color 0.2s;
    `;
    
    icon.addEventListener('mouseenter', () => {
      icon.style.background = '#f0f0f0';
      icon.style.color = '#333';
    });
    icon.addEventListener('mouseleave', () => {
      icon.style.background = 'transparent';
      icon.style.color = '#888';
    });
    
    icon.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleSinglePassword(input);
    });
    
    this.iconContainer.appendChild(icon);
    this.managedFields.push({ input, icon });
    
    this.updateEyeIcon(input, icon);
    this.updatePositions();
  }
  
  updateEyeIcon(input, icon) {
    const isVisible = input.type === 'text' && input.getAttribute('data-password-toggle') === 'true';
    var eyeOffSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 15px; height: 15px;">'
      + '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/>'
      + '<path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/>'
      + '<path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/>'
      + '<line x1="2" y1="2" x2="22" y2="22"/>'
      + '</svg>';
    var eyeOnSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 15px; height: 15px;">'
      + '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>'
      + '<circle cx="12" cy="12" r="3"/>'
      + '</svg>';
    if (isVisible) {
        icon.innerHTML = eyeOffSvg;
        icon.title = '隐藏密码';
    } else {
        icon.innerHTML = eyeOnSvg;
        icon.title = '显示密码';
    }
  }

  updatePositions() {
    this.managedFields.forEach(({ input, icon }) => {
        const rect = input.getBoundingClientRect();
        // 检查元素是否可见且存在于 DOM (使用 isConnected 兼容 Shadow DOM)
        if (!input.isConnected || rect.width === 0 || rect.height === 0 || window.getComputedStyle(input).visibility === 'hidden') {
            icon.style.display = 'none';
            return;
        }
        icon.style.display = 'flex';
        // 定位到输入框右侧内部（距离右边缘 8px，如果输入框有 padding 可以避免遮挡，统一往左偏移 28px）
        icon.style.left = (rect.right + window.scrollX - 28) + 'px';
        icon.style.top = (rect.top + window.scrollY + rect.height / 2) + 'px';
    });
  }
  
  toggleSinglePassword(input) {
    if (input.type === 'password') {
      input.type = 'text';
      input.setAttribute('data-password-toggle', 'true');
    } else if (input.getAttribute('data-password-toggle') === 'true') {
      input.type = 'password';
      input.removeAttribute('data-password-toggle');
    }
    
    // 更新对应的眼睛图标
    const field = this.managedFields.find(f => f.input === input);
    if (field) {
      this.updateEyeIcon(field.input, field.icon);
    }
  }
  
  toggleAllPasswords(show) {
    const passwordInputs = document.querySelectorAll('input[type="password"], input[type="text"][data-password-toggle]');
    
    passwordInputs.forEach(input => {
      if (show) {
        if (input.type === 'password') {
          input.type = 'text';
          input.setAttribute('data-password-toggle', 'true');
        }
      } else {
        if (input.getAttribute('data-password-toggle') === 'true') {
          input.type = 'password';
          input.removeAttribute('data-password-toggle');
        }
      }
      
      // 更新眼睛图标
      const field = this.managedFields.find(f => f.input === input);
      if (field) {
        this.updateEyeIcon(field.input, field.icon);
      }
    });
  }
  
  observePasswordFields() {
    // 监听DOM变化，自动处理动态添加的密码框
    this.observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        // 1. 监听 type 属性的动态变化 (比如 Vue 动态切换 text -> password)
        if (mutation.type === 'attributes' && mutation.attributeName === 'type') {
            if (mutation.target.tagName === 'INPUT' && mutation.target.type === 'password') {
                this.enhancePasswordInput(mutation.target);
            }
        }
        
        // 2. 监听新增节点
        if (mutation.type === 'childList') {
            mutation.addedNodes.forEach((node) => {
              if (node.nodeType === 1) {
                // 检查新添加的节点是否是密码框
                if (node.tagName === 'INPUT' && node.type === 'password') {
                  this.enhancePasswordInput(node);
                  if (this.isVisible) {
                    node.type = 'text';
                    node.setAttribute('data-password-toggle', 'true');
                  }
                }
                // 检查子节点中的密码框
                const passwordInputs = node.querySelectorAll?.('input[type="password"]');
                passwordInputs?.forEach(input => {
                  this.enhancePasswordInput(input);
                  if (this.isVisible) {
                    input.type = 'text';
                    input.setAttribute('data-password-toggle', 'true');
                  }
                });
              }
            });
        }
      });
    });
    
    this.observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['type']
    });
  }
  
  destroy() {
    // 移除容器
    if (this.iconContainer) {
      this.iconContainer.remove();
      this.iconContainer = null;
    }
    
    window.removeEventListener('scroll', this.updatePositions, true);
    window.removeEventListener('resize', this.updatePositions);
    if (this.positionInterval) clearInterval(this.positionInterval);
    
    // 恢复所有密码框
    const passwordInputs = document.querySelectorAll('input[type="text"][data-password-toggle]');
    passwordInputs.forEach(input => {
      input.type = 'password';
      input.removeAttribute('data-password-toggle');
    });
    
    // 停止观察
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    
    // 清空状态
    this.processedInputs = new WeakSet();
    this.managedFields = [];
    
    console.log('密码功能已清理');
  }
}
