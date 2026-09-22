/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-09-08
 * @FilePath: /ChromeExt/popup/modules/JsonFormatter.js
 * @Description: JSON 格式化模块（popup 端工具）：格式化 / 压缩 / 转义 / 去转义 / 按键排序 / 语法高亮
 */

class JsonFormatter extends BaseModule {
  constructor() {
    super('jsonFormatter'); // 模块名（popup 端工具，无 content 侧注入）
    this._timer = null;
    this._lastText = '';    // 最近一次成功输出（供复制 / 下载使用）
    this._indent = 2;       // 2 | 4 | 'tab'
    this._sortKeys = false;
  }

  async init(tab) {
    await Promise.all([this.initModuleStatus(tab), this._loadPrefs()]);
    this.bindEvents();
    this.updateUI();
  }

  // ───────── 偏好设置 ─────────
  async _loadPrefs() {
    const r = await chrome.storage.local.get(['jsonFormatterIndent', 'jsonFormatterSortKeys']);
    this._indent = r.jsonFormatterIndent === 4 || r.jsonFormatterIndent === 'tab' ? r.jsonFormatterIndent : 2;
    this._sortKeys = r.jsonFormatterSortKeys === true;

    const sel = document.getElementById('jsonIndent');
    if (sel) sel.value = String(this._indent);
    const sort = document.getElementById('jsonSortKeys');
    if (sort) sort.checked = this._sortKeys;
  }

  async _setPref(key, val) {
    await chrome.storage.local.set({ [key]: val });
  }

  // ───────── 事件绑定 ─────────
  bindEvents() {
    document.getElementById('jsonFormatterModuleEnabled')
      ?.addEventListener('change', (e) => this.onModuleToggle(e.target.checked));

    const input = document.getElementById('jsonInput');
    if (input) {
      input.addEventListener('input', () => this._scheduleProcess());
      // 粘贴后即时格式化（等浏览器把内容写进 textarea 再处理）
      input.addEventListener('paste', () => setTimeout(() => this._format(true), 60));
    }

    document.getElementById('jsonIndent')
      ?.addEventListener('change', async (e) => {
        this._indent = e.target.value === 'tab' ? 'tab' : Number(e.target.value) || 2;
        await this._setPref('jsonFormatterIndent', this._indent);
        this._process({ writeBack: true });
      });

    document.getElementById('jsonSortKeys')
      ?.addEventListener('change', async (e) => {
        this._sortKeys = e.target.checked;
        await this._setPref('jsonFormatterSortKeys', this._sortKeys);
        this._process({ writeBack: true });
      });

    document.getElementById('jsonFormatBtn')?.addEventListener('click', () => this._format(true));
    document.getElementById('jsonMinifyBtn')?.addEventListener('click', () => this._minify());
    document.getElementById('jsonEscapeBtn')?.addEventListener('click', () => this._escape());
    document.getElementById('jsonUnescapeBtn')?.addEventListener('click', () => this._unescape());
    document.getElementById('jsonSampleBtn')?.addEventListener('click', () => this._fillSample());
    document.getElementById('jsonClearBtn')?.addEventListener('click', () => this._clear());
    document.getElementById('jsonCopyBtn')?.addEventListener('click', () => this._copy());
    document.getElementById('jsonDownloadBtn')?.addEventListener('click', () => this._download());
  }

