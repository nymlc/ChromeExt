/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-01-26 15:28:40
 * @LastEditors: 林晨 linchen@yixin.im
 * @LastEditTime: 2026-01-26 16:43:34
 * @FilePath: /ChromeExt/content/content.js
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
// Content Script - 在网页中运行的脚本
class PasswordHelper {
  constructor() {
    this.isVisible = false;
    this.observer = null;
    this.processedInputs = new WeakSet();
    this.init();
  }
  
  async init() {
    // 读取保存的状态
    const result = await chrome.storage.local.get(['passwordVisible']);
    this.isVisible = result.passwordVisible || false;
    
    // 等待DOM加载完成
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this.setupPasswordFields());
    } else {
      this.setupPasswordFields();
    }
    
    // 监听来自popup的消息
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'togglePassword') {
        this.isVisible = request.show;
        this.toggleAllPasswords(request.show);
        sendResponse({ success: true });
      }
    });
    
    // 监听DOM变化，自动处理新添加的密码框
    this.observePasswordFields();
    
    // 监听存储变化
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.passwordVisible) {
        this.isVisible = changes.passwordVisible.newValue;
        this.toggleAllPasswords(this.isVisible);
      }
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
    wrapper.style.cssText = 'position: relative; display: inline-block; width: 100%;';
    
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
    
    // 插入包装容器
    const parent = input.parentElement;
    const inputStyle = window.getComputedStyle(input);
    
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
}

// 初始化
new PasswordHelper();
