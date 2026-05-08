/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-05-08 14:56:00
 * @FilePath: /ChromeExt/shared/SideTooltip.js
 * @Description: 侧边 Tooltip 弹框工具类 - 在目标元素侧边显示带箭头的浮层，避免与浏览器原生下拉重叠
 */

class SideTooltip {
  /**
   * @param {Object} options 配置项
   * @param {number} [options.gap=25] - 弹框与目标元素的间距
   * @param {number} [options.maxHeight=280] - 弹框最大高度
   * @param {number} [options.width=260] - 弹框宽度
   * @param {string} [options.className='side-tooltip'] - 弹框 CSS 类名
   * @param {'auto'|'right'|'left'|'top'|'bottom'} [options.placement='auto'] - 弹框方向，auto 自动检测
   */
  constructor(options = {}) {
    this.gap = options.gap ?? 25;
    this.maxHeight = options.maxHeight ?? 280;
    this.width = options.width ?? 260;
    this.className = options.className || 'side-tooltip';
    this.placement = options.placement || 'auto';

    this.popupEl = null;
    this._arrowEl = null;
    this._targetEl = null;
    this._outsideClickHandler = null;
    this._repositionHandler = null;
    this._blurHandler = null;
    this._onHide = null;
  }

  /**
   * 在目标元素侧边显示浮层
   * @param {HTMLElement} target - 目标元素（如输入框）
   * @param {HTMLElement|HTMLElement[]} content - 要放入浮层的内容元素（支持单个或数组）
   * @param {Object} [callbacks] - 回调函数
   * @param {Function} [callbacks.onHide] - 浮层关闭时的回调
   * @param {Function} [callbacks.onOutsideCheck] - 自定义外部点击判断，返回 true 表示是外部点击应关闭
   * @returns {HTMLElement} popup 元素
   */
  show(target, content, callbacks = {}) {
    this.hide();
    this._targetEl = target;
    this._onHide = callbacks.onHide || null;

    // 创建浮层
    const popup = document.createElement('div');
    popup.className = this.className;
    popup.style.cssText = `
      position: fixed;
      z-index: 2147483646;
      background: #fff;
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      box-shadow: 0 6px 20px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06);
      max-height: ${this.maxHeight}px;
      width: ${this.width}px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif;
      font-size: 13px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    `;

    // 创建箭头元素（独立于 popup，避免被 overflow:hidden 裁剪）
    // z-index 比 popup 高，显示在弹框上层形成无缝连接效果
    const arrow = document.createElement('div');
    arrow.className = `${this.className}-arrow`;
    arrow.style.cssText = `
      position: fixed;
      width: 12px;
      height: 12px;
      background: #fff;
      transform: rotate(45deg);
      z-index: 2147483647;
      pointer-events: none;
      box-shadow: -2px 2px 4px rgba(0,0,0,0.06);
    `;
    this._arrowEl = arrow;

    // 追加内容
    const contents = Array.isArray(content) ? content : [content];
    contents.forEach(el => popup.appendChild(el));

    document.body.appendChild(popup);
    document.body.appendChild(arrow);
    this.popupEl = popup;
    this._position();

    // 点击/触摸外部关闭
    this._outsideClickHandler = (e) => {
      const isOutside = !popup.contains(e.target) && e.target !== target && e.target !== arrow;
      if (callbacks.onOutsideCheck) {
        if (callbacks.onOutsideCheck(e) && isOutside) this.hide();
      } else if (isOutside) {
        this.hide();
      }
    };
    setTimeout(() => {
      document.addEventListener('mousedown', this._outsideClickHandler);
      document.addEventListener('touchstart', this._outsideClickHandler);
    }, 100);

    // 页面滚动/resize 时重新定位
    this._repositionHandler = () => {
      if (this.popupEl && this._targetEl) {
        this._position();
      }
    };
    window.addEventListener('scroll', this._repositionHandler, true);
    window.addEventListener('resize', this._repositionHandler);

    return popup;
  }

