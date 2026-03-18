/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-03-05 15:20:00
 * @FilePath: /ChromeExt/popup/utils/Toast.js
 * @Description: Toast 提示工具类
 */

class Toast {
  static show(message, duration = 2000, type = 'info') {
    // 创建 toast 容器（如果不存在）
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 10000;
        display: flex;
        flex-direction: column;
        gap: 10px;
        pointer-events: none;
      `;
      document.body.appendChild(container);
    }
    
    // 创建 toast 元素
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    
    // 根据类型设置样式
    const colors = {
      info: '#667eea',
      success: '#4caf50',
      warning: '#ff9800',
      error: '#f44336'
    };
    
    toast.style.cssText = `
      background: ${colors[type] || colors.info};
      color: white;
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
    
    container.appendChild(toast);
    
    // 触发动画
    setTimeout(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateY(0)';
    }, 10);
    
    // 自动移除
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-20px)';
      setTimeout(() => {
        container.removeChild(toast);
        // 如果容器为空，移除容器
        if (container.children.length === 0) {
          document.body.removeChild(container);
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
