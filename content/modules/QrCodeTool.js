/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-08-10
 * @FilePath: /ChromeExt/content/modules/QrCodeTool.js
 * @Description: 二维码工具模块（content 端）：网页内右键生成二维码 / 解码图片二维码浮层
 *               解码支持：<img>(含 .svg)、内联 <svg>、<canvas>、background-image，并兼容透明背景/反色。
 */

class QrCodeTool extends BaseContentModule {
  constructor() {
    super('qrCodeTool'); // 模块名需与 popup 侧一致
    this._overlay = null;
    this._overlayPanel = null;
    this._onMessage = this._onMessage.bind(this);
    this._onContextMenu = this._onContextMenu.bind(this);
    this._ctx = null; // 记录右键目标元素信息，优先解码「你点的那个」
  }

  async init() {
    const enabled = await this.checkModuleEnabled();
    if (!enabled) return;
    chrome.runtime.onMessage.addListener(this._onMessage);
    document.addEventListener('contextmenu', this._onContextMenu, true);
  }

  destroy() {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.removeListener(this._onMessage);
    }
    document.removeEventListener('contextmenu', this._onContextMenu, true);
    this._removeOverlay();
  }

  /** 右键时记录目标元素：<img> / <canvas> / 内联 <svg> / background-image */
  _onContextMenu(e) {
    const t = e.target;
    const info = { el: t, tag: t && t.tagName ? t.tagName.toLowerCase() : '' };
    if (t && t.tagName === 'IMG') info.src = t.currentSrc || t.src || '';
    if (t && t.tagName === 'CANVAS') info.isCanvas = true;
    // 向上找最近的 <svg>（覆盖右击在 svg 内部子元素的情况）
    let svgEl = null;
    let p = t;
    while (p && p !== document) {
      if (p.tagName && p.tagName.toLowerCase() === 'svg') { svgEl = p; break; }
      p = p.parentNode;
    }
    if (svgEl) { info.isSvg = true; info.svgEl = svgEl; }
    const bg = (t && getComputedStyle(t).backgroundImage) || '';
    const m = bg.match(/url\(["']?(.*?)["']?\)/);
    if (m && m[1] && m[1] !== 'none') {
      let u = m[1];
      try { u = new URL(u, location.href).href; } catch (_) {}
      info.bgUrl = u;
    }
    this._ctx = info;
  }

  _onMessage(msg, sender, sendResponse) {
    if (!msg) return;
    if (msg.type === 'qr-generate') {
      this._generate(msg.text || '');
    } else if (msg.type === 'qr-decode-image') {
      // 右键的是 <img>：优先解码该元素，失败再后台抓取
      this._decodeImageEntry(msg.srcUrl || '');
    } else if (msg.type === 'qr-decode-page') {
      // 右键的是页面（背景图 / Canvas / 内联 SVG 二维码）：整页或目标元素扫描
      this._decodePageEntry();
    }
    if (typeof sendResponse === 'function') sendResponse({ ok: true });
  }

  // ───────── 生成浮层 ─────────
  async _generate(text) {
    const panel = this._ensureOverlay();
    panel.title.textContent = '二维码';
    panel.body.innerHTML = '';
    panel.actions.innerHTML = '';

    if (!text) {
      this._setBody('<div style="padding:16px;color:#ff9500;font-size:13px;">没有可生成二维码的文本</div>');
      this._showOverlay();
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:240px;height:240px;background:#fff;border:1px solid #e0e0e0;border-radius:8px;padding:6px;box-sizing:border-box;margin:0 auto;';
    panel.body.appendChild(canvas);

    try {
      await QRCode.toCanvas(canvas, text, { width: 228, margin: 1, errorCorrectionLevel: 'M' });
      const dl = this._btn('下载 PNG');
      dl.onclick = () => {
        const a = document.createElement('a');
        a.href = canvas.toDataURL('image/png');
        a.download = 'qrcode.png';
        a.click();
      };
      panel.actions.appendChild(dl);
    } catch (e) {
      this._setBody('<div style="padding:16px;color:#ff9500;font-size:13px;">生成失败：' + (e && e.message ? e.message : e) + '</div>');
    }
    this._showOverlay();
  }

  // ───────── 解码入口 ─────────

  async _decodeImageEntry(srcUrl) {
    this._showDecodeLoading();
    const code = await this._decodeSpecificTarget();
    if (code) { this._renderDecodeResult(code.data); return; }
    // 显式传入的 srcUrl 与目标元素不一致时，再单独抓一次
    const ctxSrc = this._ctx && this._ctx.src;
    if (srcUrl && srcUrl !== ctxSrc) {
      const dataUrl = await this._fetchViaBackground(srcUrl);
      if (dataUrl) {
        const c = await this._tryDecodeDataUrl(dataUrl);
        if (c) { this._renderDecodeResult(c.data); return; }
      }
    }
    this._decodePageFallback();
  }

  async _decodePageEntry() {
    this._showDecodeLoading();
    const code = await this._decodeSpecificTarget();
    if (code) { this._renderDecodeResult(code.data); return; }
    this._decodePageFallback();
  }

  /** 针对右键目标元素解码：canvas / 内联 svg / img(含svg) / background-image，命中即返回 */
  async _decodeSpecificTarget() {
    const ctx = this._ctx || {};
    const el = ctx.el;
    if (!el) return null;
    const tag = el.tagName ? el.tagName.toLowerCase() : '';

    if (tag === 'canvas') {
      const code = this._tryDecodeCanvas(el);
      if (code) return code;
    }
    if (tag === 'svg' || ctx.isSvg) {
      const svgNode = tag === 'svg' ? el : ctx.svgEl;
      const code = await this._decodeSvgElement(svgNode);
      if (code) return code;
    }
    if (tag === 'img') {
      const src = el.currentSrc || el.src || '';
      if (/\.svg(\?|#|$)/i.test(src) || ctx.isSvgImg) {
        const code = await this._decodeSvgImg(src);
        if (code) return code;
      } else {
        // 同源/CORS 图直接读 DOM 像素（最快，带登录态）；跨域无 CORS 头会污染 canvas → 回退后台抓取
        const code = this._tryDecodeCanvasFromImg(el);
        if (code) return code;
        const dataUrl = await this._fetchViaBackground(src);
        if (dataUrl) {
          const c = await this._tryDecodeDataUrl(dataUrl);
          if (c) return c;
        }
      }
    }
    if (ctx.bgUrl) {
      const dataUrl = await this._fetchViaBackground(ctx.bgUrl);
      if (dataUrl) {
        const c = await this._tryDecodeDataUrl(dataUrl);
        if (c) return c;
      }
    }
    return null;
  }

  /** 整页扫描兜底：覆盖没被右键命中的情况（含内联 svg） */
  async _decodePageFallback() {
    const urls = this._collectImageUrls().slice(0, 30);
    const canvases = Array.from(document.querySelectorAll('canvas')).slice(0, 10);
    const svgs = Array.from(document.querySelectorAll('svg')).slice(0, 10);
    const candidates = [
      ...urls.map(u => ({ kind: 'url', url: u })),
      ...canvases.map(el => ({ kind: 'canvas', el })),
      ...svgs.map(el => ({ kind: 'svg', el })),
    ];
    for (const c of candidates) {
      let code = null;
      try {
        if (c.kind === 'url') {
          const dataUrl = await this._fetchViaBackground(c.url);
          if (dataUrl) code = await this._tryDecodeDataUrl(dataUrl);
        } else if (c.kind === 'canvas') {
          code = this._tryDecodeCanvas(c.el);
        } else if (c.kind === 'svg') {
          code = await this._decodeSvgElement(c.el);
        }
      } catch (_) { code = null; }
      if (code && code.data) { this._renderDecodeResult(code.data); return; }
    }
    this._setBody('<div style="padding:16px;color:#ff9500;font-size:13px;">未在该页面中识别到二维码（跨域受限图片可改用 popup 上传图片解码）</div>');
  }

  // ───────── 各形态解码实现 ─────────

  /** <img>（栅格图）直接读 DOM 像素，先铺白底兼容透明背景二维码 */
  _tryDecodeCanvasFromImg(imgEl) {
    try {
      const w = imgEl.naturalWidth, h = imgEl.naturalHeight;
      if (!w || !h) return null;
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      ctx.drawImage(imgEl, 0, 0);
      return this._tryDecodeCanvas(canvas);
    } catch (e) { return null; } // 跨域污染会抛错
  }

  /** 加载 data URL（含 svg）到 Image 并解码（data URL 同源，不污染 canvas） */
  async _tryDecodeDataUrl(dataUrl) {
    if (dataUrl && dataUrl.startsWith('data:image/svg')) {
      let text = null;
      if (dataUrl.startsWith('data:image/svg+xml;base64,')) {
        text = atob(dataUrl.slice('data:image/svg+xml;base64,'.length));
      } else if (dataUrl.startsWith('data:image/svg+xml,')) {
        text = decodeURIComponent(dataUrl.slice('data:image/svg+xml,'.length));
      }
      if (text) return this._rasterizeSvgText(text);
      return null;
    }
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0);
          resolve(this._tryDecodeCanvas(canvas));
        } catch (e) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  /** 对原始 ImageData 解码（整页扫描拿到像素时用） */
  _tryDecodeImageData(imgData) {
    if (!imgData) return null;
    const c = document.createElement('canvas');
    c.width = imgData.width;
    c.height = imgData.height;
    c.getContext('2d').putImageData(imgData, 0, 0);
    return this._tryDecodeCanvas(c);
  }

  /** <canvas> 直接读像素（跨域 canvas 会被污染而抛错，返回 null） */
  _readCanvas(el) {
    try {
      const ctx = el.getContext && el.getContext('2d');
      if (!ctx) return null;
      return ctx.getImageData(0, 0, el.width, el.height);
    } catch (e) { return null; }
  }

  /** 内联 <svg> 元素：序列化后栅格化解码 */
  async _decodeSvgElement(svgEl) {
    try {
      const markup = this._serializeSvg(svgEl);
      return await this._rasterizeSvgText(markup);
    } catch (e) { return null; }
  }

  /** <img src="x.svg">：后台取 svg 文本后栅格化 */
  async _decodeSvgImg(src) {
    const text = await this._fetchTextViaBackground(src);
    if (!text) return null;
    return this._rasterizeSvgText(text);
  }

  /** 核心解码：原生分辨率先试，图偏小则最近邻放大；兼容反色（黑底白码）二维码 */
  _tryDecodeCanvas(canvas) {
    if (!canvas || !canvas.width || !canvas.height) return null;
    const attempt = (c) => {
      try {
        const cx = c.getContext('2d');
        const data = cx.getImageData(0, 0, c.width, c.height);
        return jsQR(data.data, data.width, data.height, { inversionAttempts: 'attemptBoth' });
      } catch (e) { return null; }
    };
    let code = attempt(canvas);
    if (code) return code;
    const longest = Math.max(canvas.width, canvas.height);
    if (longest < 800) {
      const scale = Math.min(8, Math.max(2, Math.ceil(1000 / longest)));
      const big = document.createElement('canvas');
      big.width = canvas.width * scale;
      big.height = canvas.height * scale;
      const bctx = big.getContext('2d');
      bctx.imageSmoothingEnabled = false; // 最近邻，保持二维码硬边
      bctx.drawImage(canvas, 0, 0, big.width, big.height);
      code = attempt(big);
    }
    return code || null;
  }

  // ───────── SVG 栅格化辅助 ─────────

  /** 把 <svg> DOM 节点序列化为带尺寸的 svg 文本 */
  _serializeSvg(svgEl) {
    const clone = svgEl.cloneNode(true);
    const rect = svgEl.getBoundingClientRect();
    let w = svgEl.getAttribute('width');
    let h = svgEl.getAttribute('height');
    const vb = svgEl.getAttribute('viewBox');
    if ((!w || !h) && vb) {
      const p = vb.split(/[\s,]+/).map(Number);
      if (p.length === 4) { if (!w) w = p[2]; if (!h) h = p[3]; }
    }
    if (!w && rect.width) w = Math.round(rect.width);
    if (!h && rect.height) h = Math.round(rect.height);
    if (!w) w = 300; if (!h) h = 300;
    clone.setAttribute('width', w);
    clone.setAttribute('height', h);
    if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    return new XMLSerializer().serializeToString(clone);
  }

  /** 解析 svg 文本并栅格化（自动补全 xmlns / width / height，先铺白底） */
  async _rasterizeSvgText(text) {
    let markup = (text || '').trim();
    if (!markup) return null;
    if (!/xmlns=/.test(markup)) markup = markup.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    let w = this._parseNum(markup, 'width');
    let h = this._parseNum(markup, 'height');
    const vb = this._parseViewBox(markup);
    if (vb) { if (!w) w = vb.w; if (!h) h = vb.h; }
    w = w || 300; h = h || 300;
    markup = markup.replace(/<svg([^>]*)>/, (m, attrs) => {
      let a = attrs;
      if (!/width=/.test(a)) a += ' width="' + w + '"';
      if (!/height=/.test(a)) a += ' height="' + h + '"';
      return '<svg' + a + '>';
    });
    const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
    return this._loadSvgDataUrl(dataUrl, w, h);
  }

  _loadSvgDataUrl(dataUrl, w, h) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const cw = img.naturalWidth || w;
          const ch = img.naturalHeight || h;
          const canvas = document.createElement('canvas');
          canvas.width = cw; canvas.height = ch;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch);
          ctx.drawImage(img, 0, 0, cw, ch);
          resolve(this._tryDecodeCanvas(canvas));
        } catch (e) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  _parseNum(markup, attr) {
    const m = markup.match(new RegExp(attr + '=["\']?([\\d.]+)'));
    return m ? parseFloat(m[1]) : null;
  }

  _parseViewBox(markup) {
    const m = markup.match(/viewBox=["\']?([^"\']+)["\']?/);
    if (!m) return null;
    const p = m[1].split(/[\s,]+/).map(Number);
    if (p.length === 4) return { w: p[2], h: p[3] };
    return null;
  }

  // ───────── 资源抓取 ─────────

  /** 经后台抓取图片字节并转 data URL（绕过页面 CORS；默认 omit，失败带 cookie 重试） */
  _fetchViaBackground(url) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'qr-fetch-image', url }, (resp) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(resp && resp.ok ? resp.dataUrl : null);
        });
      } catch (_) { resolve(null); }
    });
  }

  /** 经后台抓取文本（用于 .svg 文件，需解析尺寸后栅格化） */
  _fetchTextViaBackground(url) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'qr-fetch-text', url }, (resp) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(resp && resp.ok ? resp.text : null);
        });
      } catch (_) { resolve(null); }
    });
  }

  /** 把 data URL 画到 canvas 并取像素（data URL 同源，不会污染 canvas） */
  _loadImageData(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0);
          resolve(ctx.getImageData(0, 0, canvas.width, canvas.height));
        } catch (e) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  /** 收集页面里所有可能是二维码的图像来源：<img> src + 元素 background-image（含 data:image） */
  _collectImageUrls() {
    const urls = new Set();
    document.querySelectorAll('img').forEach(img => {
      const s = img.currentSrc || img.src;
      if (s && (s.startsWith('http') || s.startsWith('data:image'))) urls.add(s);
    });
    document.querySelectorAll('*').forEach(el => {
      const bg = getComputedStyle(el).backgroundImage || '';
      const m = bg.match(/url\(["']?(.*?)["']?\)/);
      if (m && m[1] && m[1] !== 'none') {
        let u = m[1];
        try { u = new URL(u, location.href).href; } catch (_) {}
        if (u.startsWith('http') || u.startsWith('data:image')) urls.add(u);
      }
    });
    return Array.from(urls);
  }

  _renderDecodeResult(text) {
    const panel = this._ensureOverlay();
    panel.body.innerHTML = '';
    const pre = document.createElement('pre');
    pre.textContent = text;
    pre.style.cssText = 'margin:0;max-width:300px;max-height:240px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-size:13px;background:#fafafa;border:1px solid #e0e0e0;border-radius:8px;padding:10px;color:#333;';
    panel.body.appendChild(pre);
    panel.actions.innerHTML = '';
    const copy = this._btn('复制结果');
    copy.onclick = () => {
      navigator.clipboard.writeText(text)
        .then(() => { if (typeof Toast !== 'undefined') Toast.success('已复制'); })
        .catch(() => { if (typeof Toast !== 'undefined') Toast.error('复制失败'); });
    };
    panel.actions.appendChild(copy);
  }

  // ───────── 浮层基础设施 ─────────
  _ensureOverlay() {
    if (this._overlay && this._overlayPanel) return this._overlayPanel;
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';
    const panel = document.createElement('div');
    panel.style.cssText = 'background:#fff;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,0.25);width:320px;max-width:90vw;padding:16px;';
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;';
    const title = document.createElement('div');
    title.style.cssText = 'font-size:15px;font-weight:600;color:#333;';
    const close = document.createElement('button');
    close.textContent = '✕';
    close.style.cssText = 'border:none;background:#f0f0f0;width:28px;height:28px;border-radius:50%;cursor:pointer;font-size:14px;color:#666;';
    close.onclick = () => this._removeOverlay();
    header.appendChild(title);
    header.appendChild(close);
    const body = document.createElement('div');
    body.style.cssText = 'min-height:40px;';
    const actions = document.createElement('div');
    actions.style.cssText = 'margin-top:14px;display:flex;gap:8px;';
    panel.appendChild(header);
    panel.appendChild(body);
    panel.appendChild(actions);
    overlay.appendChild(panel);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) this._removeOverlay(); });
    (document.documentElement || document.body).appendChild(overlay);
    this._overlay = overlay;
    this._overlayPanel = { title, body, actions };
    return this._overlayPanel;
  }

  _setBody(html) {
    const panel = this._ensureOverlay();
    panel.body.innerHTML = html;
  }

  _btn(label) {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'border:none;border-radius:8px;padding:7px 14px;font-size:13px;cursor:pointer;background:#0a84ff;color:#fff;';
    return b;
  }

  _showDecodeLoading() {
    const panel = this._ensureOverlay();
    panel.title.textContent = '解码结果';
    panel.actions.innerHTML = '';
    this._setBody('<div style="padding:20px;color:#888;font-size:13px;">解码中…</div>');
    this._showOverlay();
  }

  _showOverlay() { if (this._overlay) this._overlay.style.display = 'flex'; }
  _removeOverlay() {
    if (this._overlay) { this._overlay.remove(); this._overlay = null; this._overlayPanel = null; }
  }
}
