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
  
  setupPasswordFields() {
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
    // 检查是否已经有图标
    if (input.parentElement?.querySelector('.password-toggle-icon')) return;
    
    // 创建包装容器
    const wrapper = document.createElement('div');
    const inputStyle = window.getComputedStyle(input);
    // 检查是否设置了 width: 100% (检查 inline style 或者实际宽度是否等于父元素宽度)
    const styleAttr = input.getAttribute('style') || '';
    const hasInlineFullWidth = input.style.width === '100%' || 
                                styleAttr.includes('width: 100%') ||
                                styleAttr.includes('width:100%');
    // 检查计算后的宽度是否接近父元素宽度
    const parent = input.parentElement;
    const parentWidth = parent ? parent.offsetWidth : 0;
    const inputWidth = input.offsetWidth;
    const isComputedFullWidth = parentWidth > 0 && Math.abs(inputWidth - parentWidth) < 5; // 允许5px误差
    console.error(parentWidth, inputWidth)
    const isFullWidth = hasInlineFullWidth || isComputedFullWidth;
    wrapper.style.cssText = `position: relative; display: ${isFullWidth ? 'block' : 'inline-block'}; width: ${isFullWidth ? '100%' : 'auto'};`;
    
    // 创建眼睛图标
    const icon = document.createElement('span');
    icon.className = 'password-toggle-icon';
    icon.innerHTML = '👁️';
    icon.style.cssText = `
      position: absolute;
      right: 10px;
      top: 50%;
      transform: translateY(-50%);
      cursor: pointer;
      user-select: none;
      font-size: 18px;
      z-index: 10000;
      opacity: 0.6;
      transition: opacity 0.2s;
    `;
    
    icon.addEventListener('mouseenter', () => {
      icon.style.opacity = '1';
    });
    
    icon.addEventListener('mouseleave', () => {
      icon.style.opacity = '0.6';
    });
    
    icon.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleSinglePassword(input);
      this.updateEyeIcon(input, icon);
    });
    
    // 如果input已经在相对定位的容器中，直接添加图标
    if (inputStyle.position === 'absolute' || parent.style.position === 'relative' || parent.style.position === 'absolute') {
      parent.style.position = parent.style.position || 'relative';
      parent.appendChild(icon);
    } else {
      // 否则创建包装容器
      parent.insertBefore(wrapper, input);
      wrapper.appendChild(input);
      wrapper.appendChild(icon);
    }
    
    this.updateEyeIcon(input, icon);
  }
  
  updateEyeIcon(input, icon) {
    const isVisible = input.type === 'text' && input.getAttribute('data-password-toggle') === 'true';
    icon.innerHTML = isVisible ? '🙈' : '👁️';
    icon.title = isVisible ? '隐藏密码' : '显示密码';
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
    const icon = input.parentElement?.querySelector('.password-toggle-icon');
    if (icon) {
      this.updateEyeIcon(input, icon);
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
      const icon = input.parentElement?.querySelector('.password-toggle-icon');
      if (icon) {
        this.updateEyeIcon(input, icon);
      }
    });
  }
  
  observePasswordFields() {
    // 监听DOM变化，自动处理动态添加的密码框
    this.observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
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
      });
    });
    
    this.observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }
  
  destroy() {
    // 移除所有眼睛图标
    const icons = document.querySelectorAll('.password-toggle-icon');
    icons.forEach(icon => icon.remove());
    
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
    
    // 清空已处理的输入框集合
    this.processedInputs = new WeakSet();
    
    console.log('密码功能已清理');
  }
}
