/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-08-10
 * @FilePath: /ChromeExt/popup/modules/QrCodeTool.js
 * @Description: 二维码工具模块（popup 端）：生成二维码 + 解码图片中的二维码
 */

class QrCodeTool extends BaseModule {
  constructor() {
    super('qrCodeTool'); // 模块名需与 content 侧一致
    this._genTimer = null;
    this._lastGenText = '';
  }

  async init() {
    await this.initModuleStatus();
    this.bindEvents();
    this.updateUI();
  }

  bindEvents() {
    document.getElementById('qrCodeToolModuleEnabled')
      ?.addEventListener('change', (e) => this.onModuleToggle(e.target.checked));

    // 生成：输入即实时预览
    document.getElementById('qrcodeGenInput')
      ?.addEventListener('input', () => this._scheduleGenerate());
    document.getElementById('qrcodeGenDownload')
      ?.addEventListener('click', () => this._download());

    // 解码：选择图片 / 粘贴图片
    document.getElementById('qrcodeDecodeFile')
      ?.addEventListener('change', (e) => this._decodeFile(e.target.files && e.target.files[0]));
    document.addEventListener('paste', (e) => this._onPasteImage(e));

    // 解码结果复制
    document.getElementById('qrcodeDecodeCopy')
      ?.addEventListener('click', () => this._copyResult());
  }

  // ───────── 生成 ─────────
  _scheduleGenerate() {
    clearTimeout(this._genTimer);
    const input = document.getElementById('qrcodeGenInput');
    const text = input ? input.value : '';
    this._genTimer = setTimeout(() => this._generate(text), 250);
  }

  async _generate(text) {
    const canvas = document.getElementById('qrcodeGenCanvas');
    const status = document.getElementById('qrcodeGenStatus');
    if (!canvas) return;
    if (!text || !text.trim()) {
      canvas.style.display = 'none';
      if (status) status.style.display = 'none';
      this._lastGenText = '';
      return;
    }
    try {
      await QRCode.toCanvas(canvas, text.trim(), { width: 220, margin: 1, errorCorrectionLevel: 'M' });
      canvas.style.display = 'block';
      this._lastGenText = text.trim();
      if (status) status.style.display = 'none';
    } catch (e) {
      canvas.style.display = 'none';
      if (status) {
        status.textContent = '生成失败：' + (e && e.message ? e.message : e);
        status.style.display = 'block';
      }
    }
  }

  _download() {
    const canvas = document.getElementById('qrcodeGenCanvas');
    if (!canvas || !this._lastGenText) return;
    const url = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = 'qrcode.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ───────── 解码 ─────────
  _decodeFile(file) {
    if (!file) return;
    this._decodeFromSource(URL.createObjectURL(file));
  }

  _onPasteImage(e) {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.type && it.type.startsWith('image/')) {
        const file = it.getAsFile();
        if (file) this._decodeFile(file);
      }
    }
  }

  async _decodeFromSource(src) {
    const status = document.getElementById('qrcodeDecodeStatus');
    const result = document.getElementById('qrcodeDecodeResult');
    try {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('图片加载失败'));
        img.src = src;
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const code = this._tryDecodeCanvas(canvas);
      if (code && code.data) {
        if (result) { result.textContent = code.data; result.style.display = 'block'; }
        if (status) status.style.display = 'none';
      } else if (result) {
        result.style.display = 'none';
        if (status) { status.textContent = '未在该图片中识别到二维码'; status.style.display = 'block'; }
      }
    } catch (e) {
      if (result) result.style.display = 'none';
      if (status) {
        status.textContent = '解码失败：' + (e && e.message ? e.message : e);
        status.style.display = 'block';
      }
    }
  }

  /**
   * 核心解码：原生分辨率先试一次，若失败且图像偏小则最近邻放大后再试。
   * jsQR 对小图 / 抗锯齿严重的图很挑剔，放大能显著提升识别率；
   * inversionAttempts:'attemptBoth' 同时兼容「黑底白码」的反色二维码。
   */
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
      bctx.imageSmoothingEnabled = false;
      bctx.drawImage(canvas, 0, 0, big.width, big.height);
      code = attempt(big);
    }
    return code || null;
  }

  _copyResult() {
    const result = document.getElementById('qrcodeDecodeResult');
    if (!result || !result.textContent) return;
    navigator.clipboard.writeText(result.textContent)
      .then(() => Toast.success('已复制'))
      .catch(() => Toast.error('复制失败'));
  }

  async onModuleToggle(enabled) {
    await this.toggleModuleEnabled(enabled);
    this.updateUI();
  }

  async onSiteToggle(enabled) {
    await this.toggleSiteEnabled(enabled);
    this.updateUI();
  }

  getModuleName() {
    return '二维码工具';
  }

  updateUI() {
    const sw = document.getElementById('qrCodeToolModuleEnabled');
    if (sw) sw.checked = this.moduleEnabled;
    const content = document.getElementById('qrCodeToolModuleContent');
    if (content) content.classList.toggle('disabled', !this.moduleEnabled);
  }
}
