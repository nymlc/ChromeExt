/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-06-15 00:00:00
 * @FilePath: /ChromeExt/shared/IframePool.js
 * @Description: iframe 池 - 基于 LRUCache，复用已加载的 iframe，超过访问次数上限自动重建
 */

class IframePool {
  /**
   * @param {object}   opts
   * @param {number}   [opts.capacity=2]   池大小
   * @param {number}   [opts.maxHits=10]   每个 iframe 最多被激活次数，超过则销毁重建
   * @param {string}   opts.baseStyle
   * @param {string}   opts.activeStyle
   * @param {function} [opts.onActivate]   (iframe, url) => void
   * @param {function} [opts.onDeactivate] (iframe, url) => void
   * @param {function} [opts.onEvict]      (iframe, url) => void
   */
  constructor(opts = {}) {
    this.capacity    = opts.capacity    || 2;
    this.maxHits     = opts.maxHits     || 3;
    this.baseStyle   = opts.baseStyle   || 'position:fixed;inset:0;width:100%;height:100%;border:none;';
    this.activeStyle = opts.activeStyle || 'z-index:2;visibility:visible;';
    this.hiddenStyle = 'z-index:0;display:none;visibility:hidden;pointer-events:none;';
    this.onActivate   = opts.onActivate   || null;
    this.onDeactivate = opts.onDeactivate || null;
    this.onEvict      = opts.onEvict      || null;

    // value: iframe element (hits 挂在 iframe 元素上)
    this._cache = new LRUCache(this.capacity, (url, iframe) => {
      iframe.remove();
      if (this.onEvict) this.onEvict(iframe, url);
    });

    this.activeUrl    = null;
    this.activeIframe = null;
  }

  show(url, container) {
    // 隐藏当前激活，若已达 maxHits 则直接移除（不再缓存）
    if (this.activeIframe) {
      if (this._shouldRecycle(this.activeIframe)) {
        this.activeIframe.remove();
        this._cache._map.delete(this.activeUrl);
      } else {
        this.activeIframe.style.cssText = this.baseStyle + this.hiddenStyle;
      }
      if (this.onDeactivate) this.onDeactivate(this.activeIframe, this.activeUrl);
    }

    let iframe = this._cache._map.get(url) || null;

    // 目标 iframe 已达 maxHits：移除旧的，清除缓存，下面重新建
    if (iframe && this._shouldRecycle(iframe)) {
      iframe.remove();
      this._cache._map.delete(url);
      iframe = null;
    }

    if (iframe) {
      // 命中缓存：更新 LRU 顺序
      this._cache.get(url);
    } else {
      // 新建 iframe，加入缓存
      iframe = document.createElement('iframe');
      iframe.id = 'mg-iframe-' + Date.now().toString(36);
      iframe.src = url;
      iframe.style.cssText = this.baseStyle + this.hiddenStyle;
      iframe.dataset.hits = '0';
      container.appendChild(iframe);
      this._cache.set(url, iframe);
    }

    // 激活计数 +1，同步到 data-hits
    const hits = (parseInt(iframe.dataset.hits, 10) || 0) + 1;
    iframe.dataset.hits = String(hits);
    iframe.style.cssText = this.baseStyle + this.activeStyle;
    this.activeUrl    = url;
    this.activeIframe = iframe;

    if (this.onActivate) this.onActivate(iframe, url);

    // 主动清理：移除所有非激活且已达 maxHits 的 iframe
    for (const [cachedUrl, cachedIframe] of this._cache._map) {
      if (cachedUrl !== this.activeUrl && this._shouldRecycle(cachedIframe)) {
        cachedIframe.remove();
        this._cache._map.delete(cachedUrl);
      }
    }

    return iframe;
  }

  /** 判断 iframe 是否应被回收重建 */
  _shouldRecycle(iframe) {
    const hits = parseInt(iframe.dataset.hits, 10) || 0;
    return hits >= this.maxHits;
  }

  get current() { return this.activeIframe; }

  /** 手动移除指定 url 的缓存 iframe */
  remove(url) {
    const iframe = this._cache._map.get(url);
    if (!iframe) return false;
    if (this.activeUrl === url) {
      this.activeIframe = null;
      this.activeUrl = null;
    }
    iframe.remove();
    this._cache._map.delete(url);
    return true;
  }

  has(url) {
    const iframe = this._cache._map.get(url);
    return !!iframe && !this._shouldRecycle(iframe);
  }

  /** 返回该 url 对应 iframe 的 hits 数，未缓存返回 null */
  getHits(url) {
    const iframe = this._cache._map.get(url);
    if (!iframe) return null;
    return parseInt(iframe.dataset.hits, 10) || 0;
  }

  resize(newCapacity) {
    this.capacity = newCapacity;
    this._cache.resize(newCapacity);
  }

  destroy() {
    this._cache.clear();
    this.activeIframe = null;
    this.activeUrl    = null;
  }
}
