/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-05-08 15:04:00
 * @FilePath: /ChromeExt/shared/Toast.js
 * @Description: Toast 提示工具类 - popup 和 content script 共用
 */

class Toast {
  /**
   * 显示一个 Toast 提示
   * @param {string} message - 提示文本
   * @param {number} [duration=2000] - 显示时长(ms)
   * @param {'info'|'success'|'warning'|'error'} [type='info'] - 类型
   */
  static show(message, duration = 2000, type = 'info') {
    // 检测运行环境：popup 中的 z-index 不需要极值
    const isContentScript = !document.querySelector('.app-wrapper');
    const zIndex = isContentScript ? 2147483647 : 10000;

    // 创建 toast 容器（如果不存在）
    let container = document.getElementById('geek-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'geek-toast-container';
      container.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        z-index: ${zIndex};
        display: flex;
        flex-direction: column;
        gap: 10px;
        pointer-events: none;
      `;
      document.body.appendChild(container);
    }

    // 图标映射
    const icons = {
      info: 'ℹ️',
      success: '✅',
      warning: '⚠️',
      error: '❌'
    };

    // 颜色映射（用于 popup 环境的彩色模式）
    const colors = {
      info: { bg: '#667eea', color: '#fff' },
      success: { bg: '#4caf50', color: '#fff' },
      warning: { bg: '#ff9800', color: '#fff' },
      error: { bg: '#f44336', color: '#fff' }
    };

    // content script 使用白底 + 图标风格，popup 使用彩色风格
    const scheme = colors[type] || colors.info;

    const toast = document.createElement('div');

    if (isContentScript) {
      // Content Script 风格：白底、带图标、高 z-index
      toast.innerHTML = `
        <span style="margin-right: 8px; font-size: 16px;">${icons[type] || icons.info}</span>
        <span>${message}</span>
      `;
      toast.style.cssText = `
        background: #ffffff;
        color: #333333;
        padding: 12px 20px;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 500;
        pointer-events: auto;
        opacity: 0;
        display: flex;
        align-items: center;
        box-shadow: 0 6px 16px rgba(0,0,0,0.12), 0 2px 4px rgba(0,0,0,0.04);
        border: 1px solid #f0f0f0;
        transform: translateY(-20px);
        transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      `;
    } else {
      // Popup 风格：彩色背景、紧凑
      toast.textContent = message;
      toast.style.cssText = `
        background: ${scheme.bg};
        color: ${scheme.color};
        padding: 12px 20px;
        border-radius: 8px;
        font-size: 14px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        opacity: 0;
        transform: translateY(-20px);
        transition: all 0.3s ease;
        pointer-events: auto;
        max-width: 300px;
        word-wrap: break-word;
      `;
    }

    container.appendChild(toast);

    // 触发 reflow 后入场
    toast.offsetHeight;
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';

    // 自动退场
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-20px)';
      setTimeout(() => {
        toast.remove();
        // 如果容器为空，移除容器
        if (container.children.length === 0) {
          container.remove();
        }
      }, 300);
    }, duration);
  }

  static info(message, duration) {
    this.show(message, duration, 'info');
  }

  static success(message, duration) {
    this.show(message, duration, 'success');
  }

  static warning(message, duration) {
    this.show(message, duration, 'warning');
  }

  static error(message, duration) {
    this.show(message, duration, 'error');
  }
}
