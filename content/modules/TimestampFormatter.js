/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-08-06
 * @FilePath: /ChromeExt/content/modules/TimestampFormatter.js
 * @Description: 复制时间戳/日期即显示格式化结果（本地/UTC/相对时间），点击任意一行即可复制。
 *   触发方式：
 *   1) 网页内复制：监听全局 copy 事件，在光标附近即时弹层（无需权限、不弹框）；
 *   2) 任意处复制（终端/编辑器/聊天等）：复制后，在任意页面/输入框**粘贴**该内容时，
 *      浮层自动弹出。粘贴事件里直接携带文本内容（event.clipboardData），无需读取系统剪贴板、
 *      不弹权限框、也不注入任何页面图标。
 *   说明：Chrome MV3 禁止后台无感读取剪贴板（Service Worker 无 navigator.clipboard、
 *   Offscreen 文档无法聚焦、内容脚本轮询会逐页弹权限框），因此「跨应用复制」改为
 *   「粘贴即识别」——粘贴是用户手势且内容随事件直送，是最稳且不打扰的方式。
 *   快捷键 Ctrl/Cmd+Shift+Y 仍可重显上一次结果（隐藏备用，网页内无图标）。
 */

class TimestampFormatter extends BaseContentModule {
  constructor() {
    super('timestampFormatter');
    this.tooltipEl = null;
    this.showUTC = true;
    this.showRelative = true;

    // 复制产生的浮层锚点（优先用光标位置，其次用选区矩形）
    this._anchorX = null;
    this._anchorY = null;
    this._autoHideTimer = null;
    this._copying = false;    // 点击浮层内行复制时，避免二次触发 onCopy

    // 绑定 self，便于解绑
    this._onCopy = this._onCopy.bind(this);
    this._onPaste = this._onPaste.bind(this);
    this._onPointer = this._onPointer.bind(this);
    this._onOutside = this._onOutside.bind(this);
    this._onKey = this._onKey.bind(this);
    this._onResize = this._reposition.bind(this);
  }

  async init() {
    const enabled = await this.checkModuleEnabled();
    if (!enabled) return;

    // 复制即触发：优先从 clipboardData 拿本次复制内容
    document.addEventListener('copy', this._onCopy);
    // 任意处复制后，在页面/输入框粘贴该内容时自动识别并弹层（粘贴事件直接携带文本，无需读剪贴板权限、无图标）
    document.addEventListener('paste', this._onPaste);
    // 记录光标位置，用于浮层定位（鼠标复制/右键菜单复制均覆盖）
    document.addEventListener('mousemove', this._onPointer, true);
    document.addEventListener('mousedown', this._onPointer, true);
    document.addEventListener('contextmenu', this._onPointer, true);
    // 点击浮层外部关闭
    document.addEventListener('mousedown', this._onOutside, true);
    window.addEventListener('resize', this._onResize);
    document.addEventListener('keydown', this._onKey);

  }

  destroy() {
    document.removeEventListener('copy', this._onCopy);
    document.removeEventListener('paste', this._onPaste);
    document.removeEventListener('mousemove', this._onPointer, true);
    document.removeEventListener('mousedown', this._onPointer, true);
    document.removeEventListener('contextmenu', this._onPointer, true);
    document.removeEventListener('mousedown', this._onOutside, true);
    window.removeEventListener('resize', this._onResize);
    document.removeEventListener('keydown', this._onKey);
    this._clearAutoHide();
    this._hide();
  }

  async _loadPrefs() {
    const get = (k, d) => (typeof StorageState !== 'undefined'
      ? Promise.resolve(StorageState.get(k, d))
      : chrome.storage.local.get([k]).then(r => (r[k] ?? d)));
    this.showUTC = await get('timestampFormatterShowUTC', true);
    this.showRelative = await get('timestampFormatterShowRelative', true);
  }

  _onKey(e) {
    if (e.key === 'Escape' && this.tooltipEl) this._hide();
  }

  _onPointer(e) {
    // 仅记录坐标，不阻止默认行为；用于复制时浮层定位
    this._anchorX = e.clientX;
    this._anchorY = e.clientY;
  }