  /**
   * 隐藏并销毁浮层
   */
  hide() {
    if (this.popupEl) {
      this.popupEl.remove();
      this.popupEl = null;
    }
    if (this._arrowEl) {
      this._arrowEl.remove();
      this._arrowEl = null;
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

    if (this._onHide) {
      this._onHide();
      this._onHide = null;
    }

    this._targetEl = null;
  }

  /**
   * 当前是否正在显示
   */
  get isVisible() {
    return !!this.popupEl;
  }

  /**
   * 手动触发重新定位
   */
  reposition() {
    if (this.popupEl && this._targetEl) {
      this._position();
    }
  }

  /**
   * 定位浮层到目标元素侧边（tooltip 风格）
   * 支持四个方向：right / left / top / bottom，auto 自动检测最佳方向
   * @private
   */
  _position() {
    const popup = this.popupEl;
    const target = this._targetEl;
    if (!popup || !target) return;

    const rect = target.getBoundingClientRect();
    const popupWidth = popup.offsetWidth || this.width;
    const popupHeight = popup.offsetHeight || this.maxHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = this.gap;
    const arrowOffset = 2; // 箭头伸出 popup 的像素数

    // 计算各方向可用空间
    const space = {
      right: vw - rect.right,
      left: rect.left,
      bottom: vh - rect.bottom,
      top: rect.top
    };

    // 确定实际放置方向
    let dir = this.placement;
    if (dir === 'auto') {
      // 优先级：右 → 左 → 下 → 上
      if (space.right >= popupWidth + gap) dir = 'right';
      else if (space.left >= popupWidth + gap) dir = 'left';
      else if (space.bottom >= popupHeight + gap) dir = 'bottom';
      else if (space.top >= popupHeight + gap) dir = 'top';
      else dir = space.right >= space.left ? 'right' : 'left'; // 都不够就选大的
    }

    let popupLeft, popupTop;

    if (dir === 'right' || dir === 'left') {
      // 水平方向定位
      popupLeft = dir === 'right' ? rect.right + gap : rect.left - popupWidth - gap;
      // 垂直方向：与目标顶部对齐，约束在视口内
      popupTop = rect.top;
      if (popupTop + popupHeight > vh - 8) popupTop = vh - popupHeight - 8;
      if (popupTop < 8) popupTop = 8;
    } else {
      // 垂直方向定位
      popupTop = dir === 'bottom' ? rect.bottom + gap : rect.top - popupHeight - gap;
      // 水平方向：与目标左侧对齐，约束在视口内
      popupLeft = rect.left;
      if (popupLeft + popupWidth > vw - 8) popupLeft = vw - popupWidth - 8;
      if (popupLeft < 8) popupLeft = 8;
    }

    popup.style.left = `${popupLeft}px`;
    popup.style.top = `${popupTop}px`;
    popup.style.right = '';
    popup.style.bottom = '';

    // 箭头定位
    const arrow = this._arrowEl;
    if (!arrow) return;
    const arrowSize = 12; // 箭头元素尺寸

    if (dir === 'right' || dir === 'left') {
      // 箭头垂直居中对齐目标元素
      const arrowCenterY = rect.top + rect.height / 2 - 6;
      const clampedY = Math.max(popupTop + 12, Math.min(arrowCenterY, popupTop + popupHeight - 20));
      arrow.style.top = `${clampedY}px`;

      if (dir === 'right') {
        // 箭头在 popup 左侧，小尖角指向左边的目标
        arrow.style.left = `${popupLeft - arrowOffset}px`;
        arrow.style.boxShadow = '-2px 2px 4px rgba(0,0,0,0.06)';
      } else {
        // 箭头在 popup 右侧，小尖角指向右边的目标
        arrow.style.left = `${popupLeft + popupWidth - arrowSize + arrowOffset}px`;
        arrow.style.boxShadow = '2px -2px 4px rgba(0,0,0,0.06)';
      }
      arrow.style.right = '';
    } else {
      // 箭头水平居中对齐目标元素
      const arrowCenterX = rect.left + rect.width / 2 - 6;
      const clampedX = Math.max(popupLeft + 12, Math.min(arrowCenterX, popupLeft + popupWidth - 20));
      arrow.style.left = `${clampedX}px`;
      arrow.style.right = '';

      if (dir === 'bottom') {
        // 箭头在 popup 上方，小尖角指向上边的目标
        arrow.style.top = `${popupTop - arrowOffset}px`;
        arrow.style.boxShadow = '-2px -2px 4px rgba(0,0,0,0.06)';
      } else {
        // 箭头在 popup 下方，小尖角指向下边的目标
        arrow.style.top = `${popupTop + popupHeight - arrowSize + arrowOffset}px`;
        arrow.style.boxShadow = '2px 2px 4px rgba(0,0,0,0.06)';
      }
    }
  }
}
