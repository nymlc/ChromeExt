/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-08-17
 * @FilePath: /ChromeExt/content/modules/ImagePreview.js
 * @Description: 图片地址预览模块 - 复制或粘贴图片地址时展示预览
 */

class ImagePreview extends BaseContentModule {
  constructor() {
    super('imagePreview');
    this.previewEl = null;
    this.previewImage = null;
    this.positionMode = null;
    this.anchorX = null;
    this.anchorY = null;
    this.autoHideTimer = null;
    this.probeImage = null;
    this.requestId = 0;
    this.loadTimer = null;
    this.maxSize = 480;
    this.maxDataUrlChars = 2 * 1024 * 1024;
    this.maxPixels = 16 * 1024 * 1024;

    this._onPointer = this._onPointer.bind(this);
    this._onCopy = this._onCopy.bind(this);
    this._onPaste = this._onPaste.bind(this);
    this._onOutside = this._onOutside.bind(this);
    this._onKey = this._onKey.bind(this);
    this._onResize = this._onResize.bind(this);
  }

  async init() {
    const enabled = await this.checkModuleEnabled();
    if (!enabled) return;

    await this._loadPreferences();
    document.addEventListener('mousemove', this._onPointer, true);
    document.addEventListener('mousedown', this._onPointer, true);
    document.addEventListener('contextmenu', this._onPointer, true);
    document.addEventListener('copy', this._onCopy);
    document.addEventListener('paste', this._onPaste);
    document.addEventListener('mousedown', this._onOutside, true);
    document.addEventListener('keydown', this._onKey);
    window.addEventListener('resize', this._onResize);
  }

  async _loadPreferences() {
    let value = 480;
    if (typeof StorageState !== 'undefined') {
      value = StorageState.get('imagePreviewMaxSize', 480);
    } else {
      const result = await chrome.storage.local.get(['imagePreviewMaxSize']);
      value = result.imagePreviewMaxSize;
    }
    this.maxSize = this._normalizeMaxSize(value);
  }

  _normalizeMaxSize(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 480;
    return Math.max(160, Math.min(1600, Math.round(number)));
  }

  applyStorageChanges(changes) {
    if (!changes.imagePreviewMaxSize) return;
    this.maxSize = this._normalizeMaxSize(changes.imagePreviewMaxSize.newValue);
    this._applyPreviewSize();
  }

  _onPointer(event) {
    this.anchorX = event.clientX;
    this.anchorY = event.clientY;
  }

  _onCopy(event) {
    let text = '';
    try {
      text = event.clipboardData?.getData('text/plain') || '';
    } catch (_) {}
    if (!text && window.getSelection && !window.getSelection().isCollapsed) {
      text = window.getSelection().toString();
    }

    const source = this._parseImageSource(text);
    if (!source) return;
    this._refreshAnchorFromSelection();
    this._requestPreview(source, 'anchor');
  }

  _onPaste(event) {
    let text = '';
    try {
      text = event.clipboardData?.getData('text/plain') || '';
    } catch (_) {}

    const source = this._parseImageSource(text);
    if (!source) return;
    // 不阻止默认粘贴：预览只是在图片加载成功后额外显示。
    this._requestPreview(source, 'center');
  }