  _onOutside(e) {
    if (this.tooltipEl && !this.tooltipEl.contains(e.target)) this._hide();
  }

  _onCopy(e) {
    // 忽略我们自己在浮层里点击复制所触发的 copy（避免用格式化结果再次弹窗）
    if (this._copying) return;

    let text = '';
    try {
      if (e.clipboardData && typeof e.clipboardData.getData === 'function') {
        text = e.clipboardData.getData('text/plain') || '';
      }
    } catch (_) { /* 某些页面无 clipboardData，回退到选区 */ }

    // 兜底：clipboardData 取不到时，用当前选区文本
    if (!text && window.getSelection && !window.getSelection().isCollapsed) {
      text = window.getSelection().toString();
    }
    text = (text || '').trim();
    if (!text) return;

    const ms = this._parse(text);
    if (ms == null) return; // 不是时间戳，静默忽略

    this._refreshAnchorFromSelection();
    Promise.resolve(this._loadPrefs()).then(() => {
      if (ms == null) return; // 再次防御
      this._show(ms, text, false);
    });
  }

  /**
   * 粘贴即识别：用户在任意页面/输入框粘贴内容时触发。
   * 粘贴事件直接携带文本（event.clipboardData），无需读取系统剪贴板、不会弹权限框、也不注入页面图标。
   * 仅当粘贴内容为合法时间戳/日期时才弹层；普通文本静默忽略。
   */
  _onPaste(e) {
    let text = '';
    try {
      if (e.clipboardData && typeof e.clipboardData.getData === 'function') {
        text = e.clipboardData.getData('text/plain') || '';
      }
    } catch (_) { /* 部分环境无 clipboardData，忽略 */ }
    text = (text || '').trim();
    if (!text) return;

    const ms = this._parse(text);
    if (ms == null) return; // 不是时间戳，静默忽略，不打扰

    // 粘贴无光标坐标，浮层置于视口中央
    this._anchorX = null;
    this._anchorY = null;
    Promise.resolve(this._loadPrefs()).then(() => {
      if (ms == null) return;
      this._show(ms, text, true);
    });
  }