  // ───────── 核心处理 ─────────
  _scheduleProcess() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._process({ writeBack: false }), 300);
  }

  /**
   * 解析并渲染输入
   * @param {boolean} writeBack 是否把结果写回输入框（点按钮 / 改配置时为 true）
   */
  _process(opts) {
    const writeBack = !!(opts && opts.writeBack);
    const input = document.getElementById('jsonInput');
    const output = document.getElementById('jsonOutput');
    if (!input || !output) return null;

    const raw = input.value;
    if (!raw.trim()) {
      this._setStatus('等待输入…', '');
      output.innerHTML = '<span class="jf-placeholder">格式化结果将显示在这里</span>';
      this._lastText = '';
      return null;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      this._showError(raw, e);
      output.innerHTML = '<span class="jf-placeholder">JSON 无效，修正后自动显示结果</span>';
      this._lastText = '';
      return null;
    }

    if (this._sortKeys) parsed = this._sortValue(parsed);

    let text;
    try {
      text = this._stringify(parsed);
    } catch (e) {
      // 循环引用等极端情况（JSON.parse 结果不会循环，兜底而已）
      this._setStatus('序列化失败：' + (e && e.message ? e.message : e), 'error');
      this._lastText = '';
      return null;
    }

    if (writeBack) input.value = text;
    this._lastText = text;
    output.innerHTML = this._highlight(text);
    output.scrollTop = 0;

    const lines = text.split('\n').length;
    const bytes = new Blob([text]).size;
    const sizeStr = bytes > 1024 ? (bytes / 1024).toFixed(1) + ' KB' : bytes + ' B';
    this._setStatus(`有效 JSON · ${lines} 行 · ${text.length} 字符 · ${sizeStr}`, 'ok');
    return text;
  }

  _stringify(value) {
    if (this._indent === 'tab') return JSON.stringify(value, null, '\t');
    return JSON.stringify(value, null, this._indent);
  }

  /** 格式化：结果写回输入框 */
  _format(auto) {
    const input = document.getElementById('jsonInput');
    if (!input || !input.value.trim()) {
      Toast.warning('请先输入或粘贴 JSON');
      return;
    }
    const text = this._process({ writeBack: true });
    if (text && !auto) Toast.success('已格式化', 1500);
  }

  /** 压缩：去掉所有空白，结果写回输入框 */
  _minify() {
    const input = document.getElementById('jsonInput');
    if (!input || !input.value.trim()) {
      Toast.warning('请先输入或粘贴 JSON');
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(input.value);
    } catch (e) {
      this._showError(input.value, e);
      return;
    }
    if (this._sortKeys) parsed = this._sortValue(parsed);
    const text = JSON.stringify(parsed);
    input.value = text;
    this._lastText = text;
    const output = document.getElementById('jsonOutput');
    if (output) {
      output.innerHTML = this._highlight(text);
      output.scrollTop = 0;
    }
    const bytes = new Blob([text]).size;
    const sizeStr = bytes > 1024 ? (bytes / 1024).toFixed(1) + ' KB' : bytes + ' B';
    this._setStatus(`已压缩 · ${text.length} 字符 · ${sizeStr}`, 'ok');
  }

  /** 转义：把整段文本转成 JSON 字符串字面量 */
  _escape() {
    const input = document.getElementById('jsonInput');
    if (!input || !input.value) {
      Toast.warning('请先输入内容');
      return;
    }
    input.value = JSON.stringify(input.value);
    this._process({ writeBack: false });
    Toast.success('已转义', 1500);
  }

  /** 去转义：先按严格 JSON 字符串解析，失败则做宽松反斜杠还原 */
  _unescape() {
    const input = document.getElementById('jsonInput');
    if (!input || !input.value) {
      Toast.warning('请先输入内容');
      return;
    }
    try {
      const v = JSON.parse(input.value);
      if (typeof v === 'string') {
        input.value = v;
        this._process({ writeBack: false });
        Toast.success('已去转义', 1500);
        return;
      }
    } catch (e) { /* 不是合法 JSON 字符串，走宽松还原 */ }

    const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0', '"': '"', "'": "'", '/': '/', '`': '`', '\\': '\\' };
    input.value = input.value.replace(
      /\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})|\\(.)/g,
      (m, u1, u2, ch) => {
        if (u1 !== undefined) return JsonFormatter._codePoint(parseInt(u1, 16));
        if (u2 !== undefined) return JsonFormatter._codePoint(parseInt(u2, 16));
        return Object.prototype.hasOwnProperty.call(map, ch) ? map[ch] : ch;
      }
    );
    this._process({ writeBack: false });
    Toast.success('已去转义', 1500);
  }

  static _codePoint(code) {
    try {
      return String.fromCodePoint(code);
    } catch (e) {
      return String.fromCharCode(code);
    }
  }

  _fillSample() {
    const input = document.getElementById('jsonInput');
    if (!input) return;
    input.value = JSON.stringify({
      name: '极客百宝箱',
      version: '1.0',
      enabled: true,
      deprecated: null,
      modules: ['password', 'credential', 'timestampFormatter'],
      author: { name: '林晨', email: 'linchen@yixin.im' },
    });
    this._process({ writeBack: true });
  }

  _clear() {
    const input = document.getElementById('jsonInput');
    if (input) input.value = '';
    this._process({ writeBack: false });
  }

  async _copy() {
    if (!this._lastText) {
      Toast.warning('没有可复制的结果');
      return;
    }
    try {
      await navigator.clipboard.writeText(this._lastText);
      Toast.success('已复制结果', 1500);
    } catch (e) {
      Toast.error('复制失败');
    }
  }

  _download() {
    if (!this._lastText) {
      Toast.warning('没有可下载的结果');
      return;
    }
    const blob = new Blob([this._lastText], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'formatted.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    Toast.success('已下载 formatted.json', 1500);
  }

  // ───────── 排序 / 高亮 / 状态 ─────────
  _sortValue(value) {
    if (Array.isArray(value)) return value.map((v) => this._sortValue(v));
    if (value && typeof value === 'object') {
      const out = {};
      Object.keys(value)
        .sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }))
        .forEach((k) => { out[k] = this._sortValue(value[k]); });
      return out;
    }
    return value;
  }

  /** 极简 JSON 语法高亮：先转义再套 span，避免 HTML 注入 */
  _highlight(text) {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const re = /("(?:\\u[0-9a-fA-F]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false)\b|\b(null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}\[\],:])/g;
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      out += esc(text.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[1] !== undefined) {
        if (m[2] !== undefined) {
          out += '<span class="jf-key">' + esc(m[1]) + '</span><span class="jf-punc">' + esc(m[2]) + '</span>';
        } else {
          out += '<span class="jf-str">' + esc(m[1]) + '</span>';
        }
      } else if (m[3] !== undefined) {
        out += '<span class="jf-bool">' + esc(m[3]) + '</span>';
      } else if (m[4] !== undefined) {
        out += '<span class="jf-null">' + esc(m[4]) + '</span>';
      } else if (m[5] !== undefined) {
        out += '<span class="jf-num">' + esc(m[5]) + '</span>';
      } else if (m[6] !== undefined) {
        out += '<span class="jf-punc">' + esc(m[6]) + '</span>';
      }
    }
    out += esc(text.slice(last));
    return out;
  }

  /** 解析失败：提示行列并把光标移到出错位置 */
  _showError(raw, err) {
    const msg = String((err && err.message) || err);
    const m = msg.match(/position\s+(\d+)/i);
    let text = msg;
    if (m) {
      const pos = parseInt(m[1], 10);
      if (!Number.isNaN(pos) && pos <= raw.length) {
        // 新版 V8 的消息已自带 (line x column y)，避免重复追加
        if (!/\(line\s+\d+\s+column\s+\d+\)/i.test(msg)) {
          const before = raw.slice(0, pos);
          const line = before.split('\n').length;
          const col = pos - before.lastIndexOf('\n');
          text = `${msg}（第 ${line} 行第 ${col} 列）`;
        }
        const input = document.getElementById('jsonInput');
        if (input) {
          try {
            input.focus({ preventScroll: true });
            input.setSelectionRange(pos, Math.min(raw.length, pos + 1));
          } catch (e) { /* 忽略光标设置失败 */ }
        }
      }
    }
    this._setStatus('JSON 无效：' + text, 'error');
  }

  _setStatus(text, type) {
    const el = document.getElementById('jsonStatus');
    if (!el) return;
    el.textContent = text;
    el.className = 'jf-status' + (type ? ' ' + type : '');
    el.title = text;
  }

  // ───────── 基类钩子 ─────────
  async onModuleToggle(enabled) {
    await this.toggleModuleEnabled(enabled);
    this.updateUI();
  }

  async onSiteToggle(enabled) {
    await this.toggleSiteEnabled(enabled);
    this.updateUI();
  }

  getModuleName() {
    return 'JSON 格式化';
  }

  updateUI() {
    const sw = document.getElementById('jsonFormatterModuleEnabled');
    if (sw) sw.checked = this.moduleEnabled;
    const content = document.getElementById('jsonFormatterModuleContent');
    if (content) content.classList.toggle('disabled', !this.moduleEnabled);
  }
}