  /**
   * 仅接收可直接赋给 img.src 的安全图片来源：HTTP(S)、data:image 与同源 blob。
   * data URL 在 onload 前仍会由浏览器解码，故先限制文本长度；最终可渲染性仍以 Image.onload 为准。
   */
  _parseImageSource(text) {
    const value = String(text || '').trim();
    if (!value) return null;

    // data URL 可以包含 URI 编码 SVG 的空白字符，不能套用普通 URL 的无空白限制。
    if (/^data:image\//i.test(value)) {
      return value.length <= this.maxDataUrlChars ? value : null;
    }

    if (/\s/.test(value)) return null;
    try {
      const url = new URL(value);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        return url.hostname ? url.href : null;
      }
      // blob URL 依赖创建它的文档与生命周期，仅对当前 origin 尽力加载。
      if (url.protocol === 'blob:' && url.origin === location.origin && url.origin !== 'null') {
        return url.href;
      }
    } catch (_) {}
    return null;
  }

  _refreshAnchorFromSelection() {
    if (this.anchorX != null && this.anchorY != null) return;
    const selection = window.getSelection?.();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    this.anchorX = rect.left;
    this.anchorY = rect.bottom;
  }

  _requestPreview(url, positionMode) {
    this._cancelPendingRequest();
    this._removePreview();
    const requestId = this.requestId;
    const probe = new Image();
    this.probeImage = probe;

    const clearProbe = () => {
      if (this.loadTimer) {
        clearTimeout(this.loadTimer);
        this.loadTimer = null;
      }
      if (this.probeImage === probe) this.probeImage = null;
      probe.onload = null;
      probe.onerror = null;
    };
    probe.onload = () => {
      if (requestId !== this.requestId || this.probeImage !== probe) return;
      const pixels = probe.naturalWidth * probe.naturalHeight;
      if (!probe.naturalWidth || !probe.naturalHeight || !Number.isSafeInteger(pixels) || pixels > this.maxPixels) {
        clearProbe();
        return;
      }
      clearProbe();
      this._showPreview(probe, positionMode);
    };
    probe.onerror = clearProbe;
    this.loadTimer = setTimeout(() => {
      if (requestId !== this.requestId || this.probeImage !== probe) return;
      clearProbe();
      probe.src = '';
    }, 5000);
    probe.src = url;
  }

  _showPreview(image, positionMode) {
    this._removePreview();
    const preview = document.createElement('div');
    preview.className = 'gk-image-preview';
    preview.style.cssText = [
      'position:fixed',
      'z-index:2147483646',
      'padding:6px',
      'background:rgba(255,255,255,0.96)',
      'border:1px solid rgba(0,0,0,0.12)',
      'border-radius:10px',
      'box-shadow:0 8px 28px rgba(0,0,0,0.2)',
      'line-height:0',
    ].join(';');

    image.draggable = false;
    image.style.cssText = 'display:block;object-fit:contain;border-radius:6px;';
    preview.appendChild(image);
    (document.body || document.documentElement).appendChild(preview);

    this.previewEl = preview;
    this.previewImage = image;
    this.positionMode = positionMode;
    this._applyPreviewSize();

    this._clearAutoHideTimer();
    this.autoHideTimer = setTimeout(() => this._closePreview(), 8000);
  }

  _applyPreviewSize() {
    if (!this.previewEl || !this.previewImage) return;
    const viewportLimit = Math.max(120, Math.min(window.innerWidth - 16, window.innerHeight - 16));
    const maxSize = Math.min(this.maxSize, viewportLimit);
    this.previewEl.style.maxWidth = `${maxSize}px`;
    this.previewEl.style.maxHeight = `${maxSize}px`;
    this.previewImage.style.maxWidth = `${Math.max(1, maxSize - 12)}px`;
    this.previewImage.style.maxHeight = `${Math.max(1, maxSize - 12)}px`;
    this._positionPreview();
  }

  _positionPreview() {
    if (!this.previewEl || !this.positionMode) return;
    const width = this.previewEl.offsetWidth || 200;
    const height = this.previewEl.offsetHeight || 200;
    const margin = 8;
    let left;
    let top;

    if (this.positionMode === 'center') {
      left = (window.innerWidth - width) / 2;
      top = (window.innerHeight - height) / 2;
    } else {
      const x = this.anchorX != null ? this.anchorX : window.innerWidth / 2;
      const y = this.anchorY != null ? this.anchorY : window.innerHeight / 2;
      left = x + 14;
      top = y + 14;
      if (left + width > window.innerWidth - margin) left = x - width - 14;
      if (top + height > window.innerHeight - margin) top = y - height - 14;
    }

    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));
    this.previewEl.style.left = `${left}px`;
    this.previewEl.style.top = `${top}px`;
  }

  _onOutside(event) {
    if (this.previewEl && !this.previewEl.contains(event.target)) this._closePreview();
  }

  _onKey(event) {
    if (event.key === 'Escape') this._closePreview();
  }

  _onResize() {
    this._applyPreviewSize();
  }

  _cancelPendingRequest() {
    this.requestId += 1;
    if (this.loadTimer) {
      clearTimeout(this.loadTimer);
      this.loadTimer = null;
    }
    if (!this.probeImage) return;
    this.probeImage.onload = null;
    this.probeImage.onerror = null;
    this.probeImage.src = '';
    this.probeImage = null;
  }

  _clearAutoHideTimer() {
    if (!this.autoHideTimer) return;
    clearTimeout(this.autoHideTimer);
    this.autoHideTimer = null;
  }

  _closePreview() {
    this._cancelPendingRequest();
    this._clearAutoHideTimer();
    this._removePreview();
  }

  _removePreview() {
    if (this.previewEl) this.previewEl.remove();
    this.previewEl = null;
    this.previewImage = null;
    this.positionMode = null;
  }

  destroy() {
    document.removeEventListener('mousemove', this._onPointer, true);
    document.removeEventListener('mousedown', this._onPointer, true);
    document.removeEventListener('contextmenu', this._onPointer, true);
    document.removeEventListener('copy', this._onCopy);
    document.removeEventListener('paste', this._onPaste);
    document.removeEventListener('mousedown', this._onOutside, true);
    document.removeEventListener('keydown', this._onKey);
    window.removeEventListener('resize', this._onResize);
    this._closePreview();
  }
}