  /** 若没有鼠标坐标（如纯键盘复制），用当前选区尾端作为锚点 */
  _refreshAnchorFromSelection() {
    if (this._anchorX != null) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
      const r = sel.getRangeAt(0).getBoundingClientRect();
      this._anchorX = r.left;
      this._anchorY = r.bottom;
    }
  }

  /**
   * 解析文本为毫秒时间戳；无法识别返回 null
   * 解析/格式化核心已抽到 shared/timeFormat.js（window.__geekTime），
   * 此处仅做委托，浮层版（isolated world）与 popup 版共用同一套算法
   */
  _parse(raw) {
    return (typeof window.__geekTime !== 'undefined')
      ? window.__geekTime.parse(raw)
      : null;
  }

  _format(ms) {
    if (typeof window.__geekTime === 'undefined') {
      return { local: '', utc: '', tz: '', relative: '', weekday: '' };
    }
    return window.__geekTime.format(ms, {
      showUTC: this.showUTC,
      showRelative: this.showRelative,
    });
  }

  _show(ms, rawText, fromClipboard) {
    this._hide();
    // 网页外复制无光标位置，浮层置于视口中央；网页内复制沿用光标/选区锚点
    if (fromClipboard) {
      this._anchorX = null;
      this._anchorY = null;
    }
    const fmt = this._format(ms);

    const el = document.createElement('div');
    el.className = 'tsf-tooltip';
    el.style.cssText = [
      'position: fixed',
      'z-index: 2147483646',
      'width: 286px',
      'background: #fff',
      'border: 1px solid #e0e0e0',
      'border-radius: 12px',
      'box-shadow: 0 8px 28px rgba(0,0,0,0.16), 0 2px 8px rgba(0,0,0,0.08)',
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif',
      'font-size: 13px',
      'color: #1d1d1f',
      'overflow: hidden',
      'box-sizing: border-box',
    ].join(';');

    // 标题：原复制文本
    const header = document.createElement('div');
    header.style.cssText = 'display:flex; align-items:center; gap:6px; padding:10px 12px; border-bottom:1px solid #f0f0f0; background:#fafafa;';
    const badge = document.createElement('span');
    badge.textContent = '时间戳';
    badge.style.cssText = 'font-size:11px; color:#fff; background:#34c759; padding:1px 6px; border-radius:6px; flex:none;';
    const src = document.createElement('span');
    src.textContent = rawText.length > 22 ? rawText.slice(0, 21) + '…' : rawText;
    src.title = rawText;
    src.style.cssText = 'color:#8a8a8e; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
    header.appendChild(badge);
    header.appendChild(src);
    el.appendChild(header);

    const body = document.createElement('div');
    body.style.cssText = 'padding:4px 0;';
    el.appendChild(body);

    body.appendChild(this._row('本地时间', fmt.local, `${fmt.local} ${fmt.tz}`));
    body.appendChild(this._row('星期', fmt.weekday, fmt.weekday));
    if (this.showUTC) body.appendChild(this._row('UTC 时间', fmt.utc, fmt.utc));
    if (this.showRelative) body.appendChild(this._row('相对时间', fmt.relative, fmt.relative));

    const tip = document.createElement('div');
    tip.textContent = '点击任意一行复制';
    tip.style.cssText = 'padding:6px 12px 10px; font-size:11px; color:#c7c7cc; text-align:center;';
    el.appendChild(tip);

    document.body.appendChild(el);
    this.tooltipEl = el;
    this._position();

    // 复制结果浮层为瞬时提示，8 秒后自动消失
    this._clearAutoHide();
    this._autoHideTimer = setTimeout(() => this._hide(), 8000);
  }

  _row(label, value, copyValue) {
    const r = document.createElement('div');
    r.style.cssText = 'display:flex; justify-content:space-between; align-items:center; gap:10px; padding:8px 12px; cursor:pointer;';
    const left = document.createElement('span');
    left.textContent = label;
    left.style.cssText = 'color:#8a8a8e; flex:none; font-size:12px;';
    const right = document.createElement('span');
    right.textContent = value;
    right.style.cssText = 'text-align:right; font-variant-numeric:tabular-nums; word-break:break-all;';
    r.appendChild(left);
    r.appendChild(right);
    r.addEventListener('mouseenter', () => { r.style.background = '#f5f5f7'; });
    r.addEventListener('mouseleave', () => { r.style.background = ''; });
    // 阻止点击时触发外部 mousedown 关闭，也避免清空选区
    r.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    r.addEventListener('click', () => {
      this._copy(copyValue != null ? copyValue : value);
      Toast.success('已复制');
    });
    return r;
  }

  _copy(text) {
    try {
      this._copying = true;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
    } catch (e) { /* 忽略复制失败 */ }
    finally {
      // 短暂置位，屏蔽本次复制引发的 onCopy 二次弹窗
      setTimeout(() => { this._copying = false; }, 60);
    }
  }

  _position() {
    const el = this.tooltipEl;
    if (!el) return;
    let x = this._anchorX != null ? this._anchorX : window.innerWidth / 2;
    let y = this._anchorY != null ? this._anchorY : window.innerHeight / 2;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = el.offsetWidth || 286;
    const h = el.offsetHeight || 160;

    // 优先右下，溢出则向左/上翻转
    let left = x + 14;
    let top = y + 14;
    if (left + w > vw - 8) left = x - w - 14;
    if (left < 8) left = 8;
    if (top + h > vh - 8) top = y - h - 14;
    if (top < 8) top = 8;

    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }

  _reposition() {
    if (this.tooltipEl) this._position();
  }

  _clearAutoHide() {
    if (this._autoHideTimer) {
      clearTimeout(this._autoHideTimer);
      this._autoHideTimer = null;
    }
  }

  _hide() {
    this._clearAutoHide();
    if (this.tooltipEl) {
      this.tooltipEl.remove();
      this.tooltipEl = null;
    }
  }
}
